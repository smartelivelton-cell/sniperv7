import { useState } from 'react';
import { Header } from '@/components/layout/Header';
import { TradingViewWidget } from '@/components/charts/TradingViewWidget';
import { ImageUploader } from '@/components/analysis/ImageUploader';
import { AnalysisResultPanel } from '@/components/analysis/AnalysisResultPanel';
import { SniperCalculator } from '@/components/calculator/SniperCalculator';
import { CopilotSidebar } from '@/components/copilot/CopilotSidebar';
import { TradeHistory } from '@/components/trades/TradeHistory';
import { cn } from '@/lib/utils';
import type { AnalysisResult } from '@workspace/api-client-react/src/generated/api.schemas';
import { useCreateTrade } from '@workspace/api-client-react';

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'QTUM', 'AVAX'];

export default function Terminal() {
  const [activeSymbol, setActiveSymbol] = useState(SYMBOLS[0]);
  const [aiResult, setAiResult] = useState<AnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  
  const createTradeMutation = useCreateTrade();

  const handleAnalysisStart = () => {
    setIsAnalyzing(true);
    setAiResult(null);
  };

  const handleAnalysisComplete = (result: AnalysisResult) => {
    setIsAnalyzing(false);
    setAiResult(result);
  };

  const handleAnalysisError = (err: Error) => {
    setIsAnalyzing(false);
    console.error(err);
    // Could add toast here
  };

  const handleExecuteTrade = async (tradeData: any) => {
    // In a real app, this would execute via exchange API, then record.
    // For this prototype, we record it directly as PENDING/OPEN.
    await createTradeMutation.mutateAsync({ data: tradeData });
  };

  return (
    <div className="flex flex-col h-screen max-h-screen bg-background text-foreground overflow-hidden">
      <Header />
      
      <main className="flex-1 flex overflow-hidden p-2 gap-2 relative">
        {/* Background texture from requirements.yaml */}
        <div 
          className="absolute inset-0 opacity-[0.03] pointer-events-none mix-blend-overlay" 
          style={{ backgroundImage: `url(${import.meta.env.BASE_URL}images/bg-texture.png)`, backgroundSize: 'cover' }}
        />

        {/* LEFT COLUMN (Charts & Analysis) - 65% width */}
        <div className="w-[65%] flex flex-col gap-2 min-w-[600px] z-10 relative">
          
          {/* Chart Section */}
          <div className="h-[55%] flex flex-col rounded-xl overflow-hidden border border-border bg-card">
            {/* Tabs */}
            <div className="flex bg-secondary/50 border-b border-border px-2 pt-2 gap-1 overflow-x-auto custom-scrollbar shrink-0">
              {SYMBOLS.map(s => (
                <button
                  key={s}
                  onClick={() => setActiveSymbol(s)}
                  className={cn(
                    "px-4 py-2 text-sm font-bold rounded-t-lg transition-colors border border-b-0",
                    activeSymbol === s 
                      ? "bg-card text-primary border-border" 
                      : "bg-background text-muted-foreground border-transparent hover:bg-secondary hover:text-foreground"
                  )}
                >
                  {s}USDT
                </button>
              ))}
            </div>
            {/* Widget */}
            <div className="flex-1 bg-black">
              {/* Force remount of iframe on symbol change to ensure clean load if needed, 
                  but TradingView handles symbol change internally via prop if properly configured. 
                  Given the iframe src approach, remounting is safer to ensure symbol sync. */}
              <TradingViewWidget key={activeSymbol} symbol={activeSymbol} />
            </div>
          </div>

          {/* Analysis Section Split */}
          <div className="flex-1 flex gap-2 h-[45%]">
            <div className="w-1/2 overflow-y-auto custom-scrollbar rounded-xl">
              <ImageUploader 
                symbol={activeSymbol}
                currentPrice={0} // Ideally passed from ticker context
                balance={187.50} 
                dailyGoal={175}
                onAnalysisStart={handleAnalysisStart}
                onAnalysisComplete={handleAnalysisComplete}
                onAnalysisError={handleAnalysisError}
              />
            </div>
            <div className="w-1/2">
              <AnalysisResultPanel result={aiResult} isLoading={isAnalyzing} />
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN (Calculator & Copilot) - 35% width */}
        <div className="w-[35%] flex flex-col gap-2 min-w-[350px] z-10">
          <div className="h-auto shrink-0">
            <SniperCalculator 
              symbol={activeSymbol} 
              onSymbolChange={setActiveSymbol}
              symbols={SYMBOLS}
              aiResult={aiResult}
              onExecuteTrade={handleExecuteTrade}
            />
          </div>
          <div className="flex-1 min-h-0">
            <CopilotSidebar lastAnalysis={aiResult} />
          </div>
        </div>
      </main>

      {/* BOTTOM FOOTER / TRADE HISTORY */}
      <div className="h-[250px] shrink-0 p-2 pt-0 z-10 relative">
        <TradeHistory dailyGoal={175} />
      </div>
    </div>
  );
}
