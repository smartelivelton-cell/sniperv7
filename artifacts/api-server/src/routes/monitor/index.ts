import { Router, type IRouter } from "express";

const router: IRouter = Router();

const OKX_BASE = "https://www.okx.com/api/v5";

const BAR_MAP: Record<string, string> = {
  "15m": "15m",
  "1m": "1m",
  "5m": "5m",
  "30m": "30m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
};

router.get("/klines", async (req, res) => {
  const { symbol, interval, limit } = req.query as Record<string, string>;

  if (!symbol || !interval) {
    res.status(400).json({ error: "symbol and interval are required" });
    return;
  }

  const bar = BAR_MAP[interval] || interval;
  const instId = symbol.includes("-") ? symbol : `${symbol}-USDT-SWAP`;
  const url = `${OKX_BASE}/market/candles?instId=${instId}&bar=${bar}&limit=${limit || "300"}`;

  try {
    const response = await fetch(url, {
      headers: { "Accept": "application/json" },
    });

    if (!response.ok) {
      const text = await response.text();
      res.status(response.status).json({ error: text });
      return;
    }

    const json = await response.json();
    if (json.code !== "0") {
      res.status(400).json({ error: json.msg || "OKX API error" });
      return;
    }

    const data = json.data as string[][];
    const reversed = [...data].reverse();

    const candles = reversed.map((k) => ({
      openTime: parseInt(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

    res.json(candles);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/ticker", async (req, res) => {
  const { symbol } = req.query as Record<string, string>;
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  const instId = symbol.includes("-") ? symbol : `${symbol}-USDT-SWAP`;
  const url = `${OKX_BASE}/market/ticker?instId=${instId}`;

  try {
    const response = await fetch(url, {
      headers: { "Accept": "application/json" },
    });

    if (!response.ok) {
      const text = await response.text();
      res.status(response.status).json({ error: text });
      return;
    }

    const json = await response.json();
    if (json.code !== "0" || !json.data?.[0]) {
      res.status(400).json({ error: json.msg || "No ticker data" });
      return;
    }

    const t = json.data[0];
    res.json({ symbol: t.instId, price: parseFloat(t.last), change: parseFloat(t.change24h || "0") });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
