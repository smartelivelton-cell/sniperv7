/**
 * 🚜 TANQUE DE GUERRA — Execução Autônoma
 *
 * Modo: Day Trade autônomo com segurança máxima para banca de $915
 *
 * Trigger Matrix:
 *   1. VWAP filter: LONG acima da VWAP · SHORT abaixo da VWAP
 *   2. Confirmação 100%: RSI(6) spike ≥15pts OU Volume ≥2× média
 *   3. Sniper RSI(2): RSI(2) < 5 (LONG extremo) · RSI(2) > 95 (SHORT extremo)
 *   4. Protocolo 2ª Vela: Volume Delta > 53% na 2ª vela confirmatória
 *
 * Lógica de Contra-Ataque (falso rompimento):
 *   - Se preço cruzar a EMA mas RSI(2) já estiver exausto → ignora e aguarda reversão
 *
 * Gestão "Blindagem":
 *   - TP: 1.1% (~$50 de lucro com $915/5x)
 *   - SL: 2.5% (estrutural — aguenta oscilação do vilãozinho)
 *   - Breakeven: ao atingir +0.4% de lucro
 *
 * Risk: TP 1.1% | SL 2.5% | Breakeven 0.4% | 5x isolado | BTC, ETH, SOL
 */

import { logger } from "./logger";
import {
  calculateEMA,
  calculateRSI,
  calculateParabolicSAR,
  calculateAvgVolume,
  calculateVWAP,
  type Candle,
} from "./indicators";

// ── Constants ──────────────────────────────────────────────────────────────────
const TANK_SYMBOLS       = ["BTC", "ETH", "SOL"];
const SCAN_INTERVAL_MS   = 22_000;          // scan a cada 22s (offset dos outros scanners)
const ESCORT_INTERVAL_MS = 20_000;          // escort a cada 20s
const SAR_UPDATE_MS      = 2 * 60 * 1000;  // narração SAR a cada 2min
const TP_PCT             = 0.011;           // 1.1%
const SL_PCT             = 0.025;           // 2.5%
const BREAKEVEN_PCT      = 0.004;           // 0.4% — Blindagem
const DELTA_THRESHOLD    = 53;             // Volume Delta > 53%
const RSI2_LONG          = 5;              // RSI(2) < 5 para LONG (extremo)
const RSI2_SHORT         = 95;             // RSI(2) > 95 para SHORT (extremo)
const BANCA              = 915;
const LEVERAGE           = 5;
const OKX_BASE           = "https://www.okx.com/api/v5";
const TZ                 = "America/Sao_Paulo";

type Direction = "LONG" | "SHORT";

// ── Config ────────────────────────────────────────────────────────────────────
export interface TankWarConfig {
  autoEnabled: boolean;
  banca:       number;
}

export const tankWarConfig: TankWarConfig = {
  autoEnabled: false,
  banca:       BANCA,
};

// ── State ──────────────────────────────────────────────────────────────────────
interface BreakoutState {
  symbol:       string;
  direction:    Direction;
  triggerClose: number;
  price:        number;
  vwap:         number;
  rsi2:         number;
  detectedAt:   number;
}

interface EscortState {
  symbol:         string;
  direction:      Direction;
  entry:          number;
  sl:             number;
  tp:             number;
  breakevenMoved: boolean;
  escortTimer:    ReturnType<typeof setInterval>;
  sarTimer:       ReturnType<typeof setInterval>;
  startedAt:      number;
  delta:          number;
  targetUsd:      number;
}

interface DayStats {
  date:      string;
  opsUsed:   number;
  wins:      number;
  losses:    number;
}

const breakoutMap = new Map<string, BreakoutState>();
const escortMap   = new Map<string, EscortState>();
let scanTimer: ReturnType<typeof setInterval> | null = null;

function todayKey(): string {
  return new Date().toLocaleDateString("pt-BR", { timeZone: TZ });
}

let dayStats: DayStats = {
  date: todayKey(), opsUsed: 0, wins: 0, losses: 0,
};

function resetDayIfNeeded() {
  const today = todayKey();
  if (dayStats.date !== today) {
    dayStats = { date: today, opsUsed: 0, wins: 0, losses: 0 };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n: number): string { return n > 1 ? n.toFixed(2) : n.toFixed(6); }

function nowBR(): string {
  return new Date().toLocaleTimeString("pt-BR", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit",
  });
}

function calcTargetUsd(banca: number): number {
  return Math.round(banca * LEVERAGE * TP_PCT * 100) / 100;
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

// ── Volume Delta ──────────────────────────────────────────────────────────────
function volumeDelta(candles: Candle[], direction: Direction): number {
  const recent   = candles.slice(-5);
  const totalVol = recent.reduce((s, c) => s + c.volume, 0);
  if (totalVol === 0) return 50;
  const upVol    = recent.filter(c => c.close >= c.open).reduce((s, c) => s + c.volume, 0);
  const pct      = (upVol / totalVol) * 100;
  return direction === "LONG" ? pct : 100 - pct;
}

// ── SAR narration (every 2min) ────────────────────────────────────────────────
async function runSarUpdate(symbol: string): Promise<void> {
  const state = escortMap.get(symbol);
  if (!state) return;
  try {
    const candles   = await fetchKlines(symbol, 50);
    const sarPoints = calculateParabolicSAR(candles);
    const lastSar   = sarPoints.at(-1);
    if (!lastSar) return;
    const price   = candles.at(-1)!.close;
    const sarPos  = lastSar.isLong ? "ABAIXO do preço 🟢" : "ACIMA do preço 🔴";
    const pnlPct  = state.direction === "LONG"
      ? ((price - state.entry) / state.entry) * 100
      : ((state.entry - price) / state.entry) * 100;
    const pnlUsd  = pnlPct / 100 * state.entry * LEVERAGE;

    await tgSend(
      `🚜 <b>TANQUE — Atualização SAR</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol}-USDT-SWAP | ${state.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT"}\n` +
      `💵 Preço: <b>${fmt(price)}</b> | SAR: <b>${fmt(lastSar.sar)}</b>\n` +
      `📊 SAR: ${sarPos}\n` +
      `${pnlPct >= 0 ? "📈" : "📉"} PnL: <b>${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%</b> | <b>${pnlUsd >= 0 ? "+" : ""}$${Math.abs(pnlUsd).toFixed(2)}</b>\n` +
      `🎯 TP: ${fmt(state.tp)} (+1.1%) | 🛡️ Stop: ${fmt(state.sl)}${state.breakevenMoved ? " ✅ Blindagem" : ""}\n` +
      `⏰ ${nowBR()} (Brasília)`,
    );
  } catch (err: any) {
    logger.warn({ symbol, err: err.message }, "TankWar: SAR update error");
  }
}

// ── Escort monitor (every 20s) ────────────────────────────────────────────────
async function runEscortUpdate(symbol: string): Promise<void> {
  const state = escortMap.get(symbol);
  if (!state) return;

  const price = await fetchPrice(symbol);
  if (!price) return;

  const pnlPct = state.direction === "LONG"
    ? ((price - state.entry) / state.entry) * 100
    : ((state.entry - price) / state.entry) * 100;
  const pnlUsd  = pnlPct / 100 * tankWarConfig.banca * LEVERAGE;
  const tpHit   = state.direction === "LONG" ? price >= state.tp : price <= state.tp;
  const slHit   = state.direction === "LONG" ? price <= state.sl : price >= state.sl;

  // ── Blindagem: Breakeven em +0.4% ────────────────────────────────────────
  if (pnlPct >= BREAKEVEN_PCT * 100 && !state.breakevenMoved) {
    state.breakevenMoved = true;
    state.sl = state.entry;
    await tgSend(
      `🛡️ <b>TANQUE — BLINDAGEM ATIVADA: RISCO ZERO!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol}-USDT-SWAP — +${pnlPct.toFixed(2)}% atingido!\n` +
      `✅ Stop movido para o Breakeven: <b>${fmt(state.entry)}</b>\n` +
      `🎯 Alvo continua: ${fmt(state.tp)} (+1.1% ≈ $${state.targetUsd.toFixed(2)})\n` +
      `⏰ ${nowBR()} (Brasília)`,
    );
    return;
  }

  // ── TP Hit ────────────────────────────────────────────────────────────────
  if (tpHit) {
    clearInterval(state.escortTimer);
    clearInterval(state.sarTimer);
    escortMap.delete(symbol);
    dayStats.opsUsed++;
    dayStats.wins++;
    await tgSend(
      `🏆 <b>TANQUE DE GUERRA — ALVO DESTRUÍDO! 🚜</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol}-USDT-SWAP | +${pnlPct.toFixed(2)}%\n` +
      `💰 Lucro: <b>+$${Math.abs(pnlUsd).toFixed(2)}</b> (meta: ~$${state.targetUsd.toFixed(2)})\n` +
      `🎉 1.1% capturado com ${LEVERAGE}x / $${tankWarConfig.banca}!\n` +
      `📊 Dia: ${dayStats.wins}W / ${dayStats.losses}L\n` +
      `⏰ ${nowBR()} (Brasília)`,
    );
    logger.info({ symbol, pnlPct, pnlUsd }, "TankWar: TP atingido — win");
    return;
  }

  // ── SL Hit ────────────────────────────────────────────────────────────────
  if (slHit) {
    clearInterval(state.escortTimer);
    clearInterval(state.sarTimer);
    escortMap.delete(symbol);
    dayStats.opsUsed++;
    const isBreakevenStop = state.breakevenMoved;
    if (isBreakevenStop) {
      await tgSend(
        `🛡️ <b>TANQUE — Blindagem segurou. Capital protegido.</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🪙 ${symbol}-USDT-SWAP — Encerrado no zero a zero.\n` +
        `O Tanque aguenta o vilãozinho ✅\n` +
        `⏰ ${nowBR()} (Brasília)`,
      );
    } else {
      dayStats.losses++;
      await tgSend(
        `🛑 <b>TANQUE LOSS — ${symbol}-USDT-SWAP</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📉 ${pnlPct.toFixed(2)}% | Stop estrutural atingido.\n` +
        `💸 -$${Math.abs(pnlUsd).toFixed(2)} (SL 2.5% com ${LEVERAGE}x)\n` +
        `📊 Dia: ${dayStats.wins}W / ${dayStats.losses}L\n` +
        `⏰ ${nowBR()} (Brasília)`,
      );
    }
    logger.info({ symbol, isBreakevenStop, pnlPct }, "TankWar: stop atingido");
  }
}

// ── Start escort ──────────────────────────────────────────────────────────────
async function startEscort(symbol: string, direction: Direction, entry: number, delta: number): Promise<void> {
  if (escortMap.has(symbol)) return;

  const sl        = direction === "LONG" ? entry * (1 - SL_PCT)  : entry * (1 + SL_PCT);
  const tp        = direction === "LONG" ? entry * (1 + TP_PCT)  : entry * (1 - TP_PCT);
  const targetUsd = calcTargetUsd(tankWarConfig.banca);
  const dirLabel  = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";

  const escortTimer = setInterval(() => runEscortUpdate(symbol), ESCORT_INTERVAL_MS);
  const sarTimer    = setInterval(() => runSarUpdate(symbol),    SAR_UPDATE_MS);

  escortMap.set(symbol, {
    symbol, direction, entry, sl, tp,
    breakevenMoved: false,
    escortTimer, sarTimer,
    startedAt: Date.now(),
    delta, targetUsd,
  });

  await tgSend(
    `🚜 TANQUE DE GUERRA EM PATRULHA: ${symbol} | 🛡️ Banca: $${tankWarConfig.banca} | 💰 Alvo: ~$${targetUsd.toFixed(2)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 ${symbol}-USDT-SWAP | ${dirLabel}\n` +
    `📊 Volume Delta: <b>${delta.toFixed(1)}%</b> (2ª vela confirmada)\n` +
    `🎚 Alavancagem: <b>${LEVERAGE}x</b> (Margem Isolada) | Banca: <b>$${tankWarConfig.banca}</b>\n` +
    `💵 Entrada: <b>${fmt(entry)}</b>\n` +
    `🎯 Take Profit: <b>${fmt(tp)}</b> (+1.1%)\n` +
    `🛡️ Stop Loss: <b>${fmt(sl)}</b> (-2.5% — estrutural)\n` +
    `⚡ Blindagem: breakeven ao atingir +0.4%\n` +
    `📡 SAR narrado a cada 2 min.\n` +
    `⏰ ${nowBR()} (Brasília)`,
  );
  logger.info({ symbol, direction, entry, sl, tp, delta, targetUsd }, "TankWar: trade iniciado");
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function scanTankWar(symbol: string): Promise<void> {
  try {
    if (escortMap.has(symbol)) return;
    if (!tankWarConfig.autoEnabled) return;

    const candles = await fetchKlines(symbol, 100);
    if (candles.length < 10) return;

    const closed  = candles.slice(0, -1);
    const partial = candles.at(-1)!;
    const closes  = closed.map(c => c.close);
    const price   = partial.close;

    // ── VWAP (last 48 M5 candles = ~4h) ────────────────────────────────────
    const vwap = calculateVWAP(closed.slice(-48));

    // ── RSI(2) — Sniper extremo ─────────────────────────────────────────────
    const rsi2Arr = calculateRSI(closes, 2);
    const rsi2    = rsi2Arr.at(-1) ?? 50;

    // ── RSI(6) — Confirmação 100% ────────────────────────────────────────────
    const rsi6Arr  = calculateRSI(closes, 6);
    const rsi6     = rsi6Arr.at(-1) ?? 50;
    const rsi6Prev = rsi6Arr.at(-2) ?? 50;
    const rsi6Spike = Math.abs(rsi6 - rsi6Prev) >= 15;

    // ── Volume — Confirmação 100% ─────────────────────────────────────────────
    const avgVol   = calculateAvgVolume(closed, 20);
    const lastVol  = closed.at(-1)?.volume ?? 0;
    const volSpike = avgVol > 0 && lastVol >= avgVol * 2;

    // ── EMA9 para falso rompimento ────────────────────────────────────────────
    const ema9Arr  = calculateEMA(closes, 9);
    const ema9     = ema9Arr.at(-1) ?? 0;
    const ema9Prev = ema9Arr.at(-2) ?? 0;
    const prevClose = closes.at(-2) ?? 0;
    const lastClose = closes.at(-1) ?? 0;

    // ── Parabolic SAR ─────────────────────────────────────────────────────────
    const sarArr  = calculateParabolicSAR(closed);
    const sarLast = sarArr.at(-1);
    const sarPrev = sarArr.at(-2);
    if (!sarLast || !sarPrev) return;

    // ── Confirmação 100% ─────────────────────────────────────────────────────
    const conf100 = rsi6Spike || volSpike;

    // ── Lógica de Contra-Ataque: Falso Rompimento ────────────────────────────
    // Se o preço cruzou a EMA9 MAS o RSI(2) já está exausto no extremo errado → ignora
    const falseLongBreak =
      lastClose > ema9 && prevClose <= ema9Prev &&  // cruzou EMA para cima
      rsi2 > 80;                                     // mas RSI(2) já no topo (exausto)

    const falseShortBreak =
      lastClose < ema9 && prevClose >= ema9Prev &&  // cruzou EMA para baixo
      rsi2 < 20;                                    // mas RSI(2) já no fundo (exausto)

    if (falseLongBreak || falseShortBreak) {
      logger.info({ symbol, rsi2, falseLongBreak, falseShortBreak }, "TankWar: falso rompimento ignorado");
      return;
    }

    // ── Determinar direção ────────────────────────────────────────────────────
    let direction: Direction | null = null;

    const longOk =
      price > vwap   &&   // LONG acima da VWAP
      conf100         &&   // Confirmação 100%
      rsi2 < RSI2_LONG;   // RSI(2) < 5 — extremo de sobrevenda

    const shortOk =
      price < vwap    &&   // SHORT abaixo da VWAP
      conf100          &&   // Confirmação 100%
      rsi2 > RSI2_SHORT;   // RSI(2) > 95 — extremo de sobrecompra

    if (longOk) direction = "LONG";
    else if (shortOk) direction = "SHORT";

    // ── Protocolo 2ª Vela ─────────────────────────────────────────────────────
    const breakout = breakoutMap.get(symbol);

    if (direction && !breakout) {
      const triggerClose = closed.at(-1)!.openTime;
      breakoutMap.set(symbol, {
        symbol, direction,
        triggerClose,
        price, vwap, rsi2,
        detectedAt: Date.now(),
      });
      logger.info({ symbol, direction, rsi2, price, vwap }, "TankWar: 1ª vela detectada — aguardando 2ª vela");
      return;
    }

    if (breakout) {
      const currentCandleTime = partial.openTime;
      const isNewCandle = currentCandleTime > breakout.triggerClose;
      const tooOld      = Date.now() - breakout.detectedAt > 10 * 60 * 1000; // 10min max

      if (tooOld) {
        breakoutMap.delete(symbol);
        logger.info({ symbol }, "TankWar: breakout expirado — descartado");
        return;
      }

      if (!isNewCandle) return;

      // ── 2ª Vela: validar Volume Delta > 53% ─────────────────────────────
      const delta = volumeDelta(candles, breakout.direction);

      if (delta > DELTA_THRESHOLD) {
        breakoutMap.delete(symbol);
        const entry = partial.close;
        await startEscort(symbol, breakout.direction, entry, delta);
      } else {
        breakoutMap.delete(symbol);
        logger.info({ symbol, delta }, "TankWar: 2ª vela sem delta suficiente — sinal descartado");
      }
    }
  } catch (err: any) {
    logger.warn({ symbol, err: err.message }, "TankWar: scanCoin error");
  }
}

async function runScan(): Promise<void> {
  resetDayIfNeeded();
  for (const symbol of TANK_SYMBOLS) {
    await scanTankWar(symbol);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
export function startTankWarScanner(): void {
  if (scanTimer) return;
  scanTimer = setInterval(() => runScan(), SCAN_INTERVAL_MS);
  runScan();
  logger.info(
    { symbols: TANK_SYMBOLS, intervalMs: SCAN_INTERVAL_MS, leverage: LEVERAGE, banca: BANCA },
    "TankWar: TANQUE DE GUERRA scanner iniciado",
  );
}

export function getTankWarStatus() {
  return {
    autoEnabled: tankWarConfig.autoEnabled,
    symbols:     TANK_SYMBOLS,
    leverage:    LEVERAGE,
    banca:       tankWarConfig.banca,
    targetUsd:   calcTargetUsd(tankWarConfig.banca),
    activeEscorts: [...escortMap.values()].map(e => ({
      symbol:         e.symbol,
      direction:      e.direction,
      entry:          e.entry,
      sl:             e.sl,
      tp:             e.tp,
      breakevenMoved: e.breakevenMoved,
      startedAt:      e.startedAt,
      delta:          e.delta,
      targetUsd:      e.targetUsd,
    })),
    pendingBreakouts: [...breakoutMap.values()].map(b => ({
      symbol:     b.symbol,
      direction:  b.direction,
      rsi2:       b.rsi2,
      detectedAt: b.detectedAt,
    })),
    dayStats: { ...dayStats },
  };
}
