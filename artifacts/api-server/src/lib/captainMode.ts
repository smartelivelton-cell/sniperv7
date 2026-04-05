/**
 * ☠️ CAPTAIN MODE — Protocolo de Engajamento Único
 *
 * ATIVOS_EM_CURSO: coins currently under escort.
 * - Per-coin blocking: only that coin's new entry signals are suppressed.
 * - All other coins continue to signal normally.
 * - Deletion on ATIRAR: only the clicked coin's pending messages are removed.
 * - Multiple coins can be in ATIVOS_EM_CURSO simultaneously, each with its own escort loop.
 * - Slot released automatically when TP3 or stop is hit.
 */

import { logger } from "./logger";

const TELEGRAM_API       = "https://api.telegram.org";
const OKX_BASE           = "https://www.okx.com/api/v5";
const ESCORT_INTERVAL_MS = 60_000;  // escort update every 60s

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
  trade:             TradeData;
  riskZeroActivated: boolean;
  escortTimer:       ReturnType<typeof setInterval>;
}

// ── Module state ──────────────────────────────────────────────────────────────

/** ATIVOS_EM_CURSO — coins currently under escort, keyed by symbol. */
const escortMap = new Map<string, EscortState>();

/** Pending signal message IDs per symbol — deleted when ATIRAR is clicked for that coin. */
const pendingMsgsBySymbol = new Map<string, number[]>();

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
    const res = await fetch(`${OKX_BASE}/market/ticker?instId=${symbol}-USDT-SWAP`, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    return json.code === "0" && json.data?.[0] ? parseFloat(json.data[0].last) : null;
  } catch { return null; }
}

function fmt(n: number): string { return n > 1 ? n.toFixed(2) : n.toFixed(6); }

// ── Per-coin escort update loop ───────────────────────────────────────────────
async function runEscortUpdate(symbol: string): Promise<void> {
  const state = escortMap.get(symbol);
  if (!state) return;

  const { trade, riskZeroActivated } = state;
  const { direction, avgEntry, tp1, tp2, tp3 } = trade;

  const price = await fetchPrice(symbol);
  if (price === null) {
    logger.warn({ symbol }, "CaptainMode: falha ao buscar preço para atualização de escolta");
    return;
  }

  const pnlPct  = direction === "LONG" ? ((price - avgEntry) / avgEntry) * 100 : ((avgEntry - price) / avgEntry) * 100;
  const tp1Hit  = direction === "LONG" ? price >= tp1 : price <= tp1;
  const tp2Hit  = direction === "LONG" ? price >= tp2 : price <= tp2;
  const tp3Hit  = direction === "LONG" ? price >= tp3 : price <= tp3;
  const stopHit = direction === "LONG" ? price <= state.trade.sl : price >= state.trade.sl;

  // Mission complete — TP3
  if (tp3Hit) {
    await tgSend(
      `🏆 <b>MISSÃO CUMPRIDA! TP3 ATINGIDO!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol}-USDT-SWAP | +${pnlPct.toFixed(2)}%\n` +
      `Lucro máximo capturado, Capitão! ${symbol} liberado para novos sinais.`,
    );
    _releaseSlot(symbol);
    return;
  }

  // Mission complete — Stop hit
  if (stopHit) {
    const msg = riskZeroActivated
      ? `🏆 <b>MISSÃO CUMPRIDA! Stop no Breakeven — Capital Protegido.</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🪙 ${symbol}-USDT-SWAP — Saiu no zero a zero, Capitão!\n` +
        `${symbol} liberado para novos sinais.`
      : `🛑 <b>STOP ATINGIDO</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🪙 ${symbol}-USDT-SWAP — Stop original atingido. Missão encerrada.\n` +
        `${symbol} liberado para novos sinais.`;
    await tgSend(msg);
    _releaseSlot(symbol);
    return;
  }

  // TP1 hit → Risk Zero protocol (only triggers once)
  if (tp1Hit && !riskZeroActivated) {
    state.riskZeroActivated = true;
    state.trade.sl = avgEntry;  // move SL to breakeven
    await tgSend(
      `🛡️ <b>PROTOCOLO RISCO ZERO ATIVADO!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol}-USDT-SWAP | TP1 atingido! ✅\n` +
      `Stop movido para o ponto de entrada: <b>${fmt(avgEntry)}</b>\n` +
      `Lucro garantido, Capitão! 🎯\n` +
      `Próximo alvo: TP2 <b>${fmt(tp2)}</b>`,
    );
  }

  // Periodic escort status message
  const distToTp1 = tp1Hit ? 0 : Math.abs(direction === "LONG" ? ((tp1 - price) / price) * 100 : ((price - tp1) / price) * 100);
  const pnlSign   = pnlPct >= 0 ? "+" : "";
  const pnlIcon   = pnlPct >= 0 ? "📈" : "📉";
  const slLine    = state.riskZeroActivated
    ? `🛡️ Stop: <b>${fmt(avgEntry)}</b> (Breakeven — Risco Zero ✅)`
    : `🛡️ Stop: <b>${fmt(state.trade.sl)}</b>`;

  let tpLine: string;
  if (tp2Hit)      tpLine = `✅ TP1 e TP2 atingidos! Próximo: TP3 <b>${fmt(tp3)}</b>`;
  else if (tp1Hit) tpLine = `✅ TP1 atingido! Próximo: TP2 <b>${fmt(tp2)}</b>`;
  else             tpLine = `🎯 Falta para o TP1: <b>${distToTp1.toFixed(2)}%</b>`;

  await tgSend(
    `📡 <b>ESCOLTA ATIVA — ${symbol}-USDT-SWAP</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 Preço Atual: <b>${fmt(price)}</b>\n` +
    `${pnlIcon} Lucro: <b>${pnlSign}${pnlPct.toFixed(2)}%</b>\n` +
    `${tpLine}\n` +
    `${slLine}`,
  );
}

/** Remove coin from ATIVOS_EM_CURSO and clear its escort timer. */
function _releaseSlot(symbol: string): void {
  const state = escortMap.get(symbol);
  if (state?.escortTimer) clearInterval(state.escortTimer);
  escortMap.delete(symbol);
  pendingMsgsBySymbol.delete(symbol);
  logger.info({ symbol }, "CaptainMode: slot liberado — scanner de entrada retomado para esta moeda");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true if a symbol is currently in ATIVOS_EM_CURSO.
 * New entry signals for this coin should be suppressed.
 * Signals for all OTHER coins continue normally.
 */
export function isSymbolBlocked(symbol: string): boolean {
  return escortMap.has(symbol);
}

/**
 * Track a signal message ID for a specific coin.
 * Only this coin's messages will be deleted when ATIRAR is clicked for it.
 */
export function trackSignalMessage(symbol: string, messageId: number): void {
  const ids = pendingMsgsBySymbol.get(symbol) ?? [];
  ids.push(messageId);
  // Keep at most 10 messages per symbol to avoid excessive deletions
  if (ids.length > 10) ids.shift();
  pendingMsgsBySymbol.set(symbol, ids);
}

/**
 * Compact price formatter — keeps numbers short enough to fit in Telegram's
 * 64-byte callback_data limit while retaining enough precision for trading.
 */
function compactP(n: number): string {
  if (n >= 10000) return n.toFixed(0);
  if (n >= 1000)  return n.toFixed(1).replace(/\.0$/, "");
  if (n >= 100)   return n.toFixed(2).replace(/\.?0+$/, "");
  if (n >= 10)    return n.toFixed(3).replace(/\.?0+$/, "");
  if (n >= 1)     return n.toFixed(4).replace(/\.?0+$/, "");
  if (n >= 0.1)   return n.toFixed(5).replace(/\.?0+$/, "");
  return n.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * Returns the Telegram inline_keyboard with ATIRAR button.
 * Trade data is encoded directly in callback_data so it survives server restarts.
 * Format: atirar:SYM:L|S:entry:sl:tp1:tp2:tp3  (always < 64 bytes)
 */
export function buildAtiraKeyboard(trade: TradeData): object {
  const dir  = trade.direction === "LONG" ? "L" : "S";
  const data = [
    "atirar",
    trade.symbol,
    dir,
    compactP(trade.avgEntry),
    compactP(trade.sl),
    compactP(trade.tp1),
    compactP(trade.tp2),
    compactP(trade.tp3),
  ].join(":");
  return {
    inline_keyboard: [[{
      text:          "🚀 ATIRAR! (ENTREI NESSA)",
      callback_data: data,
    }]],
  };
}

/**
 * Called by the webhook when captain clicks ATIRAR.
 * Trade data is passed directly from the button's callback_data (no memory lookup needed).
 * Adds coin to ATIVOS_EM_CURSO and deletes only that coin's pending signal messages.
 * Other coins in the chat are left untouched and continue signaling normally.
 */
export async function handleAtirar(
  trade:           TradeData,
  callbackQueryId: string,
): Promise<void> {
  const { symbol, direction } = trade;

  // Reject duplicate ATIRAR for the same coin already in escort
  if (escortMap.has(symbol)) {
    await tgAnswerCallback(callbackQueryId, `⚠️ ${symbol} já está em escolta ativa!`);
    return;
  }

  // ── Guard: validate trade data before starting escort ─────────────────────
  // Old-format buttons (pre-fix) or zero-price API failures will have zeros.
  // Attempt to recover using the live OKX price with a 1% SL/TP rule.
  let resolvedTrade = { ...trade };
  const isInvalid = (x: number) => !Number.isFinite(x) || x <= 0;
  if (isInvalid(resolvedTrade.avgEntry) || isInvalid(resolvedTrade.sl) || isInvalid(resolvedTrade.tp1) || isInvalid(resolvedTrade.tp2) || isInvalid(resolvedTrade.tp3)) {
    logger.warn({ symbol, direction, trade }, "CaptainMode: valores zero detectados — tentando buscar preço ao vivo");
    const livePrice = await fetchPrice(symbol);
    if (!livePrice || livePrice <= 0) {
      await tgAnswerCallback(callbackQueryId, `⚠️ Dados de ${symbol} inválidos e preço OKX indisponível. Aguarde o próximo sinal.`);
      logger.warn({ symbol, direction }, "CaptainMode: ATIRAR abortado — preço ao vivo também indisponível");
      return;
    }
    const slPct = livePrice * 0.01;
    resolvedTrade = {
      symbol,
      direction,
      avgEntry: livePrice,
      sl:  direction === "LONG" ? livePrice - slPct : livePrice + slPct,
      tp1: direction === "LONG" ? livePrice + slPct       : livePrice - slPct,
      tp2: direction === "LONG" ? livePrice + slPct * 2   : livePrice - slPct * 2,
      tp3: direction === "LONG" ? livePrice + slPct * 3   : livePrice - slPct * 3,
    };
    logger.info({ symbol, direction, livePrice }, "CaptainMode: valores reconstruídos com preço ao vivo (regra 1%)");
  }

  // Delete only THIS coin's pending signal messages (other coins untouched)
  const coinMsgIds = pendingMsgsBySymbol.get(symbol) ?? [];
  logger.info({ symbol, direction, msgCount: coinMsgIds.length }, "CaptainMode: ATIRAR — deletando sinais de " + symbol);
  await Promise.allSettled(coinMsgIds.map(id => tgDelete(id)));
  pendingMsgsBySymbol.set(symbol, []);

  await tgAnswerCallback(callbackQueryId, `🚀 ${symbol} adicionado à lista de operações!`);

  // Start per-coin escort timer
  const timer = setInterval(() => runEscortUpdate(symbol), ESCORT_INTERVAL_MS);
  escortMap.set(symbol, { trade: resolvedTrade, riskZeroActivated: false, escortTimer: timer });

  const activeList = [...escortMap.keys()].join(", ");
  logger.info({ symbol, direction, ativos: activeList }, "CaptainMode: ATIVOS_EM_CURSO atualizado");

  const dirLabel = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  await tgSend(
    `🚀 <b>CAPITÃO A BORDO!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 Escolta iniciada: <b>${symbol}-USDT-SWAP</b>\n` +
    `📍 Direção: <b>${dirLabel}</b>\n` +
    `📍 Entrada Média: <b>${fmt(resolvedTrade.avgEntry)}</b>\n` +
    `🛡️ Stop Loss: <b>${fmt(resolvedTrade.sl)}</b>\n` +
    `🎯 TP1: <b>${fmt(resolvedTrade.tp1)}</b> | TP2: <b>${fmt(resolvedTrade.tp2)}</b> | TP3: <b>${fmt(resolvedTrade.tp3)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📡 Atualização a cada 60s.\n` +
    `⏸️ Novos sinais de ${symbol} suspensos.\n` +
    `✅ Radar global ativo para outras moedas.`,
  );
}
