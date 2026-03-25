import { useBinanceTicker } from '@/hooks/use-binance-ticker';
import { Zap, Activity } from 'lucide-react';
import { formatNumber } from '@/lib/utils';
import { cn } from '@/lib/utils';

export function Header() {
  const { tickers, isConnected } = useBinanceTicker();
  const tickerList = Object.values(tickers);

  return (
    <header className="h-14 border-b border-border bg-card/95 backdrop-blur z-50 flex items-center shrink-0">
      <div className="flex items-center gap-2 px-4 border-r border-border h-full shrink-0 w-[240px]">
        <Zap className="w-5 h-5 text-primary fill-primary animate-pulse-slow" />
        <h1 className="font-display font-bold text-xl tracking-wider text-foreground">
          TRADESNIPER <span className="text-primary">PRO</span>
        </h1>
      </div>
      
      <div className="flex-1 overflow-hidden relative flex items-center h-full">
        {/* Ticker Gradient masks */}
        <div className="absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-card to-transparent z-10" />
        <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-card to-transparent z-10" />
        
        {tickerList.length === 0 && (
          <div className="px-6 text-xs text-muted-foreground flex items-center gap-2">
            <Activity className="w-4 h-4 animate-spin" />
            Connecting to Binance WS...
          </div>
        )}

        <div className="flex whitespace-nowrap animate-[marquee_30s_linear_infinite] hover:[animation-play-state:paused]">
          {/* Duplicate list for seamless loop */}
          {[...tickerList, ...tickerList].map((t, i) => (
            <div key={`${t.symbol}-${i}`} className="flex items-center gap-2 px-6 border-r border-border/30 h-8">
              <span className="font-bold text-sm">{t.symbol}</span>
              <span className="font-mono text-sm">{formatNumber(t.price, t.price < 1 ? 4 : 2)}</span>
              <span className={cn(
                "font-mono text-xs font-bold",
                t.isUp ? "text-success" : "text-destructive"
              )}>
                {t.isUp ? '+' : ''}{t.changePercent.toFixed(2)}%
              </span>
            </div>
          ))}
        </div>
      </div>
      
      <div className="px-4 shrink-0 flex items-center gap-2 text-xs border-l border-border h-full">
        <span className="relative flex h-2.5 w-2.5">
          {isConnected && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>}
          <span className={cn("relative inline-flex rounded-full h-2.5 w-2.5", isConnected ? "bg-success" : "bg-destructive")}></span>
        </span>
        <span className="text-muted-foreground font-mono">
          {isConnected ? 'WS CONNECTED' : 'WS OFFLINE'}
        </span>
      </div>
    </header>
  );
}
