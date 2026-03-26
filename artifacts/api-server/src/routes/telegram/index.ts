import { Router, type IRouter } from "express";

const router: IRouter = Router();

const TELEGRAM_API = "https://api.telegram.org";

async function sendTelegramMessage(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured");
  }

  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram API error: ${text}`);
  }
}

router.post("/notify", async (req, res) => {
  const { symbol, side, price, sl, tp } = req.body as {
    symbol: string;
    side: "LONG" | "SHORT";
    price: number;
    sl: number;
    tp: number;
  };

  if (!symbol || !side || !price) {
    res.status(400).json({ error: "symbol, side and price are required" });
    return;
  }

  const fmt = (n: number) => (n > 1 ? n.toFixed(2) : n.toFixed(6));
  const emoji = side === "LONG" ? "📈" : "📉";

  const message =
    `🚀 <b>SINAL SNIPER DETECTADO!</b>\n` +
    `🪙 Moeda: <b>${symbol}</b>\n` +
    `${emoji} Direção: <b>${side}</b>\n` +
    `💵 Preço Atual: <b>${fmt(price)}</b>\n` +
    `🛡️ Stop Loss: <b>${fmt(sl)}</b>\n` +
    `🎯 Take Profit: <b>${fmt(tp)}</b>\n` +
    `⚠️ Confirme a rejeição na média antes de entrar com 50x!`;

  try {
    await sendTelegramMessage(message);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/activate", async (req, res) => {
  try {
    await sendTelegramMessage("✅ <b>Sistema de Alertas Telegram Ativado</b>\nTradeSniper AI PRO está monitorando o mercado OKX 24h.");
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
