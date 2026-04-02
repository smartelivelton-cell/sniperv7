export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SARPoint {
  sar: number;
  isLong: boolean;
}

export function calculateEMA(prices: number[], period: number): number[] {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    result.push(prices[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

export function calculateATR(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const last = trs.slice(-period);
  return last.reduce((a, b) => a + b, 0) / last.length;
}

export function calculateRSI(prices: number[], period = 14): number[] {
  if (prices.length < period + 1) return prices.map(() => 50);
  const result: number[] = new Array(period).fill(50);
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const delta = prices[i] - prices[i - 1];
    avgGain += Math.max(0, delta);
    avgLoss += Math.max(0, -delta);
  }
  avgGain /= period;
  avgLoss /= period;

  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(100 - 100 / (1 + rs0));

  for (let i = period + 1; i < prices.length; i++) {
    const delta = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, delta)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -delta)) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));
  }
  return result;
}

export function calculateParabolicSAR(
  candles: Candle[],
  afStep = 0.02,
  maxAf = 0.2,
): SARPoint[] {
  if (candles.length < 3) return candles.map(() => ({ sar: 0, isLong: true }));

  let isLong = candles[1].close >= candles[0].close;
  let af = afStep;
  let sar = isLong
    ? Math.min(candles[0].low, candles[1].low)
    : Math.max(candles[0].high, candles[1].high);
  let ep = isLong ? candles[0].high : candles[0].low;

  const result: SARPoint[] = [{ sar, isLong }, { sar, isLong }];

  for (let i = 2; i < candles.length; i++) {
    const prevSar = sar;
    sar = prevSar + af * (ep - prevSar);

    if (isLong) {
      sar = Math.min(sar, candles[i - 1].low, candles[i - 2].low);
      if (candles[i].low < sar) {
        isLong = false; sar = ep; ep = candles[i].low; af = afStep;
      } else if (candles[i].high > ep) {
        ep = candles[i].high;
        af = Math.min(af + afStep, maxAf);
      }
    } else {
      sar = Math.max(sar, candles[i - 1].high, candles[i - 2].high);
      if (candles[i].high > sar) {
        isLong = true; sar = ep; ep = candles[i].high; af = afStep;
      } else if (candles[i].low < ep) {
        ep = candles[i].low;
        af = Math.min(af + afStep, maxAf);
      }
    }
    result.push({ sar, isLong });
  }
  return result;
}

export function calculateAvgVolume(candles: Candle[], period = 20): number {
  const slice = candles.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, c) => sum + c.volume, 0) / slice.length;
}

export function computeTrend(
  closes: number[],
  emaPeriod: number,
): "BULL" | "BEAR" | "NEUTRAL" {
  if (closes.length < emaPeriod) return "NEUTRAL";
  const ema  = calculateEMA(closes, emaPeriod);
  const last = closes.length - 1;
  const price = closes[last];
  const val   = ema[last];
  if (!val || val === 0) return "NEUTRAL";
  const diff = (price - val) / val;
  return diff > 0.001 ? "BULL" : diff < -0.001 ? "BEAR" : "NEUTRAL";
}

export function calcSlTp(
  entry: number,
  direction: "LONG" | "SHORT",
  atr: number,
): { sl: number; tp1: number; tp2: number; tp3: number } {
  const slDist = Math.max(atr * 1.2, entry * 0.003);
  if (direction === "LONG") {
    return { sl: entry - slDist, tp1: entry + slDist, tp2: entry + slDist * 2, tp3: entry + slDist * 3 };
  }
  return { sl: entry + slDist, tp1: entry - slDist, tp2: entry - slDist * 2, tp3: entry - slDist * 3 };
}
