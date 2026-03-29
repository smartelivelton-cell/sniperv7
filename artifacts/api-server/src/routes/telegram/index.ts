import { Router, type IRouter } from "express";

const router: IRouter = Router();

const TELEGRAM_API = "https://api.telegram.org";

async function sendTelegramMessage(text: string): Promise<void> {
  const token = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("TELEGRAM_TOKEN or CHAT_ID not configured");
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
    const body = await response.text();
    let parsed: any;
    try { parsed = JSON.parse(body); } catch (_) { parsed = {}; }
    if (parsed?.error_code === 429) {
      const retryAfter = parsed?.parameters?.retry_after ?? 60;
      throw new Error(`RATE_LIMITED:${retryAfter}`);
    }
    throw new Error(`Telegram API error: ${body}`);
  }
}

router.post("/notify", async (req, res) => {
  const {
    symbol,
    side,
    price,
    sl,
    tp1,
    tp2,
    tp3,
    strategy,
    leverage,
    rsi6,
    h4Trend,
    reason,
  } = req.body as {
    symbol: string;
    side: "LONG" | "SHORT";
    price: number;
    sl: number;
    tp1: number;
    tp2: number;
    tp3: number;
    strategy: string;
    leverage: number;
    rsi6?: number;
    h4Trend?: string;
    reason?: string;
  };

  if (!symbol || !side || !price) {
    res.status(400).json({ error: "symbol, side and price are required" });
    return;
  }

  const fmt = (n: number) => (n > 1 ? n.toFixed(2) : n.toFixed(6));
  const pct = (a: number, b: number) => (((b - a) / a) * 100).toFixed(2);

  const dirEmoji = side === "LONG" ? "📈" : "📉";
  const dirLabel = side === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const h4Label = h4Trend === "BULL" ? "📊 H4: ALTA ✅" : h4Trend === "BEAR" ? "📊 H4: BAIXA ✅" : "";
  const rsiLabel = rsi6 !== undefined ? `\n🔬 RSI(6): <b>${rsi6.toFixed(0)}</b>` : "";
  const stratEmoji =
    strategy === "Muralha 200" ? "🏰" :
    strategy === "Surfe 200" ? "🌊" :
    strategy === "Onda SAR" ? "📡" :
    strategy === "Fibonacci 50%" ? "📐" :
    strategy === "Exaustão Sniper" ? "🎯" : "⚡";

  const slPct = Math.abs(parseFloat(pct(price, sl)));
  const tp1Pct = Math.abs(parseFloat(pct(price, tp1)));
  const tp2Pct = Math.abs(parseFloat(pct(price, tp2)));
  const tp3Pct = Math.abs(parseFloat(pct(price, tp3)));

  const message =
    `🚀 <b>SINAL SNIPER DETECTADO!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 Ativo: <b>${symbol}</b>\n` +
    `${stratEmoji} Estratégia: <b>${strategy}</b>\n` +
    `⏱ Timeframe: <b>M15</b>${h4Label ? ` · ${h4Label}` : ""}\n` +
    `${dirEmoji} Direção: <b>${dirLabel}</b>\n` +
    `🎚 Alavancagem: <b>${leverage}x</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 Entrada: <b>${fmt(price)}</b>\n` +
    `🛡️ Stop Loss: <b>${fmt(sl)}</b> (-${slPct}%)\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 <b>ALVOS:</b>\n` +
    `  TP1: <b>${fmt(tp1)}</b> (+${tp1Pct}%) ← Mover SL para BE\n` +
    `  TP2: <b>${fmt(tp2)}</b> (+${tp2Pct}%)\n` +
    `  TP3: <b>${fmt(tp3)}</b> (+${tp3Pct}%)\n` +
    `📏 Risco/Retorno: <b>1:3</b>` +
    `${rsiLabel}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ <b>PROTOCOLO RISCO ZERO:</b>\n` +
    `Ao atingir TP1, mova o SL para o ponto de entrada!\n` +
    `💰 Banca: $187.50 · Meta Diária: $100`;

  try {
    await sendTelegramMessage(message);
    res.json({ ok: true });
  } catch (err: any) {
    if (err.message?.startsWith("RATE_LIMITED:")) {
      const retryAfter = parseInt(err.message.split(":")[1] || "60");
      res.status(429).json({ error: "Rate limited", retryAfter });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

router.post("/activate", async (req, res) => {
  try {
    await sendTelegramMessage(
      `✅ <b>CryptoSniper PRO — Sistema Ativado</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📡 Monitorando OKX SWAP 24h\n` +
      `🪙 Ativos: BTC · ETH · SOL · DOGE · AXS · AVAX\n` +
      `🧠 5 Estratégias Ativas:\n` +
      `  🏰 Muralha & Suporte 200\n` +
      `  🌊 Surfe 200\n` +
      `  📡 Onda SAR Parabólico\n` +
      `  📐 Retração 50% Fibonacci\n` +
      `  🎯 Exaustão Sniper RSI(6)\n` +
      `⏱ Varredura: a cada 30s · GPS: H4 + M15`
    );
    res.json({ ok: true });
  } catch (err: any) {
    if (err.message?.startsWith("RATE_LIMITED:")) {
      const retryAfter = parseInt(err.message.split(":")[1] || "60");
      res.status(429).json({ error: "Rate limited", retryAfter });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

export default router;
