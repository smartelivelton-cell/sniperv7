import { Router, type IRouter } from "express";

const router: IRouter = Router();

const TELEGRAM_API = "https://api.telegram.org";
const BANCA = 2000;

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

function handleError(res: any, err: any) {
  if (err.message?.startsWith("RATE_LIMITED:")) {
    const retryAfter = parseInt(err.message.split(":")[1] || "60");
    res.status(429).json({ error: "Rate limited", retryAfter });
  } else {
    res.status(500).json({ error: err.message });
  }
}

function profitLine(label: string, pct: number) {
  const p10 = (BANCA * 10 * pct / 100).toFixed(2);
  const p25 = (BANCA * 25 * pct / 100).toFixed(2);
  const p50 = (BANCA * 50 * pct / 100).toFixed(2);
  return `  ${label} → 10x: <b>+$${p10}</b> | 25x: <b>+$${p25}</b> | 50x: <b>+$${p50}</b>`;
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
    strategies,
    leverage,
    rsi6,
    h4Trend,
  } = req.body as {
    symbol: string;
    side: "LONG" | "SHORT";
    price: number;
    sl: number;
    tp1: number;
    tp2: number;
    tp3: number;
    strategy: string;
    strategies?: string[];
    leverage: number;
    rsi6?: number;
    h4Trend?: string;
  };

  if (!symbol || !side || !price) {
    res.status(400).json({ error: "symbol, side and price are required" });
    return;
  }

  const fmt = (n: number) => (n > 1 ? n.toFixed(2) : n.toFixed(6));
  const absPct = (a: number, b: number) => Math.abs(((b - a) / a) * 100);

  const dirEmoji = side === "LONG" ? "📈" : "📉";
  const dirLabel = side === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const h4Label = h4Trend === "BULL" ? "📊 H4: ALTA ✅" : h4Trend === "BEAR" ? "📊 H4: BAIXA ✅" : "";
  const rsiLabel = rsi6 !== undefined ? `\n🔬 RSI(6): <b>${rsi6.toFixed(0)}</b>` : "";

  const isMaster = Array.isArray(strategies) && strategies.length > 1;
  const stratList = isMaster ? strategies.join(" + ") : strategy;
  const stratEmoji =
    strategy === "Muralha 200" ? "🏰" :
    strategy === "Surfe 200" ? "🌊" :
    strategy === "Onda SAR" ? "📡" :
    strategy === "Fibonacci 50%" ? "📐" :
    strategy === "Exaustão Sniper" ? "🎯" :
    isMaster ? "🚀" : "⚡";

  const slPct = absPct(price, sl).toFixed(2);
  const tp1Pct = absPct(price, tp1);
  const tp2Pct = absPct(price, tp2);
  const tp3Pct = absPct(price, tp3);

  const header = isMaster
    ? `🚀 <b>SINAL MESTRE DETECTADO! (${stratList})</b>`
    : `${stratEmoji} <b>SINAL SNIPER DETECTADO!</b>`;

  const message =
    `${header}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 Ativo: <b>${symbol}</b>\n` +
    `${stratEmoji} Estratégia: <b>${stratList}</b>\n` +
    `⏱ Timeframe: <b>M15</b>${h4Label ? ` · ${h4Label}` : ""}\n` +
    `${dirEmoji} Direção: <b>${dirLabel}</b>\n` +
    `🎚 Alavancagem: <b>${leverage}x</b>` +
    `${rsiLabel}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 Entrada: <b>${fmt(price)}</b>\n` +
    `🛡️ Stop Loss: <b>${fmt(sl)}</b> (-${slPct}%)\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 <b>ALVOS:</b>\n` +
    `  TP1: <b>${fmt(tp1)}</b> (+${tp1Pct.toFixed(2)}%) ← Risco Zero\n` +
    `  TP2: <b>${fmt(tp2)}</b> (+${tp2Pct.toFixed(2)}%)\n` +
    `  TP3: <b>${fmt(tp3)}</b> (+${tp3Pct.toFixed(2)}%)\n` +
    `📏 Risco/Retorno: <b>1:3</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 <b>Projeção de Lucro (Banca $${BANCA}):</b>\n` +
    `${profitLine("TP1", tp1Pct)}\n` +
    `${profitLine("TP2", tp2Pct)}\n` +
    `${profitLine("TP3", tp3Pct)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 <b>Caução Segura (Liq ≥ -10%):</b>\n` +
    `  10x: $${BANCA} · 25x: $${(BANCA * 0.4).toFixed(0)} · 50x: $${(BANCA * 0.2).toFixed(0)}\n` +
    `⚠️ <b>PROTOCOLO RISCO ZERO:</b>\n` +
    `Ao atingir TP1, mova o SL para o ponto de entrada!`;

  try {
    await sendTelegramMessage(message);
    res.json({ ok: true });
  } catch (err: any) {
    handleError(res, err);
  }
});

router.post("/win", async (req, res) => {
  const { symbol, side, entry, tp1, tp2, tp3, tpLevel, strategy } = req.body as {
    symbol: string;
    side: "LONG" | "SHORT";
    entry: number;
    tp1: number;
    tp2: number;
    tp3: number;
    tpLevel: 1 | 2 | 3;
    strategy: string;
  };

  if (!symbol || !side || !entry || !tpLevel) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const fmt = (n: number) => (n > 1 ? n.toFixed(2) : n.toFixed(6));
  const absPct = (a: number, b: number) => Math.abs(((b - a) / a) * 100);
  const fmtUSD = (n: number) => `$${n.toFixed(2)}`;

  const dirEmoji = side === "LONG" ? "📈" : "📉";
  const tpPrices = [tp1, tp2, tp3];
  const tpPrice = tpPrices[tpLevel - 1];
  const tpPct = absPct(entry, tpPrice);
  const profit10 = BANCA * 10 * tpPct / 100;
  const profit25 = BANCA * 25 * tpPct / 100;
  const profit50 = BANCA * 50 * tpPct / 100;

  let message: string;

  if (tpLevel === 1) {
    message =
      `✅ <b>ALVO 1 ATINGIDO! Protocolo Risco Zero Ativado.</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol} | ${dirEmoji} ${side}\n` +
      `🎯 TP1: <b>${fmt(tpPrice)}</b> (+${tpPct.toFixed(2)}%)\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🛡️ <b>MOVA O STOP LOSS PARA O PONTO DE ENTRADA AGORA!</b>\n` +
      `Entrada: ${fmt(entry)} → Novo SL: <b>${fmt(entry)}</b> (Break-Even)\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 <b>Ganhos Parciais (Posição Inteira · Banca $${BANCA}):</b>\n` +
      `  · 10x: <b>+${fmtUSD(profit10)}</b>\n` +
      `  · 25x: <b>+${fmtUSD(profit25)}</b>\n` +
      `  · 50x: <b>+${fmtUSD(profit50)}</b>`;
  } else {
    const tp1Pct = absPct(entry, tp1);
    const tp1_10 = BANCA * 10 * tp1Pct / 100;
    const tp1_25 = BANCA * 25 * tp1Pct / 100;
    const tp1_50 = BANCA * 50 * tp1Pct / 100;

    message =
      `💰 <b>WIN! ALVO ${tpLevel} ATINGIDO! Lucro Travado.</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol} | ${dirEmoji} ${side}\n` +
      `🎯 TP${tpLevel}: <b>${fmt(tpPrice)}</b> (+${tpPct.toFixed(2)}%)\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 <b>Resumo de Ganhos da Posição:</b>\n` +
      `  · Com 10x Alavancagem: <b>+${fmtUSD(profit10)} Lucro</b>\n` +
      `  · Com 25x Alavancagem: <b>+${fmtUSD(profit25)} Lucro</b>\n` +
      `  · Com 50x Alavancagem: <b>+${fmtUSD(profit50)} Lucro</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📈 <b>Acumulado até TP${tpLevel} (vs TP1):</b>\n` +
      `  · 10x: <b>+${fmtUSD(profit10 - tp1_10)} adicional</b>\n` +
      `  · 25x: <b>+${fmtUSD(profit25 - tp1_25)} adicional</b>\n` +
      `  · 50x: <b>+${fmtUSD(profit50 - tp1_50)} adicional</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🛡️ <b>Meta Banca $${BANCA}:</b> Proteja o lucro e use o SAR como Stop Móvel.`;
  }

  try {
    await sendTelegramMessage(message);
    res.json({ ok: true });
  } catch (err: any) {
    handleError(res, err);
  }
});

router.post("/activate", async (req, res) => {
  try {
    await sendTelegramMessage(
      `✅ <b>TradeSniper AI PRO — Sistema Ativado</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📡 Monitorando OKX SWAP 24h\n` +
      `🪙 Ativos: BTC · ETH · SOL · DOGE · AXS · AVAX\n` +
      `💼 Banca de Referência: <b>$2.000</b>\n` +
      `🧠 5 Estratégias Ativas:\n` +
      `  🏰 Muralha & Suporte 200\n` +
      `  🌊 Surfe 200\n` +
      `  📡 Onda SAR Parabólico\n` +
      `  📐 Retração 50% Fibonacci\n` +
      `  🎯 Exaustão Sniper RSI(6)\n` +
      `🚀 Anti-Spam: cooldown 10min por ativo\n` +
      `⏱ Varredura: a cada 30s · GPS: H4 + M15`
    );
    res.json({ ok: true });
  } catch (err: any) {
    handleError(res, err);
  }
});

export default router;
