/**
 * 🎯 CONFLUÊNCIA SNIPER — Execução Autônoma
 *
 * Trigger Matrix (todos os 4 devem ser verdadeiros simultaneamente):
 *   1. Confirmação 100%: RSI(6) spike ≥15pts OU volume ≥2× média, trend não neutro
 *   2. Sniper RSI(2): RSI(2) < 10 (LONG) ou > 90 (SHORT)
 *   3. Filtro Fibonacci: preço dentro de 0.3% do nível 0.5 ou 0.618 do range do dia
 *   4. Onda SAR: SAR Parabólica a favor da tendência
 *
 * Protocolo "Sombra do General":
 *   - Breakeven ao atingir +0.25% de lucro (mais agressivo que o Warrior)
 *   - Trailing stop se Volume Delta cair abaixo de 45% após entrada
 *
 * Risk: TP 0.6% | SL 0.3% | Breakeven em 0.25% | 50x isolado
 */

import { logger } from "./logger";
import {
  calculateEMA,
  calculateRSI,
  calculateParabolicSAR,
  calculateAvgVolume,
  type Candle,
} from "./indicators";

// ── Constants ──────────────────────────────────────────────────────────────────
const SNIPER_SYMBOLS     = ["BTC", "ETH", "SOL", "XRP", "ADA", "BNB", "POL"];
const SCAN_INTERVAL_MS   = 25_000;          // scan a cada 25s
const ESCORT_INTERVAL_MS = 15_000;          // escort a cada 15s
const SAR_UPDATE_MS      = 2 * 60 * 1000;  // narração SAR a cada 2min
const TP_PCT             = 0.006;           // 0.6%
const SL_PCT             = 0.003;           // 0.3%
const BREAKEVEN_PCT      = 0.0025;          // 0.25% — "Sombra do General"
const DELTA_DANGER       = 45;             // Volume Delta < 45% → trailing stop
const FIB_TOLERANCE      = 0.003;          // ±0.3% de tolerância Fibonacci
const LEVERAGE           = 50;
const OKX_BASE           = "https://www.okx.com/api/v5";
const TZ                 = "America/Sao_Paulo";

type Direction = "LONG" | "SHORT";

// ── Automation config ──────────────────────────────────────────────────────────
export interface SniperConfig {
  autoEnabled: boolean;
}

export const sniperConfig: SniperConfig = {
  autoEnabled: false,
};

// ── State ──────────────────────────────────────────────────────────────────────
interface EscortState {
  symbol:           string;
  direction:        Direction;
  entry:            number;
  sl:               number;
  tp:               number;
  breakevenMoved:   boolean;
  trailingActive:   boolean;
  escortTimer:      ReturnType<typeof setInterval>;
  sarTimer:         ReturnType<typeof setInterval>;
  startedAt:        number;
  fibLevel:         number;
  confluenceScore:  number;
}

const escortMap = new Map<string, EscortState>();
let scanTimer: ReturnType<typeof setInterval> | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n: number): string { return n > 1 ? n.toFixed(2) : n.toFixed(6); }

function nowBR(): string {
  return new Date().toLocaleTimeString("pt-BR", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit",
  });
}

async function tgSend(text: string, extra?: object): Promise<void> {
  const token  = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CHAT_ID        || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, parse_mode: "HTML", text, ...extra }),
      signal:  AbortSignal.timeout(8_000),
    });
  } catch { /* ignore */ }
}

async function fetchKlines(symbol: string, limit = 100): Promise<Candle[]> {
  const instId = `${symbol}-USDT-SWAP`;
  const url    = `${OKX_BASE}/market/candles?instId=${instId}&bar=5m&limit=${limit}`;
  const res    = await fetch(url, {
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

// ── Volume Delta (last 5 candles) ─────────────────────────────────────────────
function volumeDelta(candles: Candle[], direction: Direction): number {
  const recent   = candles.slice(-5);
  const totalVol = recent.reduce((s, c) => s + c.volume, 0);
  if (totalVol === 0) return 50;
  const upVol    = recent.filter(c => c.close >= c.open).reduce((s, c) => s + c.volume, 0);
  const pct      = (upVol / totalVol) * 100;
  return direction === "LONG" ? pct : 100 - pct;
}

// ── Fibonacci filter ───────────────────────────────────────────────────────────
// Uses the day range (last 96 M5 candles = 8h) to compute 0.5 and 0.618 levels.
// Returns the nearest Fib level hit (0 = none).
function fibonacciLevel(candles: Candle[], price: number): number | null {
  const dayCandles = candles.slice(-96);
  const swingHigh  = Math.max(...dayCandles.map(c => c.high));
  const swingLow   = Math.min(...dayCandles.map(c => c.low));
  const range      = swingHigh - swingLow;
  if (range === 0) return null;

  const levels = [
    { ratio: 0.500, level: swingLow + range * 0.500 },
    { ratio: 0.618, level: swingLow + range * 0.618 },
    // Expansion levels (price pulled back and now near expansion)
    { ratio: 0.5,   level: swingHigh - range * 0.500 },
    { ratio: 0.618, level: swingHigh - range * 0.618 },
  ];

  for (const { level } of levels) {
    if (Math.abs(price - level) / level <= FIB_TOLERANCE) {
      return level;
    }
  }
  return null;
}

// ── SAR narration during trade ─────────────────────────────────────────────────
async function runSarUpdate(symbol: string): Promise<void> {
  const state = escortMap.get(symbol);
  if (!state) return;
  try {
    const candles   = await fetchKlines(symbol, 50);
    const sarPoints = calculateParabolicSAR(candles);
    const lastSar   = sarPoints.at(-1);
    if (!lastSar) return;
    const price      = candles.at(-1)!.close;
    const sarPos     = lastSar.isLong ? "ABAIXO do preço 🟢" : "ACIMA do preço 🔴";
    const pnlPct     = state.direction === "LONG"
      ? ((price - state.entry) / state.entry) * 100
      : ((state.entry - price) / state.entry) * 100;
    const delta      = volumeDelta(candles, state.direction);
    const deltaWarn  = delta < DELTA_DANGER ? ` ⚠️ Delta: ${delta.toFixed(1)}%` : "";

    await tgSend(
      `🎯 <b>SNIPER — Atualização SAR</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol}-USDT-SWAP | ${state.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT"}\n` +
      `💵 Preço: <b>${fmt(price)}</b> | SAR: <b>${fmt(lastSar.sar)}</b>\n` +
      `📊 Onda SAR: ${sarPos}${deltaWarn}\n` +
      `${pnlPct >= 0 ? "📈" : "📉"} PnL: <b>${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%</b>\n` +
      `🎯 TP: ${fmt(state.tp)} | 🛡️ Stop: ${fmt(state.sl)}${state.breakevenMoved ? " ✅ Breakeven" : ""}${state.trailingActive ? " 🔄 Trailing" : ""}\n` +
      `⏰ ${nowBR()} (Brasília)`,
    );
  } catch (err: any) {
    logger.warn({ symbol, err: err.message }, "Sniper: SAR update error");
  }
}

// ── Escort monitor (every 15s — "Sombra do General") ─────────────────────────
async function runEscortUpdate(symbol: string): Promise<void> {
  const state = escortMap.get(symbol);
  if (!state) return;

  try {
    const candles = await fetchKlines(symbol, 50);
    const price   = candles.at(-1)?.close ?? await fetchPrice(symbol);
    if (!price) return;

    const pnlPct = state.direction === "LONG"
      ? ((price - state.entry) / state.entry) * 100
      : ((state.entry - price) / state.entry) * 100;

    const tpHit = state.direction === "LONG" ? price >= state.tp : price <= state.tp;
    const slHit = state.direction === "LONG" ? price <= state.sl : price >= state.sl;

    // ── Protocolo "Sombra do General" — Breakeven em 0.25% ─────────────────
    if (pnlPct >= BREAKEVEN_PCT * 100 && !state.breakevenMoved) {
      state.breakevenMoved = true;
      state.sl = state.entry;
      await tgSend(
        `🛡️ <b>SNIPER — SOMBRA DO GENERAL: RISCO ZERO!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🪙 ${symbol}-USDT-SWAP — Lucro de +${pnlPct.toFixed(2)}% atingido!\n` +
        `✅ Stop movido para o Breakeven: <b>${fmt(state.entry)}</b>\n` +
        `🎯 Alvo continua: ${fmt(state.tp)} (+0.6%)\n` +
        `⏰ ${nowBR()} (Brasília)`,
      );
    }

    // ── Volume Delta < 45% → ativar Trailing Stop ────────────────────────────
    if (!state.trailingActive && state.breakevenMoved) {
      const delta = volumeDelta(candles, state.direction);
      if (delta < DELTA_DANGER) {
        state.trailingActive = true;
        // Trailing stop: move SL para preço atual - pequeno buffer (0.1%)
        const trailBuffer = state.entry * 0.001;
        const newSl = state.direction === "LONG"
          ? price - trailBuffer
          : price + trailBuffer;
        state.sl = newSl;
        await tgSend(
          `🔄 <b>SNIPER — TRAILING STOP ATIVADO!</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `🪙 ${symbol}-USDT-SWAP\n` +
          `⚠️ Volume Delta caiu para <b>${delta.toFixed(1)}%</b> (abaixo de 45%)\n` +
          `🔄 Stop ajustado para: <b>${fmt(newSl)}</b>\n` +
          `💡 Protegendo qualquer lucro acumulado\n` +
          `⏰ ${nowBR()} (Brasília)`,
        );
      }
    }

    // ── TP Hit ───────────────────────────────────────────────────────────────
    if (tpHit) {
      clearInterval(state.escortTimer);
      clearInterval(state.sarTimer);
      escortMap.delete(symbol);
      await tgSend(
        `🏆 <b>CONFLUÊNCIA SNIPER WIN! 🎯</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🪙 ${symbol}-USDT-SWAP | +${pnlPct.toFixed(2)}%\n` +
        `🎉 Alvo de 0.6% capturado com precisão Sniper!\n` +
        `💰 $${(100 * 50 * TP_PCT).toFixed(2)} lucro ($100/50x)\n` +
        `⏰ ${nowBR()} (Brasília)`,
      );
      logger.info({ symbol, pnlPct }, "Sniper: TP atingido — win");
      return;
    }

    // ── SL Hit ───────────────────────────────────────────────────────────────
    if (slHit) {
      clearInterval(state.escortTimer);
      clearInterval(state.sarTimer);
      escortMap.delete(symbol);
      const isBreakevenStop = state.breakevenMoved;
      if (isBreakevenStop) {
        await tgSend(
          `🛡️ <b>SNIPER — Stop no Breakeven. Capital protegido.</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `🪙 ${symbol}-USDT-SWAP — Encerrado no zero a zero.\n` +
          `Sombra do General protegeu a banca ✅\n` +
          `⏰ ${nowBR()} (Brasília)`,
        );
      } else {
        await tgSend(
          `🛑 <b>SNIPER LOSS — ${symbol}-USDT-SWAP</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `📉 Perda de ${pnlPct.toFixed(2)}% | Stop atingido.\n` +
          `Confluência não sustentou o movimento.\n` +
          `⏰ ${nowBR()} (Brasília)`,
        );
      }
      logger.info({ symbol, isBreakevenStop, pnlPct }, "Sniper: stop atingido");
    }
  } catch (err: any) {
    logger.warn({ symbol, err: err.message }, "Sniper: escort error");
  }
}

// ── Start escort ───────────────────────────────────────────────────────────────
async function startEscort(
  symbol:          string,
  direction:       Direction,
  entry:           number,
  fibLevel:        number,
  confluenceScore: number,
): Promise<void> {
  if (escortMap.has(symbol)) return;

  const sl = direction === "LONG" ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);
  const tp = direction === "LONG" ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);

  const escortTimer = setInterval(() => runEscortUpdate(symbol), ESCORT_INTERVAL_MS);
  const sarTimer    = setInterval(() => runSarUpdate(symbol),    SAR_UPDATE_MS);

  escortMap.set(symbol, {
    symbol, direction, entry, sl, tp,
    breakevenMoved: false,
    trailingActive: false,
    escortTimer, sarTimer,
    startedAt: Date.now(),
    fibLevel, confluenceScore,
  });

  const dirLabel  = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const dirEmoji  = direction === "LONG" ? "📈" : "📉";

  await tgSend(
    `🎯 <b>CONFLUÊNCIA SNIPER: ${symbol} | 🔥 Confirmação 100% Detectada | 💰 Alvo: 0.6%</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 ${symbol}-USDT-SWAP | ${dirLabel}\n` +
    `${dirEmoji} Confluência: <b>${confluenceScore}/4 filtros ativados</b>\n` +
    `📐 Fibonacci: <b>${fmt(fibLevel)}</b> (0.5/0.618 do range do dia)\n` +
    `🎚 Alavancagem: <b>${LEVERAGE}x</b> (Margem Isolada)\n` +
    `💵 Entrada: <b>${fmt(entry)}</b>\n` +
    `🎯 Take Profit: <b>${fmt(tp)}</b> (+0.6%)\n` +
    `🛡️ Stop Loss: <b>${fmt(sl)}</b> (-0.3%)\n` +
    `🗡️ Protocolo Sombra do General: breakeven em +0.25%\n` +
    `⚡ Trailing stop: ativa se Delta cair abaixo de 45%\n` +
    `📡 SAR narrado a cada 2 min.\n` +
    `⏰ ${nowBR()} (Brasília)`,
  );
  logger.info({ symbol, direction, entry, sl, tp, fibLevel, confluenceScore }, "Sniper: trade iniciado");
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function scanSniper(symbol: string): Promise<void> {
  try {
    if (escortMap.has(symbol)) return;
    if (!sniperConfig.autoEnabled) return;

    const candles = await fetchKlines(symbol, 120);
    if (candles.length < 30) return;

    const closed  = candles.slice(0, -1);
    const partial = candles.at(-1)!;
    const closes  = closed.map(c => c.close);
    const price   = partial.close;

    // ── Indicadores ────────────────────────────────────────────────────────────
    // RSI(2) — Sniper exhaustion
    const rsi2Arr  = calculateRSI(closes, 2);
    const rsi2     = rsi2Arr.at(-1) ?? 50;

    // RSI(6) — para "Confirmação 100%"
    const rsi6Arr  = calculateRSI(closes, 6);
    const rsi6     = rsi6Arr.at(-1) ?? 50;
    const rsi6Prev = rsi6Arr.at(-2) ?? 50;
    const rsi6Spike = Math.abs(rsi6 - rsi6Prev) >= 15;

    // Volume — para "Confirmação 100%"
    const avgVol     = calculateAvgVolume(closed, 20);
    const lastVol    = closed.at(-1)?.volume ?? 0;
    const volSpike   = avgVol > 0 && lastVol >= avgVol * 2;

    // Trend (EMA9) para não ser neutro
    const ema9Arr   = calculateEMA(closes, 9);
    const ema9      = ema9Arr.at(-1) ?? 0;
    const ema9Prev  = ema9Arr.at(-2) ?? 0;
    const trend     = price > ema9 && ema9 > ema9Prev
      ? "BULL"
      : price < ema9 && ema9 < ema9Prev
      ? "BEAR"
      : "NEUTRAL";

    // Parabolic SAR
    const sarArr  = calculateParabolicSAR(closed);
    const sarLast = sarArr.at(-1);
    if (!sarLast) return;

    // Fibonacci check
    const fibHit = fibonacciLevel(closed, price);

    // ── Gatilho 1: Confirmação 100% ────────────────────────────────────────────
    const conf100 = (rsi6Spike || volSpike) && trend !== "NEUTRAL";

    // ── Determinar direção ──────────────────────────────────────────────────────
    let direction: Direction | null = null;

    const longCond =
      trend === "BULL" &&
      conf100        &&           // Confirmação 100%
      rsi2 < 10      &&           // Sniper RSI(2) exaustão baixa
      fibHit !== null &&          // Fibonacci 0.5 ou 0.618
      sarLast.isLong;             // SAR bullish

    const shortCond =
      trend === "BEAR" &&
      conf100         &&           // Confirmação 100%
      rsi2 > 90       &&           // Sniper RSI(2) exaustão alta
      fibHit !== null &&           // Fibonacci 0.5 ou 0.618
      !sarLast.isLong;             // SAR bearish

    if (longCond)       direction = "LONG";
    else if (shortCond) direction = "SHORT";

    if (!direction) return;

    // Contar confluências ativas (para log e Telegram)
    const score = [conf100, rsi2 < 10 || rsi2 > 90, fibHit !== null, true].filter(Boolean).length;

    await startEscort(symbol, direction, price, fibHit!, score);
  } catch (err: any) {
    logger.warn({ symbol, err: err.message }, "Sniper: scanCoin error");
  }
}

async function runScan(): Promise<void> {
  for (const symbol of SNIPER_SYMBOLS) {
    await scanSniper(symbol);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────
export function startSniperScanner(): void {
  if (scanTimer) return;
  scanTimer = setInterval(() => runScan(), SCAN_INTERVAL_MS);
  runScan();
  logger.info({ symbols: SNIPER_SYMBOLS, intervalMs: SCAN_INTERVAL_MS }, "Sniper: CONFLUÊNCIA scanner iniciado");
}

export function getSniperStatus() {
  return {
    autoEnabled: sniperConfig.autoEnabled,
    activeEscorts: [...escortMap.values()].map(e => ({
      symbol:          e.symbol,
      direction:       e.direction,
      entry:           e.entry,
      sl:              e.sl,
      tp:              e.tp,
      breakevenMoved:  e.breakevenMoved,
      trailingActive:  e.trailingActive,
      startedAt:       e.startedAt,
      fibLevel:        e.fibLevel,
      confluenceScore: e.confluenceScore,
    })),
  };
}
