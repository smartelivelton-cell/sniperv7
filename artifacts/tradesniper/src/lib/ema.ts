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

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function parseBinanceKlines(raw: any[][]): Candle[] {
  return raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

export function parseOKXCandles(raw: any[]): Candle[] {
  return raw.map((k) => ({
    openTime: typeof k.openTime === "number" ? k.openTime : parseInt(k.openTime),
    open: typeof k.open === "number" ? k.open : parseFloat(k.open),
    high: typeof k.high === "number" ? k.high : parseFloat(k.high),
    low: typeof k.low === "number" ? k.low : parseFloat(k.low),
    close: typeof k.close === "number" ? k.close : parseFloat(k.close),
    volume: typeof k.volume === "number" ? k.volume : parseFloat(k.volume),
  }));
}

export function calcSlTp(entry: number, direction: 'LONG' | 'SHORT', atr: number) {
  const slDist = Math.max(atr * 1.2, entry * 0.003);
  const tpDist = slDist * 2;
  if (direction === 'LONG') {
    return { sl: entry - slDist, tp: entry + tpDist };
  }
  return { sl: entry + slDist, tp: entry - tpDist };
}
