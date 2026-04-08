/**
 * 🛡️ THE WARRIOR SCANNER — Execução Autônoma
 *
 * Strategy: VWAP filter + RSI(2) exhaustion + SAR flip after EMA200 break
 * Protocol: Wait for 2nd M5 candle with Volume Delta > 53%
 * Risk: TP 0.6% | SL 0.3% | Breakeven at 0.3% profit
 * Assets: BTC, ETH, SOL
 */

import { logger } from "./logger";
import {
  calculateEMA,
  calculateRSI,
  calculateParabolicSAR,
  calculateVWAP,
  type Candle,
} from "./indicators";

// ── Constants ──────────────────────────────────────────────────────────────────
const WARRIOR_SYMBOLS   = ["BTC", "ETH", "SOL"];
const SCAN_INTERVAL_MS  = 20_000;
const SAR_UPDATE_MS     = 2 * 60 * 1000;   // SAR narration every 2 min
const TP_PCT            = 0.006;             // 0.6%
const SL_PCT            = 0.003;             // 0.3%
const BREAKEVEN_PCT     = 0.003;             // trigger breakeven at 0.3% profit
const DELTA_THRESHOLD   = 53;               // Volume Delta %
const LEVERAGE          = 50;
const OKX_BASE          = "https://www.okx.com/api/v5";
const TZ                = "America/Sao_Paulo";

type Direction = "LONG" | "SHORT";

// ── Automation config (exported so routes can read/write) ─────────────────────
export interface WarriorConfig {
  autoEnabled:  boolean;
  banca:        number;  // USD
  leverage:     number;
  dailyGoal:    number;  // USD daily profit target
  enabledStrats: string[]; // which strategy IDs are auto-enabled
}

export const warriorConfig: WarriorConfig = {
  autoEnabled:  false,
  banca:        200,
  leverage:     50,
  dailyGoal:    50,
  enabledStrats: ["warrior", "muralha", "surfe", "ondaSar", "sinalMestre"],
};

// ── Scan state ─────────────────────────────────────────────────────────────────
interface BreakoutState {
  symbol:     string;
  direction:  Direction;
  triggerClose: number;   // closeTime of the candle that triggered
  price:      number;
  vwap:       number;
  rsi2:       number;
  detectedAt: number;     // Date.now() when we stored this
}

interface EscortState {
  symbol:           string;
  direction:        Direction;
  entry:            number;
  sl:               number;
  tp:               number;
  breakevenMoved:   boolean;
  escortTimer:      ReturnType<typeof setInterval>;
  sarTimer:         ReturnType<typeof setInterval>;
  startedAt:        number;
}

interface DayStats {
  date:        string;
  opsUsed:     number;
  maxOps:      number;   // starts at 1, +1 after each win
  waitingReply: boolean; // waiting for user yes/no after loss
}

const breakoutMap = new Map<string, BreakoutState>();
const escortMap   = new Map<string, EscortState>();

function todayKey(): string {
  return new Date().toLocaleDateString("pt-BR", { timeZone: TZ });
}

let dayStats: DayStats = {
  date: todayKey(),
  opsUsed: 0,
  maxOps: 1,
  waitingReply: false,
};

function resetDayIfNeeded() {
  const today = todayKey();
  if (dayStats.date !== today) {
    dayStats = { date: today, opsUsed: 0, maxOps: 1, waitingReply: false };
  }
}

let scanTimer: ReturnType<typeof setInterval> | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmt(n: number): string { return n > 1 ? n.toFixed(2) : n.toFixed(6); }
function nowBR(): string {
  return new Date().toLocaleTimeString("pt-BR", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit",
  });
}

async function tgSend(text: string, extra?: object): Promise<number | null> {
  const token  = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CHAT_ID        || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, parse_mode: "HTML", text, ...extra }),
      signal:  AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    return json?.result?.message_id ?? null;
  } catch { return null; }
}

async function fetchKlines(symbol: string, limit = 100): Promise<Candle[]> {
  const instId = `${symbol}-USDT-SWAP`;
  const url    = `${OKX_BASE}/market/candles?instId=${instId}&bar=5m&limit=${limit}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal:  AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`OKX ${res.status} for ${symbol}`);
  const json: any = await res.json();
  if (json.code !== "0") throw new Error(`OKX error: ${json.msg}`);
  const raw = [...json.data as string[][]].reverse();
  return raw.map(k => ({
    openTime: parseInt(k[0]),
    open:     parseFloat(k[1]),
    high:     parseFloat(k[2]),
    low:      parseFloat(k[3]),
    close:    parseFloat(k[4]),
    volume:   parseFloat(k[5]),
  }));
}

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

// ── Volume Delta approx ────────────────────────────────────────────────────────
// Uses last 5 candles: up-candle volume vs total as % (bullish delta for LONG)
function volumeDelta(candles: Candle[], direction: Direction): number {
  const recent = candles.slice(-5);
  const totalVol = recent.reduce((s, c) => s + c.volume, 0);
  if (totalVol === 0) return 50;
  const upVol = recent
    .filter(c => c.close >= c.open)
    .reduce((s, c) => s + c.volume, 0);
  const deltaPct = (upVol / totalVol) * 100;
  return direction === "LONG" ? deltaPct : 100 - deltaPct;
}

// ── SAR escort update (every 2 min during active trade) ───────────────────────
async function runSarUpdate(symbol: string): Promise<void> {
  const state = escortMap.get(symbol);
  if (!state) return;
  try {
    const candles = await fetchKlines(symbol, 50);
    const sarPoints = calculateParabolicSAR(candles);
    const lastSar   = sarPoints.at(-1);
    if (!lastSar) return;
    const price = candles.at(-1)!.close;
    const sarPosition = lastSar.isLong ? "ABAIXO do preço (Bullish 🟢)" : "ACIMA do preço (Bearish 🔴)";
    const pnlPct = state.direction === "LONG"
      ? ((price - state.entry) / state.entry) * 100
      : ((state.entry - price) / state.entry) * 100;
    await tgSend(
      `📡 <b>WARRIOR — Atualização SAR</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol}-USDT-SWAP | ${state.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT"}\n` +
      `💵 Preço: <b>${fmt(price)}</b> | SAR: <b>${fmt(lastSar.sar)}</b>\n` +
      `📊 Onda SAR: ${sarPosition}\n` +
      `${pnlPct >= 0 ? "📈" : "📉"} PnL: <b>${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%</b>\n` +
      `🎯 TP: ${fmt(state.tp)} | 🛡️ Stop: ${fmt(state.sl)}${state.breakevenMoved ? " ✅ Breakeven" : ""}\n` +
      `⏰ ${nowBR()} (Brasília)`,
    );
  } catch (err: any) {
    logger.warn({ symbol, err: err.message }, "Warrior: SAR update error");
  }
}

// ── Escort monitor (every 30s, checks TP/SL/breakeven) ────────────────────────
async function runEscortUpdate(symbol: string): Promise<void> {
  const state = escortMap.get(symbol);
  if (!state) return;
  const price = await fetchPrice(symbol);
  if (!price) return;

  const pnlPct = state.direction === "LONG"
    ? ((price - state.entry) / state.entry) * 100
    : ((state.entry - price) / state.entry) * 100;
  const tpHit = state.direction === "LONG" ? price >= state.tp : price <= state.tp;
  const slHit = state.direction === "LONG" ? price <= state.sl : price >= state.sl;

  // Move to breakeven at 0.3% profit
  if (pnlPct >= BREAKEVEN_PCT * 100 && !state.breakevenMoved) {
    state.breakevenMoved = true;
    state.sl = state.entry;
    await tgSend(
      `🛡️ <b>WARRIOR — PROTOCOLO RISCO ZERO!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol}-USDT-SWAP — Lucro de +${pnlPct.toFixed(2)}% atingido!\n` +
      `✅ Stop movido para o Breakeven: <b>${fmt(state.entry)}</b>\n` +
      `🏹 Banca protegida! Alvo: ${fmt(state.tp)} (+0.6%)`,
    );
    return;
  }

  if (tpHit) {
    clearInterval(state.escortTimer);
    clearInterval(state.sarTimer);
    escortMap.delete(symbol);
    dayStats.opsUsed++;
    dayStats.maxOps++; // win → allow one more operation today
    await tgSend(
      `🏆 <b>WARRIOR WIN! ALVO CAPTURADO!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol}-USDT-SWAP | +${pnlPct.toFixed(2)}%\n` +
      `🎉 Lucro de 0.6% capturado com sucesso!\n` +
      `✅ Uma nova operação liberada para hoje.\n` +
      `⏰ ${nowBR()} (Brasília)`,
    );
    logger.info({ symbol, pnlPct }, "Warrior: TP atingido — win");
    return;
  }

  if (slHit) {
    clearInterval(state.escortTimer);
    clearInterval(state.sarTimer);
    escortMap.delete(symbol);
    dayStats.opsUsed++;
    const isBreakevenStop = state.breakevenMoved;
    if (isBreakevenStop) {
      await tgSend(
        `🛡️ <b>WARRIOR — Stop no Breakeven. Capital protegido.</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🪙 ${symbol}-USDT-SWAP — Encerrado no zero a zero.\n` +
        `${symbol} liberado para novos sinais.\n` +
        `⏰ ${nowBR()} (Brasília)`,
      );
    } else {
      dayStats.waitingReply = true;
      await tgSend(
        `🛑 <b>WARRIOR LOSS — ${symbol}-USDT-SWAP</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📉 Perda de ${pnlPct.toFixed(2)}% | Stop atingido.\n` +
        `⏰ ${nowBR()} (Brasília)\n\n` +
        `❓ <b>Deseja continuar operando hoje?</b>`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ SIM — Continuar", callback_data: "warrior_continue:YES" },
              { text: "❌ NÃO — Parar hoje",  callback_data: "warrior_continue:NO" },
            ]],
          },
        },
      );
    }
    logger.info({ symbol, isBreakevenStop, pnlPct }, "Warrior: stop atingido");
    return;
  }
}

// ── Start escort for a warrior trade ──────────────────────────────────────────
async function startEscort(symbol: string, direction: Direction, entry: number, delta: number): Promise<void> {
  if (escortMap.has(symbol)) return;

  const sl = direction === "LONG" ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);
  const tp = direction === "LONG" ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);

  const escortTimer = setInterval(() => runEscortUpdate(symbol), 30_000);
  const sarTimer    = setInterval(() => runSarUpdate(symbol),    SAR_UPDATE_MS);

  escortMap.set(symbol, {
    symbol, direction, entry, sl, tp,
    breakevenMoved: false,
    escortTimer, sarTimer,
    startedAt: Date.now(),
  });

  const dirLabel = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  await tgSend(
    `🪖 <b>THE WARRIOR ATIVADO: ${symbol} | ${direction}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 ${symbol}-USDT-SWAP | ${dirLabel}\n` +
    `📊 Volume Delta: <b>${delta.toFixed(1)}%</b>\n` +
    `🎚 Alavancagem: <b>${LEVERAGE}x</b>\n` +
    `💵 Entrada: <b>${fmt(entry)}</b>\n` +
    `🎯 Take Profit: <b>${fmt(tp)}</b> (+0.6%)\n` +
    `🛡️ Stop Loss: <b>${fmt(sl)}</b> (-0.3%)\n` +
    `🏹 Alvo: 0.6% | Banca protegida no breakeven (0.3%)\n` +
    `📡 SAR narrado a cada 2 min.\n` +
    `⏰ ${nowBR()} (Brasília)`,
  );
  logger.info({ symbol, direction, entry, sl, tp, delta }, "Warrior: trade iniciado");
}

// ── Main scan ──────────────────────────────────────────────────────────────────
async function scanWarrior(symbol: string): Promise<void> {
  try {
    // Skip if active escort running
    if (escortMap.has(symbol)) return;

    // Skip if waiting for user yes/no reply after loss
    if (dayStats.waitingReply) return;

    // Skip if day op limit reached
    if (dayStats.opsUsed >= dayStats.maxOps) return;

    // Skip if automation not enabled
    if (!warriorConfig.autoEnabled) {
      // Check breakout map even if not auto — still scan, just don't auto-fire
      // (reserved for future manual confirmation mode)
      return;
    }

    const candles = await fetchKlines(symbol, 100);
    if (candles.length < 5) return;

    // Separate closed candles from current partial
    // OKX: last candle in array is current (partial), second-to-last is last closed
    const closed  = candles.slice(0, -1);   // all confirmed candles
    const partial = candles.at(-1)!;        // current open candle

    const closes = closed.map(c => c.close);
    const price  = partial.close;

    // ── VWAP (on closed candles) ────────────────────────────────────────────
    const vwap = calculateVWAP(closed);

    // ── RSI(2) ──────────────────────────────────────────────────────────────
    const rsi2Arr = calculateRSI(closes, 2);
    const rsi2    = rsi2Arr.at(-1) ?? 50;

    // ── EMA 200 ─────────────────────────────────────────────────────────────
    const ema200Arr = calculateEMA(closes, 200);
    const ema200    = ema200Arr.at(-1) ?? 0;
    const ema200Prev = ema200Arr.at(-2) ?? 0;
    const prevClose  = closes.at(-2) ?? 0;
    const lastClose  = closes.at(-1) ?? 0;

    // ── Parabolic SAR ────────────────────────────────────────────────────────
    const sarArr    = calculateParabolicSAR(closed);
    const sarLast   = sarArr.at(-1);
    const sarPrev   = sarArr.at(-2);
    if (!sarLast || !sarPrev || ema200 === 0) return;

    // ── Determine signal direction ────────────────────────────────────────────
    let direction: Direction | null = null;

    const longOk =
      price > vwap &&                            // VWAP filter: above for LONG
      rsi2 < 10 &&                               // RSI(2) exhaustion low
      lastClose > ema200 &&                      // price broke above EMA200
      prevClose <= ema200Prev &&                 // previous candle was at/below EMA200
      sarLast.isLong && !sarPrev.isLong;         // SAR just flipped bullish

    const shortOk =
      price < vwap &&                            // VWAP filter: below for SHORT
      rsi2 > 90 &&                               // RSI(2) exhaustion high
      lastClose < ema200 &&                      // price broke below EMA200
      prevClose >= ema200Prev &&                 // previous candle was at/above EMA200
      !sarLast.isLong && sarPrev.isLong;         // SAR just flipped bearish

    if (longOk) direction = "LONG";
    else if (shortOk) direction = "SHORT";

    // ── 2nd Candle Protocol ─────────────────────────────────────────────────
    const breakout = breakoutMap.get(symbol);

    if (direction && !breakout) {
      // First trigger: store breakout candle and wait for 2nd candle
      const triggerClose = closed.at(-1)!.openTime;
      breakoutMap.set(symbol, {
        symbol, direction,
        triggerClose,
        price, vwap, rsi2,
        detectedAt: Date.now(),
      });
      logger.info({ symbol, direction, rsi2, price, vwap }, "Warrior: breakout detectado — aguardando 2ª vela");
      return;
    }

    if (breakout) {
      // Check if a new candle has opened since the breakout
      const currentCandleTime = partial.openTime;
      const isNewCandle = currentCandleTime > breakout.triggerClose;
      const tooOld      = Date.now() - breakout.detectedAt > 10 * 60 * 1000; // 10min max

      if (tooOld) {
        breakoutMap.delete(symbol);
        logger.info({ symbol }, "Warrior: breakout expirado — descartado");
        return;
      }

      if (!isNewCandle) return; // still on the same candle — keep waiting

      // 2nd candle opened — check Volume Delta
      const delta = volumeDelta(candles, breakout.direction);

      if (delta > DELTA_THRESHOLD) {
        breakoutMap.delete(symbol);
        const entry = partial.close;
        await startEscort(symbol, breakout.direction, entry, delta);
      } else {
        breakoutMap.delete(symbol);
        logger.info({ symbol, delta }, "Warrior: 2ª vela sem delta suficiente — sinal descartado");
      }
    }
  } catch (err: any) {
    logger.warn({ symbol, err: err.message }, "Warrior: scanCoin error");
  }
}

async function runScan(): Promise<void> {
  resetDayIfNeeded();
  for (const symbol of WARRIOR_SYMBOLS) {
    await scanWarrior(symbol);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function startWarriorScanner(): void {
  if (scanTimer) return;
  scanTimer = setInterval(() => runScan(), SCAN_INTERVAL_MS);
  runScan();
  logger.info({ symbols: WARRIOR_SYMBOLS, intervalMs: SCAN_INTERVAL_MS }, "Warrior: scanner iniciado");
}

export function getWarriorStatus() {
  return {
    autoEnabled:  warriorConfig.autoEnabled,
    activeEscorts: [...escortMap.values()].map(e => ({
      symbol:        e.symbol,
      direction:     e.direction,
      entry:         e.entry,
      sl:            e.sl,
      tp:            e.tp,
      breakevenMoved: e.breakevenMoved,
      startedAt:     e.startedAt,
    })),
    pendingBreakouts: [...breakoutMap.values()].map(b => ({
      symbol:    b.symbol,
      direction: b.direction,
      rsi2:      b.rsi2,
      detectedAt: b.detectedAt,
    })),
    dayStats: { ...dayStats },
  };
}

/** Called by webhook when user replies YES/NO to loss message */
export function handleWarriorContinue(reply: "YES" | "NO"): void {
  dayStats.waitingReply = false;
  if (reply === "NO") {
    dayStats.opsUsed = dayStats.maxOps; // block further ops today
    logger.info("Warrior: usuário optou por parar — operações suspensas pelo resto do dia");
  } else {
    logger.info("Warrior: usuário optou por continuar — scanner retomado");
  }
}
