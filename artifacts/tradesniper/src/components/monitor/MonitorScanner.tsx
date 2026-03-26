import { useState, useEffect, useRef, useCallback } from 'react';
import { GlassCard } from '../ui/PremiumComponents';
import { cn } from '@/lib/utils';
import { calculateEMA, calculateATR, parseBinanceKlines, calcSlTp, type Candle } from '@/lib/ema';

const MONITOR_SYMBOLS = ['BTC', 'ETH', 'SOL', 'DOGE', 'ZEC', 'CHR', 'ICX', 'OP', 'QTUM', 'AXS', 'AVAX'];
const TIMEFRAMES = ['15m', '1h'] as const;
type TF = typeof TIMEFRAMES[number];

interface SignalAlert {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  price: number;
  sl: number;
  tp: number;
  tf: TF;
  reason: string;
  ts: number;
}

interface CoinState {
  symbol: string;
  price: number;
  ema9_15m: number;
  ema21_15m: number;
  ema200_15m: number;
  ema9_1h: number;
  ema21_1h: number;
  ema200_1h: number;
  trend: 'BULL' | 'BEAR' | 'NEUTRAL';
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
  const url = `${BASE}/api/monitor/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  return parseBinanceKlines(raw);
}

export function MonitorScanner() {
  const [coins, setCoins] = useState<Record<string, CoinState>>(() => {
    const init: Record<string, CoinState> = {};
    for (const s of MONITOR_SYMBOLS) {
      init[s] = { symbol: s, price: 0, ema9_15m: 0, ema21_15m: 0, ema200_15m: 0, ema9_1h: 0, ema21_1h: 0, ema200_1h: 0, trend: 'NEUTRAL', loading: true, error: false };
    }
    return init;
  });
  const [alerts, setAlerts] = useState<SignalAlert[]>([]);
  const [activeAlert, setActiveAlert] = useState<SignalAlert | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [lastScan, setLastScan] = useState<Date | null>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scanCoin = useCallback(async (symbol: string) => {
    try {
      const [candles15m, candles1h] = await Promise.all([
        fetchKlines(symbol, '15m', 300),
        fetchKlines(symbol, '1h', 300),
      ]);

      const closes15m = candles15m.map(c => c.close);
      const closes1h = candles1h.map(c => c.close);

      const ema9_15m = calculateEMA(closes15m, 9);
      const ema21_15m = calculateEMA(closes15m, 21);
      const ema200_15m = calculateEMA(closes15m, 200);

      const ema9_1h = calculateEMA(closes1h, 9);
      const ema21_1h = calculateEMA(closes1h, 21);
      const ema200_1h = calculateEMA(closes1h, 200);

      const last15 = closes15m.length - 1;
      const prev15 = last15 - 1;
      const last1h = closes1h.length - 1;
      const price = closes15m[last15];
      const atr = calculateATR(candles15m.slice(-20), 14);

      const curr9_15 = ema9_15m[last15];
      const curr21_15 = ema21_15m[last15];
      const curr200_15 = ema200_15m[last15];
      const prev9_15 = ema9_15m[prev15];
      const prev21_15 = ema21_15m[prev15];

      const curr9_1h = ema9_1h[last1h];
      const curr21_1h = ema21_1h[last1h];
      const curr200_1h = ema200_1h[last1h];

      const trend: 'BULL' | 'BEAR' | 'NEUTRAL' =
        price > curr200_15 ? 'BULL' : price < curr200_15 ? 'BEAR' : 'NEUTRAL';

      setCoins(prev => ({
        ...prev,
        [symbol]: {
          symbol,
          price,
          ema9_15m: curr9_15,
          ema21_15m: curr21_15,
          ema200_15m: curr200_15,
          ema9_1h: curr9_1h,
          ema21_1h: curr21_1h,
          ema200_1h: curr200_1h,
          trend,
          loading: false,
          error: false,
        },
      }));

      const newSignals: SignalAlert[] = [];

      const checkCross = (tf: TF, curr9: number, curr21: number, prev9: number, prev21: number, curr200: number, currPrice: number) => {
        const bullTrend = currPrice > curr200;
        const bearTrend = currPrice < curr200;
        const near200 = Math.abs(currPrice - curr200) / curr200 < 0.001;

        const crossedUp = prev9 < prev21 && curr9 > curr21;
        const crossedDown = prev9 > prev21 && curr9 < curr21;

        if (crossedUp && bullTrend) {
          const { sl, tp } = calcSlTp(currPrice, 'LONG', atr);
          return { direction: 'LONG' as const, reason: `EMA9 cruzou EMA21 para cima no ${tf}`, sl, tp };
        }
        if (crossedDown && bearTrend) {
          const { sl, tp } = calcSlTp(currPrice, 'SHORT', atr);
          return { direction: 'SHORT' as const, reason: `EMA9 cruzou EMA21 para baixo no ${tf}`, sl, tp };
        }
        if (near200 && bullTrend && curr9 > curr21) {
          const { sl, tp } = calcSlTp(currPrice, 'LONG', atr);
          return { direction: 'LONG' as const, reason: `Preço próximo da EMA200 (suporte) no ${tf}`, sl, tp };
        }
        if (near200 && bearTrend && curr9 < curr21) {
          const { sl, tp } = calcSlTp(currPrice, 'SHORT', atr);
          return { direction: 'SHORT' as const, reason: `Preço próximo da EMA200 (resistência) no ${tf}`, sl, tp };
        }
        return null;
      };

      const s15 = checkCross('15m', curr9_15, curr21_15, prev9_15, prev21_15, curr200_15, price);
      if (s15) {
        const id = `${symbol}-${s15.direction}-15m-${Math.floor(Date.now() / 60000)}`;
        if (!seenIds.current.has(id)) {
          seenIds.current.add(id);
          newSignals.push({ id, symbol, direction: s15.direction, price, sl: s15.sl, tp: s15.tp, tf: '15m', reason: s15.reason, ts: Date.now() });
        }
      }

      const s1h = checkCross('1h', curr9_1h, curr21_1h, ema9_1h[last1h - 1], ema21_1h[last1h - 1], curr200_1h, price);
      if (s1h) {
        const id = `${symbol}-${s1h.direction}-1h-${Math.floor(Date.now() / 3600000)}`;
        if (!seenIds.current.has(id)) {
          seenIds.current.add(id);
          newSignals.push({ id, symbol, direction: s1h.direction, price, sl: s1h.sl, tp: s1h.tp, tf: '1h', reason: s1h.reason, ts: Date.now() });
        }
      }

      if (newSignals.length > 0) {
        setAlerts(prev => [...newSignals, ...prev].slice(0, 50));
        setActiveAlert(newSignals[0]);
        playBeep(newSignals[0].direction);
      }
    } catch (_) {
      setCoins(prev => ({
        ...prev,
        [symbol]: { ...prev[symbol], loading: false, error: true },
      }));
    }
  }, []);

  const runScan = useCallback(async () => {
    await Promise.allSettled(MONITOR_SYMBOLS.map(s => scanCoin(s)));
    setLastScan(new Date());
  }, [scanCoin]);

  useEffect(() => {
    if (!isRunning) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    runScan();
    intervalRef.current = setInterval(runScan, 60_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isRunning, runScan]);

  const fmt = (n: number) => n > 1 ? n.toFixed(2) : n.toFixed(6);

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-2 gap-2 relative">

      {/* Alert popup overlay */}
      {activeAlert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setActiveAlert(null)}>
          <div
            className={cn(
              "relative rounded-2xl border-2 p-8 min-w-[340px] text-center shadow-2xl",
              activeAlert.direction === 'LONG'
                ? "border-green-400 bg-green-950/90 shadow-green-500/30"
                : "border-red-400 bg-red-950/90 shadow-red-500/30"
            )}
            onClick={e => e.stopPropagation()}
          >
            <div className={cn("text-5xl font-black mb-2", activeAlert.direction === 'LONG' ? "text-green-400" : "text-red-400")}>
              {activeAlert.direction === 'LONG' ? '▲ LONGA' : '▼ CURTA'}
            </div>
            <div className="text-3xl font-bold text-white mb-1">{activeAlert.symbol}USDT</div>
            <div className="text-lg text-muted-foreground mb-4">Entrada: <span className="font-bold text-white">${fmt(activeAlert.price)}</span></div>
            <div className="flex justify-center gap-6 mb-4 text-sm">
              <div className="text-red-400 font-bold">SL: ${fmt(activeAlert.sl)}</div>
              <div className="text-green-400 font-bold">TP: ${fmt(activeAlert.tp)}</div>
            </div>
            <div className="text-xs text-muted-foreground mb-1">{activeAlert.tf.toUpperCase()} · {activeAlert.reason}</div>
            <div className="text-xs text-muted-foreground mb-4">50x · Banca $187.50</div>
            <button
              onClick={() => setActiveAlert(null)}
              className="px-6 py-2 rounded-lg bg-white/10 text-white hover:bg-white/20 text-sm font-bold transition-colors"
            >
              FECHAR
            </button>
          </div>
        </div>
      )}

      {/* Header bar */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="flex-1">
          <h2 className="text-sm font-black text-primary tracking-widest">SCANNER MULTILATERAL</h2>
          <p className="text-xs text-muted-foreground">EMA 9/21/200 · M15 & H1 · 11 Pares · 50x Alavancagem</p>
        </div>
        {lastScan && (
          <span className="text-xs text-muted-foreground">
            Última varredura: {lastScan.toLocaleTimeString('pt-BR')}
          </span>
        )}
        <button
          onClick={() => setIsRunning(r => !r)}
          className={cn(
            "px-4 py-2 rounded-lg text-xs font-black tracking-widest transition-all border",
            isRunning
              ? "bg-red-900/50 border-red-500 text-red-300 hover:bg-red-900"
              : "bg-green-900/50 border-green-500 text-green-300 hover:bg-green-900"
          )}
        >
          {isRunning ? '⏹ PARAR' : '▶ INICIAR MONITORAMENTO'}
        </button>
      </div>

      <div className="flex-1 flex gap-2 overflow-hidden min-h-0">
        {/* Coin status grid */}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 gap-1">
            {MONITOR_SYMBOLS.map(symbol => {
              const c = coins[symbol];
              return (
                <GlassCard key={symbol} className="p-3">
                  <div className="flex items-center gap-3">
                    {/* Symbol */}
                    <div className="w-16 shrink-0">
                      <div className="font-black text-sm text-white">{symbol}</div>
                      <div className={cn("text-xs font-bold",
                        c.trend === 'BULL' ? "text-green-400" : c.trend === 'BEAR' ? "text-red-400" : "text-muted-foreground"
                      )}>
                        {c.loading ? '...' : c.trend}
                      </div>
                    </div>

                    {/* Price */}
                    <div className="w-24 shrink-0">
                      {c.error ? (
                        <span className="text-xs text-red-400">Erro de dados</span>
                      ) : c.loading ? (
                        <div className="h-4 w-20 bg-white/10 rounded animate-pulse" />
                      ) : (
                        <span className="font-bold text-white text-sm">${fmt(c.price)}</span>
                      )}
                    </div>

                    {/* EMA values M15 */}
                    {!c.loading && !c.error && (
                      <>
                        <div className="flex-1 grid grid-cols-3 gap-2 text-xs">
                          <div>
                            <div className="text-muted-foreground text-[10px]">EMA9 M15</div>
                            <div className={cn("font-mono", c.price > c.ema9_15m ? "text-green-400" : "text-red-400")}>{fmt(c.ema9_15m)}</div>
                          </div>
                          <div>
                            <div className="text-muted-foreground text-[10px]">EMA21 M15</div>
                            <div className={cn("font-mono", c.price > c.ema21_15m ? "text-green-400" : "text-red-400")}>{fmt(c.ema21_15m)}</div>
                          </div>
                          <div>
                            <div className="text-muted-foreground text-[10px]">EMA200 M15</div>
                            <div className={cn("font-mono", c.price > c.ema200_15m ? "text-green-400" : "text-red-400")}>{fmt(c.ema200_15m)}</div>
                          </div>
                        </div>

                        <div className="flex-1 grid grid-cols-3 gap-2 text-xs">
                          <div>
                            <div className="text-muted-foreground text-[10px]">EMA9 H1</div>
                            <div className={cn("font-mono", c.price > c.ema9_1h ? "text-green-400" : "text-red-400")}>{fmt(c.ema9_1h)}</div>
                          </div>
                          <div>
                            <div className="text-muted-foreground text-[10px]">EMA21 H1</div>
                            <div className={cn("font-mono", c.price > c.ema21_1h ? "text-green-400" : "text-red-400")}>{fmt(c.ema21_1h)}</div>
                          </div>
                          <div>
                            <div className="text-muted-foreground text-[10px]">EMA200 H1</div>
                            <div className={cn("font-mono", c.price > c.ema200_1h ? "text-green-400" : "text-red-400")}>{fmt(c.ema200_1h)}</div>
                          </div>
                        </div>
                      </>
                    )}

                    {/* Trend badge */}
                    {!c.loading && !c.error && (
                      <div className="shrink-0 w-16 text-right">
                        <span className={cn(
                          "text-[10px] font-black px-2 py-1 rounded",
                          c.trend === 'BULL' ? "bg-green-900/50 text-green-400" :
                          c.trend === 'BEAR' ? "bg-red-900/50 text-red-400" : "bg-white/5 text-muted-foreground"
                        )}>
                          {c.price > c.ema200_15m ? '▲ ACIMA' : '▼ ABAIXO'}
                        </span>
                      </div>
                    )}
                  </div>
                </GlassCard>
              );
            })}
          </div>
        </div>

        {/* Alerts panel */}
        <div className="w-72 shrink-0 flex flex-col gap-2">
          <div className="text-xs font-black text-muted-foreground tracking-widest">ALERTAS RECENTES</div>
          <div className="flex-1 overflow-y-auto flex flex-col gap-1">
            {alerts.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center mt-8">
                {isRunning ? 'Varrendo o mercado...' : 'Clique em INICIAR para monitorar'}
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
                    <span className="text-[10px] text-muted-foreground">{a.tf.toUpperCase()}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">${fmt(a.price)}</div>
                  <div className="flex gap-2 text-[10px] mt-1">
                    <span className="text-red-400">SL {fmt(a.sl)}</span>
                    <span className="text-green-400">TP {fmt(a.tp)}</span>
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
