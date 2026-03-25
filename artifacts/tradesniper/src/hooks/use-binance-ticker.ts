import { useState, useEffect, useRef } from 'react';

export interface TickerData {
  symbol: string;
  price: number;
  changePercent: number;
  isUp: boolean;
}

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'QTUMUSDT', 'AVAXUSDT'];
const STREAM_URL = `wss://stream.binance.com/stream?streams=${SYMBOLS.map(s => s.toLowerCase() + '@ticker').join('/')}`;

export function useBinanceTicker() {
  const [tickers, setTickers] = useState<Record<string, TickerData>>({});
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let isMounted = true;
    let reconnectTimeout: number;

    const connect = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      
      const ws = new WebSocket(STREAM_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (isMounted) setIsConnected(true);
      };

      ws.onmessage = (event) => {
        if (!isMounted) return;
        try {
          const message = JSON.parse(event.data);
          if (message.data) {
            const data = message.data;
            const symbol = data.s.replace('USDT', '');
            const price = parseFloat(data.c);
            const changePercent = parseFloat(data.P);
            
            setTickers(prev => ({
              ...prev,
              [symbol]: {
                symbol,
                price,
                changePercent,
                isUp: changePercent >= 0
              }
            }));
          }
        } catch (error) {
          console.error("Failed to parse ticker data", error);
        }
      };

      ws.onclose = () => {
        if (isMounted) {
          setIsConnected(false);
          // Reconnect logic
          reconnectTimeout = window.setTimeout(connect, 3000);
        }
      };

      ws.onerror = (error) => {
        console.error("WebSocket error", error);
        ws.close();
      };
    };

    connect();

    return () => {
      isMounted = false;
      clearTimeout(reconnectTimeout);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  return { tickers, isConnected };
}
