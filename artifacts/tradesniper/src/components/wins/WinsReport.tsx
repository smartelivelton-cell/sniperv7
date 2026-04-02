import { useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';

interface WinEntry {
  id: string;
  symbol: string;
  strategy: string;
  direction: 'LONG' | 'SHORT';
  tpLevel: 1 | 2 | 3;
  profitPct: number;
  leverage: number;
  avgEntry: number;
  tpPrice: number;
  timestamp: string;
  timestampBR: string;
  dateBR: string;
}

const BANCA = 2000;

function profitUSD(pct: number, lev: number) {
  return (BANCA * lev * pct) / 100;
}

const TP_LABEL: Record<number, string> = { 1: '🥇 Alvo 1', 2: '🥈 Alvo 2', 3: '🏆 Alvo 3' };
const TP_COLOR: Record<number, string> = {
  1: 'text-yellow-400 border-yellow-400/30 bg-yellow-400/5',
  2: 'text-blue-400 border-blue-400/30 bg-blue-400/5',
  3: 'text-green-400 border-green-400/30 bg-green-400/5',
};

export function WinsReport() {
  const [wins, setWins] = useState<WinEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchWins = useCallback(async () => {
    try {
      const base = import.meta.env.BASE_URL ?? '/';
      const res = await fetch(`${base}api/wins/today`);
      if (res.ok) {
        const data = await res.json();
        setWins((data.wins ?? []).slice().reverse());
        setLastUpdated(new Date());
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWins();
    const id = setInterval(fetchWins, 30_000);
    return () => clearInterval(id);
  }, [fetchWins]);

  const totalWins = wins.length;
  const tp1Count = wins.filter(w => w.tpLevel === 1).length;
  const tp2Count = wins.filter(w => w.tpLevel === 2).length;
  const tp3Count = wins.filter(w => w.tpLevel === 3).length;
  const avgPct = totalWins > 0 ? wins.reduce((s, w) => s + w.profitPct, 0) / totalWins : 0;

  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-base sm:text-lg font-bold text-foreground flex items-center gap-2">
          📜 Relatório de Hoje
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          {lastUpdated && (
            <span className="text-xs text-muted-foreground">
              Atualizado: {lastUpdated.toLocaleTimeString('pt-BR')}
            </span>
          )}
          <button
            onClick={() => {
              if (wins.length === 0) return;
              const header = 'Moeda,Estratégia,Direção,Alvo,Lucro %,Horário';
              const rows = wins.map(w =>
                `${w.symbol}-USDT,${w.strategy},${w.direction},Alvo ${w.tpLevel},+${w.profitPct.toFixed(2)}%,${w.timestampBR}`
              );
              const csv = [header, ...rows].join('\n');
              const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              const today = new Date().toLocaleDateString('pt-BR').replace(/\//g, '-');
              a.download = `wins_${today}.csv`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            disabled={wins.length === 0}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors',
              wins.length === 0
                ? 'border-border text-muted-foreground cursor-not-allowed opacity-50'
                : 'border-green-500/50 bg-green-500/10 text-green-400 hover:bg-green-500/20'
            )}
          >
            📥 Baixar CSV
          </button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="rounded-lg border border-border bg-card p-3 text-center">
          <p className="text-xl sm:text-2xl font-bold text-green-400">{totalWins}</p>
          <p className="text-xs text-muted-foreground mt-1">Wins Hoje</p>
        </div>
        <div className="rounded-lg border border-yellow-400/30 bg-yellow-400/5 p-3 text-center">
          <p className="text-xl sm:text-2xl font-bold text-yellow-400">{tp1Count}</p>
          <p className="text-xs text-muted-foreground mt-1">Alvo 1</p>
        </div>
        <div className="rounded-lg border border-blue-400/30 bg-blue-400/5 p-3 text-center">
          <p className="text-xl sm:text-2xl font-bold text-blue-400">{tp2Count}</p>
          <p className="text-xs text-muted-foreground mt-1">Alvo 2</p>
        </div>
        <div className="rounded-lg border border-green-400/30 bg-green-400/5 p-3 text-center">
          <p className="text-xl sm:text-2xl font-bold text-green-400">{tp3Count}</p>
          <p className="text-xs text-muted-foreground mt-1">Alvo 3 🏆</p>
        </div>
      </div>

      {avgPct > 0 && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-center">
          <p className="text-sm font-bold text-primary">
            Lucro médio por alvo: +{avgPct.toFixed(2)}% · 
            10x: <span className="text-green-400">+${(BANCA * 10 * avgPct / 100).toFixed(0)}</span> · 
            25x: <span className="text-green-400">+${(BANCA * 25 * avgPct / 100).toFixed(0)}</span>
          </p>
        </div>
      )}

      {/* Wins list */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
          Carregando histórico…
        </div>
      ) : wins.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
          <span className="text-4xl">🎯</span>
          <p className="text-sm font-medium">Nenhum win registrado hoje</p>
          <p className="text-xs text-center">Os wins aparecem aqui automaticamente quando o robô atingir um alvo.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {wins.map((w) => {
            const p10 = profitUSD(w.profitPct, 10);
            const p25 = profitUSD(w.profitPct, 25);
            const p50 = profitUSD(w.profitPct, 50);
            return (
              <div
                key={w.id}
                className={cn(
                  'rounded-lg border p-3 sm:p-4 space-y-1',
                  TP_COLOR[w.tpLevel],
                )}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold">{TP_LABEL[w.tpLevel]}</span>
                    <span className={cn(
                      'text-xs font-bold px-2 py-0.5 rounded-full',
                      w.direction === 'LONG' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400',
                    )}>
                      {w.direction === 'LONG' ? '📈 LONG' : '📉 SHORT'}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">{w.timestampBR}</span>
                </div>

                <div className="flex items-center gap-3 flex-wrap text-xs sm:text-sm">
                  <span className="font-bold text-foreground">{w.symbol}-USDT</span>
                  <span className="text-muted-foreground">{w.strategy}</span>
                </div>

                <div className="flex items-center gap-3 flex-wrap text-xs">
                  <span className="text-green-400 font-bold">+{w.profitPct.toFixed(2)}%</span>
                  <span className="text-muted-foreground">
                    10x: <span className="text-green-400 font-semibold">+${p10.toFixed(0)}</span>
                  </span>
                  <span className="text-muted-foreground">
                    25x: <span className="text-green-400 font-semibold">+${p25.toFixed(0)}</span>
                  </span>
                  <span className="text-muted-foreground">
                    50x: <span className="text-green-400 font-semibold">+${p50.toFixed(0)}</span>
                  </span>
                </div>

                <div className="text-xs text-muted-foreground">
                  Entrada média: <span className="text-foreground">{w.avgEntry > 1 ? w.avgEntry.toFixed(2) : w.avgEntry.toFixed(6)}</span>
                  {' · '}
                  TP atingido: <span className="text-foreground">{w.tpPrice > 1 ? w.tpPrice.toFixed(2) : w.tpPrice.toFixed(6)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
