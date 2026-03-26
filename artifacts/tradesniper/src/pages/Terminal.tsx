import { useState, useEffect } from 'react';
import { Header } from '@/components/layout/Header';
import { TradingViewWidget } from '@/components/charts/TradingViewWidget';
import { ImageUploader } from '@/components/analysis/ImageUploader';
import { AnalysisResultPanel } from '@/components/analysis/AnalysisResultPanel';
import { SniperCalculator } from '@/components/calculator/SniperCalculator';
import { GoalsTracker } from '@/components/calculator/GoalsTracker';
import { CopilotSidebar } from '@/components/copilot/CopilotSidebar';
import { TradeHistory } from '@/components/trades/TradeHistory';
import { MonitorScanner } from '@/components/monitor/MonitorScanner';
import { cn } from '@/lib/utils';
import type { AnalysisResult } from '@workspace/api-client-react/src/generated/api.schemas';
import { useCreateTrade } from '@workspace/api-client-react';
import { LayoutDashboard, Eye, Calculator, Bot, Radar } from 'lucide-react';

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'DOGE', 'ZEC', 'OP', 'QTUM', 'AXS', 'AVAX'];

const TABS = [
  { id: 'command', label: 'Central de Comando', icon: LayoutDashboard },
  { id: 'vision', label: 'Visão IA', icon: Eye },
  { id: 'calculator', label: 'Calculadora & Metas', icon: Calculator },
  { id: 'scanner', label: 'Scanner', icon: Radar },
  { id: 'copilot', label: 'Copiloto Chat', icon: Bot },
] as const;

type TabId = typeof TABS[number]['id'];

export default function Terminal() {
  const [activeTab, setActiveTab] = useState<TabId>('command');
  const [activeSymbol, setActiveSymbol] = useState(SYMBOLS[0]);
  const [aiResult, setAiResult] = useState<AnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chartKey, setChartKey] = useState(0);

  useEffect(() => {
    if (activeTab === 'command') {
      setChartKey(k => k + 1);
    }
  }, [activeTab]);

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
  };

  const handleExecuteTrade = async (tradeData: any) => {
    await createTradeMutation.mutateAsync({ data: tradeData });
  };

  return (
    <div className="flex flex-col h-screen max-h-screen bg-background text-foreground overflow-hidden">
      <Header />

      <nav className="flex bg-card/80 border-b border-border shrink-0 px-2">
        {TABS.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-2 px-5 py-3 text-sm font-bold transition-all border-b-2 whitespace-nowrap",
                isActive
                  ? "border-primary text-primary bg-primary/5"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/40"
              )}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
              {tab.id === 'vision' && aiResult && (
                <span className="ml-1 w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              )}
              {tab.id === 'scanner' && (
                <span className="ml-1 w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              )}
            </button>
          );
        })}
      </nav>

      {/* ── ABA 1: CENTRAL DE COMANDO ── */}
      <div className={cn("flex-1 flex flex-col overflow-hidden", activeTab !== 'command' && "hidden")}>
        <div className="flex-1 flex flex-col overflow-hidden p-2 pb-1">
          <div className="flex-1 flex flex-col rounded-xl overflow-hidden border border-border bg-card relative">
            <div className="flex bg-secondary/50 border-b border-border px-2 gap-1 overflow-x-auto shrink-0">
              {SYMBOLS.map(s => (
                <button
                  key={s}
                  onClick={() => setActiveSymbol(s)}
                  className={cn(
                    "px-4 py-2 text-sm font-bold rounded-t-lg transition-colors border border-b-0 shrink-0",
                    activeSymbol === s
                      ? "bg-card text-primary border-border"
                      : "bg-background text-muted-foreground border-transparent hover:bg-secondary hover:text-foreground"
                  )}
                >
                  {s}-USDT-SWAP
                </button>
              ))}
            </div>
            <div className="flex-1 bg-black min-h-0">
              <TradingViewWidget key={`${activeSymbol}-${chartKey}`} symbol={activeSymbol} />
            </div>
          </div>
        </div>

        <div className="shrink-0 px-2 pb-2 z-10">
          <button
            onClick={() => setHistoryOpen(o => !o)}
            className="w-full flex items-center justify-between px-4 py-2 bg-card border border-border rounded-lg text-xs font-bold text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
          >
            <span>📋 HISTÓRICO DO DIA</span>
            <span>{historyOpen ? '▲ Fechar' : '▼ Expandir'}</span>
          </button>
          {historyOpen && (
            <div className="mt-1 max-h-[200px] overflow-y-auto">
              <TradeHistory dailyGoal={175} />
            </div>
          )}
        </div>
      </div>

      {/* ── ABA 2: VISÃO IA ── */}
      <div className={cn("flex-1 flex overflow-hidden p-2 gap-2", activeTab !== 'vision' && "hidden")}>
        <div className="w-1/2 overflow-y-auto">
          <ImageUploader
            symbol={activeSymbol}
            currentPrice={0}
            balance={187.50}
            dailyGoal={175}
            onAnalysisStart={handleAnalysisStart}
            onAnalysisComplete={(result) => {
              handleAnalysisComplete(result);
            }}
            onAnalysisError={handleAnalysisError}
          />
        </div>
        <div className="w-1/2 overflow-y-auto">
          <AnalysisResultPanel result={aiResult} isLoading={isAnalyzing} />
        </div>
      </div>

      {/* ── ABA 3: CALCULADORA & METAS ── */}
      <div className={cn("flex-1 flex overflow-hidden p-2 gap-2", activeTab !== 'calculator' && "hidden")}>
        <div className="w-[45%] overflow-y-auto">
          <SniperCalculator
            symbol={activeSymbol}
            onSymbolChange={setActiveSymbol}
            symbols={SYMBOLS}
            aiResult={aiResult}
            onExecuteTrade={handleExecuteTrade}
          />
        </div>
        <div className="w-[55%] overflow-y-auto">
          <GoalsTracker />
        </div>
      </div>

      {/* ── ABA 4: SCANNER ── */}
      <div className={cn("flex-1 flex overflow-hidden", activeTab !== 'scanner' && "hidden")}>
        <MonitorScanner />
      </div>

      {/* ── ABA 5: COPILOTO CHAT ── */}
      <div className={cn("flex-1 flex overflow-hidden p-2", activeTab !== 'copilot' && "hidden")}>
        <div className="flex-1 max-w-3xl mx-auto">
          <CopilotSidebar lastAnalysis={aiResult} />
        </div>
      </div>
    </div>
  );
}
