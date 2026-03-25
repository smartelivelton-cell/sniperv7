import { useState } from 'react';
import { GlassCard, Badge, Button, Input, Label } from '../ui/PremiumComponents';
import { useListTrades, useGetDailyPnl, useCreateTrade } from '@workspace/api-client-react';
import { formatCurrency, formatNumber } from '@/lib/utils';
import { Check, X, Target } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog';

const TODAY = new Date().toISOString().split('T')[0];

interface Props {
  dailyGoal: number;
}

export function TradeHistory({ dailyGoal }: Props) {
  const { data: trades = [] } = useListTrades({ date: TODAY });
  const { data: pnlData } = useGetDailyPnl({ date: TODAY });
  const createTradeMutation = useCreateTrade();
  
  const [isOpen, setIsOpen] = useState(false);
  const [newTrade, setNewTrade] = useState({
    symbol: 'BTC', direction: 'LONG', entryPrice: 0, size: 0, leverage: 50, pnl: 0, result: 'WIN'
  });

  const totalPnl = pnlData?.totalPnl || 0;
  const progressPercent = Math.min(100, Math.max(0, (totalPnl / dailyGoal) * 100));
  const isProfitable = totalPnl >= 0;

  const handleSaveTrade = async () => {
    await createTradeMutation.mutateAsync({ data: newTrade });
    setIsOpen(false);
  };

  return (
    <GlassCard className="p-4 flex flex-col gap-4">
      {/* PNL Bar */}
      <div className="flex items-center gap-4 bg-secondary/30 p-4 rounded-xl border border-border">
        <div className="shrink-0 flex items-center justify-center w-12 h-12 rounded-full bg-card border border-border">
          <Target className="w-6 h-6 text-primary" />
        </div>
        <div className="flex-1">
          <div className="flex justify-between mb-1">
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Daily Progress</span>
            <span className={cn("text-sm font-bold font-mono", isProfitable ? "text-success" : "text-destructive")}>
              {formatCurrency(totalPnl)} / {formatCurrency(dailyGoal)}
            </span>
          </div>
          <div className="h-3 w-full bg-background rounded-full overflow-hidden border border-border/50">
            <div 
              className={cn("h-full transition-all duration-1000 ease-out relative", isProfitable ? "bg-success" : "bg-destructive")}
              style={{ width: `${progressPercent}%` }}
            >
              <div className="absolute inset-0 bg-white/20 w-full animate-[marquee_2s_linear_infinite]" style={{ backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(0,0,0,0.1) 10px, rgba(0,0,0,0.1) 20px)'}} />
            </div>
          </div>
        </div>
        <div className="shrink-0 text-right font-mono text-sm">
          <div className="text-success"><Check className="w-3 h-3 inline mr-1"/>{pnlData?.winCount || 0}</div>
          <div className="text-destructive"><X className="w-3 h-3 inline mr-1"/>{pnlData?.lossCount || 0}</div>
        </div>

        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button variant="secondary" size="sm" className="ml-4 shrink-0">Log Manual Trade</Button>
          </DialogTrigger>
          <DialogContent className="bg-card border-border sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle className="font-display tracking-widest text-primary">MANUAL ENTRY</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Symbol</Label>
                  <Input value={newTrade.symbol} onChange={e=>setNewTrade(prev=>({...prev, symbol: e.target.value.toUpperCase()}))} />
                </div>
                <div>
                  <Label>Direction</Label>
                  <select className="w-full h-10 bg-input border border-border rounded px-3 text-sm" value={newTrade.direction} onChange={e=>setNewTrade(prev=>({...prev, direction: e.target.value}))}>
                    <option value="LONG">LONG</option>
                    <option value="SHORT">SHORT</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                 <div>
                  <Label>PNL (USD)</Label>
                  <Input type="number" value={newTrade.pnl} onChange={e=>setNewTrade(prev=>({...prev, pnl: Number(e.target.value)}))} className={newTrade.pnl >= 0 ? "text-success" : "text-destructive"} />
                </div>
                <div>
                  <Label>Result</Label>
                  <select className="w-full h-10 bg-input border border-border rounded px-3 text-sm" value={newTrade.result} onChange={e=>setNewTrade(prev=>({...prev, result: e.target.value}))}>
                    <option value="WIN">WIN</option>
                    <option value="LOSS">LOSS</option>
                    <option value="BREAKEVEN">BREAKEVEN</option>
                  </select>
                </div>
              </div>
              <Button onClick={handleSaveTrade} className="w-full mt-2" disabled={createTradeMutation.isPending}>
                {createTradeMutation.isPending ? "SAVING..." : "SAVE RECORD"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Trades Table */}
      <div className="border border-border rounded-xl overflow-hidden bg-background/50">
        <table className="w-full text-sm font-mono text-left">
          <thead className="bg-secondary text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Pair</th>
              <th className="px-4 py-3">Dir</th>
              <th className="px-4 py-3 text-right">Entry</th>
              <th className="px-4 py-3 text-right">Size/Lev</th>
              <th className="px-4 py-3 text-right">PNL</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {trades.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground font-sans">No trades recorded today. Time to hunt.</td></tr>
            ) : (
              trades.map((trade) => (
                <tr key={trade.id} className="hover:bg-secondary/30 transition-colors">
                  <td className="px-4 py-3 opacity-60">{format(new Date(trade.createdAt), 'HH:mm:ss')}</td>
                  <td className="px-4 py-3 font-bold">{trade.symbol}</td>
                  <td className="px-4 py-3">
                    <Badge variant={trade.direction === 'LONG' ? 'success' : 'danger'}>{trade.direction}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right">{formatNumber(trade.entryPrice, 4)}</td>
                  <td className="px-4 py-3 text-right opacity-80">{formatNumber(trade.size, 3)} / {trade.leverage}x</td>
                  <td className={cn("px-4 py-3 text-right font-bold", trade.pnl >= 0 ? "text-success" : "text-destructive")}>
                    {trade.pnl > 0 ? '+' : ''}{formatCurrency(trade.pnl)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </GlassCard>
  );
}
