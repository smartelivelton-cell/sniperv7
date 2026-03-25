import { GlassCard, Badge } from '../ui/PremiumComponents';
import { Target, TrendingUp, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { AnalysisResult } from '@workspace/api-client-react/src/generated/api.schemas';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

interface Props {
  result: AnalysisResult | null;
  isLoading: boolean;
}

export function AnalysisResultPanel({ result, isLoading }: Props) {
  if (isLoading) {
    return (
      <GlassCard className="p-6 h-full flex flex-col items-center justify-center gap-4 border-primary/20">
        <div className="w-16 h-16 rounded-full border-t-2 border-primary animate-spin" />
        <div className="text-primary font-mono text-sm tracking-widest animate-pulse">EXTRACTING ALFA...</div>
      </GlassCard>
    );
  }

  if (!result) {
    return (
      <GlassCard className="p-6 h-full flex flex-col items-center justify-center text-muted-foreground">
        <Target className="w-12 h-12 mb-2 opacity-20" />
        <p className="text-sm">Awaiting Chart Uploads</p>
      </GlassCard>
    );
  }

  const isBuy = result.direction === 'LONG';
  const isNeutral = result.direction === 'NEUTRAL';
  
  const signalColor = isBuy ? 'text-success' : isNeutral ? 'text-muted-foreground' : 'text-destructive';
  const signalBg = isBuy ? 'bg-success/10 border-success/30' : isNeutral ? 'bg-secondary border-border' : 'bg-destructive/10 border-destructive/30';

  return (
    <GlassCard className="p-0 h-full flex flex-col overflow-hidden relative">
      {/* Decorative background glow based on signal */}
      <div className={cn(
        "absolute top-0 right-0 w-32 h-32 blur-3xl opacity-20 pointer-events-none rounded-full translate-x-1/2 -translate-y-1/2",
        isBuy ? "bg-success" : isNeutral ? "bg-muted" : "bg-destructive"
      )} />

      {/* Header Signal */}
      <div className={cn("p-4 border-b flex items-center justify-between", signalBg)}>
        <div>
          <h2 className={cn("text-2xl font-black tracking-tighter uppercase", signalColor, `text-glow-${isBuy ? 'success' : 'destructive'}`)}>
            {result.signal}
          </h2>
          <p className="text-xs font-mono mt-1 opacity-80 uppercase tracking-widest">
            {result.trendAnalysis || "SMC CONFIRMATION PENDING"}
          </p>
        </div>
        <Badge variant={isBuy ? 'success' : isNeutral ? 'default' : 'danger'} className="text-lg px-3 py-1">
          {result.direction}
        </Badge>
      </div>

      <div className="p-4 flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-4">
        
        {/* Verdict Box */}
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="border border-primary/50 bg-primary/5 rounded-lg p-4 relative"
        >
          <div className="absolute -top-2 left-4 bg-background px-2 text-[10px] font-bold text-primary tracking-widest">VERDICT</div>
          <p className="text-sm font-medium leading-relaxed">{result.verdict}</p>
        </motion.div>

        {/* Warnings */}
        {(result.syncError || result.warning) && (
          <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-3 flex gap-3 text-destructive items-start">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
            <div className="text-sm font-medium">
              {result.syncError && <p className="mb-1">ERRO DE SINCRONIA - PREÇO DIVERGENTE DA TELA. ATUALIZE O M5.</p>}
              {result.warning && <p>{result.warning}</p>}
            </div>
          </div>
        )}

        {/* Matrix Table */}
        {result.timeframes && result.timeframes.length > 0 && (
          <div>
            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2 flex items-center gap-2">
              <TrendingUp className="w-3 h-3" /> Timeframe Matrix
            </h3>
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-xs font-mono text-left">
                <thead className="bg-secondary/50">
                  <tr>
                    <th className="px-3 py-2 font-medium">TF</th>
                    <th className="px-3 py-2 font-medium">Trend</th>
                    <th className="px-3 py-2 font-medium text-right">RSI</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {result.timeframes.map((tf, i) => (
                    <tr key={i} className="hover:bg-secondary/20">
                      <td className="px-3 py-2 font-bold text-foreground">{tf.timeframe}</td>
                      <td className={cn("px-3 py-2", 
                        tf.trend.includes('UP') ? 'text-success' : 
                        tf.trend.includes('DOWN') ? 'text-destructive' : 'text-muted-foreground'
                      )}>
                        {tf.trend}
                      </td>
                      <td className="px-3 py-2 text-right opacity-80">{tf.rsi || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </GlassCard>
  );
}
