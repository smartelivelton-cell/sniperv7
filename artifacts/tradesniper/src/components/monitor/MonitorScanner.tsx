import { useState, useEffect, useRef, useCallback } from 'react';
import { GlassCard } from '../ui/PremiumComponents';
import { cn } from '@/lib/utils';
import {
  calculateEMA,
  calculateATR,
  calculateRSI,
  calculateParabolicSAR,
  calculateAvgVolume,
  parseOKXCandles,
  calcSlTp,
  type Candle,
} from '@/lib/ema';

const MONITOR_SYMBOLS = ['BTC', 'ETH', 'SOL', 'DOGE', 'AXS', 'AVAX'];
const SCAN_INTERVAL_MS = 30_000;
const COOLDOWN_MS = 2 * 60 * 1000;
const RADAR_INTERVAL_MS = 4 * 60 * 60 * 1000;

// Cache to reduce OKX API calls for slow-moving timeframes
const klinesCache = new Map<string, { candles: Candle[]; ts: number }>();
const CACHE_TTL: Record<string, number> = {
  '5m':  30_000,
  '15m': 30_000,
  '1H':  5 * 60_000,
  '4H':  60 * 60_000,
  '1D':  60 * 60_000,
};

interface MultiTrend {
  d1:  'BULL' | 'BEAR' | 'NEUTRAL';
  h4:  'BULL' | 'BEAR' | 'NEUTRAL';
  h1:  'BULL' | 'BEAR' | 'NEUTRAL';
  m15: 'BULL' | 'BEAR' | 'NEUTRAL';
  m5:  'BULL' | 'BEAR' | 'NEUTRAL';
}

interface SignalAlert {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  price: number;
  ema21: number;
  avgEntry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  strategy: string;
  strategies: string[];
  leverage: number;
  rsi6: number;
  h4Trend: 'BULL' | 'BEAR' | 'NEUTRAL';
  multiTrend: MultiTrend;
  confluenceCount: number;
  isHighProbability: boolean;
  reason: string;
  ts: number;
}

interface ActiveSignalState {
  signal: SignalAlert;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
}

interface InversionAlert {
  id: string;
  symbol: string;
  from: 'LONG' | 'SHORT';
  to: 'LONG' | 'SHORT';
  price: number;
  reason: string;
  ts: number;
}

interface MentoringMessage {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  price: number;
  text: string;
  ts: number;
}

interface CoinState {
  symbol: string;
  price: number;
  ema9: number;
  ema21: number;
  ema200: number;
  trend: 'BULL' | 'BEAR' | 'NEUTRAL';
  h4Trend: 'BULL' | 'BEAR' | 'NEUTRAL';
  rsi6: number;
  sarIsLong: boolean;
  multiTrend: MultiTrend;
  confluenceCount: number;
  loading: boolean;
  error: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeTrend(closes: number[], emaPeriod: number): 'BULL' | 'BEAR' | 'NEUTRAL' {
  if (closes.length < emaPeriod) return 'NEUTRAL';
  const ema = calculateEMA(closes, emaPeriod);
  const last = closes.length - 1;
  const price = closes[last];
  const val = ema[last];
  if (!val || val === 0) return 'NEUTRAL';
  const diff = (price - val) / val;
  return diff > 0.001 ? 'BULL' : diff < -0.001 ? 'BEAR' : 'NEUTRAL';
}

function confluenceScore(mt: MultiTrend, direction: 'LONG' | 'SHORT'): number {
  const check = direction === 'LONG' ? 'BULL' : 'BEAR';
  return [mt.d1, mt.h4, mt.h1, mt.m15, mt.m5].filter(t => t === check).length;
}

function playBeep(direction: 'LONG' | 'SHORT', isMaster = false, isHighProb = false) {
  try {
    const ctx = new AudioContext();
    const count = isHighProb ? 5 : isMaster ? 4 : direction === 'LONG' ? 2 : 3;
    const freq  = isHighProb ? 1400 : isMaster ? 1200 : direction === 'LONG' ? 880 : 440;
    for (let i = 0; i < count; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq; osc.type = 'sine';
      const t = ctx.currentTime + i * 0.2;
      gain.gain.setValueAtTime(0.4, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      osc.start(t); osc.stop(t + 0.18);
    }
  } catch (_) {}
}

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';

async function fetchKlines(symbol: string, interval: string, limit = 300): Promise<Candle[]> {
  const key = `${symbol}-${interval}`;
  const ttl = CACHE_TTL[interval] ?? 30_000;
  const cached = klinesCache.get(key);
  if (cached && Date.now() - cached.ts < ttl) return cached.candles;

  const instId = `${symbol}-USDT-SWAP`;
  const url = `${BASE}/api/monitor/klines?symbol=${instId}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  const candles = parseOKXCandles(raw);
  klinesCache.set(key, { candles, ts: Date.now() });
  return candles;
}

// ── Telegram API calls — desativadas no browser (servidor envia 24/7) ──────────
// O scanner server-side é responsável por todos os alertas do Telegram.
// As funções abaixo são mantidas apenas para compatibilidade com o display local.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function sendTelegramAlert(_signal: SignalAlert) {}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function sendWinAlert(_signal: SignalAlert, _tpLevel: 1 | 2 | 3) {}
async function sendActivationMessage() {}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function sendRetainedAlert(_symbol: string, _direction: string, _price: number, _strategies: string[]) {}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function sendCalmMessage(_signal: SignalAlert, _currentPrice: number) {}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function sendAnticipationAlert(
  _symbol: string, _side: 'LONG' | 'SHORT', _strategy: string,
  _price: number, _reason: string, _confluenceCount: number,
) {}

// ── Strategy emoji map ────────────────────────────────────────────────────────

const strategyEmoji: Record<string, string> = {
  'Muralha 200': '🏰',
  'Muralha Buffer': '🏰',
  'Surfe 200': '🌊',
  'Onda SAR': '📡',
  'Fibonacci 50%': '📐',
  'Exaustão Sniper': '🎯',
  'Fênix Reversão': '🔥',
  'SINAL MESTRE': '🚀',
};

const tfKeys: (keyof MultiTrend)[] = ['d1', 'h4', 'h1', 'm15', 'm5'];
const tfDot = (t: string) => t === 'BULL' ? '🟢' : t === 'BEAR' ? '🔴' : '🟡';
const tfDotCss = (t: string) =>
  t === 'BULL' ? 'bg-green-900/50 text-green-400' :
  t === 'BEAR' ? 'bg-red-900/50 text-red-400' :
  'bg-white/5 text-muted-foreground';

// ── Component ─────────────────────────────────────────────────────────────────

export function MonitorScanner() {
  const [coins, setCoins] = useState<Record<string, CoinState>>(() => {
    const init: Record<string, CoinState> = {};
    for (const s of MONITOR_SYMBOLS) {
      init[s] = {
        symbol: s, price: 0, ema9: 0, ema21: 0, ema200: 0,
        trend: 'NEUTRAL', h4Trend: 'NEUTRAL', rsi6: 50,
        sarIsLong: true,
        multiTrend: { d1: 'NEUTRAL', h4: 'NEUTRAL', h1: 'NEUTRAL', m15: 'NEUTRAL', m5: 'NEUTRAL' },
        confluenceCount: 0,
        loading: true, error: false,
      };
    }
    return init;
  });

  const [alerts, setAlerts] = useState<SignalAlert[]>([]);
  const [activeAlert, setActiveAlert] = useState<SignalAlert | null>(null);
  const [lastScan, setLastScan] = useState<Date | null>(null);
  const [nextScanIn, setNextScanIn] = useState(0);
  const [inversionAlerts, setInversionAlerts] = useState<InversionAlert[]>([]);
  const [mentoringMessages, setMentoringMessages] = useState<MentoringMessage[]>([]);
  const [dismissedMessages, setDismissedMessages] = useState<Set<string>>(new Set());
  const prevEma200Ref = useRef<Map<string, number>>(new Map());

  const seenIds              = useRef<Set<string>>(new Set());
  const cooldownMap          = useRef<Map<string, number>>(new Map());
  const activeSignalsRef     = useRef<Map<string, ActiveSignalState>>(new Map());
  const anticipationCooldown = useRef<Map<string, number>>(new Map());
  const calmSentRef     = useRef<Set<string>>(new Set());
  const coinsRef        = useRef<Record<string, CoinState>>({});
  const btcTrendRef     = useRef<'BULL' | 'BEAR' | 'NEUTRAL'>('NEUTRAL');
  const prevM5RsiRef    = useRef<Map<string, number>>(new Map());
  const intervalRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const radarRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const activatedRef    = useRef(false);

  const scanCoin = useCallback(async (symbol: string) => {
    try {
      // ── Fetch all 5 timeframes in parallel ──────────────────────────────────
      const [candles5m, candles15m, candlesH1, candlesH4, candlesD1] = await Promise.all([
        fetchKlines(symbol, '5m',  50),
        fetchKlines(symbol, '15m', 300),
        fetchKlines(symbol, '1H',  50),
        fetchKlines(symbol, '4H',  250),
        fetchKlines(symbol, '1D',  250),
      ]);

      if (candles15m.length < 20 || candlesH4.length < 22) return;

      // ── M15 indicators (main) ────────────────────────────────────────────────
      const closes    = candles15m.map(c => c.close);
      const ema9arr   = calculateEMA(closes, 9);
      const ema21arr  = calculateEMA(closes, 21);
      const ema200arr = calculateEMA(closes, 200);
      const rsi6arr   = calculateRSI(closes, 6);
      const sarData   = calculateParabolicSAR(candles15m);
      const avgVol    = calculateAvgVolume(candles15m, 20);
      const atr       = calculateATR(candles15m.slice(-20), 14);

      const last     = closes.length - 1;
      const prev     = last - 1;
      const price    = closes[last];
      const curr9    = ema9arr[last];
      const curr21   = ema21arr[last];
      const curr200  = ema200arr[last];
      const currRsi  = rsi6arr[last];
      const currSar  = sarData[last];
      const prevSar  = sarData[prev];
      const prevClose   = closes[prev];
      const prevEma200  = ema200arr[prev];
      const lastCandle  = candles15m[last];
      const prevCandle  = candles15m[prev];

      // ── Multi-temporal trend (GPS 5TF) ───────────────────────────────────────
      const m15Trend = price > curr200 ? 'BULL' : price < curr200 ? 'BEAR' : 'NEUTRAL' as 'BULL' | 'BEAR' | 'NEUTRAL';

      const h4Closes = candlesH4.map(c => c.close);
      const h4ema21  = calculateEMA(h4Closes, 21);
      const h4ema200 = calculateEMA(h4Closes, 200);
      const h4Last   = h4Closes.length - 1;
      const h4Price  = h4Closes[h4Last];
      const h4Trend: 'BULL' | 'BEAR' | 'NEUTRAL' =
        h4ema200.length > 0 && h4Last >= h4ema200.length - 1
          ? h4Price > h4ema200[h4Last] && h4Price > h4ema21[h4Last] ? 'BULL'
          : h4Price < h4ema200[h4Last] && h4Price < h4ema21[h4Last] ? 'BEAR'
          : 'NEUTRAL'
          : 'NEUTRAL';

      const m5Trend  = computeTrend(candles5m.map(c => c.close), 21);
      const h1Trend  = computeTrend(candlesH1.map(c => c.close), 21);
      const d1Trend  = computeTrend(candlesD1.map(c => c.close), 200);

      const multiTrend: MultiTrend = { d1: d1Trend, h4: h4Trend, h1: h1Trend, m15: m15Trend, m5: m5Trend };

      // ── V7: Body/Wick Breakout Filter ──────────────────────────────────────
      const body = Math.abs(lastCandle.close - lastCandle.open);
      const upperWick = lastCandle.high - Math.max(lastCandle.close, lastCandle.open);
      const lowerWick = Math.min(lastCandle.close, lastCandle.open) - lastCandle.low;
      const totalRange = lastCandle.high - lastCandle.low;
      const bodyPct = totalRange > 0 ? body / totalRange : 0;
      const bodyDominant = body > (upperWick + lowerWick) * 2;
      const isBreakoutCandle = bodyPct > 0.7 && lastCandle.volume >= avgVol * 1.5 && bodyDominant;

      // ── V7: M5 Proximity Radar (aceleração de aproximação da EMA200) ────────
      const m5Closes = candles5m.map(c => c.close);
      const m5Last   = m5Closes.length - 1;
      const m5DistCurr = curr200 > 0 ? Math.abs(m5Closes[m5Last] - curr200) / curr200 : 1;
      const m5DistPrev = curr200 > 0 && m5Last >= 3
        ? Math.abs(m5Closes[m5Last - 3] - curr200) / curr200
        : m5DistCurr;
      const approachingFast = m5DistPrev - m5DistCurr > 0.003;
      const m5VolSurge = m5Last >= 1 && candles5m[m5Last]?.volume > (candles5m[m5Last - 1]?.volume ?? 0) * 1.3;
      const preBreakoutSignal = approachingFast && m5VolSurge && m5DistCurr < 0.008;

      // ── V7: EMA9 Inclination sync (≈30°) ───────────────────────────────────
      const ema9Slope = curr9 - (ema9arr[last - 1] ?? curr9);
      const ema9Inclining = ema9Slope > curr9 * 0.0002;
      const ema9Declining = ema9Slope < -curr9 * 0.0002;

      // ── M5 RSI + Gatilho de Volatilidade ─────────────────────────────────────
      const m5Rsi6arr  = calculateRSI(m5Closes, 6);
      const m5RsiLast  = m5Rsi6arr[m5Rsi6arr.length - 1] ?? 50;
      const prevM5Rsi  = prevM5RsiRef.current.get(symbol) ?? m5RsiLast;
      const rsiSpiked  = Math.abs(m5RsiLast - prevM5Rsi) >= 15;
      const m5AvgVol   = calculateAvgVolume(candles5m, 20);
      const m5LastIdx  = candles5m.length - 1;
      const m5VolDoubled = (candles5m[m5LastIdx]?.volume ?? 0) > m5AvgVol * 2;
      const volatilityTrigger = rsiSpiked || m5VolDoubled;

      // ── Update BTC reference trend (M5) ─────────────────────────────────────
      if (symbol === 'BTC') btcTrendRef.current = m5Trend;

      // ── Update coin state ────────────────────────────────────────────────────
      const bearCount = [multiTrend.d1, multiTrend.h4, multiTrend.h1, multiTrend.m15, multiTrend.m5].filter(t => t === 'BEAR').length;
      const bullCount = [multiTrend.d1, multiTrend.h4, multiTrend.h1, multiTrend.m15, multiTrend.m5].filter(t => t === 'BULL').length;
      const baseConfluence = Math.max(bullCount, bearCount);

      const coinData: CoinState = {
        symbol, price, ema9: curr9, ema21: curr21, ema200: curr200,
        trend: m15Trend, h4Trend, rsi6: currRsi,
        sarIsLong: currSar?.isLong ?? true,
        multiTrend, confluenceCount: baseConfluence,
        loading: false, error: false,
      };
      coinsRef.current = { ...coinsRef.current, [symbol]: coinData };
      setCoins(prev_ => ({ ...prev_, [symbol]: coinData }));

      // ── MODULE: Anti-Ansiedade + TP/SL Tracking ──────────────────────────────
      for (const [sigId, entry] of activeSignalsRef.current) {
        if (entry.signal.symbol !== symbol) continue;
        const sig = entry.signal;
        const isLong = sig.direction === 'LONG';

        // SL hit
        if ((isLong && price <= sig.sl) || (!isLong && price >= sig.sl)) {
          activeSignalsRef.current.delete(sigId);
          continue;
        }

        // Anti-anxiety: price against position >0.5% but SAR still holds
        const drawdown = isLong ? (sig.avgEntry - price) / sig.avgEntry : (price - sig.avgEntry) / sig.avgEntry;
        const calmKey = `${sigId}-calm`;
        if (!entry.tp1Hit && drawdown > 0.005 && !calmSentRef.current.has(calmKey)) {
          const sarHolds = isLong ? (currSar?.isLong ?? false) : !(currSar?.isLong ?? true);
          if (sarHolds) {
            calmSentRef.current.add(calmKey);
            sendCalmMessage(sig, price);
            const dd = (drawdown * 100).toFixed(2);
            const mentorTexts = [
              `O SAR continua ${isLong ? 'de alta' : 'de baixa'} — o setup ainda é válido. ${dd}% de recuo é normal nessa estratégia. Mantenha o plano.`,
              `Recuos são parte do trading. O SAR não inverteu. Enquanto a estrutura aguenta, o trade está vivo. Respire.`,
              `A EMA200 é um ímã — o preço oscila antes de reagir. SAR confirma: você ainda está no lado certo.`,
              `${dd}% de flutuação não é perda — é só o mercado testando o suporte. O setup está intacto.`,
            ];
            const mentor: MentoringMessage = {
              id: calmKey,
              symbol: sig.symbol,
              direction: sig.direction,
              price,
              text: mentorTexts[Math.floor(Date.now() / 1000) % mentorTexts.length],
              ts: Date.now(),
            };
            setMentoringMessages(prev => [mentor, ...prev.filter(m => m.id !== mentor.id)].slice(0, 5));
          }
        }

        // TP1
        if (!entry.tp1Hit && ((isLong && price >= sig.tp1) || (!isLong && price <= sig.tp1))) {
          entry.tp1Hit = true;
          sendWinAlert(sig, 1);
        }
        // TP2
        if (entry.tp1Hit && !entry.tp2Hit && ((isLong && price >= sig.tp2) || (!isLong && price <= sig.tp2))) {
          entry.tp2Hit = true;
          sendWinAlert(sig, 2);
        }
        // TP3
        if (entry.tp2Hit && !entry.tp3Hit && ((isLong && price >= sig.tp3) || (!isLong && price <= sig.tp3))) {
          entry.tp3Hit = true;
          sendWinAlert(sig, 3);
          activeSignalsRef.current.delete(sigId);
        }
      }

      // ── GPS: confluência necessária ──────────────────────────────────────────
      const bullGPS  = m15Trend === 'BULL' && h4Trend === 'BULL';
      const bearGPS  = m15Trend === 'BEAR' && h4Trend === 'BEAR';
      const near200  = Math.abs(price - curr200) / curr200 < 0.002;
      const near9    = Math.abs(price - curr9) / curr9 < 0.001;
      const near21   = Math.abs(price - curr21) / curr21 < 0.001;
      const nearAnyEma = near200 || near9 || near21;

      // ── Collect raw signals ──────────────────────────────────────────────────
      type Raw = { direction: 'LONG' | 'SHORT'; strategy: string; leverage: number; reason: string };
      const rawSignals: Raw[] = [];

      // 1 — Muralha & Suporte 200
      if (near200 && bullGPS && currRsi < 30)
        rawSignals.push({ direction: 'LONG', strategy: 'Muralha 200', leverage: 50, reason: `🏰 EMA200 suporte institucional | RSI(6): ${currRsi.toFixed(0)}` });
      if (near200 && bearGPS && currRsi > 70)
        rawSignals.push({ direction: 'SHORT', strategy: 'Muralha 200', leverage: 50, reason: `🏰 EMA200 resistência institucional | RSI(6): ${currRsi.toFixed(0)}` });

      // 2 — Surfe 200 (rompimento com volume) — V7: filtro Corpo+Volume
      const crossedAbove200 = prevClose < prevEma200 && price > curr200;
      const crossedBelow200 = prevClose > prevEma200 && price < curr200;
      const bigVolume = lastCandle.volume > avgVol * 2;
      if (crossedAbove200 && bigVolume && h4Trend === 'BULL') {
        const tag = isBreakoutCandle ? '⚡ ROMPIMENTO (Corpo>70% + Vol≥1.5x)' : '🌊 Rompimento';
        rawSignals.push({ direction: 'LONG', strategy: 'Surfe 200', leverage: isBreakoutCandle ? 35 : 25,
          reason: `${tag} acima EMA200 · Vol ${(lastCandle.volume / avgVol).toFixed(1)}x · Corpo ${Math.round(bodyPct * 100)}%` });
      }
      if (crossedBelow200 && bigVolume && h4Trend === 'BEAR') {
        const tag = isBreakoutCandle ? '⚡ ROMPIMENTO (Corpo>70% + Vol≥1.5x)' : '🌊 Rompimento';
        rawSignals.push({ direction: 'SHORT', strategy: 'Surfe 200', leverage: isBreakoutCandle ? 35 : 25,
          reason: `${tag} abaixo EMA200 · Vol ${(lastCandle.volume / avgVol).toFixed(1)}x · Corpo ${Math.round(bodyPct * 100)}%` });
      }
      // V7: Radar M5 — pré-calcula rompimento antes do toque no M15
      if (preBreakoutSignal && bullGPS)
        rawSignals.push({ direction: 'LONG',  strategy: 'Muralha Buffer', leverage: 25, reason: `🔭 RADAR M5: aceleração detectada + vol ↑. Rompimento da EMA200 antecipado!` });
      if (preBreakoutSignal && bearGPS)
        rawSignals.push({ direction: 'SHORT', strategy: 'Muralha Buffer', leverage: 25, reason: `🔭 RADAR M5: aceleração detectada + vol ↑. Queda na EMA200 antecipada!` });

      // 3 — Onda SAR Parabólico — V7: requer SAR + EMA9 alinhados (sync)
      const sarFlippedUp   = prevSar && !prevSar.isLong && currSar?.isLong;
      const sarFlippedDown = prevSar && prevSar.isLong && !currSar?.isLong;
      const sarEma9LongSync  = sarFlippedUp   && ema9Inclining;
      const sarEma9ShortSync = sarFlippedDown && ema9Declining;
      if (sarEma9LongSync  && bullGPS) rawSignals.push({ direction: 'LONG',  strategy: 'Onda SAR', leverage: 25,
        reason: `📡 SAR ▲ + EMA9 inclinando (${ema9Slope > 0 ? '+' : ''}${(ema9Slope / curr9 * 100).toFixed(3)}%/vela) — sync confirmado` });
      if (sarEma9ShortSync && bearGPS) rawSignals.push({ direction: 'SHORT', strategy: 'Onda SAR', leverage: 25,
        reason: `📡 SAR ▼ + EMA9 declinando (${(ema9Slope / curr9 * 100).toFixed(3)}%/vela) — sync confirmado` });
      // Fallback sem sync (sinal pendente)
      if (sarFlippedUp   && !ema9Inclining && bullGPS) rawSignals.push({ direction: 'LONG',  strategy: 'Onda SAR', leverage: 15, reason: '📡 SAR virou ▲ — aguardando EMA9 sincronizar (alavancagem reduzida)' });
      if (sarFlippedDown && !ema9Declining && bearGPS) rawSignals.push({ direction: 'SHORT', strategy: 'Onda SAR', leverage: 15, reason: '📡 SAR virou ▼ — aguardando EMA9 sincronizar (alavancagem reduzida)' });

      // 4 — Retração 50% Fibonacci
      const isStrongCandle = prevCandle.volume > avgVol * 3;
      if (isStrongCandle) {
        const range = Math.abs(prevCandle.close - prevCandle.open);
        const bullPrev = prevCandle.close > prevCandle.open;
        const fib50 = bullPrev ? prevCandle.open + range * 0.5 : prevCandle.close + range * 0.5;
        const atFib50 = Math.abs(price - fib50) / fib50 < 0.0015;
        if (atFib50 && bullPrev  && bullGPS) rawSignals.push({ direction: 'LONG',  strategy: 'Fibonacci 50%', leverage: 25, reason: `📐 Retração 50% após vela de força (${(prevCandle.volume / avgVol).toFixed(1)}x vol)` });
        if (atFib50 && !bullPrev && bearGPS) rawSignals.push({ direction: 'SHORT', strategy: 'Fibonacci 50%', leverage: 25, reason: `📐 Retração 50% após vela de força (${(prevCandle.volume / avgVol).toFixed(1)}x vol)` });
      }

      // 5 — Exaustão Sniper RSI(6)
      if (nearAnyEma && bullGPS && currRsi < 25) rawSignals.push({ direction: 'LONG',  strategy: 'Exaustão Sniper', leverage: 50, reason: `🎯 RSI(6) exaustão venda: ${currRsi.toFixed(0)} — toque na média` });
      if (nearAnyEma && bearGPS && currRsi > 75) rawSignals.push({ direction: 'SHORT', strategy: 'Exaustão Sniper', leverage: 50, reason: `🎯 RSI(6) exaustão compra: ${currRsi.toFixed(0)} — toque na média` });

      // 6 — Muralha Buffer (Antecipação SHORT)
      const approachFromAbove = price > curr200 && near200;
      if (approachFromAbove && h4Trend === 'BEAR' && currRsi > 75)
        rawSignals.push({ direction: 'SHORT', strategy: 'Muralha Buffer', leverage: 50, reason: `🏰 Antecipação: 0.2% da EMA200 | H4 BEAR | RSI(6): ${currRsi.toFixed(0)}` });

      // 7 — Fênix de Reversão (Contra-Tendência LONG)
      const farBelow  = curr200 > 0 && (curr200 - price) / curr200 > 0.02;
      const greenCandle = lastCandle.close > lastCandle.open;
      const volSpike30  = lastCandle.volume > avgVol * 1.3;
      if (farBelow && currRsi < 20 && greenCandle && volSpike30)
        rawSignals.push({ direction: 'LONG', strategy: 'Fênix Reversão', leverage: 25, reason: `🔥 REVERSÃO: ${((curr200 - price) / curr200 * 100).toFixed(1)}% abaixo EMA200 | RSI(6): ${currRsi.toFixed(0)} | Vol: ${(lastCandle.volume / avgVol).toFixed(1)}x ⚠️ ALVO CURTO` });

      // 8 — Gatilho de Volatilidade M5 (ignora espera de fechamento de TFs maiores)
      if (volatilityTrigger && m5Trend !== 'NEUTRAL') {
        const vtDir    = m5Trend === 'BULL' ? 'LONG' : 'SHORT' as 'LONG' | 'SHORT';
        const vtReason = rsiSpiked
          ? `⚡ RSI(6) M5 deslocou ${Math.abs(m5RsiLast - prevM5Rsi).toFixed(0)} pts (${prevM5Rsi.toFixed(0)} → ${m5RsiLast.toFixed(0)}) — Momentum explosivo`
          : `⚡ Volume M5 ${(( candles5m[m5LastIdx]?.volume ?? 0) / m5AvgVol).toFixed(1)}x acima da média — Pressão ${vtDir === 'LONG' ? 'compradora' : 'vendedora'} confirmada`;
        rawSignals.push({ direction: vtDir, strategy: 'Confirmação 100%', leverage: 50, reason: vtReason });
      }
      prevM5RsiRef.current.set(symbol, m5RsiLast);

      // ── V7: Antecipação 80% ───────────────────────────────────────────────────
      const ANTICIPATION_COOLDOWN_MS = 30 * 60 * 1000;
      if (rawSignals.length === 0) {
        const antNow = Date.now();
        const nearEma200_80 = curr200 > 0 && Math.abs(price - curr200) / curr200 < 0.02;
        const rsiPreLong    = currRsi >= 30 && currRsi <= 40;
        const rsiPreShort   = currRsi >= 60 && currRsi <= 70;

        const bullReady80 = bullCount >= 3 && (nearEma200_80 || rsiPreLong);
        const bearReady80 = bearCount >= 3 && (nearEma200_80 || rsiPreShort);

        if (bullReady80 || bearReady80) {
          const ant80Dir = bullReady80 ? 'LONG' : 'SHORT';
          const antKey   = `${symbol}-${ant80Dir}-anticipation`;
          const lastAnt  = anticipationCooldown.current.get(antKey) ?? 0;

          if (antNow - lastAnt >= ANTICIPATION_COOLDOWN_MS) {
            anticipationCooldown.current.set(antKey, antNow);
            const ant80Strategy = nearEma200_80 ? 'Muralha 200' : 'Exaustão Sniper';
            const ant80Reason   = nearEma200_80
              ? `Preço a ${((Math.abs(price - curr200) / curr200) * 100).toFixed(2)}% da EMA200 · ${bullCount >= 3 ? 'GPS ' + bullCount + '/5 BULL' : 'GPS ' + bearCount + '/5 BEAR'}`
              : `RSI(6) em ${currRsi.toFixed(0)} (zona de pré-exaustão) · ${bullCount >= 3 ? 'GPS ' + bullCount + '/5 BULL' : 'GPS ' + bearCount + '/5 BEAR'}\n→ Aguardando toque na média e volume confirmador.`;
            sendAnticipationAlert(symbol, ant80Dir, ant80Strategy, price, ant80Reason, Math.max(bullCount, bearCount));
          }
        }
        return;
      }

      // ── Cooldown per asset ───────────────────────────────────────────────────
      const now = Date.now();
      if (now - (cooldownMap.current.get(symbol) ?? 0) < COOLDOWN_MS) return;

      // ── Unify: dominant direction → SINAL MESTRE if multiple ─────────────────
      const longRaws  = rawSignals.filter(s => s.direction === 'LONG');
      const shortRaws = rawSignals.filter(s => s.direction === 'SHORT');
      const dominant  = longRaws.length >= shortRaws.length && longRaws.length > 0 ? longRaws : shortRaws;
      if (dominant.length === 0) return;

      const direction   = dominant[0].direction;
      const strategies  = dominant.map(s => s.strategy);
      const isMaster    = strategies.length > 1;
      const strategy    = isMaster ? 'SINAL MESTRE' : strategies[0];
      const leverage    = Math.max(...dominant.map(s => s.leverage));
      const reason      = dominant.map(s => s.reason).join(' | ');

      // ── MODULE: Termômetro BTC V7 — bloqueia sinais contra a tendência do BTC ──
      if (symbol !== 'BTC') {
        const btcTrend = btcTrendRef.current;
        if (direction === 'SHORT' && btcTrend === 'BULL') {
          sendRetainedAlert(symbol, direction, price, strategies);
          return;
        }
        if (direction === 'LONG' && btcTrend === 'BEAR') {
          sendRetainedAlert(symbol, direction, price, strategies);
          return;
        }
      }

      // ── V7: Detecção de Inversão de Fluxo ──────────────────────────────────────
      const prevEma200Stored = prevEma200Ref.current.get(symbol);
      if (prevEma200Stored !== undefined) {
        const prevWasAbove = prevClose > prevEma200Stored;
        const nowBelow200  = price < curr200;
        const prevWasBelow = prevClose < prevEma200Stored;
        const nowAbove200  = price > curr200;
        if (prevWasAbove && nowBelow200) {
          const inv: InversionAlert = {
            id: `inv-${symbol}-short-${Math.floor(now / 60000)}`,
            symbol, from: 'LONG', to: 'SHORT', price,
            reason: `A EMA200 não segurou — pressão vendedora detectada. Inversão para SHORT!`,
            ts: now,
          };
          setInversionAlerts(prev => [inv, ...prev.filter(a => a.id !== inv.id)].slice(0, 8));
        }
        if (prevWasBelow && nowAbove200) {
          const inv: InversionAlert = {
            id: `inv-${symbol}-long-${Math.floor(now / 60000)}`,
            symbol, from: 'SHORT', to: 'LONG', price,
            reason: `EMA200 rompida para cima — pressão compradora forte. Inversão para LONG!`,
            ts: now,
          };
          setInversionAlerts(prev => [inv, ...prev.filter(a => a.id !== inv.id)].slice(0, 8));
        }
      }
      prevEma200Ref.current.set(symbol, curr200);

      // ── Confluence scoring ───────────────────────────────────────────────────
      const count = confluenceScore(multiTrend, direction);
      const isHighProbability = count >= 4;

      // ── Entry escada ─────────────────────────────────────────────────────────
      const escadaEntry2 = direction === 'LONG'
        ? Math.min(curr21, curr9)   // buy lower at EMA9 or EMA21
        : Math.max(curr21, curr9);  // sell higher at EMA9 or EMA21
      const avgEntry = (price + escadaEntry2) / 2;

      const { sl, tp1, tp2, tp3 } = calcSlTp(price, direction, atr);
      const id = `${symbol}-${direction}-${Math.floor(now / COOLDOWN_MS)}`;

      if (!seenIds.current.has(id)) {
        seenIds.current.add(id);
        cooldownMap.current.set(symbol, now);

        const sig: SignalAlert = {
          id, symbol, direction, price, ema21: escadaEntry2, avgEntry,
          sl, tp1, tp2, tp3, strategy, strategies, leverage,
          rsi6: currRsi, h4Trend, multiTrend, confluenceCount: count, isHighProbability, reason, ts: now,
        };

        activeSignalsRef.current.set(id, { signal: sig, tp1Hit: false, tp2Hit: false, tp3Hit: false });
        setAlerts(prev_ => [sig, ...prev_].slice(0, 50));
        setActiveAlert(sig);
        playBeep(direction, isMaster, isHighProbability);
        sendTelegramAlert(sig);
      }
    } catch (_) {
      setCoins(prev_ => ({
        ...prev_,
        [symbol]: { ...prev_[symbol], loading: false, error: true },
      }));
    }
  }, []);

  const sendRadarReport = useCallback(async () => {
    const coinsData = MONITOR_SYMBOLS.map(s => coinsRef.current[s]).filter(c => c && !c.loading && !c.error);
    if (coinsData.length < 3) return;
    try {
      await fetch(`${BASE}/api/telegram/radar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coins: coinsData.map(c => ({
          symbol: c.symbol,
          d1: c.multiTrend.d1, h4: c.multiTrend.h4, h1: c.multiTrend.h1,
          m15: c.multiTrend.m15, m5: c.multiTrend.m5,
        })) }),
      });
    } catch (_) {}
  }, []);

  const runScan = useCallback(async () => {
    await Promise.allSettled(MONITOR_SYMBOLS.map(s => scanCoin(s)));
    setLastScan(new Date());
    setNextScanIn(SCAN_INTERVAL_MS / 1000);
  }, [scanCoin]);

  useEffect(() => {
    if (!activatedRef.current) {
      activatedRef.current = true;
      sendActivationMessage();
    }
    runScan().then(() => sendRadarReport());
    intervalRef.current  = setInterval(runScan, SCAN_INTERVAL_MS);
    radarRef.current     = setInterval(sendRadarReport, RADAR_INTERVAL_MS);
    countdownRef.current = setInterval(() => setNextScanIn(n => Math.max(0, n - 1)), 1000);
    return () => {
      if (intervalRef.current)  clearInterval(intervalRef.current);
      if (radarRef.current)     clearInterval(radarRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [runScan, sendRadarReport]);

  const fmt = (n: number) => n > 1 ? n.toFixed(2) : n.toFixed(6);

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-2 gap-2 relative">

      {/* ── Signal Modal ── */}
      {activeAlert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setActiveAlert(null)}>
          <div
            className={cn(
              "relative rounded-2xl border-2 p-6 min-w-[420px] max-w-[500px] text-center shadow-2xl",
              activeAlert.isHighProbability ? "border-yellow-400 bg-yellow-950/90 shadow-yellow-500/30" :
              activeAlert.direction === 'LONG' ? "border-green-400 bg-green-950/90 shadow-green-500/30"
                                               : "border-red-400 bg-red-950/90 shadow-red-500/30"
            )}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            {activeAlert.isHighProbability && (
              <div className="text-yellow-300 font-black text-xs mb-1 tracking-widest animate-pulse">
                🔥 SINAL DE ALTA PROBABILIDADE ({activeAlert.confluenceCount}/5 TFs)
              </div>
            )}
            {activeAlert.strategy === 'SINAL MESTRE' ? (
              <div className="text-xs font-bold text-yellow-300 mb-1 tracking-widest animate-pulse">
                🚀 SINAL MESTRE · {activeAlert.strategies.join(' + ')}
              </div>
            ) : (
              <div className="text-xs font-bold text-yellow-400 mb-1 tracking-widest">
                {strategyEmoji[activeAlert.strategy] || '⚡'} {activeAlert.strategy.toUpperCase()}
              </div>
            )}

            <div className={cn("text-4xl font-black mb-1", activeAlert.direction === 'LONG' ? "text-green-400" : "text-red-400")}>
              {activeAlert.direction === 'LONG' ? '▲ LONGA' : '▼ CURTA'}
            </div>
            <div className="text-2xl font-bold text-white mb-1">{activeAlert.symbol}-USDT-SWAP</div>

            {/* Multi-trend dots */}
            <div className="flex justify-center gap-1 mb-2">
              {tfKeys.map(tf => (
                <span key={tf} className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded", tfDotCss(activeAlert.multiTrend[tf]))}>
                  {tf.toUpperCase()}
                </span>
              ))}
            </div>

            <div className="text-sm text-muted-foreground mb-2">
              RSI(6): <span className="font-bold text-yellow-400">{activeAlert.rsi6.toFixed(0)}</span>
              {' · '}<span className="font-bold text-primary">{activeAlert.leverage}x</span>
            </div>

            {/* Entry escada */}
            <div className="bg-black/30 rounded-lg p-2 mb-3 text-xs text-left">
              <div className="text-yellow-400 font-bold mb-1">💵 ENTRADA EM ESCADA (50% + 50%):</div>
              <div className="flex justify-between text-muted-foreground">
                <span>🔹 50% Mkt: <span className="text-white font-bold">${fmt(activeAlert.price)}</span></span>
                <span>🔹 50% EMA21: <span className="text-white font-bold">${fmt(activeAlert.ema21)}</span></span>
              </div>
              <div className="text-center mt-1">Preço Médio: <span className="text-green-400 font-bold">${fmt(activeAlert.avgEntry)}</span></div>
            </div>

            {/* TPs */}
            <div className="grid grid-cols-3 gap-2 mb-2 text-xs">
              <div className="bg-green-900/40 rounded p-2">
                <div className="text-muted-foreground">TP1 ← BE</div>
                <div className="font-bold text-green-400">${fmt(activeAlert.tp1)}</div>
              </div>
              <div className="bg-green-900/40 rounded p-2">
                <div className="text-muted-foreground">TP2</div>
                <div className="font-bold text-green-400">${fmt(activeAlert.tp2)}</div>
              </div>
              <div className="bg-green-900/40 rounded p-2">
                <div className="text-muted-foreground">TP3</div>
                <div className="font-bold text-green-400">${fmt(activeAlert.tp3)}</div>
              </div>
            </div>
            <div className="text-red-400 font-bold text-sm mb-2">🛡️ SL: ${fmt(activeAlert.sl)}</div>

            {/* Profit table */}
            {(() => {
              const BANCA = 2000;
              const tp1Pct = Math.abs((activeAlert.tp1 - activeAlert.avgEntry) / activeAlert.avgEntry) * 100;
              const p10 = (BANCA * 10 * tp1Pct / 100).toFixed(0);
              const p25 = (BANCA * 25 * tp1Pct / 100).toFixed(0);
              const p50 = (BANCA * 50 * tp1Pct / 100).toFixed(0);
              return (
                <div className="bg-black/30 rounded-lg p-2 mb-3 text-xs text-left">
                  <div className="text-yellow-400 font-bold mb-1">💰 Lucro no TP1 (Banca $2.000 · Média):</div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>10x → <span className="text-green-400 font-bold">+${p10}</span></span>
                    <span>25x → <span className="text-green-400 font-bold">+${p25}</span></span>
                    <span>50x → <span className="text-green-400 font-bold">+${p50}</span></span>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-1">
                    Caução: $800@25x | $400@50x (liq ≥ -10%)
                  </div>
                </div>
              );
            })()}

            <div className="text-xs text-yellow-400 font-bold mb-3">⚠️ Ao atingir TP1, mova o SL para o ponto de entrada!</div>
            <button onClick={() => setActiveAlert(null)} className="px-6 py-2 rounded-lg bg-white/10 text-white hover:bg-white/20 text-sm font-bold transition-colors">
              FECHAR
            </button>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="flex-1">
          <h2 className="text-sm font-black text-primary tracking-widest">TRADESNIPER AI PRO · OKX SWAP · 7 ESTRATÉGIAS · GPS 5TF</h2>
          <p className="text-xs text-muted-foreground">D1·H4·H1·M15·M5 · EMA 9/21/200 · RSI(6) · SAR · Fib · Muralha Buffer · Fênix · BTC Termômetro</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {lastScan && <span className="text-xs text-muted-foreground">Última: {lastScan.toLocaleTimeString('pt-BR')}</span>}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-blue-900/40 border border-blue-500/50 text-blue-300 text-[10px] font-black">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse inline-block" />
            SERVIDOR 24/7
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-900/40 border border-green-500/50 text-green-300 text-xs font-black">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
            DISPLAY · {nextScanIn}s
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex gap-2 overflow-hidden min-h-0">

        {/* Coin cards */}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 gap-1">
            {MONITOR_SYMBOLS.map(symbol => {
              const c = coins[symbol];
              return (
                <GlassCard key={symbol} className="p-3">
                  <div className="flex items-center gap-3">
                    <div className="w-20 shrink-0">
                      <div className="font-black text-sm text-white">{symbol}</div>
                      <div className="text-[10px] text-muted-foreground">USDT SWAP</div>
                      <div className={cn("text-xs font-bold",
                        c.trend === 'BULL' ? "text-green-400" : c.trend === 'BEAR' ? "text-red-400" : "text-muted-foreground"
                      )}>
                        {c.loading ? '...' : `M15 ${c.trend}`}
                      </div>
                      {!c.loading && c.confluenceCount >= 4 && (
                        <div className="text-[10px] text-yellow-400 font-bold">🔥 {c.confluenceCount}/5</div>
                      )}
                    </div>

                    <div className="w-24 shrink-0">
                      {c.error ? <span className="text-xs text-red-400">Erro</span> :
                       c.loading ? <div className="h-4 w-20 bg-white/10 rounded animate-pulse" /> :
                       <span className="font-bold text-white text-sm">${fmt(c.price)}</span>}
                    </div>

                    {!c.loading && !c.error && (
                      <div className="flex-1 flex flex-col gap-1">
                        {/* EMA values */}
                        <div className="grid grid-cols-4 gap-2 text-xs">
                          <div>
                            <div className="text-muted-foreground text-[10px]">EMA9</div>
                            <div className={cn("font-mono", c.price > c.ema9 ? "text-green-400" : "text-red-400")}>{fmt(c.ema9)}</div>
                          </div>
                          <div>
                            <div className="text-muted-foreground text-[10px]">EMA21</div>
                            <div className={cn("font-mono", c.price > c.ema21 ? "text-green-400" : "text-red-400")}>{fmt(c.ema21)}</div>
                          </div>
                          <div>
                            <div className="text-muted-foreground text-[10px]">EMA200</div>
                            <div className={cn("font-mono", c.price > c.ema200 ? "text-green-400" : "text-red-400")}>{fmt(c.ema200)}</div>
                          </div>
                          <div>
                            <div className="text-muted-foreground text-[10px]">RSI(6)</div>
                            <div className={cn("font-mono font-bold",
                              c.rsi6 < 25 ? "text-green-400" : c.rsi6 > 75 ? "text-red-400" : "text-yellow-400"
                            )}>{c.rsi6.toFixed(0)}</div>
                          </div>
                        </div>
                        {/* Multi-trend dots */}
                        <div className="flex gap-1">
                          {tfKeys.map(tf => (
                            <span key={tf} className={cn("text-[9px] font-bold px-1 py-0.5 rounded", tfDotCss(c.multiTrend[tf]))}>
                              {tf.toUpperCase()}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {!c.loading && !c.error && (
                      <div className="shrink-0 w-20 text-right">
                        <span className={cn(
                          "text-[10px] font-black px-2 py-1 rounded",
                          c.trend === 'BULL' ? "bg-green-900/50 text-green-400" :
                          c.trend === 'BEAR' ? "bg-red-900/50 text-red-400" : "bg-white/5 text-muted-foreground"
                        )}>
                          {c.price > c.ema200 ? '▲ ACIMA' : '▼ ABAIXO'}
                        </span>
                        <div className={cn("text-[10px] mt-1 font-bold", c.sarIsLong ? "text-green-400" : "text-red-400")}>
                          SAR {c.sarIsLong ? '▲' : '▼'}
                        </div>
                      </div>
                    )}
                  </div>
                </GlassCard>
              );
            })}
          </div>
        </div>

        {/* Alerts panel */}
        <div className="w-72 shrink-0 flex flex-col gap-2 overflow-y-auto">

          {/* V7: Inversion Alerts */}
          {inversionAlerts.length > 0 && (
            <div className="shrink-0">
              <div className="text-xs font-black text-orange-400 tracking-widest flex items-center gap-2 mb-1">
                ⚠️ INVERSÕES DE FLUXO
                <span className="bg-orange-500/20 text-orange-400 rounded px-1.5 py-0.5">{inversionAlerts.length}</span>
                <button onClick={() => setInversionAlerts([])} className="ml-auto text-[10px] text-muted-foreground hover:text-white">✕ limpar</button>
              </div>
              <div className="flex flex-col gap-1 max-h-36 overflow-y-auto">
                {inversionAlerts.map(inv => (
                  <div key={inv.id} className="p-2 rounded-lg border border-orange-500/40 bg-orange-900/20 text-xs">
                    <div className="flex justify-between items-center mb-0.5">
                      <span className="font-black text-orange-300">{inv.symbol}</span>
                      <span className="text-[10px] text-muted-foreground">{new Date(inv.ts).toLocaleTimeString('pt-BR')}</span>
                    </div>
                    <div className="flex items-center gap-1 text-[10px] font-bold mb-1">
                      <span className={inv.from === 'LONG' ? 'text-green-400' : 'text-red-400'}>
                        {inv.from === 'LONG' ? '▲ LONG' : '▼ SHORT'}
                      </span>
                      <span className="text-orange-400">→</span>
                      <span className={inv.to === 'LONG' ? 'text-green-400' : 'text-red-400'}>
                        {inv.to === 'LONG' ? '▲ LONG' : '▼ SHORT'}
                      </span>
                      <span className="ml-auto font-mono text-white">${inv.price.toFixed(2)}</span>
                    </div>
                    <div className="text-[10px] text-orange-200/80 leading-tight">{inv.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* V7: Mentoring / Anti-anxiety Messages */}
          {mentoringMessages.filter(m => !dismissedMessages.has(m.id)).length > 0 && (
            <div className="shrink-0">
              <div className="text-xs font-black text-blue-400 tracking-widest flex items-center gap-2 mb-1">
                🧘 MENTOR SNIPER
              </div>
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                {mentoringMessages.filter(m => !dismissedMessages.has(m.id)).map(m => (
                  <div key={m.id} className="p-2 rounded-lg border border-blue-500/40 bg-blue-900/20 relative">
                    <div className="flex items-center gap-1 mb-1">
                      <span className={cn("text-[10px] font-black", m.direction === 'LONG' ? 'text-green-400' : 'text-red-400')}>
                        {m.direction === 'LONG' ? '▲' : '▼'} {m.symbol}
                      </span>
                      <span className="text-[10px] text-muted-foreground ml-auto">{new Date(m.ts).toLocaleTimeString('pt-BR')}</span>
                      <button
                        onClick={() => setDismissedMessages(prev => new Set([...prev, m.id]))}
                        className="text-[10px] text-muted-foreground hover:text-white ml-1"
                      >✕</button>
                    </div>
                    <div className="text-[10px] text-blue-200/90 leading-snug italic">"{m.text}"</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="text-xs font-black text-muted-foreground tracking-widest flex items-center gap-2 shrink-0">
            ALERTAS SNIPER
            {alerts.length > 0 && <span className="bg-primary/20 text-primary rounded px-1.5 py-0.5">{alerts.length}</span>}
          </div>
          <div className="flex-1 overflow-y-auto flex flex-col gap-1">
            {alerts.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center mt-8">
                Varrendo OKX · GPS 5TF...<br />
                <span className="text-[10px]">7 estratégias · anti-spam 10min</span>
              </div>
            ) : (
              alerts.map(a => (
                <button
                  key={a.id}
                  onClick={() => setActiveAlert(a)}
                  className={cn(
                    "w-full text-left p-3 rounded-lg border transition-colors",
                    a.isHighProbability ? "border-yellow-400/60 bg-yellow-900/20 hover:bg-yellow-900/40" :
                    a.direction === 'LONG' ? "border-green-500/40 bg-green-900/20 hover:bg-green-900/40"
                                          : "border-red-500/40 bg-red-900/20 hover:bg-red-900/40"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className={cn("font-black text-sm", a.direction === 'LONG' ? "text-green-400" : "text-red-400")}>
                      {a.direction === 'LONG' ? '▲' : '▼'} {a.symbol}
                    </span>
                    <div className="flex items-center gap-1">
                      {a.isHighProbability && <span className="text-yellow-400 text-[10px]">🔥</span>}
                      <span className="text-[10px] font-bold text-primary">{a.leverage}x</span>
                    </div>
                  </div>
                  <div className={cn("text-[10px] font-bold", a.strategy === 'SINAL MESTRE' ? 'text-yellow-300' : 'text-yellow-400')}>
                    {strategyEmoji[a.strategy] || '⚡'} {a.strategy === 'SINAL MESTRE' ? `MESTRE (${a.strategies.join('+')})` : a.strategy}
                  </div>
                  {/* Mini TF dots */}
                  <div className="flex gap-0.5 mt-0.5">
                    {tfKeys.map(tf => (
                      <span key={tf} className={cn("text-[8px] px-0.5 rounded", tfDotCss(a.multiTrend[tf]))}>{tf.toUpperCase()}</span>
                    ))}
                  </div>
                  <div className="text-xs text-white mt-0.5">
                    Mkt: ${fmt(a.price)} · Média: ${fmt(a.avgEntry)}
                  </div>
                  <div className="flex gap-2 text-[10px] mt-0.5">
                    <span className="text-red-400">SL {fmt(a.sl)}</span>
                    <span className="text-green-400">TP1 {fmt(a.tp1)}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {new Date(a.ts).toLocaleTimeString('pt-BR')}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
