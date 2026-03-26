import { useState, useEffect, useRef } from 'react';

export interface TickerData {
  symbol: string;
  price: number;
  changePercent: number;
  isUp: boolean;
}

const SYMBOLS = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP', 'DOGE-USDT-SWAP', 'AVAX-USDT-SWAP'];
const OKX_WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';

export function useBinanceTicker() {
  const [tickers, setTickers] = useState<Record<string, TickerData>>({});
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let isMounted = true;
    let reconnectTimeout: number;

    const connect = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;

      const ws = new WebSocket(OKX_WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMounted) return;
        setIsConnected(true);
        ws.send(JSON.stringify({
          op: 'subscribe',
          args: SYMBOLS.map(instId => ({ channel: 'tickers', instId })),
        }));
      };

      ws.onmessage = (event) => {
        if (!isMounted) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.arg?.channel === 'tickers' && msg.data?.[0]) {
            const d = msg.data[0];
            const instId: string = d.instId;
            const base = instId.replace('-USDT-SWAP', '');
            const price = parseFloat(d.last);
            const open24h = parseFloat(d.open24h);
            const changePercent = open24h ? ((price - open24h) / open24h) * 100 : 0;

            setTickers(prev => ({
              ...prev,
              [base]: { symbol: base, price, changePercent, isUp: changePercent >= 0 },
            }));
          }
        } catch (_) {}
      };

      ws.onclose = () => {
        if (isMounted) {
          setIsConnected(false);
          reconnectTimeout = window.setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      isMounted = false;
      clearTimeout(reconnectTimeout);
      wsRef.current?.close();
    };
  }, []);

  return { tickers, isConnected };
}
