import { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import {
  TrendingUp, TrendingDown, RefreshCw, AlertTriangle, CheckCircle2,
  Loader2, Trophy, Target, Zap, BarChart2, DollarSign,
} from 'lucide-react';
import {
  BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';

const BASE = (import.meta.env.BASE_URL ?? '').replace(/\/$/, '');

// ─── Cálculo-base fixo: $100 / 50x ───────────────────────────────────────────
const BANCA    = 100;
const ALAVANCA = 50;
const TP_PCT   = 0.006;   // 0.60%
const SL_PCT   = 0.003;   // 0.30%

const WIN_USD       = BANCA * ALAVANCA * TP_PCT;   // $30.00
const LOSS_USD      = BANCA * ALAVANCA * SL_PCT;   // $15.00
const BREAKEVEN_WR  = LOSS_USD / (WIN_USD + LOSS_USD); // 33.33%

function ev(winRate: number) {
  const wr = winRate / 100;
  return wr * WIN_USD - (1 - wr) * LOSS_USD;
}

// ─── Estratégias (dados dos backtests 365 dias) ───────────────────────────────
const STRATEGIES = [
  { id: 'warrior_live',       name: '🛡️ Warrior',             wr: null, signals: null, live: true },
  { id: 'confluencia_sniper', name: '🎯 Confluência Sniper',  wr: 76,  signals: 93,   highlight: true },
  { id: 'breakeven',          name: '⚡ Break-Even',           wr: 78,  signals: 142 },
  { id: 'sniper',             name: '🎯 Sniper RSI',           wr: 74,  signals: 211 },
  { id: 'muralha',            name: '🏰 Muralha 200',          wr: 72,  signals: 187 },
  { id: 'suntzu',             name: '🏮 Sun Tzu',              wr: 71,  signals: 89  },
  { id: 'fibonacci',          name: '📐 Fibonacci 50%',        wr: 69,  signals: 158 },
  { id: 'sar',                name: '📡 Onda SAR',             wr: 65,  signals: 176 },
  { id: 'surfe',              name: '🌊 Surfe 200',            wr: 63,  signals: 243 },
  { id: 'fenix',              name: '🔥 Fênix',                wr: 58,  signals: 96  },
] as { id: string; name: string; wr: number | null; signals: number | null; live?: boolean; highlight?: boolean }[];

// ─── Tipos da API ─────────────────────────────────────────────────────────────
interface HourStat { wins: number; losses: number; winRate: number; signals: number }
interface WarriorBtData {
  symbol: string; bar: string;
  totalSignals: number; wins: number; losses: number; skipped: number;
  winRate: number; accumulatedProfitPct: number; avgRR: number;
  hourStats: Record<number, HourStat>;
  lowAssertivityHours: number[];
  lastUpdated: string; dataPoints: number; daysAnalyzed: number;
}

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];

// ─── Sub-abas ─────────────────────────────────────────────────────────────────
type SubTab = 'taxa' | 'ranking';

function StatBox({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-secondary/40 rounded-lg p-2.5 text-center">
      <p className="text-[10px] text-muted-foreground mb-0.5">{label}</p>
      <p className={cn("text-base font-black leading-none", color ?? 'text-foreground')}>{value}</p>
      {sub && <p className="text-[9px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Painel de Taxa Win (Warrior backtest real M15) ───────────────────────────
function TaxaWinTab() {
  const [symbol, setSymbol] = useState('BTC');
  const [data, setData]     = useState<WarriorBtData | null>(null);
  const [loading, setLoading] = useState(false);
  const [cached, setCached]   = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async (sym: string) => {
    setLoading(true); setError(null);
    try {
      const res  = await fetch(`${BASE}/api/backtest/warrior?symbol=${sym}`);
      const json = await res.json() as { ok: boolean; data: WarriorBtData; cached: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Erro');
      setData(json.data); setCached(json.cached);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(symbol); }, [symbol, load]);

  const hourChartData = data
    ? Array.from({ length: 24 }, (_, h) => {
        const s = data.hourStats[h];
        return { hour: `${String(h).padStart(2,'0')}h`, wr: s ? s.winRate : null, signals: s?.signals ?? 0, low: data.lowAssertivityHours.includes(h) };
      })
    : [];

  const wrColor = (wr: number | null) => {
    if (wr === null) return '#374151';
    if (wr >= 65) return '#22c55e';
    if (wr >= 50) return '#f59e0b';
    return '#ef4444';
  };

  const projected365 = data
    ? Math.round((data.totalSignals / data.daysAnalyzed) * 365)
    : null;
  const projectedPnl = projected365 !== null && data
    ? (projected365 * ev(data.winRate)).toFixed(2)
    : null;

  return (
    <div className="space-y-3">
      {/* Selector + refresh */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {SYMBOLS.map(s => (
            <button key={s} onClick={() => setSymbol(s)}
              className={cn("px-2.5 py-1 rounded text-[10px] font-bold border transition-colors",
                symbol === s ? "bg-blue-900/60 border-blue-500 text-blue-300" : "border-border text-muted-foreground hover:border-blue-500/50"
              )}>{s}</button>
          ))}
        </div>
        <button onClick={() => load(symbol)} disabled={loading}
          className="p-1.5 rounded border border-border text-muted-foreground hover:text-white hover:border-primary/50 transition-colors disabled:opacity-40">
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        </button>
      </div>

      {/* Parâmetros do cálculo */}
      <div className="rounded-lg bg-blue-900/20 border border-blue-500/30 p-2.5 text-[11px]">
        <span className="font-black text-blue-300">⚙️ Base do cálculo: </span>
        <span className="text-blue-200">$100 capital · 50x alavancagem · TP <b>+0.60%</b> · SL <b>-0.30%</b></span>
        <div className="mt-1 flex gap-4">
          <span className="text-green-400 font-bold">WIN = +${WIN_USD.toFixed(2)}</span>
          <span className="text-red-400 font-bold">LOSS = -${LOSS_USD.toFixed(2)}</span>
          <span className="text-yellow-400 font-bold">Break-even = {(BREAKEVEN_WR * 100).toFixed(1)}% WR</span>
        </div>
      </div>

      {loading && !data && (
        <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
          <p className="text-xs">Calculando Warrior M15 — 90 dias OKX…</p>
          <p className="text-[10px] opacity-60">Primeira vez leva 15–30 segundos</p>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-900/20 border border-red-500/30 text-red-400 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0" /><span>Erro: {error}</span>
        </div>
      )}

      {data && (
        <>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <CheckCircle2 className="w-3 h-3 text-green-400" />
            <span>{data.daysAnalyzed} dias analisados · {data.totalSignals} sinais · M15 · {cached ? 'Cache' : 'Recalculado'} · {data.lastUpdated}</span>
          </div>

          {/* KPIs */}
          <div className="grid grid-cols-4 gap-2">
            <StatBox label="Win Rate Real"
              value={`${data.winRate}%`}
              color={data.winRate >= 60 ? 'text-green-400' : data.winRate >= 40 ? 'text-yellow-400' : 'text-red-400'}
              sub={`${data.wins}W / ${data.losses}L`} />
            <StatBox label="Lucro Acum."
              value={`${data.accumulatedProfitPct >= 0 ? '+' : ''}${data.accumulatedProfitPct}%`}
              color={data.accumulatedProfitPct >= 0 ? 'text-green-400' : 'text-red-400'}
              sub="(sem alavancagem)" />
            <StatBox label="EV por op."
              value={`${ev(data.winRate) >= 0 ? '+' : ''}$${ev(data.winRate).toFixed(2)}`}
              color={ev(data.winRate) >= 0 ? 'text-green-400' : 'text-red-400'}
              sub="$100 / 50x" />
            <StatBox label="Ops p/ ano (proj.)"
              value={projected365 !== null ? String(projected365) : '—'}
              color="text-primary"
              sub={projectedPnl !== null ? `≈$${projectedPnl}` : ''} />
          </div>

          {/* Projeção $100/50x */}
          <div className="rounded-lg bg-secondary/30 border border-border p-3">
            <p className="text-[10px] font-black text-muted-foreground uppercase tracking-wide mb-2">Projeção com $100 / 50x — Warrior M15</p>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-2 text-center">
                <p className="text-green-400 font-black text-sm">${(data.wins * WIN_USD).toFixed(0)}</p>
                <p className="text-muted-foreground text-[10px]">{data.wins} wins × ${WIN_USD}</p>
              </div>
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-2 text-center">
                <p className="text-red-400 font-black text-sm">-${(data.losses * LOSS_USD).toFixed(0)}</p>
                <p className="text-muted-foreground text-[10px]">{data.losses} loss × ${LOSS_USD}</p>
              </div>
              <div className={cn("border rounded-lg p-2 text-center",
                data.wins * WIN_USD - data.losses * LOSS_USD >= 0
                  ? "bg-primary/10 border-primary/30"
                  : "bg-red-900/20 border-red-500/30"
              )}>
                <p className={cn("font-black text-sm",
                  data.wins * WIN_USD - data.losses * LOSS_USD >= 0 ? 'text-primary' : 'text-red-400'
                )}>
                  {data.wins * WIN_USD - data.losses * LOSS_USD >= 0 ? '+' : ''}
                  ${(data.wins * WIN_USD - data.losses * LOSS_USD).toFixed(2)}
                </p>
                <p className="text-muted-foreground text-[10px]">Resultado líquido ({data.daysAnalyzed}d)</p>
              </div>
            </div>
          </div>

          {/* Horários de baixa */}
          {data.lowAssertivityHours.length > 0 && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-900/20 border border-amber-500/30">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
              <div className="text-[11px]">
                <span className="font-black text-amber-400">Horários de baixa assertividade: </span>
                <span className="text-amber-300">
                  {data.lowAssertivityHours.sort((a, b) => a - b).map(h => `${String(h).padStart(2,'0')}h`).join(', ')} (Brasília)
                </span>
              </div>
            </div>
          )}

          {/* Gráfico por hora */}
          <div>
            <p className="text-[10px] font-black text-muted-foreground tracking-widest mb-2">WIN RATE POR HORA (BRASÍLIA)</p>
            <div className="h-24">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourChartData} margin={{ top: 2, right: 2, left: -24, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis dataKey="hour" tick={{ fontSize: 8, fill: '#555' }} tickLine={false} interval={1} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 8, fill: '#555' }} tickLine={false} tickFormatter={v => `${v}%`} />
                  <Tooltip content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const wr = payload[0]?.value as number | null;
                    const d  = hourChartData.find(h => h.hour === label);
                    return (
                      <div className="bg-card border border-border rounded p-2 text-xs shadow-xl">
                        <div className="font-bold text-muted-foreground">{label}</div>
                        {wr !== null
                          ? <><div style={{ color: wrColor(wr) }}>WR: {wr}%</div><div className="text-muted-foreground">{d?.signals} sinais</div></>
                          : <div className="text-muted-foreground">Sem sinais</div>}
                      </div>
                    );
                  }} />
                  <Bar dataKey="wr" radius={[2,2,0,0]} maxBarSize={16}>
                    {hourChartData.map((e, i) => (
                      <Cell key={i} fill={e.wr === null ? '#1f2937' : wrColor(e.wr)} opacity={e.signals === 0 ? 0.3 : 1} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Ranking de Estratégias ───────────────────────────────────────────────────
function RankingTab({ warriorWr }: { warriorWr: number | null }) {
  const rows = STRATEGIES.map(s => {
    const wr   = s.live ? warriorWr : s.wr;
    const evUsd = wr !== null ? ev(wr) : null;
    const annualPnl = wr !== null && s.signals !== null
      ? ev(wr) * s.signals
      : null;
    return { ...s, wr, evUsd, annualPnl };
  })
  .filter(s => s.wr !== null)
  .sort((a, b) => (b.wr ?? 0) - (a.wr ?? 0));

  const pending = STRATEGIES.filter(s => s.live && warriorWr === null);

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-blue-900/20 border border-blue-500/30 p-2.5 text-[11px]">
        <span className="font-black text-blue-300">Base de cálculo (todas as estratégias): </span>
        <span className="text-blue-200">$100 · 50x · TP +0.60% → <b className="text-green-400">+${WIN_USD}</b> · SL -0.30% → <b className="text-red-400">-${LOSS_USD}</b></span>
        <div className="mt-1 text-muted-foreground">RR = 2:1 · Break-even = <span className="text-yellow-400 font-bold">{(BREAKEVEN_WR * 100).toFixed(1)}% de acerto</span></div>
      </div>

      {pending.length > 0 && (
        <div className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> Carregando taxa Win Warrior ao vivo…
        </div>
      )}

      {/* Tabela */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-1.5 px-1 text-[10px] text-muted-foreground font-bold">#</th>
              <th className="text-left py-1.5 px-1 text-[10px] text-muted-foreground font-bold">Estratégia</th>
              <th className="text-right py-1.5 px-1 text-[10px] text-muted-foreground font-bold">Win Rate</th>
              <th className="text-right py-1.5 px-1 text-[10px] text-muted-foreground font-bold">EV/op</th>
              <th className="text-right py-1.5 px-1 text-[10px] text-muted-foreground font-bold">Sinais/ano</th>
              <th className="text-right py-1.5 px-1 text-[10px] text-muted-foreground font-bold">Proj. anual $</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, idx) => (
              <tr key={s.id}
                className={cn("border-b border-border/40 transition-colors",
                  s.live      ? "bg-blue-500/5"   :
                  s.highlight ? "bg-yellow-500/5 border-l-2 border-l-yellow-500/40" :
                  "hover:bg-secondary/20"
                )}>
                <td className="py-2 px-1">
                  {idx === 0 && <Trophy className="w-3 h-3 text-yellow-400" />}
                  {idx === 1 && <span className="text-[10px] text-muted-foreground">2°</span>}
                  {idx === 2 && <span className="text-[10px] text-muted-foreground">3°</span>}
                  {idx > 2   && <span className="text-[10px] text-muted-foreground">{idx + 1}°</span>}
                </td>
                <td className="py-2 px-1 font-bold text-foreground">
                  {s.name}
                  {s.live && <span className="ml-1 text-[9px] text-blue-400 font-normal">(ao vivo)</span>}
                </td>
                <td className="py-2 px-1 text-right">
                  <span className={cn("font-black",
                    (s.wr ?? 0) >= 65 ? 'text-green-400' : (s.wr ?? 0) >= 50 ? 'text-yellow-400' : 'text-red-400'
                  )}>{s.wr}%</span>
                </td>
                <td className={cn("py-2 px-1 text-right font-bold",
                  (s.evUsd ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                )}>
                  {s.evUsd !== null ? `${s.evUsd >= 0 ? '+' : ''}$${s.evUsd.toFixed(2)}` : '—'}
                </td>
                <td className="py-2 px-1 text-right text-muted-foreground">
                  {s.signals !== null ? s.signals : '—'}
                </td>
                <td className={cn("py-2 px-1 text-right font-bold",
                  (s.annualPnl ?? 0) >= 0 ? 'text-primary' : 'text-red-400'
                )}>
                  {s.annualPnl !== null
                    ? `${s.annualPnl >= 0 ? '+' : ''}$${s.annualPnl.toFixed(0)}`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Nota */}
      <div className="text-[10px] text-muted-foreground space-y-0.5 pt-1">
        <p>• <b>EV/op</b> = Valor Esperado por operação: WR × $30 − (1−WR) × $15</p>
        <p>• <b>Proj. anual</b> = EV/op × sinais por ano (dados históricos 365 dias)</p>
        <p>• Sinais do Warrior calculados em tempo real via backtest M15 90 dias OKX</p>
      </div>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────
export function WarriorStatsPanel() {
  const [subTab, setSubTab]     = useState<SubTab>('taxa');
  const [warriorWr, setWarriorWr] = useState<number | null>(null);

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <BarChart2 className="w-5 h-5 text-primary" />
        <h2 className="text-sm font-bold text-foreground uppercase tracking-wide">Taxa Win & Cálculos — Automação</h2>
      </div>

      {/* Sub-tabs */}
      <div className="flex bg-secondary/50 rounded-lg p-0.5 gap-0.5">
        {([
          { id: 'taxa',    label: '📈 Taxa Win 90 dias', icon: TrendingUp    },
          { id: 'ranking', label: '🏆 Ranking Estratégias', icon: Trophy    },
        ] as { id: SubTab; label: string; icon: any }[]).map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setSubTab(t.id)}
              className={cn("flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-bold transition-all",
                subTab === t.id ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}>
              <Icon className="w-3.5 h-3.5" />{t.label}
            </button>
          );
        })}
      </div>

      {subTab === 'taxa' && (
        <TaxaWinTab />
      )}
      {subTab === 'ranking' && (
        <RankingTab warriorWr={warriorWr} />
      )}

      {/* Sync warriorWr when taxa tab loads data (bridge between tabs) */}
      {subTab === 'taxa' && <WarriorWrBridge onWr={setWarriorWr} />}
    </div>
  );
}

function WarriorWrBridge({ onWr }: { onWr: (wr: number) => void }) {
  useEffect(() => {
    fetch(`${BASE}/api/backtest/warrior?symbol=BTC`)
      .then(r => r.json())
      .then((j: { ok: boolean; data: WarriorBtData }) => { if (j.ok) onWr(j.data.winRate); })
      .catch(() => {});
  }, [onWr]);
  return null;
}
