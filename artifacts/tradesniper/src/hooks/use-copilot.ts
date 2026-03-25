import { useState, useRef, useCallback } from 'react';
import { useCreateAnthropicConversation, useListAnthropicMessages } from '@workspace/api-client-react';

export interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
}

export function useCopilot() {
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  
  const createConvMutation = useCreateAnthropicConversation();
  
  // Fetch existing messages if we have an ID (useful for reconnection/reload scenarios)
  const { data: history } = useListAnthropicMessages(conversationId!, {
    query: { enabled: !!conversationId }
  });

  const sendMessage = useCallback(async (content: string, systemContext?: string) => {
    let currentId = conversationId;
    
    // 1. Ensure conversation exists
    if (!currentId) {
      try {
        const newConv = await createConvMutation.mutateAsync({ 
          data: { title: "TradeSniper Copilot" } 
        });
        currentId = newConv.id;
        setConversationId(currentId);
      } catch (err) {
        console.error("Failed to create conversation", err);
        return;
      }
    }

    // 2. Optimistic user message update
    const userMsgId = Date.now().toString();
    const payload = systemContext ? `[SYSTEM CONTEXT]\n${systemContext}\n\n[USER]\n${content}` : content;
    
    setMessages(prev => [...prev, { id: userMsgId, role: 'user', content }]);
    
    // 3. Prepare AI message placeholder
    const aiMsgId = (Date.now() + 1).toString();
    setMessages(prev => [...prev, { id: aiMsgId, role: 'assistant', content: '', isStreaming: true }]);
    setIsTyping(true);

    try {
      // 4. Send request and consume SSE
      const response = await fetch(`/api/anthropic/conversations/${currentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: payload })
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let fullContent = '';

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.done) {
                  // Finalize message
                  setMessages(prev => prev.map(m => 
                    m.id === aiMsgId ? { ...m, isStreaming: false } : m
                  ));
                } else if (data.content) {
                  fullContent += data.content;
                  setMessages(prev => prev.map(m => 
                    m.id === aiMsgId ? { ...m, content: fullContent } : m
                  ));
                }
              } catch (e) {
                // Ignore partial JSON parse errors
              }
            }
          }
        }
      }
    } catch (error) {
      console.error("SSE Error:", error);
      setMessages(prev => prev.map(m => 
        m.id === aiMsgId ? { ...m, content: "⚠️ Error connecting to AI Copilot.", isStreaming: false } : m
      ));
    } finally {
      setIsTyping(false);
    }
  }, [conversationId, createConvMutation]);

  return {
    messages,
    sendMessage,
    isTyping,
    hasConversation: !!conversationId
  };
}
