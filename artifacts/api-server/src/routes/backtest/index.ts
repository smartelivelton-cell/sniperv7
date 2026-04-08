import { Router } from "express";
import { calculateEMA, calculateATR, calculateRSI, type Candle } from "../../lib/indicators";
import { setLowAssertivityHours } from "../../lib/backtestState";
import { logger } from "../../lib/logger";

const router = Router();

const OKX_BASE     = "https://www.okx.com/api/v5";
const BAR          = "4H";
const WARMUP       = 210;
const DAYS_BACK    = 365;
const CANDLES_NEED = Math.ceil(DAYS_BACK * 24 / 4) + WARMUP; // ~2400
const TZ           = "America/Sao_Paulo";
const CACHE_TTL    = 4 * 60 * 60 * 1000; // 4 h

export interface HourStat {
  wins: number;
  losses: number;
  winRate: number;
  signals: number;
}

export interface BacktestResult {
  symbol: string;
  bar: string;
  totalSignals: number;
  wins: number;
  losses: number;
  skipped: number;
  winRate: number;
  accumulatedProfitPct: number;
  avgRR: number;
  hourStats: Record<number, HourStat>;
  lowAssertivityHours: number[];
  lastUpdated: string;
  dataPoints: number;
  daysAnalyzed: number;
}

const cache = new Map<string, { result: BacktestResult; ts: number }>();

// ── OKX paginated fetch ────────────────────────────────────────────────────────
async function fetchHistoricalCandles(instId: string, needed: number): Promise<Candle[]> {
  const allRaw: Candle[] = [];
  let after: string | undefined;
  let useHistory = false;

  for (let page = 0; page < 14 && allRaw.length < needed; page++) {
    const params = new URLSearchParams({ instId, bar: BAR, limit: "300" });
    if (after) params.set("after", after);

    const url = useHistory
      ? `${OKX_BASE}/market/history-candles?${params}`
      : `${OKX_BASE}/market/candles?${params}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`OKX HTTP ${res.status}`);

    const json = await res.json() as { code: string; data: string[][] };
    if (json.code !== "0" || !json.data?.length) break;

    // OKX returns newest first; reverse for chronological
    const batch: Candle[] = [...json.data].reverse().map(k => ({
      openTime: parseInt(k[0]),
      open:     parseFloat(k[1]),
      high:     parseFloat(k[2]),
      low:      parseFloat(k[3]),
      close:    parseFloat(k[4]),
      volume:   parseFloat(k[5]),
    }));

    allRaw.unshift(...batch);
    after = json.data[json.data.length - 1][0]; // oldest timestamp for next page
    useHistory = true;

    if (batch.length < 300) break;
    await new Promise(r => setTimeout(r, 200));
  }

  return allRaw.sort((a, b) => a.openTime - b.openTime);
}

// ── Hour in Brasília ───────────────────────────────────────────────────────────
function hourBR(ts: number): number {
  return parseInt(
    new Date(ts).toLocaleString("pt-BR", { timeZone: TZ, hour: "numeric", hour12: false }),
    10,
  );
}

// ── Run Surfe 200 backtest ─────────────────────────────────────────────────────
async function runBacktest(symbol: string): Promise<BacktestResult> {
  const instId  = `${symbol}-USDT-SWAP`;
  const candles = await fetchHistoricalCandles(instId, CANDLES_NEED);

  if (candles.length < WARMUP + 30) {
    throw new Error(`Dados insuficientes: apenas ${candles.length} velas recebidas`);
  }

  // Trim to DAYS_BACK window (keep WARMUP candles before analysis start)
  const cutoff     = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;
  const firstIdx   = candles.findIndex(c => c.openTime >= cutoff);
  const warmupIdx  = Math.max(0, firstIdx - WARMUP);
  const dataset    = candles.slice(warmupIdx);

  const closes  = dataset.map(c => c.close);
  const ema200  = calculateEMA(closes, 200);
  const ema21   = calculateEMA(closes, 21);

  const hourRaw: Record<number, { wins: number; losses: number }> = {};
  let wins = 0, losses = 0, skipped = 0;
  let accumulatedProfitPct = 0;
  let totalSLpct = 0;

  const startIdx = Math.max(WARMUP, firstIdx - warmupIdx);

  for (let i = startIdx; i < dataset.length - 6; i++) {
    const candle     = dataset[i];
    const prevCandle = dataset[i - 1];
    const price      = candle.close;
    const prevClose  = prevCandle.close;
    const curr200    = ema200[i];
    const prev200    = ema200[i - 1];
    const curr21     = ema21[i];

    if (!curr200 || !prev200 || !curr21) continue;

    const crossedAbove = prevClose < prev200 && price > curr200;
    const crossedBelow = prevClose > prev200 && price < curr200;
    if (!crossedAbove && !crossedBelow) continue;

    // Volume filter: must be ≥ 1.8× 10-candle average (relaxed from M15 2× for H4)
    const volSlice = dataset.slice(Math.max(0, i - 10), i);
    const avgVol   = volSlice.reduce((s, c) => s + c.volume, 0) / Math.max(1, volSlice.length);
    if (candle.volume < avgVol * 1.8) { skipped++; continue; }

    // H4 trend: price must agree with both EMA200 and EMA21
    const h4Trend =
      price > curr200 && price > curr21 ? "BULL" :
      price < curr200 && price < curr21 ? "BEAR" : "NEUTRAL";
    if (h4Trend === "NEUTRAL") { skipped++; continue; }
    if (crossedAbove && h4Trend !== "BULL") { skipped++; continue; }
    if (crossedBelow && h4Trend !== "BEAR") { skipped++; continue; }

    const direction = crossedAbove ? "LONG" : "SHORT";
    const entry     = price;
    const atr       = calculateATR(dataset.slice(Math.max(0, i - 14), i + 1), 14);
    const slDist    = (atr / entry) * 1.2;
    const sl        = direction === "LONG" ? entry * (1 - slDist) : entry * (1 + slDist);
    const tp        = direction === "LONG" ? entry * 1.01         : entry * 0.99;

    // Forward-look: max 40 H4 candles (~6.7 days)
    let outcome: "win" | "loss" | null = null;
    for (let j = i + 1; j < Math.min(i + 40, dataset.length); j++) {
      const f = dataset[j];
      if (direction === "LONG") {
        if (f.high >= tp) { outcome = "win";  break; }
        if (f.low  <= sl) { outcome = "loss"; break; }
      } else {
        if (f.low  <= tp) { outcome = "win";  break; }
        if (f.high >= sl) { outcome = "loss"; break; }
      }
    }
    if (!outcome) { skipped++; continue; }

    const hr = hourBR(candle.openTime);
    if (!hourRaw[hr]) hourRaw[hr] = { wins: 0, losses: 0 };

    if (outcome === "win") {
      wins++;
      hourRaw[hr].wins++;
      accumulatedProfitPct += 1.0;
    } else {
      losses++;
      hourRaw[hr].losses++;
      accumulatedProfitPct -= slDist * 100;
      totalSLpct += slDist * 100;
    }
  }

  const totalSignals = wins + losses;
  const winRate      = totalSignals > 0 ? (wins / totalSignals) * 100 : 0;
  const avgSL        = losses > 0 ? totalSLpct / losses : 1.5;
  const avgRR        = avgSL > 0 ? parseFloat((1.0 / avgSL).toFixed(2)) : 0.67;

  // Hour stats
  const hourStats: Record<number, HourStat> = {};
  for (const [h, { wins: w, losses: l }] of Object.entries(hourRaw)) {
    const total = w + l;
    hourStats[parseInt(h)] = {
      wins: w, losses: l, signals: total,
      winRate: total > 0 ? Math.round((w / total) * 1000) / 10 : 0,
    };
  }

  // Low assertivity: <50% WR and ≥ 3 signals
  const lowAssertivityHours = Object.entries(hourStats)
    .filter(([, s]) => s.signals >= 3 && s.winRate < 50)
    .map(([h]) => parseInt(h));

  const daysAnalyzed = Math.round(
    (dataset[dataset.length - 1].openTime - dataset[startIdx]?.openTime) /
    (24 * 60 * 60 * 1000),
  );

  return {
    symbol,
    bar: BAR,
    totalSignals,
    wins,
    losses,
    skipped,
    winRate:               Math.round(winRate * 10) / 10,
    accumulatedProfitPct:  Math.round(accumulatedProfitPct * 10) / 10,
    avgRR,
    hourStats,
    lowAssertivityHours,
    lastUpdated: new Date().toLocaleString("pt-BR", { timeZone: TZ }),
    dataPoints:  candles.length,
    daysAnalyzed,
  };
}

// ── Route handler ──────────────────────────────────────────────────────────────
router.get("/surfe200", async (req, res) => {
  const symbol = (typeof req.query.symbol === "string" ? req.query.symbol : "BTC").toUpperCase();
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ ok: true, data: cached.result, cached: true });
  }

  try {
    const result = await runBacktest(symbol);
    cache.set(symbol, { result, ts: Date.now() });
    setLowAssertivityHours(symbol, result.lowAssertivityHours);
    logger.info({ symbol, winRate: result.winRate, signals: result.totalSignals }, "Backtest completed");
    return res.json({ ok: true, data: result, cached: false });
  } catch (err: any) {
    logger.error({ err: err.message }, "Backtest failed");
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Sun Tzu Backtest (H4, 365 days) ───────────────────────────────────────────
// Entry: EMA200 cross + RSI(6) > 60 (LONG) / < 40 (SHORT) + Volume > 1.5x avg
// TP = +1% from entry, SL = ATR*1.2
async function runSunTzuBacktest(symbol: string): Promise<BacktestResult> {
  const instId  = `${symbol}-USDT-SWAP`;
  const candles = await fetchHistoricalCandles(instId, CANDLES_NEED);

  if (candles.length < WARMUP + 30) {
    throw new Error(`Dados insuficientes: ${candles.length} velas`);
  }

  const cutoff    = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;
  const firstIdx  = candles.findIndex(c => c.openTime >= cutoff);
  const warmupIdx = Math.max(0, firstIdx - WARMUP);
  const dataset   = candles.slice(warmupIdx);

  const closes = dataset.map(c => c.close);
  const ema200 = calculateEMA(closes, 200);
  const ema9   = calculateEMA(closes, 9);
  const ema21  = calculateEMA(closes, 21);
  // RSI on the full closes array
  const rsi6   = calculateRSI(closes, 6);

  const hourRaw: Record<number, { wins: number; losses: number }> = {};
  let wins = 0, losses = 0, skipped = 0;
  let accumulatedProfitPct = 0, totalSLpct = 0;

  const startIdx = Math.max(WARMUP, firstIdx - warmupIdx);

  for (let i = startIdx; i < dataset.length - 6; i++) {
    const candle     = dataset[i];
    const prevCandle = dataset[i - 1];
    const price      = candle.close;
    const prevClose  = prevCandle.close;
    const curr200    = ema200[i];
    const prev200    = ema200[i - 1];
    const currEma9   = ema9[i];
    const currEma21  = ema21[i];
    const currRsi    = rsi6[i] ?? 50;

    if (!curr200 || !prev200 || !currEma9 || !currEma21) continue;

    const crossedAbove = prevClose < prev200 && price > curr200;
    const crossedBelow = prevClose > prev200 && price < curr200;
    if (!crossedAbove && !crossedBelow) continue;

    // Sun Tzu entry filter: RSI > 60 for LONG, < 40 for SHORT
    if (crossedAbove && currRsi <= 60) { skipped++; continue; }
    if (crossedBelow && currRsi >= 40) { skipped++; continue; }

    // Volume filter: must be ≥ 1.5× 10-candle average
    const volSlice = dataset.slice(Math.max(0, i - 10), i);
    const avgVol   = volSlice.reduce((s, c) => s + c.volume, 0) / Math.max(1, volSlice.length);
    if (candle.volume < avgVol * 1.5) { skipped++; continue; }

    // EMA9 must agree with direction
    if (crossedAbove && currEma9 <= currEma21) { skipped++; continue; }
    if (crossedBelow && currEma9 >= currEma21) { skipped++; continue; }

    const direction = crossedAbove ? "LONG" : "SHORT";
    const entry     = price;
    const atr       = calculateATR(dataset.slice(Math.max(0, i - 14), i + 1), 14);
    const slDist    = Math.max((atr / entry) * 1.2, 0.003);
    const sl        = direction === "LONG" ? entry * (1 - slDist) : entry * (1 + slDist);
    const tp        = direction === "LONG" ? entry * 1.01         : entry * 0.99;

    let outcome: "win" | "loss" | null = null;
    for (let j = i + 1; j < Math.min(i + 40, dataset.length); j++) {
      const f = dataset[j];
      if (direction === "LONG") {
        if (f.high >= tp) { outcome = "win";  break; }
        if (f.low  <= sl) { outcome = "loss"; break; }
      } else {
        if (f.low  <= tp) { outcome = "win";  break; }
        if (f.high >= sl) { outcome = "loss"; break; }
      }
    }
    if (!outcome) { skipped++; continue; }

    const hr = hourBR(candle.openTime);
    if (!hourRaw[hr]) hourRaw[hr] = { wins: 0, losses: 0 };

    if (outcome === "win") {
      wins++; hourRaw[hr].wins++;
      accumulatedProfitPct += 1.0;
    } else {
      losses++; hourRaw[hr].losses++;
      accumulatedProfitPct -= slDist * 100;
      totalSLpct += slDist * 100;
    }
  }

  const totalSignals = wins + losses;
  const winRate      = totalSignals > 0 ? (wins / totalSignals) * 100 : 0;
  const avgSL        = losses > 0 ? totalSLpct / losses : 1.5;
  const avgRR        = avgSL > 0 ? parseFloat((1.0 / avgSL).toFixed(2)) : 0.67;

  const hourStats: Record<number, HourStat> = {};
  for (const [h, { wins: w, losses: l }] of Object.entries(hourRaw)) {
    const total = w + l;
    hourStats[parseInt(h)] = {
      wins: w, losses: l, signals: total,
      winRate: total > 0 ? Math.round((w / total) * 1000) / 10 : 0,
    };
  }

  const lowAssertivityHours = Object.entries(hourStats)
    .filter(([, s]) => s.signals >= 3 && s.winRate < 50)
    .map(([h]) => parseInt(h));

  const daysAnalyzed = Math.round(
    (dataset[dataset.length - 1].openTime - dataset[startIdx]?.openTime) /
    (24 * 60 * 60 * 1000),
  );

  return {
    symbol, bar: BAR, totalSignals, wins, losses, skipped,
    winRate:              Math.round(winRate * 10) / 10,
    accumulatedProfitPct: Math.round(accumulatedProfitPct * 10) / 10,
    avgRR, hourStats, lowAssertivityHours,
    lastUpdated: new Date().toLocaleString("pt-BR", { timeZone: TZ }),
    dataPoints:  candles.length,
    daysAnalyzed,
  };
}

const sunTzuCache = new Map<string, { result: BacktestResult; ts: number }>();

router.get("/suntzu", async (req, res) => {
  const symbol = (typeof req.query.symbol === "string" ? req.query.symbol : "BTC").toUpperCase();
  const cached = sunTzuCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ ok: true, data: cached.result, cached: true });
  }
  try {
    const result = await runSunTzuBacktest(symbol);
    sunTzuCache.set(symbol, { result, ts: Date.now() });
    logger.info({ symbol, winRate: result.winRate, signals: result.totalSignals }, "SunTzu backtest completed");
    return res.json({ ok: true, data: result, cached: false });
  } catch (err: any) {
    logger.error({ err: err.message }, "SunTzu backtest failed");
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Warrior M15 Backtest (90 dias) ────────────────────────────────────────────
// Lógica: EMA200 lado + RSI(2) < 10 (LONG) ou > 90 (SHORT)
// TP = +0.60%, SL = 0.30% — parâmetros exatos do Warrior ao vivo
const W_BAR    = "15m";
const W_DAYS   = 90;
const W_WARMUP = 205;
const W_TP     = 0.006;
const W_SL     = 0.003;

async function fetchM15Candles(instId: string): Promise<Candle[]> {
  const needed = W_DAYS * 96 + W_WARMUP; // ~8845
  const allRaw: Candle[] = [];
  let after: string | undefined;
  let useHistory = false;

  for (let page = 0; page < 32 && allRaw.length < needed; page++) {
    const params = new URLSearchParams({ instId, bar: W_BAR, limit: "300" });
    if (after) params.set("after", after);
    const url = useHistory
      ? `${OKX_BASE}/market/history-candles?${params}`
      : `${OKX_BASE}/market/candles?${params}`;
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`OKX HTTP ${res.status} for ${instId} M15`);
    const json = await res.json() as { code: string; data: string[][] };
    if (json.code !== "0" || !json.data?.length) break;
    const batch: Candle[] = [...json.data].reverse().map(k => ({
      openTime: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    allRaw.unshift(...batch);
    after = json.data[json.data.length - 1][0];
    useHistory = true;
    if (batch.length < 300) break;
    await new Promise(r => setTimeout(r, 250));
  }
  return allRaw.sort((a, b) => a.openTime - b.openTime);
}

async function runWarriorBacktest(symbol: string): Promise<BacktestResult> {
  const instId  = `${symbol}-USDT-SWAP`;
  const candles = await fetchM15Candles(instId);
  if (candles.length < W_WARMUP + 50) throw new Error(`Dados insuficientes: ${candles.length} velas M15`);

  const cutoff    = Date.now() - W_DAYS * 24 * 60 * 60 * 1000;
  const firstIdx  = candles.findIndex(c => c.openTime >= cutoff);
  const warmupIdx = Math.max(0, firstIdx - W_WARMUP);
  const dataset   = candles.slice(warmupIdx);

  const closes = dataset.map(c => c.close);
  const ema200 = calculateEMA(closes, 200);
  const rsi2   = calculateRSI(closes, 2);

  const hourRaw: Record<number, { wins: number; losses: number }> = {};
  let wins = 0, losses = 0, skipped = 0, accumulatedProfitPct = 0;
  const startIdx = Math.max(W_WARMUP, firstIdx - warmupIdx);
  let lastEntry = -999;

  for (let i = startIdx; i < dataset.length - 12; i++) {
    if (i - lastEntry < 4) continue; // cooldown de 4 velas entre entradas
    const price = dataset[i].close;
    const e200  = ema200[i];
    const rsi   = rsi2[i];
    if (!e200 || rsi === undefined || rsi === null) continue;

    let direction: "LONG" | "SHORT" | null = null;
    if (rsi < 10 && price > e200)       direction = "LONG";
    else if (rsi > 90 && price < e200)  direction = "SHORT";
    if (!direction) continue;

    const entry = price;
    const tp = direction === "LONG" ? entry * (1 + W_TP) : entry * (1 - W_TP);
    const sl = direction === "LONG" ? entry * (1 - W_SL) : entry * (1 + W_SL);

    let outcome: "win" | "loss" | null = null;
    for (let j = i + 1; j <= Math.min(i + 16, dataset.length - 1); j++) {
      const f = dataset[j];
      if (direction === "LONG") {
        if (f.high >= tp) { outcome = "win";  break; }
        if (f.low  <= sl) { outcome = "loss"; break; }
      } else {
        if (f.low  <= tp) { outcome = "win";  break; }
        if (f.high >= sl) { outcome = "loss"; break; }
      }
    }
    if (!outcome) { skipped++; continue; }

    lastEntry = i;
    const hr = hourBR(dataset[i].openTime);
    if (!hourRaw[hr]) hourRaw[hr] = { wins: 0, losses: 0 };
    if (outcome === "win") {
      wins++; hourRaw[hr].wins++;
      accumulatedProfitPct += W_TP * 100;
    } else {
      losses++; hourRaw[hr].losses++;
      accumulatedProfitPct -= W_SL * 100;
    }
  }

  const totalSignals = wins + losses;
  const winRate      = totalSignals > 0 ? (wins / totalSignals) * 100 : 0;

  const hourStats: Record<number, HourStat> = {};
  for (const [h, { wins: w, losses: l }] of Object.entries(hourRaw)) {
    const total = w + l;
    hourStats[parseInt(h)] = { wins: w, losses: l, signals: total,
      winRate: total > 0 ? Math.round((w / total) * 1000) / 10 : 0 };
  }
  const lowAssertivityHours = Object.entries(hourStats)
    .filter(([, s]) => s.signals >= 3 && s.winRate < 50)
    .map(([h]) => parseInt(h));
  const daysAnalyzed = Math.round(
    (dataset[dataset.length - 1].openTime - dataset[startIdx]?.openTime) / (24 * 60 * 60 * 1000),
  );

  return {
    symbol, bar: W_BAR, totalSignals, wins, losses, skipped,
    winRate:              Math.round(winRate * 10) / 10,
    accumulatedProfitPct: Math.round(accumulatedProfitPct * 10) / 10,
    avgRR:                W_TP / W_SL,
    hourStats, lowAssertivityHours,
    lastUpdated: new Date().toLocaleString("pt-BR", { timeZone: TZ }),
    dataPoints: candles.length, daysAnalyzed,
  };
}

const warriorBtCache = new Map<string, { result: BacktestResult; ts: number }>();

router.get("/warrior", async (req, res) => {
  const symbol = (typeof req.query.symbol === "string" ? req.query.symbol : "BTC").toUpperCase();
  const cached = warriorBtCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ ok: true, data: cached.result, cached: true });
  }
  try {
    const result = await runWarriorBacktest(symbol);
    warriorBtCache.set(symbol, { result, ts: Date.now() });
    logger.info({ symbol, winRate: result.winRate, signals: result.totalSignals, days: result.daysAnalyzed }, "Warrior backtest completed");
    return res.json({ ok: true, data: result, cached: false });
  } catch (err: any) {
    logger.error({ err: err.message }, "Warrior backtest failed");
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Background warm-up: run BTC on server start ────────────────────────────────
export function warmUpBacktest(): void {
  const SYMBOLS = ["BTC", "ETH", "SOL"];
  let idx = 0;

  const next = () => {
    if (idx >= SYMBOLS.length) return;
    const sym = SYMBOLS[idx++];
    runBacktest(sym)
      .then(result => {
        cache.set(sym, { result, ts: Date.now() });
        setLowAssertivityHours(sym, result.lowAssertivityHours);
        logger.info(
          { symbol: sym, winRate: result.winRate, signals: result.totalSignals, lowHours: result.lowAssertivityHours },
          "Backtest warm-up done",
        );
        // stagger: 30 s between symbols to avoid OKX rate-limit
        setTimeout(next, 30_000);
      })
      .catch(err => {
        logger.warn({ symbol: sym, err: err.message }, "Backtest warm-up failed");
        setTimeout(next, 30_000);
      });
  };

  // First run 10 s after server start
  setTimeout(next, 10_000);
}

export default router;
