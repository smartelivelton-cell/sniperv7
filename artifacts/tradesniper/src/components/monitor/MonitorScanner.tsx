import { useState, useEffect, useRef, useCallback } from 'react';
import { GlassCard } from '../ui/PremiumComponents';
import { cn } from '@/lib/utils';
import { calculateEMA, calculateATR, parseOKXCandles, calcSlTp, type Candle } from '@/lib/ema';

const MONITOR_SYMBOLS = ['BTC', 'ETH', 'SOL', 'DOGE', 'ZEC', 'ICX', 'OP', 'QTUM', 'AXS', 'AVAX'];
const SCAN_INTERVAL_MS = 30_000;

interface SignalAlert {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  price: number;
  sl: number;
  tp: number;
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
        tp: signal.tp,
      }),
    });
  } catch (_) {}
}

async function sendActivationMessage() {
  try {
    await fetch(`${BASE}/api/telegram/activate`, { method: 'POST' });
  } catch (_) {}
}

export function MonitorScanner() {
  const [coins, setCoins] = useState<Record<string, CoinState>>(() => {
    const init: Record<string, CoinState> = {};
    for (const s of MONITOR_SYMBOLS) {
      init[s] = { symbol: s, price: 0, ema9: 0, ema21: 0, ema200: 0, trend: 'NEUTRAL', loading: true, error: false };
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
      const candles15m = await fetchKlines(symbol, '15m', 300);

      const closes = candles15m.map(c => c.close);
      const ema9arr = calculateEMA(closes, 9);
      const ema21arr = calculateEMA(closes, 21);
      const ema200arr = calculateEMA(closes, 200);

      const last = closes.length - 1;
      const prev = last - 1;
      const price = closes[last];
      const atr = calculateATR(candles15m.slice(-20), 14);

      const curr9 = ema9arr[last];
      const curr21 = ema21arr[last];
      const curr200 = ema200arr[last];
      const prev9 = ema9arr[prev];
      const prev21 = ema21arr[prev];

      const trend: 'BULL' | 'BEAR' | 'NEUTRAL' =
        price > curr200 ? 'BULL' : price < curr200 ? 'BEAR' : 'NEUTRAL';

      setCoins(prev => ({
        ...prev,
        [symbol]: { symbol, price, ema9: curr9, ema21: curr21, ema200: curr200, trend, loading: false, error: false },
      }));

      const bullTrend = price > curr200;
      const bearTrend = price < curr200;
      const crossedUp = prev9 < prev21 && curr9 > curr21;
      const crossedDown = prev9 > prev21 && curr9 < curr21;
      const near200 = Math.abs(price - curr200) / curr200 < 0.001;

      const newSignals: SignalAlert[] = [];

      const addSignal = (direction: 'LONG' | 'SHORT', reason: string) => {
        const { sl, tp } = calcSlTp(price, direction, atr);
        const id = `${symbol}-${direction}-15m-${Math.floor(Date.now() / 60000)}`;
        if (!seenIds.current.has(id)) {
          seenIds.current.add(id);
          newSignals.push({ id, symbol, direction, price, sl, tp, reason, ts: Date.now() });
        }
      };

      if (crossedUp && bullTrend) addSignal('LONG', `EMA9 cruzou EMA21 ↑ (acima da EMA200)`);
      else if (crossedDown && bearTrend) addSignal('SHORT', `EMA9 cruzou EMA21 ↓ (abaixo da EMA200)`);
      else if (near200 && bullTrend && curr9 > curr21) addSignal('LONG', `Preço rejeitou EMA200 (suporte)`);
      else if (near200 && bearTrend && curr9 < curr21) addSignal('SHORT', `Preço rejeitou EMA200 (resistência)`);

      if (newSignals.length > 0) {
        setAlerts(prev => [...newSignals, ...prev].slice(0, 50));
        setActiveAlert(newSignals[0]);
        playBeep(newSignals[0].direction);
        for (const sig of newSignals) sendTelegramAlert(sig);
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
            <div className="text-3xl font-bold text-white mb-1">{activeAlert.symbol}-USDT-SWAP</div>
            <div className="text-lg text-muted-foreground mb-4">Entrada: <span className="font-bold text-white">${fmt(activeAlert.price)}</span></div>
            <div className="flex justify-center gap-6 mb-4 text-sm">
              <div className="text-red-400 font-bold">SL: ${fmt(activeAlert.sl)}</div>
              <div className="text-green-400 font-bold">TP: ${fmt(activeAlert.tp)}</div>
            </div>
            <div className="text-xs text-muted-foreground mb-1">M15 · {activeAlert.reason}</div>
            <div className="text-xs text-yellow-400 font-bold mb-4">⚠️ Confirme a rejeição na média antes de entrar com 50x!</div>
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
          <h2 className="text-sm font-black text-primary tracking-widest">SCANNER MULTILATERAL · OKX SWAP</h2>
          <p className="text-xs text-muted-foreground">EMA 9/21 vs EMA 200 · M15 · 11 Contratos · 50x Alavancagem · Auto 30s</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {lastScan && (
            <span className="text-xs text-muted-foreground">
              Última varredura: {lastScan.toLocaleTimeString('pt-BR')}
            </span>
          )}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-900/40 border border-green-500/50 text-green-300 text-xs font-black">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
            ATIVO · próxima em {nextScanIn}s
          </div>
        </div>
      </div>

      <div className="flex-1 flex gap-2 overflow-hidden min-h-0">
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
                        {c.loading ? '...' : c.trend}
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
                      <div className="flex-1 grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <div className="text-muted-foreground text-[10px]">EMA9 M15</div>
                          <div className={cn("font-mono", c.price > c.ema9 ? "text-green-400" : "text-red-400")}>{fmt(c.ema9)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-[10px]">EMA21 M15</div>
                          <div className={cn("font-mono", c.price > c.ema21 ? "text-green-400" : "text-red-400")}>{fmt(c.ema21)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-[10px]">EMA200 M15</div>
                          <div className={cn("font-mono", c.price > c.ema200 ? "text-green-400" : "text-red-400")}>{fmt(c.ema200)}</div>
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
                        <div className={cn("text-[10px] mt-1 font-bold",
                          c.ema9 > c.ema21 ? "text-green-400" : "text-red-400"
                        )}>
                          {c.ema9 > c.ema21 ? '9>21 ▲' : '9<21 ▼'}
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
                Varrendo o mercado OKX...
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
                    <span className="text-[10px] text-muted-foreground">M15</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{a.reason}</div>
                  <div className="text-xs text-white mt-0.5">${fmt(a.price)}</div>
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
