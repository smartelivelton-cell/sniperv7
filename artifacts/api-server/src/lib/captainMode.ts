/**
 * ☠️ CAPTAIN MODE — Protocolo de Engajamento Único
 * When the captain clicks ATIRAR, escort mode activates:
 *   - All pending signal messages are deleted from chat
 *   - New entry signals for the escorted coin are suppressed
 *   - Periodic price updates are sent every 60s
 *   - TP1 triggers the Risk Zero protocol (SL moved to breakeven)
 *   - TP3 or stop hit ends the mission
 */

import { logger } from "./logger";

const TELEGRAM_API      = "https://api.telegram.org";
const OKX_BASE          = "https://www.okx.com/api/v5";
const ESCORT_INTERVAL_MS = 60_000;  // update every 60s

// ── Types ─────────────────────────────────────────────────────────────────────
export interface TradeData {
  symbol:    string;
  direction: "LONG" | "SHORT";
  avgEntry:  number;
  sl:        number;
  tp1:       number;
  tp2:       number;
  tp3:       number;
}

interface EscortState {
  trade:              TradeData;
  riskZeroActivated:  boolean;
  escortTimer:        ReturnType<typeof setInterval>;
}

// ── Module state ──────────────────────────────────────────────────────────────
let escort: EscortState | null = null;

const pendingMessageIds: number[]            = [];         // signal msg IDs to delete
const pendingTrades     = new Map<string, TradeData>();    // keyed by "SYMBOL:DIRECTION"

// ── Internal Telegram helpers ─────────────────────────────────────────────────
async function tgSend(text: string, extra: Record<string, any> = {}): Promise<number | null> {
  const token  = process.env.TELEGRAM_TOKEN  || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CHAT_ID         || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, parse_mode: "HTML", text, ...extra }),
      signal:  AbortSignal.timeout(8_000),
    });
    if (!res.ok) { logger.warn({ status: res.status }, "CaptainMode: Telegram send error"); return null; }
    const json: any = await res.json();
    return json?.result?.message_id ?? null;
  } catch (err: any) {
    logger.warn({ err: err.message }, "CaptainMode: Telegram send failed");
    return null;
  }
}

async function tgDelete(messageId: number): Promise<void> {
  const token  = process.env.TELEGRAM_TOKEN  || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CHAT_ID         || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`${TELEGRAM_API}/bot${token}/deleteMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, message_id: messageId }),
      signal:  AbortSignal.timeout(5_000),
    });
  } catch { /* message may already be gone */ }
}

async function tgAnswerCallback(callbackQueryId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
      signal:  AbortSignal.timeout(5_000),
    });
  } catch { /* ignore */ }
}

// ── OKX price helper ──────────────────────────────────────────────────────────
async function fetchPrice(symbol: string): Promise<number | null> {
  try {
    const res  = await fetch(`${OKX_BASE}/market/ticker?instId=${symbol}-USDT-SWAP`, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    return json.code === "0" && json.data?.[0] ? parseFloat(json.data[0].last) : null;
  } catch { return null; }
}

function fmt(n: number): string { return n > 1 ? n.toFixed(2) : n.toFixed(6); }

// ── Escort loop ───────────────────────────────────────────────────────────────
async function runEscortUpdate(): Promise<void> {
  if (!escort) return;
  const { trade, riskZeroActivated } = escort;
  const { symbol, direction, avgEntry, tp1, tp2, tp3 } = trade;

  const price = await fetchPrice(symbol);
  if (price === null) { logger.warn({ symbol }, "CaptainMode: failed to fetch price for escort update"); return; }

  const pnlPct  = direction === "LONG" ? ((price - avgEntry) / avgEntry) * 100 : ((avgEntry - price) / avgEntry) * 100;
  const tp1Hit  = direction === "LONG" ? price >= tp1 : price <= tp1;
  const tp2Hit  = direction === "LONG" ? price >= tp2 : price <= tp2;
  const tp3Hit  = direction === "LONG" ? price >= tp3 : price <= tp3;
  const stopHit = direction === "LONG" ? price <= escort.trade.sl : price >= escort.trade.sl;

  // Mission complete — TP3
  if (tp3Hit) {
    await tgSend(
      `🏆 <b>MISSÃO CUMPRIDA! TP3 ATINGIDO!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol}-USDT-SWAP | +${pnlPct.toFixed(2)}%\n` +
      `Lucro máximo capturado, Capitão! Retomando scanner global...`,
    );
    _deactivate();
    return;
  }

  // Mission complete — Stop hit
  if (stopHit) {
    const msg = riskZeroActivated
      ? `🏆 <b>MISSÃO CUMPRIDA! Stop no Breakeven — Capital Protegido.</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🪙 ${symbol}-USDT-SWAP — Saiu no zero a zero, Capitão!\n` +
        `Retomando scanner global...`
      : `🛑 <b>STOP ATINGIDO</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🪙 ${symbol}-USDT-SWAP — Stop original atingido. Missão encerrada.\n` +
        `Retomando scanner global...`;
    await tgSend(msg);
    _deactivate();
    return;
  }

  // TP1 hit → Risk Zero
  if (tp1Hit && !riskZeroActivated) {
    escort.riskZeroActivated = true;
    escort.trade.sl = avgEntry;  // move SL to breakeven
    await tgSend(
      `🛡️ <b>PROTOCOLO RISCO ZERO ATIVADO!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol}-USDT-SWAP | TP1 atingido! ✅\n` +
      `Stop movido para o ponto de entrada: <b>${fmt(avgEntry)}</b>\n` +
      `Lucro garantido, Capitão! 🎯\n` +
      `Próximo alvo: TP2 <b>${fmt(tp2)}</b>`,
    );
  }

  // Periodic escort status
  const distToTp1 = tp1Hit ? 0 : Math.abs(direction === "LONG" ? ((tp1 - price) / price) * 100 : ((price - tp1) / price) * 100);
  const pnlSign   = pnlPct >= 0 ? "+" : "";
  const pnlIcon   = pnlPct >= 0 ? "📈" : "📉";
  const slLine    = escort.riskZeroActivated
    ? `🛡️ Stop: <b>${fmt(avgEntry)}</b> (Breakeven — Risco Zero ✅)`
    : `🛡️ Stop: <b>${fmt(escort.trade.sl)}</b>`;

  let tpLine: string;
  if (tp2Hit) {
    tpLine = `✅ TP1 e TP2 atingidos! Próximo: TP3 <b>${fmt(tp3)}</b>`;
  } else if (tp1Hit) {
    tpLine = `✅ TP1 atingido! Próximo: TP2 <b>${fmt(tp2)}</b>`;
  } else {
    tpLine = `🎯 Falta para o TP1: <b>${distToTp1.toFixed(2)}%</b>`;
  }

  await tgSend(
    `📡 <b>ESCOLTA ATIVA — ${symbol}-USDT-SWAP</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 Preço Atual: <b>${fmt(price)}</b>\n` +
    `${pnlIcon} Lucro: <b>${pnlSign}${pnlPct.toFixed(2)}%</b>\n` +
    `${tpLine}\n` +
    `${slLine}`,
  );
}

function _deactivate(): void {
  if (escort?.escortTimer) clearInterval(escort.escortTimer);
  escort = null;
  logger.info("CaptainMode: Modo Escolta desativado — scanner global retomado");
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns true if a symbol is currently under escort (new signals should be suppressed). */
export function isSymbolBlocked(symbol: string): boolean {
  return escort !== null && escort.trade.symbol === symbol;
}

/** Returns true if captain mode is currently active (any coin). */
export function isCaptainActive(): boolean {
  return escort !== null;
}

/** Register trade data so it can be retrieved when ATIRAR is clicked. */
export function registerTrade(data: TradeData): void {
  pendingTrades.set(`${data.symbol}:${data.direction}`, data);
}

/** Track a signal message ID so it can be deleted when ATIRAR is clicked. */
export function trackSignalMessage(messageId: number): void {
  pendingMessageIds.push(messageId);
  if (pendingMessageIds.length > 30) pendingMessageIds.shift();
}

/** Returns the Telegram inline_keyboard object for the ATIRAR button. */
export function buildAtiraKeyboard(symbol: string, direction: string): object {
  return {
    inline_keyboard: [[{
      text:          "🚀 ATIRAR! (ENTREI NESSA)",
      callback_data: `atirar:${symbol}:${direction}`,
    }]],
  };
}

/**
 * Called by the webhook when captain clicks ATIRAR.
 * Deletes pending messages and starts escort mode.
 */
export async function handleAtirar(
  symbol:          string,
  direction:       "LONG" | "SHORT",
  callbackQueryId: string,
): Promise<void> {
  if (escort) {
    await tgAnswerCallback(callbackQueryId, `⚠️ Escolta já ativa para ${escort.trade.symbol}!`);
    return;
  }

  const data = pendingTrades.get(`${symbol}:${direction}`);
  if (!data) {
    await tgAnswerCallback(callbackQueryId, `⚠️ Dados do sinal expirados. Aguarde o próximo.`);
    logger.warn({ symbol, direction }, "CaptainMode: trade data não encontrado — ATIRAR ignorado");
    return;
  }

  logger.info({ symbol, direction, msgCount: pendingMessageIds.length }, "CaptainMode: ATIRAR — deletando sinais pendentes e ativando escolta");

  await tgAnswerCallback(callbackQueryId, `🚀 Escolta ativada para ${symbol}!`);

  // Delete all tracked signal messages
  await Promise.allSettled([...pendingMessageIds].map(id => tgDelete(id)));
  pendingMessageIds.length = 0;

  // Start escort mode
  const timer = setInterval(runEscortUpdate, ESCORT_INTERVAL_MS);
  escort = { trade: { ...data }, riskZeroActivated: false, escortTimer: timer };

  await tgSend(
    `🚀 <b>CAPITÃO A BORDO!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 Escolta iniciada: <b>${symbol}-USDT-SWAP</b>\n` +
    `📍 Entrada Média: <b>${fmt(data.avgEntry)}</b>\n` +
    `🛡️ Stop Loss: <b>${fmt(data.sl)}</b>\n` +
    `🎯 TP1: <b>${fmt(data.tp1)}</b> | TP2: <b>${fmt(data.tp2)}</b> | TP3: <b>${fmt(data.tp3)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📡 Atualização a cada 60s.\n` +
    `⏸️ Outros sinais de ${symbol} suspensos.`,
  );
}
