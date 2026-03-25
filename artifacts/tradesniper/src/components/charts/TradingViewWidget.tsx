import { memo } from 'react';

interface Props {
  symbol: string;
}

// Memoized to prevent iframe reloads on every parent render
export const TradingViewWidget = memo(function TradingViewWidget({ symbol }: Props) {
  const tvSymbol = `BINANCE:${symbol}USDT`;
  
  return (
    <div className="w-full h-full rounded-xl overflow-hidden border border-border relative">
      <iframe
        src={`https://s.tradingview.com/widgetembed/?frameElementId=tradingview_widget&symbol=${tvSymbol}&interval=15&hidesidetoolbar=0&symboledit=1&saveimage=1&toolbarbg=1E1E1E&studies=[]&theme=dark&style=1&timezone=Etc%2FUTC&studies_overrides={}&overrides={}&enabled_features=[]&disabled_features=[]&locale=en&utm_source=localhost&utm_medium=widget&utm_campaign=chart&utm_term=${tvSymbol}`}
        className="w-full h-full border-0 absolute inset-0"
        title={`${symbol} TradingView Chart`}
        allowFullScreen
      />
    </div>
  );
});
