import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/klines", async (req, res) => {
  const { symbol, interval, limit } = req.query as Record<string, string>;

  if (!symbol || !interval) {
    res.status(400).json({ error: "symbol and interval are required" });
    return;
  }

  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit || "300"}`;

  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    res.status(response.status).json({ error: text });
    return;
  }

  const data = await response.json();
  res.json(data);
});

router.get("/ticker", async (req, res) => {
  const { symbol } = req.query as Record<string, string>;
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`;
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    res.status(response.status).json({ error: text });
    return;
  }

  const data = await response.json();
  res.json(data);
});

export default router;
