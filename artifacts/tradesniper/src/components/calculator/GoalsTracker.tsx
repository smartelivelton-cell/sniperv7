import { useState } from 'react';
import { GlassCard, Input, Label } from '../ui/PremiumComponents';
import { Target, TrendingUp, DollarSign, Calculator } from 'lucide-react';
import { cn } from '@/lib/utils';

export function GoalsTracker() {
  const [currentBalance, setCurrentBalance] = useState(187.50);
  const [targetBalance, setTargetBalance] = useState(2000);
  const [entryPrice, setEntryPrice] = useState(0);
  const [leverage, setLeverage] = useState(50);
  const [profitGoal, setProfitGoal] = useState(250);

  const progress = Math.min((currentBalance / targetBalance) * 100, 100);
  const remaining = targetBalance - currentBalance;
  const doublesNeeded = Math.ceil(Math.log2(targetBalance / currentBalance));

  // Lot size calculation: what SIZE gives profitGoal USD from 1% move, minus 0.1% fee
  // PNL = size * entryPrice * 0.01 (1% move) - size * entryPrice * 0.001 (0.1% fee)
  // PNL = size * entryPrice * (0.01 - 0.001) = size * entryPrice * 0.009
  // size = profitGoal / (entryPrice * 0.009)
  const netMovePercent = 0.01 - 0.001; // 1% move minus 0.1% fee = 0.9%
  const requiredSizeCoins = entryPrice > 0 ? profitGoal / (entryPrice * netMovePercent) : 0;
  const requiredSizeUSDT = requiredSizeCoins * (entryPrice || 0);
  const requiredMargin = leverage > 0 ? requiredSizeUSDT / leverage : 0;
  const requiredLeverage = currentBalance > 0 && entryPrice > 0
    ? requiredSizeUSDT / currentBalance
    : 0;

  const milestones = [
    { label: '500 USDT', value: 500 },
    { label: '1.000 USDT', value: 1000 },
    { label: '2.000 USDT', value: 2000 },
  ];

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto pr-1">
      {/* Progress Section */}
      <GlassCard className="p-5">
        <div className="flex items-center gap-2 mb-4 border-b border-border pb-3">
          <Target className="w-5 h-5 text-primary" />
          <h2 className="font-bold text-lg">RASTREADOR DE BANCA</h2>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-5">
          <div>
            <Label>Saldo Atual (USDT)</Label>
            <Input
              type="number"
              value={currentBalance}
              onChange={e => setCurrentBalance(Number(e.target.value))}
              className="text-green-400 border-green-400/30"
            />
          </div>
          <div>
            <Label>Meta Final (USDT)</Label>
            <Input
              type="number"
              value={targetBalance}
              onChange={e => setTargetBalance(Number(e.target.value))}
              className="text-primary border-primary/30"
            />
          </div>
        </div>

        {/* Progress Bar */}
        <div className="mb-2 flex justify-between text-xs text-muted-foreground">
          <span className="font-mono text-green-400 font-bold">$ {currentBalance.toFixed(2)}</span>
          <span className="font-bold text-primary">{progress.toFixed(1)}%</span>
          <span className="font-mono text-primary font-bold">$ {targetBalance.toFixed(2)}</span>
        </div>
        <div className="w-full h-4 bg-secondary rounded-full overflow-hidden border border-border mb-4">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${progress}%`,
              background: 'linear-gradient(90deg, #00FF88 0%, #F3BA2F 100%)',
              boxShadow: '0 0 12px rgba(243,186,47,0.5)',
            }}
          />
        </div>

        {/* Milestones */}
        <div className="flex gap-2 mb-4">
          {milestones.map(m => (
            <div
              key={m.value}
              className={cn(
                "flex-1 rounded-lg border p-2 text-center text-xs font-bold transition-colors",
                currentBalance >= m.value
                  ? "border-green-500 text-green-400 bg-green-400/10"
                  : "border-border text-muted-foreground"
              )}
            >
              {currentBalance >= m.value ? '✓' : '○'} {m.label}
            </div>
          ))}
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="bg-secondary/60 rounded-lg p-3 border border-border">
            <div className="text-xs text-muted-foreground mb-1">Falta</div>
            <div className="font-bold text-sm font-mono text-destructive">
              ${remaining.toFixed(2)}
            </div>
          </div>
          <div className="bg-secondary/60 rounded-lg p-3 border border-border">
            <div className="text-xs text-muted-foreground mb-1">Progresso</div>
            <div className="font-bold text-sm font-mono text-primary">
              {progress.toFixed(1)}%
            </div>
          </div>
          <div className="bg-secondary/60 rounded-lg p-3 border border-border">
            <div className="text-xs text-muted-foreground mb-1">Dobradas</div>
            <div className="font-bold text-sm font-mono text-yellow-400">
              ~{doublesNeeded}x
            </div>
          </div>
        </div>
      </GlassCard>

      {/* Lot Size Calculator */}
      <GlassCard className="p-5">
        <div className="flex items-center gap-2 mb-4 border-b border-border pb-3">
          <Calculator className="w-5 h-5 text-primary" />
          <h2 className="font-bold text-lg">CALCULADORA DE LOTE</h2>
          <span className="text-xs text-muted-foreground ml-auto">1% mov. − 0.1% taxa</span>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-5">
          <div>
            <Label>Meta de Lucro (USD)</Label>
            <Input
              type="number"
              value={profitGoal}
              onChange={e => setProfitGoal(Number(e.target.value))}
              className="text-primary border-primary/30"
            />
          </div>
          <div>
            <Label>Preço de Entrada</Label>
            <Input
              type="number"
              value={entryPrice || ''}
              placeholder="ex: 71000"
              onChange={e => setEntryPrice(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="mb-4">
          <Label>Alavancagem (x)</Label>
          <Input
            type="number"
            value={leverage}
            onChange={e => setLeverage(Number(e.target.value))}
          />
        </div>

        {entryPrice > 0 ? (
          <div className="space-y-3">
            <div className="flex justify-between items-center py-2 border-b border-border/50">
              <span className="text-sm text-muted-foreground">Size necessário (moedas)</span>
              <span className="font-mono font-bold text-primary">
                {requiredSizeCoins.toFixed(4)}
              </span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-border/50">
              <span className="text-sm text-muted-foreground">Valor do contrato (USDT)</span>
              <span className="font-mono font-bold text-foreground">
                ${requiredSizeUSDT.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-border/50">
              <span className="text-sm text-muted-foreground">Margem necessária (USDT)</span>
              <span className="font-mono font-bold text-yellow-400">
                ${requiredMargin.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-border/50">
              <span className="text-sm text-muted-foreground">Alavancagem necessária</span>
              <span className={cn(
                "font-mono font-bold",
                requiredLeverage > 100 ? "text-destructive" : "text-green-400"
              )}>
                {requiredLeverage.toFixed(1)}x
              </span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-sm text-muted-foreground">Lucro líquido estimado</span>
              <span className="font-mono font-bold text-green-400">${profitGoal.toFixed(2)}</span>
            </div>

            {requiredLeverage > 100 && (
              <div className="bg-destructive/10 border border-destructive rounded-lg p-3 text-center text-xs font-bold text-destructive">
                ⚠️ ALAVANCAGEM SUICIDA — REDUZA O SIZE OU AUMENTE O SALDO
              </div>
            )}
            {requiredMargin > currentBalance && requiredLeverage <= 100 && (
              <div className="bg-yellow-500/10 border border-yellow-500 rounded-lg p-3 text-center text-xs font-bold text-yellow-400">
                ⚠️ MARGEM INSUFICIENTE — Saldo atual: ${currentBalance.toFixed(2)}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
            <DollarSign className="w-8 h-8 opacity-30" />
            <span className="text-sm">Informe o preço de entrada para calcular</span>
          </div>
        )}
      </GlassCard>
    </div>
  );
}
