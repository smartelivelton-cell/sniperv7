import { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Shield, ShieldCheck, RefreshCw, AlertCircle, CheckCircle2, XCircle, Clock, TrendingUp, TrendingDown, Zap } from 'lucide-react';

const BASE = (import.meta.env.BASE_URL ?? '').replace(/\/$/, '');

const STRATEGIES = [
  { id: 'warrior',     label: '🛡️ THE WARRIOR',    desc: 'VWAP + RSI(2) + SAR' },
  { id: 'muralha',     label: '🏰 Muralha 200',     desc: 'EMA200 suporte/resist.' },
  { id: 'surfe',       label: '🌊 Surfe 200',        desc: 'Breakout da EMA200' },
  { id: 'ondaSar',     label: '📡 Onda SAR',         desc: 'Trend following SAR' },
  { id: 'sinalMestre', label: '🚀 Sinal Mestre',     desc: 'Multi-confluência' },
  { id: 'fenix',       label: '🔥 Fênix Reversão',  desc: 'Mean reversion' },
  { id: 'tank',        label: '⚔️ Tank Scanner',     desc: 'Liquidez P50 + absorção' },
  { id: 'sunTzu',      label: '🧠 Sun Tzu',          desc: 'Vencer sem lutar' },
];

interface WarriorConfig {
  autoEnabled:   boolean;
  banca:         number;
  leverage:      number;
  dailyGoal:     number;
  enabledStrats: string[];
}

interface EscortInfo {
  symbol:         string;
  direction:      string;
  entry:          number;
  sl:             number;
  tp:             number;
  breakevenMoved: boolean;
  startedAt:      number;
}

interface WarriorStatus {
  autoEnabled:     boolean;
  activeEscorts:   EscortInfo[];
  pendingBreakouts: { symbol: string; direction: string; rsi2: number; detectedAt: number }[];
  dayStats:        { date: string; opsUsed: number; maxOps: number; waitingReply: boolean };
}

interface OkxBalance {
  configured: boolean;
  balance:    { available: number; equity: number; currency: string } | null;
}

function fmt(n: number) { return n > 1 ? n.toFixed(2) : n.toFixed(6); }

export function AutomationPanel() {
  const [config, setConfig]   = useState<WarriorConfig>({
    autoEnabled: false,
    banca: 200,
    leverage: 50,
    dailyGoal: 50,
    enabledStrats: ['warrior', 'muralha', 'surfe', 'ondaSar', 'sinalMestre'],
  });
  const [status, setStatus]   = useState<WarriorStatus | null>(null);
  const [balance, setBalance] = useState<OkxBalance | null>(null);
  const [saving, setSaving]   = useState(false);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [saved, setSaved]     = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/warrior/config`);
      if (res.ok) setConfig(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/warrior/status`);
      if (res.ok) setStatus(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchBalance = useCallback(async () => {
    setBalanceLoading(true);
    try {
      const res = await fetch(`${BASE}/api/warrior/balance`);
      if (res.ok) setBalance(await res.json());
    } catch { /* ignore */ } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
    fetchStatus();
    fetchBalance();
    const interval = setInterval(fetchStatus, 15_000);
    return () => clearInterval(interval);
  }, [fetchConfig, fetchStatus, fetchBalance]);

  const saveConfig = async (updated: WarriorConfig) => {
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/warrior/config`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(updated),
      });
      if (res.ok) {
        const data = await res.json();
        setConfig(data.config);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
  };

  const toggleAuto = () => {
    const updated = { ...config, autoEnabled: !config.autoEnabled };
    setConfig(updated);
    saveConfig(updated);
  };

  const toggleStrat = (id: string) => {
    const updated = {
      ...config,
      enabledStrats: config.enabledStrats.includes(id)
        ? config.enabledStrats.filter(s => s !== id)
        : [...config.enabledStrats, id],
    };
    setConfig(updated);
    saveConfig(updated);
  };

  const handleFieldChange = (field: keyof WarriorConfig, value: number) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  const handleFieldBlur = () => {
    saveConfig(config);
  };

  const estimatedProfit = (config.banca * config.leverage * 0.006).toFixed(2);
  const estimatedOps    = config.dailyGoal > 0
    ? Math.ceil(config.dailyGoal / parseFloat(estimatedProfit || '1'))
    : 0;

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3">

      {/* ── Header ── */}
      <div className="flex items-center gap-2 mb-1">
        <Shield className="w-5 h-5 text-primary" />
        <h2 className="text-sm font-bold text-foreground uppercase tracking-wide">THE WARRIOR — Automação</h2>
        {saved && (
          <span className="ml-auto text-xs text-green-400 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Salvo
          </span>
        )}
      </div>

      {/* ── OKX Futures Balance ── */}
      <div className="bg-card border border-border rounded-xl p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Saldo OKX Futuros</span>
          <button
            onClick={fetchBalance}
            className="p-1 rounded hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", balanceLoading && "animate-spin")} />
          </button>
        </div>
        {balance === null || balanceLoading ? (
          <div className="text-xs text-muted-foreground animate-pulse">Carregando...</div>
        ) : !balance.configured ? (
          <div className="flex items-start gap-2 text-xs text-yellow-400">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>Chaves OKX não configuradas. Adicione <code className="bg-secondary px-1 rounded">OKX_API_KEY</code>, <code className="bg-secondary px-1 rounded">OKX_SECRET_KEY</code> e <code className="bg-secondary px-1 rounded">OKX_PASSPHRASE</code> nas variáveis de ambiente.</span>
          </div>
        ) : balance.balance ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-secondary/40 rounded-lg p-2">
              <p className="text-xs text-muted-foreground">Disponível</p>
              <p className="text-lg font-bold text-green-400">${balance.balance.available.toFixed(2)}</p>
            </div>
            <div className="bg-secondary/40 rounded-lg p-2">
              <p className="text-xs text-muted-foreground">Equity Total</p>
              <p className="text-lg font-bold text-primary">${balance.balance.equity.toFixed(2)}</p>
            </div>
          </div>
        ) : (
          <div className="text-xs text-red-400">Erro ao buscar saldo. Verifique as chaves de API.</div>
        )}
      </div>

      {/* ── Config: Banca, Leverage, Daily Goal ── */}
      <div className="bg-card border border-border rounded-xl p-3 space-y-3">
        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Configuração de Banca</span>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Banca ($)</label>
            <input
              type="number"
              value={config.banca}
              onChange={e => handleFieldChange('banca', parseFloat(e.target.value) || 0)}
              onBlur={handleFieldBlur}
              className="w-full bg-secondary/50 border border-border rounded-lg px-2 py-1.5 text-sm font-bold text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Alavancagem (x)</label>
            <input
              type="number"
              value={config.leverage}
              onChange={e => handleFieldChange('leverage', parseFloat(e.target.value) || 1)}
              onBlur={handleFieldBlur}
              className="w-full bg-secondary/50 border border-border rounded-lg px-2 py-1.5 text-sm font-bold text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Lucro / dia ($)</label>
            <input
              type="number"
              value={config.dailyGoal}
              onChange={e => handleFieldChange('dailyGoal', parseFloat(e.target.value) || 0)}
              onBlur={handleFieldBlur}
              className="w-full bg-secondary/50 border border-border rounded-lg px-2 py-1.5 text-sm font-bold text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {/* Projection */}
        <div className="bg-secondary/30 rounded-lg p-2 grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-muted-foreground">Lucro por TP (0.6%): </span>
            <span className="font-bold text-green-400">${estimatedProfit}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Ops p/ meta: </span>
            <span className="font-bold text-primary">{estimatedOps} ops</span>
          </div>
        </div>
      </div>

      {/* ── Authorize Button ── */}
      <button
        onClick={toggleAuto}
        disabled={saving}
        className={cn(
          "w-full py-3.5 rounded-xl font-bold text-sm uppercase tracking-wide flex items-center justify-center gap-2 transition-all shadow-lg",
          config.autoEnabled
            ? "bg-green-500/20 border-2 border-green-500 text-green-400 hover:bg-green-500/30"
            : "bg-primary/10 border-2 border-primary/50 text-primary hover:bg-primary/20",
        )}
      >
        {config.autoEnabled ? (
          <>
            <ShieldCheck className="w-5 h-5" />
            ✅ OPERAÇÕES AUTOMÁTICAS ATIVAS — Clique para Pausar
          </>
        ) : (
          <>
            <Zap className="w-5 h-5" />
            🚀 AUTORIZAR OPERAÇÕES AUTOMÁTICAS
          </>
        )}
      </button>

      {/* ── Strategy toggles ── */}
      <div className="bg-card border border-border rounded-xl p-3">
        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide block mb-2">Estratégias no Modo Automático</span>
        <div className="grid grid-cols-2 gap-1.5">
          {STRATEGIES.map(s => {
            const on = config.enabledStrats.includes(s.id);
            return (
              <button
                key={s.id}
                onClick={() => toggleStrat(s.id)}
                className={cn(
                  "flex flex-col items-start px-3 py-2 rounded-lg border text-left transition-all",
                  on
                    ? "bg-primary/10 border-primary/50 text-primary"
                    : "bg-secondary/30 border-border/50 text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                <span className="text-xs font-bold">{s.label}</span>
                <span className="text-[10px] text-muted-foreground">{s.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Live Warrior Status ── */}
      {status && (
        <div className="bg-card border border-border rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Status ao Vivo</span>
            <span className={cn(
              "text-[10px] font-bold px-2 py-0.5 rounded-full",
              status.autoEnabled ? "bg-green-500/20 text-green-400" : "bg-secondary text-muted-foreground",
            )}>
              {status.autoEnabled ? "● ATIVO" : "○ PAUSADO"}
            </span>
          </div>

          {/* Day Stats */}
          <div className="grid grid-cols-3 gap-1.5 text-xs">
            <div className="bg-secondary/40 rounded-lg p-2 text-center">
              <p className="text-muted-foreground">Ops usadas</p>
              <p className="font-bold text-foreground">{status.dayStats.opsUsed}/{status.dayStats.maxOps}</p>
            </div>
            <div className="bg-secondary/40 rounded-lg p-2 text-center">
              <p className="text-muted-foreground">Escortas ativas</p>
              <p className="font-bold text-foreground">{status.activeEscorts.length}</p>
            </div>
            <div className="bg-secondary/40 rounded-lg p-2 text-center">
              <p className="text-muted-foreground">Em observação</p>
              <p className="font-bold text-foreground">{status.pendingBreakouts.length}</p>
            </div>
          </div>

          {/* Waiting reply warning */}
          {status.dayStats.waitingReply && (
            <div className="flex items-center gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-2 text-xs text-yellow-400">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              Aguardando sua resposta no Telegram para continuar operando.
            </div>
          )}

          {/* Active escorts */}
          {status.activeEscorts.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground font-medium">Operações ativas:</p>
              {status.activeEscorts.map(e => {
                const durMin = Math.floor((Date.now() - e.startedAt) / 60000);
                return (
                  <div key={e.symbol} className="bg-secondary/40 rounded-lg p-2.5 text-xs">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-foreground">{e.symbol}-USDT</span>
                      <div className="flex items-center gap-1">
                        {e.direction === 'LONG'
                          ? <TrendingUp className="w-3.5 h-3.5 text-green-400" />
                          : <TrendingDown className="w-3.5 h-3.5 text-red-400" />}
                        <span className={e.direction === 'LONG' ? 'text-green-400 font-bold' : 'text-red-400 font-bold'}>
                          {e.direction}
                        </span>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-[10px] text-muted-foreground">
                      <span>Entrada: <b className="text-foreground">{fmt(e.entry)}</b></span>
                      <span>TP: <b className="text-green-400">{fmt(e.tp)}</b></span>
                      <span>SL: <b className="text-red-400">{fmt(e.sl)}</b></span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[10px]">
                      {e.breakevenMoved && (
                        <span className="bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded-full">✅ Breakeven</span>
                      )}
                      <span className="text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3 h-3" />{durMin}min
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pending breakouts */}
          {status.pendingBreakouts.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground font-medium">Aguardando 2ª vela:</p>
              {status.pendingBreakouts.map(b => (
                <div key={b.symbol} className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-2.5 py-1.5 text-xs flex items-center justify-between">
                  <span className="font-bold text-yellow-400">{b.symbol}</span>
                  <span className={b.direction === 'LONG' ? 'text-green-400' : 'text-red-400'}>{b.direction}</span>
                  <span className="text-muted-foreground">RSI(2): {b.rsi2.toFixed(1)}</span>
                </div>
              ))}
            </div>
          )}

          {status.activeEscorts.length === 0 && status.pendingBreakouts.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-1">Nenhuma operação ativa — scanner monitorando BTC, ETH, SOL</p>
          )}
        </div>
      )}

      {/* ── Warrior params summary ── */}
      <div className="bg-card border border-border rounded-xl p-3">
        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide block mb-2">Parâmetros THE WARRIOR</span>
        <div className="space-y-1 text-xs">
          <div className="flex justify-between"><span className="text-muted-foreground">Ativos</span><span className="font-bold text-foreground">BTC · ETH · SOL · XRP · ADA · BNB · POL</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Timeframe</span><span className="font-bold text-foreground">M5</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Gatilho 1 — VWAP</span><span className="font-bold text-foreground">LONG acima · SHORT abaixo</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Gatilho 2 — RSI(2)</span><span className="font-bold text-foreground">{'<'}10 LONG · {'>'}90 SHORT</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Gatilho 3 — SAR + EMA200</span><span className="font-bold text-foreground">Inversão SAR pós-rompimento</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Protocolo 2ª Vela</span><span className="font-bold text-foreground">Delta {'>'} 53% → Executa</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Alavancagem fixa</span><span className="font-bold text-foreground">50x</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Take Profit</span><span className="font-bold text-green-400">+0.6%</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Stop Loss</span><span className="font-bold text-red-400">-0.3%</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Breakeven</span><span className="font-bold text-yellow-400">ao atingir +0.3%</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Pós-win</span><span className="font-bold text-foreground">+1 op permitida no dia</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Pós-loss</span><span className="font-bold text-foreground">Pergunta no Telegram</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Monitor SAR</span><span className="font-bold text-foreground">A cada 2 minutos</span></div>
        </div>
      </div>
    </div>
  );
}
