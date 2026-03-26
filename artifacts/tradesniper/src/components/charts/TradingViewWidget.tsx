import { memo } from 'react';

interface Props {
  symbol: string;
}

export const TradingViewWidget = memo(function TradingViewWidget({ symbol }: Props) {
  const tvSymbol = `OKX:${symbol}USDT.P`;
  const src = `https://s.tradingview.com/widgetembed/?frameElementId=tv_${symbol}&symbol=${encodeURIComponent(tvSymbol)}&interval=15&hidesidetoolbar=0&symboledit=1&saveimage=1&toolbarbg=1E1E1E&studies=%5B%5D&theme=dark&style=1&timezone=Etc%2FUTC&studies_overrides=%7B%7D&overrides=%7B%7D&enabled_features=%5B%5D&disabled_features=%5B%5D&locale=pt_BR`;

  return (
    <iframe
      key={src}
      src={src}
      style={{ width: '100%', height: '100%', display: 'block', border: 'none' }}
      title={`OKX:${symbol}-USDT-SWAP Chart`}
      allowFullScreen
      loading="eager"
    />
  );
});
