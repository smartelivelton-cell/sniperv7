import { useState, useEffect } from 'react';
import { GlassCard, Input, Label, Button, Badge } from '../ui/PremiumComponents';
import { Crosshair, AlertOctagon, TrendingUp, TrendingDown } from 'lucide-react';
import { formatNumber, formatCurrency } from '@/lib/utils';
import { useBinanceTicker } from '@/hooks/use-binance-ticker';
import type { AnalysisResult } from '@workspace/api-client-react/src/generated/api.schemas';
import { cn } from '@/lib/utils';

interface Props {
  symbol: string;
  onSymbolChange: (s: string) => void;
  symbols: string[];
  aiResult: AnalysisResult | null;
  onExecuteTrade: (trade: any) => void;
}

export function SniperCalculator({ symbol, onSymbolChange, symbols, aiResult, onExecuteTrade }: Props) {
  const { tickers } = useBinanceTicker();
  const currentPrice = tickers[symbol]?.price || 0;

  const [balance, setBalance] = useState(187.50);
  const [dailyGoal, setDailyGoal] = useState(175);
  const [leverage, setLeverage] = useState(50);
  const [entryPrice, setEntryPrice] = useState(currentPrice);
  const [stopLoss, setStopLoss] = useState(0);
  const [takeProfit, setTakeProfit] = useState(0);

  // Sync AI result when it comes in
  useEffect(() => {
    if (aiResult?.entryPrice) setEntryPrice(aiResult.entryPrice);
    if (aiResult?.stopLoss) setStopLoss(aiResult.stopLoss);
    if (aiResult?.takeProfit) setTakeProfit(aiResult.takeProfit);
    if (aiResult?.leverage) setLeverage(aiResult.leverage);
  }, [aiResult]);

  // Keep entry updated with live price if empty
  useEffect(() => {
    if (!entryPrice && currentPrice) setEntryPrice(currentPrice);
  }, [currentPrice, entryPrice]);

  // Calculations
  const size = entryPrice > 0 ? (balance * leverage) / entryPrice : 0;
  const fee = size * entryPrice * 0.001;
  const liqDistancePercent = leverage > 0 ? 100 / leverage : 0;
  
  const isSuicide = liqDistancePercent < 2;

  // Sync Error Check (0.5% rule)
  const syncDiff = Math.abs(currentPrice - entryPrice) / entryPrice * 100;
  const hasSyncError = syncDiff > 0.5 && entryPrice > 0;

  const blockLong = aiResult?.warning?.includes('EMA200'); // Simulated logic based on instructions
  const blockShort = blockLong; // Simplify for UI

  const handleExecute = (direction: 'LONG' | 'SHORT') => {
    onExecuteTrade({
      symbol,
      direction,
      entryPrice,
      size,
      leverage,
      result: 'PENDING'
    });
  };

  return (
    <GlassCard className="p-5 flex flex-col gap-5 h-full">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h2 className="font-display text-xl font-bold flex items-center gap-2">
          <Crosshair className="w-5 h-5 text-primary" />
          SNIPER <span className="text-primary">EXECUTION</span>
        </h2>
        <select 
          value={symbol}
          onChange={(e) => onSymbolChange(e.target.value)}
          className="bg-secondary border border-border text-foreground rounded px-2 py-1 text-sm font-bold"
        >
          {symbols.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Wallet Bal. (USDT)</Label>
          <Input type="number" value={balance} onChange={e => setBalance(Number(e.target.value))} />
        </div>
        <div>
          <Label>Daily Goal (USDT)</Label>
          <Input type="number" value={dailyGoal} onChange={e => setDailyGoal(Number(e.target.value))} className="text-primary border-primary/50" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-1">
          <Label>Leverage (x)</Label>
          <Input type="number" value={leverage} onChange={e => setLeverage(Number(e.target.value))} />
        </div>
        <div className="col-span-2">
          <Label>Entry Price</Label>
          <div className="relative">
            <Input type="number" value={entryPrice || ''} onChange={e => setEntryPrice(Number(e.target.value))} className={cn(hasSyncError && "border-destructive focus-visible:ring-destructive")} />
            <span className="absolute right-3 top-2.5 text-xs font-mono text-muted-foreground">{currentPrice}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Stop Loss</Label>
          <Input type="number" value={stopLoss || ''} onChange={e => setStopLoss(Number(e.target.value))} className="text-destructive border-destructive/30" />
        </div>
        <div>
          <Label>Take Profit</Label>
          <Input type="number" value={takeProfit || ''} onChange={e => setTakeProfit(Number(e.target.value))} className="text-success border-success/30" />
        </div>
      </div>

      {/* Metrics Display */}
      <div className="bg-secondary/50 rounded-lg p-3 space-y-2 border border-border/50 font-mono text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Pos Size:</span>
          <span className="font-bold text-foreground">{formatNumber(size, 4)} {symbol}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Est. Fee:</span>
          <span>{formatCurrency(fee)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Liq. Dist:</span>
          <span className={cn("font-bold", isSuicide ? "text-destructive" : "text-primary")}>
            {liqDistancePercent.toFixed(2)}%
          </span>
        </div>
      </div>

      {/* Warnings */}
      {isSuicide && (
        <div className="bg-destructive/10 text-destructive border border-destructive rounded p-2 text-xs font-bold flex items-center justify-center gap-2 text-center animate-pulse">
          <AlertOctagon className="w-4 h-4" /> ALAVANCAGEM SUICIDA - REDUZA O SIZE
        </div>
      )}
      
      {hasSyncError && (
        <div className="bg-primary/10 text-primary border border-primary rounded p-2 text-xs font-bold flex items-center justify-center gap-2 text-center">
          <AlertOctagon className="w-4 h-4" /> ERRO DE SINCRONIA {'>'}  0.5%
        </div>
      )}

      {/* Action Buttons */}
      <div className="grid grid-cols-2 gap-3 mt-auto pt-4">
        <Button 
          variant="success" 
          size="lg"
          disabled={blockLong}
          onClick={() => handleExecute('LONG')}
          className="relative overflow-hidden group"
        >
          <div className="absolute inset-0 bg-white/20 translate-y-[100%] group-hover:translate-y-[0%] transition-transform duration-300 ease-out" />
          <span className="relative flex items-center gap-2"><TrendingUp className="w-5 h-5" /> LONG</span>
        </Button>
        <Button 
          variant="danger" 
          size="lg"
          disabled={blockShort}
          onClick={() => handleExecute('SHORT')}
          className="relative overflow-hidden group"
        >
          <div className="absolute inset-0 bg-white/20 translate-y-[-100%] group-hover:translate-y-[0%] transition-transform duration-300 ease-out" />
          <span className="relative flex items-center gap-2"><TrendingDown className="w-5 h-5" /> SHORT</span>
        </Button>
      </div>
    </GlassCard>
  );
}
