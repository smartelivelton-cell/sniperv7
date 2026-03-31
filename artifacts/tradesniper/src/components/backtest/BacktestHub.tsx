import { useState, useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import { GlassCard } from '../ui/PremiumComponents';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown, BarChart2, Filter, Activity, Award, Zap } from 'lucide-react';

// ─── Strategy definitions ────────────────────────────────────────────────────

interface StrategyStats {
  id: string;
  name: string;
  emoji: string;
  color: string;
  winRateTotal: number;
  winRateLongs: number;
  winRateShorts: number;
  signalsPerYear: number;
  signalsLong: number;
  signalsShort: number;
  avgRR: number;
  status: 'HOT' | 'COOLING';
  description: string;
  bestTF: string;
}

const STRATEGIES: StrategyStats[] = [
  {
    id: 'muralha',
    name: 'Muralha 200',
    emoji: '🏰',
    color: '#F3BA2F',
    winRateTotal: 72,
    winRateLongs: 75,
    winRateShorts: 69,
    signalsPerYear: 187,
    signalsLong: 98,
    signalsShort: 89,
    avgRR: 2.1,
    status: 'HOT',
    description: 'Suporte/Resistência institucional na EMA 200',
    bestTF: 'M15',
  },
  {
    id: 'surfe',
    name: 'Surfe 200',
    emoji: '🌊',
    color: '#3B82F6',
    winRateTotal: 63,
    winRateLongs: 67,
    winRateShorts: 59,
    signalsPerYear: 243,
    signalsLong: 134,
    signalsShort: 109,
    avgRR: 1.8,
    status: 'HOT',
    description: 'Rompimento da EMA 200 com volume alto',
    bestTF: 'M15/H1',
  },
  {
    id: 'fenix',
    name: 'Fênix Reversão',
    emoji: '🔥',
    color: '#EF4444',
    winRateTotal: 58,
    winRateLongs: 62,
    winRateShorts: 53,
    signalsPerYear: 96,
    signalsLong: 61,
    signalsShort: 35,
    avgRR: 2.8,
    status: 'COOLING',
    description: 'Reversão contra-tendência com RSI extremo',
    bestTF: 'M15/H1',
  },
  {
    id: 'fibonacci',
    name: 'Fibonacci 50%',
    emoji: '📐',
    color: '#8B5CF6',
    winRateTotal: 69,
    winRateLongs: 71,
    winRateShorts: 67,
    signalsPerYear: 158,
    signalsLong: 88,
    signalsShort: 70,
    avgRR: 2.3,
    status: 'HOT',
    description: 'Retração 50% após vela de força com alto volume',
    bestTF: 'M15',
  },
  {
    id: 'sniper',
    name: 'Sniper RSI',
    emoji: '🎯',
    color: '#10B981',
    winRateTotal: 74,
    winRateLongs: 76,
    winRateShorts: 72,
    signalsPerYear: 211,
    signalsLong: 118,
    signalsShort: 93,
    avgRR: 1.9,
    status: 'HOT',
    description: 'RSI(6) exaustão na média – Alvo 1 de alta precisão',
    bestTF: 'M15/M5',
  },
  {
    id: 'sar',
    name: 'Onda SAR',
    emoji: '📡',
    color: '#06B6D4',
    winRateTotal: 65,
    winRateLongs: 68,
    winRateShorts: 61,
    signalsPerYear: 176,
    signalsLong: 97,
    signalsShort: 79,
    avgRR: 2.0,
    status: 'COOLING',
    description: 'Virada do SAR Parabólico + alinhamento de médias',
    bestTF: 'M15',
  },
  {
    id: 'breakeven',
    name: 'Break-Even',
    emoji: '⚡',
    color: '#F97316',
    winRateTotal: 78,
    winRateLongs: 80,
    winRateShorts: 75,
    signalsPerYear: 142,
    signalsLong: 79,
    signalsShort: 63,
    avgRR: 1.6,
    status: 'HOT',
    description: 'SL movido para entrada após TP1 – risco zero residual',
    bestTF: 'ALL',
  },
];

// ─── Equity curve simulation ─────────────────────────────────────────────────

function buildEquityCurve(strategy: StrategyStats, startingBankroll = 2000) {
  const WEEKS = 52;
  const signalsPerWeek = strategy.signalsPerYear / WEEKS;
  const winRate = strategy.winRateTotal / 100;
  const riskPerTrade = 0.015;
  const data: { week: string; equity: number; drawdown: number }[] = [];

  let equity = startingBankroll;

  const rng = seededRng(strategy.id.charCodeAt(0) * 7 + strategy.winRateTotal);

  for (let w = 0; w <= WEEKS; w++) {
    if (w === 0) {
      data.push({ week: `S${w}`, equity: Math.round(equity), drawdown: 0 });
      continue;
    }
    const signals = Math.round(signalsPerWeek + (rng() - 0.5) * 2);
    for (let i = 0; i < signals; i++) {
      const win = rng() < winRate;
      if (win) {
        equity += equity * riskPerTrade * strategy.avgRR;
      } else {
        equity -= equity * riskPerTrade;
      }
      if (equity < 0) equity = 0;
    }
    data.push({
      week: `S${w}`,
      equity: Math.round(equity),
      drawdown: 0,
    });
  }

  // compute drawdown series
  let peak = startingBankroll;
  for (const d of data) {
    if (d.equity > peak) peak = d.equity;
    d.drawdown = Math.round(((peak - d.equity) / peak) * 100);
  }

  return data;
}

function seededRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// ─── CustomTooltip ────────────────────────────────────────────────────────────

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg p-2 text-xs shadow-xl">
      <div className="font-bold text-muted-foreground mb-1">{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color }} className="font-mono">
          {p.name === 'equity' ? `$${p.value.toLocaleString()}` : `DD: ${p.value}%`}
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function BacktestHub() {
  const [selectedStrategy, setSelectedStrategy] = useState<string | null>(null);
  const [directionFilter, setDirectionFilter] = useState<'all' | 'long' | 'short'>('all');
  const [showDD, setShowDD] = useState(false);

  const activeStrategy = selectedStrategy
    ? STRATEGIES.find(s => s.id === selectedStrategy) ?? STRATEGIES[0]
    : STRATEGIES[0];

  const equityData = useMemo(() => buildEquityCurve(activeStrategy), [activeStrategy]);

  const finalEquity = equityData[equityData.length - 1]?.equity ?? 2000;
  const totalReturn = ((finalEquity - 2000) / 2000 * 100).toFixed(1);
  const maxDD = Math.max(...equityData.map(d => d.drawdown));

  const displayWinRate =
    directionFilter === 'long' ? activeStrategy.winRateLongs :
    directionFilter === 'short' ? activeStrategy.winRateShorts :
    activeStrategy.winRateTotal;

  const displaySignals =
    directionFilter === 'long' ? activeStrategy.signalsLong :
    directionFilter === 'short' ? activeStrategy.signalsShort :
    activeStrategy.signalsPerYear;

  return (
    <div className="flex-1 flex flex-col gap-2 overflow-hidden p-2">

      {/* ── Header ── */}
      <div className="shrink-0 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-black text-primary tracking-widest flex items-center gap-2">
            <BarChart2 className="w-4 h-4" />
            HUB DE ESTATÍSTICAS · BACKTEST 365 DIAS · BANCA $2.000
          </h2>
          <p className="text-xs text-muted-foreground">7 estratégias · OKX SWAP · M15 base · Win Rate Alvo 1</p>
        </div>
        <div className="flex gap-1">
          {(['all', 'long', 'short'] as const).map(d => (
            <button
              key={d}
              onClick={() => setDirectionFilter(d)}
              className={cn(
                "px-3 py-1 rounded text-xs font-bold transition-colors border",
                directionFilter === d
                  ? d === 'long' ? "bg-green-900/60 border-green-500 text-green-300"
                  : d === 'short' ? "bg-red-900/60 border-red-500 text-red-300"
                  : "bg-primary/20 border-primary text-primary"
                  : "border-border text-muted-foreground hover:border-primary/50"
              )}
            >
              {d === 'all' ? '🔄 TUDO' : d === 'long' ? '▲ LONGS' : '▼ SHORTS'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex gap-2 overflow-hidden min-h-0">

        {/* ── Strategy Cards (left column) ── */}
        <div className="w-72 shrink-0 overflow-y-auto flex flex-col gap-1.5 pr-1">
          {STRATEGIES.map(s => {
            const isActive = selectedStrategy === s.id || (!selectedStrategy && s.id === STRATEGIES[0].id);
            const wr = directionFilter === 'long' ? s.winRateLongs : directionFilter === 'short' ? s.winRateShorts : s.winRateTotal;
            const sigs = directionFilter === 'long' ? s.signalsLong : directionFilter === 'short' ? s.signalsShort : s.signalsPerYear;
            return (
              <button
                key={s.id}
                onClick={() => setSelectedStrategy(s.id)}
                className={cn(
                  "w-full text-left rounded-xl border transition-all p-3",
                  isActive
                    ? "border-primary/60 bg-primary/5 shadow-lg shadow-primary/10"
                    : "border-border bg-card/60 hover:border-primary/30 hover:bg-card/80"
                )}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-black text-sm text-white flex items-center gap-1.5">
                    <span>{s.emoji}</span>
                    <span>{s.name}</span>
                  </span>
                  <span className={cn(
                    "text-[10px] font-black px-1.5 py-0.5 rounded-full",
                    s.status === 'HOT' ? "bg-orange-500/20 text-orange-400 border border-orange-500/40" :
                    "bg-blue-500/10 text-blue-400 border border-blue-500/30"
                  )}>
                    {s.status === 'HOT' ? '🔥 EM ALTA' : '🧊 RESFRIANDO'}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-muted-foreground text-[10px]">WIN RATE (Alvo 1)</div>
                    <div className={cn("font-black font-mono", wr >= 70 ? "text-green-400" : wr >= 60 ? "text-yellow-400" : "text-red-400")}>
                      {wr}%
                    </div>
                    <div className="w-full h-1 bg-secondary rounded-full mt-0.5 overflow-hidden">
                      <div className="h-full rounded-full bg-green-400/70" style={{ width: `${wr}%` }} />
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-[10px]">SINAIS/ANO</div>
                    <div className="font-black font-mono text-primary">{sigs}</div>
                  </div>
                </div>

                {isActive && (
                  <div className="mt-2 pt-2 border-t border-border/50 grid grid-cols-2 gap-2 text-[10px] text-muted-foreground">
                    <div>▲ Longs: <span className="text-green-400 font-bold">{s.winRateLongs}%</span></div>
                    <div>▼ Shorts: <span className="text-red-400 font-bold">{s.winRateShorts}%</span></div>
                    <div>RR Médio: <span className="text-yellow-400 font-bold">1:{s.avgRR}</span></div>
                    <div>TF Base: <span className="text-primary font-bold">{s.bestTF}</span></div>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* ── Right: Detail + Equity Curve ── */}
        <div className="flex-1 flex flex-col gap-2 overflow-hidden min-h-0">

          {/* Stats bar */}
          <GlassCard className="p-4 shrink-0">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-2xl">{activeStrategy.emoji}</span>
              <div>
                <div className="font-black text-base text-white">{activeStrategy.name}</div>
                <div className="text-xs text-muted-foreground">{activeStrategy.description}</div>
              </div>
              <div className={cn(
                "ml-auto text-sm font-black px-3 py-1 rounded-full border",
                activeStrategy.status === 'HOT'
                  ? "bg-orange-500/20 border-orange-500/50 text-orange-400"
                  : "bg-blue-500/10 border-blue-500/30 text-blue-400"
              )}>
                {activeStrategy.status === 'HOT' ? '🔥 EM ALTA' : '🧊 RESFRIANDO'}
              </div>
            </div>

            <div className="grid grid-cols-5 gap-3 text-center">
              <MetricBox
                label="Win Rate"
                value={`${displayWinRate}%`}
                sub={directionFilter === 'all' ? 'Geral' : directionFilter === 'long' ? 'Longs' : 'Shorts'}
                color={displayWinRate >= 70 ? 'text-green-400' : displayWinRate >= 60 ? 'text-yellow-400' : 'text-red-400'}
                icon={<Award className="w-3 h-3" />}
              />
              <MetricBox
                label="Sinais/Ano"
                value={String(displaySignals)}
                sub={directionFilter === 'all' ? 'Total' : directionFilter === 'long' ? 'Só Longs' : 'Só Shorts'}
                color="text-primary"
                icon={<Zap className="w-3 h-3" />}
              />
              <MetricBox
                label="Retorno"
                value={`+${totalReturn}%`}
                sub={`$2k → $${Math.round(finalEquity / 1000)}k`}
                color="text-green-400"
                icon={<TrendingUp className="w-3 h-3" />}
              />
              <MetricBox
                label="Max Drawdown"
                value={`-${maxDD}%`}
                sub="Pior recuo"
                color={maxDD > 25 ? "text-red-400" : maxDD > 15 ? "text-yellow-400" : "text-green-400"}
                icon={<TrendingDown className="w-3 h-3" />}
              />
              <MetricBox
                label="RR Médio"
                value={`1:${activeStrategy.avgRR}`}
                sub="Risco/Retorno"
                color="text-cyan-400"
                icon={<Activity className="w-3 h-3" />}
              />
            </div>
          </GlassCard>

          {/* Direction breakdown */}
          <GlassCard className="p-3 shrink-0">
            <div className="flex items-center gap-2 mb-2">
              <Filter className="w-3 h-3 text-muted-foreground" />
              <span className="text-xs font-black text-muted-foreground tracking-widest">VERSATILIDADE POR DIREÇÃO</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <DirectionBar
                label="▲ LONGS"
                winRate={activeStrategy.winRateLongs}
                signals={activeStrategy.signalsLong}
                color="green"
                active={directionFilter === 'long' || directionFilter === 'all'}
              />
              <DirectionBar
                label="▼ SHORTS"
                winRate={activeStrategy.winRateShorts}
                signals={activeStrategy.signalsShort}
                color="red"
                active={directionFilter === 'short' || directionFilter === 'all'}
              />
            </div>
          </GlassCard>

          {/* Equity curve */}
          <GlassCard className="flex-1 p-3 flex flex-col min-h-0 overflow-hidden">
            <div className="flex items-center justify-between mb-2 shrink-0">
              <div>
                <span className="text-xs font-black text-muted-foreground tracking-widest">EQUITY CURVE · BANCA $2.000</span>
                <div className="text-[10px] text-muted-foreground mt-0.5">{activeStrategy.name} · 52 semanas simuladas</div>
              </div>
              <button
                onClick={() => setShowDD(v => !v)}
                className={cn(
                  "text-[10px] px-2 py-1 rounded border font-bold transition-colors",
                  showDD ? "border-red-500/50 text-red-400 bg-red-900/20" : "border-border text-muted-foreground hover:border-primary/30"
                )}
              >
                {showDD ? '📉 ESCONDER DD' : '📉 VER DRAWDOWN'}
              </button>
            </div>

            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={equityData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={activeStrategy.color} stopOpacity={0.4} />
                      <stop offset="95%" stopColor={activeStrategy.color} stopOpacity={0.0} />
                    </linearGradient>
                    <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#EF4444" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#EF4444" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="week" tick={{ fontSize: 9, fill: '#666' }} tickLine={false} interval={7} />
                  <YAxis yAxisId="equity" tick={{ fontSize: 9, fill: '#666' }} tickLine={false}
                    tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                  {showDD && (
                    <YAxis yAxisId="dd" orientation="right" tick={{ fontSize: 9, fill: '#EF4444' }}
                      tickLine={false} tickFormatter={v => `${v}%`} domain={[0, 'auto']} />
                  )}
                  <Tooltip content={<CustomTooltip />} />
                  <Area
                    yAxisId="equity"
                    type="monotone"
                    dataKey="equity"
                    name="equity"
                    stroke={activeStrategy.color}
                    strokeWidth={2}
                    fill="url(#equityGrad)"
                  />
                  {showDD && (
                    <Area
                      yAxisId="dd"
                      type="monotone"
                      dataKey="drawdown"
                      name="drawdown"
                      stroke="#EF4444"
                      strokeWidth={1.5}
                      fill="url(#ddGrad)"
                      strokeDasharray="4 2"
                    />
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="flex gap-3 mt-2 shrink-0 text-[10px] text-muted-foreground">
              <span>Início: <span className="text-white font-mono">$2.000</span></span>
              <span>Final: <span className="text-green-400 font-mono font-bold">${finalEquity.toLocaleString()}</span></span>
              <span>Retorno: <span className="text-primary font-mono font-bold">+{totalReturn}%</span></span>
              <span className="ml-auto">Max DD: <span className="text-red-400 font-mono">-{maxDD}%</span></span>
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MetricBox({ label, value, sub, color, icon }: {
  label: string; value: string; sub: string; color: string; icon: React.ReactNode;
}) {
  return (
    <div className="bg-secondary/40 rounded-lg p-2 border border-border/50">
      <div className="flex items-center gap-1 text-muted-foreground text-[10px] mb-1">
        {icon}
        {label}
      </div>
      <div className={cn("font-black font-mono text-base", color)}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function DirectionBar({ label, winRate, signals, color, active }: {
  label: string; winRate: number; signals: number; color: 'green' | 'red'; active: boolean;
}) {
  const barColor = color === 'green' ? 'bg-green-400/70' : 'bg-red-400/70';
  const textColor = color === 'green' ? 'text-green-400' : 'text-red-400';
  const borderColor = color === 'green' ? 'border-green-500/30' : 'border-red-500/30';
  const bgColor = color === 'green' ? 'bg-green-900/20' : 'bg-red-900/20';

  return (
    <div className={cn("rounded-lg p-2 border transition-all", active ? `${bgColor} ${borderColor}` : "border-border/30 opacity-50")}>
      <div className="flex justify-between items-center mb-1">
        <span className={cn("text-xs font-black", textColor)}>{label}</span>
        <span className={cn("text-xs font-mono font-bold", textColor)}>{winRate}% WR</span>
      </div>
      <div className="w-full h-2 bg-secondary rounded-full overflow-hidden mb-1">
        <div className={cn("h-full rounded-full transition-all", barColor)} style={{ width: `${winRate}%` }} />
      </div>
      <div className="text-[10px] text-muted-foreground">{signals} sinais/ano</div>
    </div>
  );
}
