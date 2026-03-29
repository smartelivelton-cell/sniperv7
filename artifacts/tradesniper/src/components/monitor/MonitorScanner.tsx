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

interface SignalAlert {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  price: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  strategy: string;
  leverage: number;
  rsi6: number;
  h4Trend: 'BULL' | 'BEAR' | 'NEUTRAL';
  reason: string;
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
  loading: boolean;
  error: boolean;
}

function playBeep(direction: 'LONG' | 'SHORT') {
  try {
    const ctx = new AudioContext();
    const count = direction === 'LONG' ? 2 : 3;
    for (let i = 0; i < count; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = direction === 'LONG' ? 880 : 440;
      osc.type = 'sine';
      const t = ctx.currentTime + i * 0.25;
      gain.gain.setValueAtTime(0.3, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      osc.start(t);
      osc.stop(t + 0.2);
    }
  } catch (_) {}
}

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';

async function fetchKlines(symbol: string, interval: string, limit = 300): Promise<Candle[]> {
  const instId = `${symbol}-USDT-SWAP`;
  const url = `${BASE}/api/monitor/klines?symbol=${instId}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  return parseOKXCandles(raw);
}

async function sendTelegramAlert(signal: SignalAlert) {
  try {
    await fetch(`${BASE}/api/telegram/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: `${signal.symbol}-USDT-SWAP`,
        side: signal.direction,
        price: signal.price,
        sl: signal.sl,
        tp1: signal.tp1,
        tp2: signal.tp2,
        tp3: signal.tp3,
        strategy: signal.strategy,
        leverage: signal.leverage,
        rsi6: signal.rsi6,
        h4Trend: signal.h4Trend,
        reason: signal.reason,
      }),
    });
  } catch (_) {}
}

async function sendActivationMessage() {
  try {
    await fetch(`${BASE}/api/telegram/activate`, { method: 'POST' });
  } catch (_) {}
}

const strategyEmoji: Record<string, string> = {
  'Muralha 200': '🏰',
  'Surfe 200': '🌊',
  'Onda SAR': '📡',
  'Fibonacci 50%': '📐',
  'Exaustão Sniper': '🎯',
};

export function MonitorScanner() {
  const [coins, setCoins] = useState<Record<string, CoinState>>(() => {
    const init: Record<string, CoinState> = {};
    for (const s of MONITOR_SYMBOLS) {
      init[s] = {
        symbol: s, price: 0, ema9: 0, ema21: 0, ema200: 0,
        trend: 'NEUTRAL', h4Trend: 'NEUTRAL', rsi6: 50,
        sarIsLong: true, loading: true, error: false,
      };
    }
    return init;
  });
  const [alerts, setAlerts] = useState<SignalAlert[]>([]);
  const [activeAlert, setActiveAlert] = useState<SignalAlert | null>(null);
  const [lastScan, setLastScan] = useState<Date | null>(null);
  const [nextScanIn, setNextScanIn] = useState(0);
  const seenIds = useRef<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activatedRef = useRef(false);

  const scanCoin = useCallback(async (symbol: string) => {
    try {
      const [candles15m, candlesH4] = await Promise.all([
        fetchKlines(symbol, '15m', 300),
        fetchKlines(symbol, '4h', 250),
      ]);

      if (candles15m.length < 20 || candlesH4.length < 22) return;

      const closes = candles15m.map(c => c.close);
      const ema9arr = calculateEMA(closes, 9);
      const ema21arr = calculateEMA(closes, 21);
      const ema200arr = calculateEMA(closes, 200);
      const rsi6arr = calculateRSI(closes, 6);
      const sarData = calculateParabolicSAR(candles15m);
      const avgVol = calculateAvgVolume(candles15m, 20);
      const atr = calculateATR(candles15m.slice(-20), 14);

      const last = closes.length - 1;
      const prev = last - 1;
      const price = closes[last];

      const curr9 = ema9arr[last];
      const curr21 = ema21arr[last];
      const curr200 = ema200arr[last];
      const currRsi = rsi6arr[last];
      const currSar = sarData[last];
      const prevSar = sarData[prev];
      const prevClose = closes[prev];
      const prevEma200 = ema200arr[prev];

      const trend: 'BULL' | 'BEAR' | 'NEUTRAL' =
        price > curr200 ? 'BULL' : price < curr200 ? 'BEAR' : 'NEUTRAL';

      const h4Closes = candlesH4.map(c => c.close);
      const h4ema21 = calculateEMA(h4Closes, 21);
      const h4ema200 = calculateEMA(h4Closes, 200);
      const h4Last = h4Closes.length - 1;
      const h4Price = h4Closes[h4Last];
      const h4Trend: 'BULL' | 'BEAR' | 'NEUTRAL' =
        h4ema200.length > 0 && h4Last >= h4ema200.length - 1
          ? h4Price > h4ema200[h4Last] && h4Price > h4ema21[h4Last] ? 'BULL'
          : h4Price < h4ema200[h4Last] && h4Price < h4ema21[h4Last] ? 'BEAR'
          : 'NEUTRAL'
          : 'NEUTRAL';

      setCoins(prev_ => ({
        ...prev_,
        [symbol]: {
          symbol, price, ema9: curr9, ema21: curr21, ema200: curr200,
          trend, h4Trend, rsi6: currRsi,
          sarIsLong: currSar?.isLong ?? true,
          loading: false, error: false,
        },
      }));

      const bullGPS = trend === 'BULL' && h4Trend === 'BULL';
      const bearGPS = trend === 'BEAR' && h4Trend === 'BEAR';
      const newSignals: SignalAlert[] = [];

      const addSignal = (direction: 'LONG' | 'SHORT', strategy: string, leverage: number, reason: string) => {
        const { sl, tp1, tp2, tp3 } = calcSlTp(price, direction, atr);
        const id = `${symbol}-${strategy}-${direction}-${Math.floor(Date.now() / 60000)}`;
        if (!seenIds.current.has(id)) {
          seenIds.current.add(id);
          newSignals.push({ id, symbol, direction, price, sl, tp1, tp2, tp3, strategy, leverage, rsi6: currRsi, h4Trend, reason, ts: Date.now() });
        }
      };

      const near200 = Math.abs(price - curr200) / curr200 < 0.002;
      const near9 = Math.abs(price - curr9) / curr9 < 0.001;
      const near21 = Math.abs(price - curr21) / curr21 < 0.001;
      const nearAnyEma = near200 || near9 || near21;

      // ── Estratégia 1: Muralha & Suporte 200
      if (near200 && bullGPS && currRsi < 30) {
        addSignal('LONG', 'Muralha 200', 50, `🏰 EMA200 como suporte institucional | RSI(6): ${currRsi.toFixed(0)}`);
      }
      if (near200 && bearGPS && currRsi > 70) {
        addSignal('SHORT', 'Muralha 200', 50, `🏰 EMA200 como resistência institucional | RSI(6): ${currRsi.toFixed(0)}`);
      }

      // ── Estratégia 2: Surfe 200 (rompimento com volume)
      const crossedAbove200 = prevClose < prevEma200 && price > curr200;
      const crossedBelow200 = prevClose > prevEma200 && price < curr200;
      const lastCandle = candles15m[last];
      const bigVolume = lastCandle.volume > avgVol * 2;

      if (crossedAbove200 && bigVolume && h4Trend === 'BULL') {
        addSignal('LONG', 'Surfe 200', 25, `🌊 Rompimento acima da EMA200 com volume ${(lastCandle.volume / avgVol).toFixed(1)}x`);
      }
      if (crossedBelow200 && bigVolume && h4Trend === 'BEAR') {
        addSignal('SHORT', 'Surfe 200', 25, `🌊 Rompimento abaixo da EMA200 com volume ${(lastCandle.volume / avgVol).toFixed(1)}x`);
      }

      // ── Estratégia 3: Onda SAR Parabólico
      const sarFlippedUp = prevSar && !prevSar.isLong && currSar?.isLong;
      const sarFlippedDown = prevSar && prevSar.isLong && !currSar?.isLong;

      if (sarFlippedUp && bullGPS) {
        addSignal('LONG', 'Onda SAR', 25, '📡 SAR Parabólico virou para cima — nova onda de alta');
      }
      if (sarFlippedDown && bearGPS) {
        addSignal('SHORT', 'Onda SAR', 25, '📡 SAR Parabólico virou para baixo — nova onda de queda');
      }

      // ── Estratégia 4: Retração 50% Fibonacci
      const prevCandle = candles15m[prev];
      const isStrongCandle = prevCandle.volume > avgVol * 3;
      if (isStrongCandle) {
        const candleRange = Math.abs(prevCandle.close - prevCandle.open);
        const bullishPrev = prevCandle.close > prevCandle.open;
        const fib50 = bullishPrev
          ? prevCandle.open + candleRange * 0.5
          : prevCandle.close + candleRange * 0.5;
        const atFib50 = Math.abs(price - fib50) / fib50 < 0.0015;

        if (atFib50 && bullishPrev && bullGPS) {
          addSignal('LONG', 'Fibonacci 50%', 25, `📐 Retração 50% após vela de força (${(prevCandle.volume / avgVol).toFixed(1)}x vol)`);
        }
        if (atFib50 && !bullishPrev && bearGPS) {
          addSignal('SHORT', 'Fibonacci 50%', 25, `📐 Retração 50% após vela de força (${(prevCandle.volume / avgVol).toFixed(1)}x vol)`);
        }
      }

      // ── Estratégia 5: Exaustão Sniper RSI(6)
      if (nearAnyEma && bullGPS && currRsi < 25) {
        addSignal('LONG', 'Exaustão Sniper', 50, `🎯 RSI(6) em exaustão de venda: ${currRsi.toFixed(0)} — toque na média`);
      }
      if (nearAnyEma && bearGPS && currRsi > 75) {
        addSignal('SHORT', 'Exaustão Sniper', 50, `🎯 RSI(6) em exaustão de compra: ${currRsi.toFixed(0)} — toque na média`);
      }

      if (newSignals.length > 0) {
        setAlerts(prev_ => [...newSignals, ...prev_].slice(0, 50));
        setActiveAlert(newSignals[0]);
        playBeep(newSignals[0].direction);
        for (const sig of newSignals) sendTelegramAlert(sig);
      }
    } catch (_) {
      setCoins(prev_ => ({
        ...prev_,
        [symbol]: { ...prev_[symbol], loading: false, error: true },
      }));
    }
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
    runScan();
    intervalRef.current = setInterval(runScan, SCAN_INTERVAL_MS);
    countdownRef.current = setInterval(() => {
      setNextScanIn(n => Math.max(0, n - 1));
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [runScan]);

  const fmt = (n: number) => n > 1 ? n.toFixed(2) : n.toFixed(6);

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-2 gap-2 relative">

      {activeAlert && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setActiveAlert(null)}
        >
          <div
            className={cn(
              "relative rounded-2xl border-2 p-8 min-w-[380px] text-center shadow-2xl",
              activeAlert.direction === 'LONG'
                ? "border-green-400 bg-green-950/90 shadow-green-500/30"
                : "border-red-400 bg-red-950/90 shadow-red-500/30"
            )}
            onClick={e => e.stopPropagation()}
          >
            <div className="text-xs font-bold text-yellow-400 mb-1 tracking-widest">
              {strategyEmoji[activeAlert.strategy] || '⚡'} {activeAlert.strategy.toUpperCase()}
            </div>
            <div className={cn("text-5xl font-black mb-2", activeAlert.direction === 'LONG' ? "text-green-400" : "text-red-400")}>
              {activeAlert.direction === 'LONG' ? '▲ LONGA' : '▼ CURTA'}
            </div>
            <div className="text-3xl font-bold text-white mb-1">{activeAlert.symbol}-USDT-SWAP</div>
            <div className="text-sm text-muted-foreground mb-1">
              GPS H4: <span className={cn("font-bold", activeAlert.h4Trend === 'BULL' ? "text-green-400" : "text-red-400")}>{activeAlert.h4Trend}</span>
              {' · '}RSI(6): <span className="font-bold text-yellow-400">{activeAlert.rsi6.toFixed(0)}</span>
              {' · '}<span className="font-bold text-primary">{activeAlert.leverage}x</span>
            </div>
            <div className="text-lg text-muted-foreground mb-3">Entrada: <span className="font-bold text-white">${fmt(activeAlert.price)}</span></div>
            <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
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
            <div className="text-red-400 font-bold text-sm mb-3">🛡️ SL: ${fmt(activeAlert.sl)}</div>
            <div className="text-xs text-muted-foreground mb-1">M15 · {activeAlert.reason}</div>
            <div className="text-xs text-yellow-400 font-bold mb-4">⚠️ Ao atingir TP1, mova o SL para o ponto de entrada!</div>
            <button
              onClick={() => setActiveAlert(null)}
              className="px-6 py-2 rounded-lg bg-white/10 text-white hover:bg-white/20 text-sm font-bold transition-colors"
            >
              FECHAR
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 shrink-0">
        <div className="flex-1">
          <h2 className="text-sm font-black text-primary tracking-widest">CRYPTOSNIPER PRO · OKX SWAP · 5 ESTRATÉGIAS</h2>
          <p className="text-xs text-muted-foreground">GPS: H4+M15 · EMA 9/21/200 · RSI(6) · SAR · Fibonacci · 6 Ativos · Auto 30s</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {lastScan && (
            <span className="text-xs text-muted-foreground">
              Última: {lastScan.toLocaleTimeString('pt-BR')}
            </span>
          )}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-900/40 border border-green-500/50 text-green-300 text-xs font-black">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
            ATIVO · {nextScanIn}s
          </div>
        </div>
      </div>

      <div className="flex-1 flex gap-2 overflow-hidden min-h-0">
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 gap-1">
            {MONITOR_SYMBOLS.map(symbol => {
              const c = coins[symbol];
              const h4Color = c.h4Trend === 'BULL' ? 'text-green-400' : c.h4Trend === 'BEAR' ? 'text-red-400' : 'text-muted-foreground';
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
                      <div className={cn("text-[10px] font-bold", h4Color)}>
                        {c.loading ? '' : `H4 ${c.h4Trend}`}
                      </div>
                    </div>

                    <div className="w-24 shrink-0">
                      {c.error ? (
                        <span className="text-xs text-red-400">Erro</span>
                      ) : c.loading ? (
                        <div className="h-4 w-20 bg-white/10 rounded animate-pulse" />
                      ) : (
                        <span className="font-bold text-white text-sm">${fmt(c.price)}</span>
                      )}
                    </div>

                    {!c.loading && !c.error && (
                      <div className="flex-1 grid grid-cols-4 gap-2 text-xs">
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
                    )}

                    {!c.loading && !c.error && (
                      <div className="shrink-0 w-24 text-right">
                        <span className={cn(
                          "text-[10px] font-black px-2 py-1 rounded",
                          c.trend === 'BULL' ? "bg-green-900/50 text-green-400" :
                          c.trend === 'BEAR' ? "bg-red-900/50 text-red-400" : "bg-white/5 text-muted-foreground"
                        )}>
                          {c.price > c.ema200 ? '▲ ACIMA' : '▼ ABAIXO'}
                        </span>
                        <div className={cn("text-[10px] mt-1 font-bold",
                          c.ema9 > c.ema21 ? "text-green-400" : "text-red-400"
                        )}>
                          {c.ema9 > c.ema21 ? '9>21 ▲' : '9<21 ▼'}
                        </div>
                        <div className={cn("text-[10px] font-bold",
                          c.sarIsLong ? "text-green-400" : "text-red-400"
                        )}>
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

        <div className="w-72 shrink-0 flex flex-col gap-2">
          <div className="text-xs font-black text-muted-foreground tracking-widest flex items-center gap-2">
            ALERTAS SNIPER
            {alerts.length > 0 && (
              <span className="bg-primary/20 text-primary rounded px-1.5 py-0.5">{alerts.length}</span>
            )}
          </div>
          <div className="flex-1 overflow-y-auto flex flex-col gap-1">
            {alerts.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center mt-8">
                Varrendo mercado OKX...<br />
                <span className="text-[10px]">5 estratégias ativas</span>
              </div>
            ) : (
              alerts.map(a => (
                <button
                  key={a.id}
                  onClick={() => setActiveAlert(a)}
                  className={cn(
                    "w-full text-left p-3 rounded-lg border transition-colors",
                    a.direction === 'LONG'
                      ? "border-green-500/40 bg-green-900/20 hover:bg-green-900/40"
                      : "border-red-500/40 bg-red-900/20 hover:bg-red-900/40"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className={cn("font-black text-sm", a.direction === 'LONG' ? "text-green-400" : "text-red-400")}>
                      {a.direction === 'LONG' ? '▲' : '▼'} {a.symbol}
                    </span>
                    <span className="text-[10px] font-bold text-primary">{a.leverage}x</span>
                  </div>
                  <div className="text-[10px] text-yellow-400 font-bold">
                    {strategyEmoji[a.strategy] || '⚡'} {a.strategy}
                  </div>
                  <div className="text-xs text-white mt-0.5">${fmt(a.price)}</div>
                  <div className="flex gap-2 text-[10px] mt-1">
                    <span className="text-red-400">SL {fmt(a.sl)}</span>
                    <span className="text-green-400">TP1 {fmt(a.tp1)}</span>
                    <span className="text-green-400/60">TP3 {fmt(a.tp3)}</span>
                  </div>
                  <div className="flex gap-2 text-[10px] mt-0.5">
                    <span className={cn("font-bold", a.h4Trend === 'BULL' ? "text-green-400" : "text-red-400")}>
                      H4:{a.h4Trend}
                    </span>
                    <span className={cn("font-bold",
                      a.rsi6 < 25 ? "text-green-400" : a.rsi6 > 75 ? "text-red-400" : "text-yellow-400"
                    )}>
                      RSI:{a.rsi6.toFixed(0)}
                    </span>
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
