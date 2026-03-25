import { useState, useRef, useEffect } from 'react';
import { GlassCard, Input, Button } from '../ui/PremiumComponents';
import { Bot, Send, User } from 'lucide-react';
import { useCopilot } from '@/hooks/use-copilot';
import type { AnalysisResult } from '@workspace/api-client-react/src/generated/api.schemas';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

const QUICK_REPLIES = [
  "Pavio de rejeição - cancelo?",
  "Proteger no 0x0 agora?",
  "Volume confirmou?",
  "Qual o melhor setup agora?"
];

interface Props {
  lastAnalysis: AnalysisResult | null;
}

export function CopilotSidebar({ lastAnalysis }: Props) {
  const { messages, sendMessage, isTyping } = useCopilot();
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isTyping) return;
    
    // Inject analysis context if available
    const contextStr = lastAnalysis ? JSON.stringify(lastAnalysis, null, 2) : undefined;
    sendMessage(input, contextStr);
    setInput('');
  };

  const handleQuickReply = (text: string) => {
    const contextStr = lastAnalysis ? JSON.stringify(lastAnalysis, null, 2) : undefined;
    sendMessage(text, contextStr);
  };

  return (
    <GlassCard className="flex flex-col h-full overflow-hidden border-primary/20">
      <div className="p-4 border-b border-border bg-card/50 flex items-center gap-3">
        <div className="relative">
          <img src={`${import.meta.env.BASE_URL}images/ai-avatar.png`} alt="AI Copilot" className="w-10 h-10 rounded-full border border-primary/50" />
          <div className="absolute bottom-0 right-0 w-3 h-3 bg-primary rounded-full border-2 border-card animate-pulse" />
        </div>
        <div>
          <h2 className="font-display font-bold text-lg leading-tight">SNIPER AI</h2>
          <p className="text-[10px] text-primary uppercase tracking-widest">Tactical Support Active</p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
        {messages.length === 0 && (
          <div className="text-center text-muted-foreground text-sm my-10 font-mono opacity-50">
            <Bot className="w-12 h-12 mx-auto mb-2 opacity-50" />
            Waiting for tactical input...
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                "flex gap-3 max-w-[85%]",
                msg.role === 'user' ? "ml-auto flex-row-reverse" : "mr-auto"
              )}
            >
              <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1",
                msg.role === 'user' ? "bg-secondary text-muted-foreground" : "bg-primary/20 text-primary border border-primary/30"
              )}>
                {msg.role === 'user' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
              </div>
              
              <div className={cn(
                "p-3 rounded-xl text-sm leading-relaxed",
                msg.role === 'user' 
                  ? "bg-secondary text-foreground rounded-tr-sm" 
                  : "bg-primary/10 border border-primary/20 text-foreground rounded-tl-sm font-mono"
              )}>
                {msg.content}
                {msg.isStreaming && <span className="inline-block w-1.5 h-3 bg-primary ml-1 animate-pulse" />}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className="p-3 border-t border-border bg-card/50">
        <div className="flex flex-wrap gap-2 mb-3">
          {QUICK_REPLIES.map(qr => (
            <button 
              key={qr}
              onClick={() => handleQuickReply(qr)}
              disabled={isTyping}
              className="text-[10px] bg-secondary hover:bg-primary/20 hover:text-primary hover:border-primary/50 border border-border px-2 py-1 rounded-full transition-colors disabled:opacity-50"
            >
              {qr}
            </button>
          ))}
        </div>
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input 
            value={input} 
            onChange={e => setInput(e.target.value)} 
            placeholder="Ask tactical advice..." 
            className="flex-1 bg-background/50 focus-visible:ring-primary focus-visible:border-primary border-primary/30"
            disabled={isTyping}
          />
          <Button type="submit" variant="primary" disabled={!input.trim() || isTyping} className="px-3 shrink-0">
            <Send className="w-4 h-4" />
          </Button>
        </form>
      </div>
    </GlassCard>
  );
}
