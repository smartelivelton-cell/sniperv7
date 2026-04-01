import { Router, type IRouter } from "express";
import { notifySignalSent } from "../../lib/heartbeat";

const router: IRouter = Router();

const TELEGRAM_API = "https://api.telegram.org";
const BANCA = 2000;

async function sendTelegramMessage(text: string): Promise<void> {
  const token  = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_TOKEN or CHAT_ID not configured");

  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
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

const fmt    = (n: number) => n > 1 ? n.toFixed(2) : n.toFixed(6);
const fmtUSD = (n: number) => `$${n.toFixed(2)}`;
const absPct = (a: number, b: number) => Math.abs(((b - a) / a) * 100);
const tfDot  = (t: string) => t === "BULL" ? "🟢" : t === "BEAR" ? "🔴" : "🟡";

function profitRow(label: string, pct: number, banca = BANCA) {
  const p10 = fmtUSD(banca * 10 * pct / 100);
  const p25 = fmtUSD(banca * 25 * pct / 100);
  const p50 = fmtUSD(banca * 50 * pct / 100);
  return `  ${label} → 10x: <b>+${p10}</b> | 25x: <b>+${p25}</b> | 50x: <b>+${p50}</b>`;
}

// ── /notify ───────────────────────────────────────────────────────────────────

router.post("/notify", async (req, res) => {
  const {
    symbol, side, price, entry2, avgEntry,
    sl, tp1, tp2, tp3,
    strategy, strategies, leverage,
    rsi6, h4Trend, multiTrend, confluenceCount, isHighProbability,
  } = req.body as {
    symbol: string; side: "LONG" | "SHORT";
    price: number; entry2?: number; avgEntry?: number;
    sl: number; tp1: number; tp2: number; tp3: number;
    strategy: string; strategies?: string[]; leverage: number;
    rsi6?: number; h4Trend?: string;
    multiTrend?: { d1: string; h4: string; h1: string; m15: string; m5: string };
    confluenceCount?: number; isHighProbability?: boolean;
  };

  if (!symbol || !side || !price) {
    res.status(400).json({ error: "symbol, side and price are required" });
    return;
  }

  const isMaster    = Array.isArray(strategies) && strategies.length > 1;
  const stratList   = isMaster ? strategies!.join(" + ") : strategy;
  const isReversal  = strategy === "Fênix Reversão";
  const dirEmoji    = side === "LONG" ? "📈" : "📉";
  const dirLabel    = side === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const rsiLabel    = rsi6 !== undefined ? `\n🔬 RSI(6): <b>${rsi6.toFixed(0)}</b>` : "";
  const h4Label     = h4Trend === "BULL" ? "H4:🟢" : h4Trend === "BEAR" ? "H4:🔴" : "";
  const avgE        = avgEntry ?? price;
  const entry2val   = entry2 ?? price;

  const stratEmoji =
    strategy === "Muralha 200"   ? "🏰" :
    strategy === "Muralha Buffer"? "🏰" :
    strategy === "Surfe 200"     ? "🌊" :
    strategy === "Onda SAR"      ? "📡" :
    strategy === "Fibonacci 50%" ? "📐" :
    strategy === "Exaustão Sniper"? "🎯" :
    isReversal ? "🔥" :
    isMaster ? "🚀" : "⚡";

  const slPct   = absPct(avgE, sl).toFixed(2);
  const tp1Pct  = absPct(avgE, tp1);
  const tp2Pct  = absPct(avgE, tp2);
  const tp3Pct  = absPct(avgE, tp3);

  // GPS multi-temporal line
  const gpsLine = multiTrend
    ? `\n📡 GPS: D1(${tfDot(multiTrend.d1)}) H4(${tfDot(multiTrend.h4)}) H1(${tfDot(multiTrend.h1)}) M15(${tfDot(multiTrend.m15)}) M5(${tfDot(multiTrend.m5)})`
    : "";

  const header =
    isHighProbability ? `🔥 <b>SINAL DE ALTA PROBABILIDADE! (${confluenceCount}/5 TFs)</b>` :
    isMaster ? `🚀 <b>SINAL MESTRE DETECTADO! (${stratList})</b>` :
    isReversal ? `🔥 <b>FÊNIX DE REVERSÃO DETECTADO!</b>` :
    `${stratEmoji} <b>SINAL SNIPER DETECTADO!</b>`;

  const reversalLine = isReversal ? `⚠️ <b>OPERAÇÃO DE REVERSÃO — ALVO CURTO</b>\n` : "";

  const message =
    `${header}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${reversalLine}` +
    `🪙 Ativo: <b>${symbol}</b>\n` +
    `${stratEmoji} Estratégia: <b>${stratList}</b>\n` +
    `⏱ Timeframe: <b>M15</b>${h4Label ? ` · ${h4Label}` : ""}${gpsLine}` +
    `\n${dirEmoji} Direção: <b>${dirLabel}</b>\n` +
    `🎚 Alavancagem: <b>${leverage}x</b>${rsiLabel}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 <b>ENTRADA EM ESCADA (50% + 50%):</b>\n` +
    `  🔹 Entrada 1 (50% Mkt): <b>${fmt(price)}</b>\n` +
    `  🔹 Entrada 2 (50% EMA21): <b>${fmt(entry2val)}</b>\n` +
    `  📊 Preço Médio: <b>${fmt(avgE)}</b>\n` +
    `🛡️ Stop Loss: <b>${fmt(sl)}</b> (-${slPct}%)\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 <b>ALVOS (a partir da média):</b>\n` +
    `  TP1: <b>${fmt(tp1)}</b> (+${tp1Pct.toFixed(2)}%) ← Risco Zero\n` +
    `  TP2: <b>${fmt(tp2)}</b> (+${tp2Pct.toFixed(2)}%)\n` +
    `  TP3: <b>${fmt(tp3)}</b> (+${tp3Pct.toFixed(2)}%)\n` +
    `📏 Risco/Retorno: <b>1:3</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 <b>Projeção de Lucro (Banca $${BANCA} · Entrada Média):</b>\n` +
    `${profitRow("TP1", tp1Pct)}\n` +
    `${profitRow("TP2", tp2Pct)}\n` +
    `${profitRow("TP3", tp3Pct)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 <b>Caução Segura (Liq ≥ -10%):</b>\n` +
    `  10x: $${BANCA} · 25x: $${(BANCA * 0.4).toFixed(0)} · 50x: $${(BANCA * 0.2).toFixed(0)}\n` +
    `⚠️ <b>PROTOCOLO RISCO ZERO:</b>\n` +
    `Ao atingir TP1, mova o SL para o ponto de entrada!`;

  try {
    await sendTelegramMessage(message);
    notifySignalSent();
    res.json({ ok: true });
  } catch (err: any) {
    handleError(res, err);
  }
});

// ── /win ──────────────────────────────────────────────────────────────────────

router.post("/win", async (req, res) => {
  const { symbol, side, entry, entry2, avgEntry, tp1, tp2, tp3, tpLevel, strategy } = req.body as {
    symbol: string; side: "LONG" | "SHORT";
    entry: number; entry2?: number; avgEntry?: number;
    tp1: number; tp2: number; tp3: number;
    tpLevel: 1 | 2 | 3; strategy: string;
  };

  if (!symbol || !side || !entry || !tpLevel) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const avgE       = avgEntry ?? entry;
  const dirEmoji   = side === "LONG" ? "📈" : "📉";
  const tpPrices   = [tp1, tp2, tp3];
  const tpPrice    = tpPrices[tpLevel - 1];
  const tpPct      = absPct(avgE, tpPrice);
  const profit10   = BANCA * 10 * tpPct / 100;
  const profit25   = BANCA * 25 * tpPct / 100;
  const profit50   = BANCA * 50 * tpPct / 100;

  let message: string;

  if (tpLevel === 1) {
    message =
      `✅ <b>ALVO 1 ATINGIDO! Protocolo Risco Zero Ativado.</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol} | ${dirEmoji} ${side}\n` +
      `🎯 TP1: <b>${fmt(tpPrice)}</b> (+${tpPct.toFixed(2)}%)\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🛡️ <b>MOVA O STOP LOSS PARA O PONTO DE ENTRADA AGORA!</b>\n` +
      `Média de Entrada: ${fmt(avgE)} → Novo SL: <b>${fmt(avgE)}</b> (Break-Even)\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 <b>Ganhos Parciais (Banca $${BANCA} · Entrada Média):</b>\n` +
      `  · 10x: <b>+${fmtUSD(profit10)}</b>\n` +
      `  · 25x: <b>+${fmtUSD(profit25)}</b>\n` +
      `  · 50x: <b>+${fmtUSD(profit50)}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🎯 Próximo alvo: TP2 — mantenha a posição restante!`;
  } else {
    const tp1Pct  = absPct(avgE, tp1);
    const addPct  = tpPct - tp1Pct;
    const add10   = BANCA * 10 * addPct / 100;
    const add25   = BANCA * 25 * addPct / 100;
    const add50   = BANCA * 50 * addPct / 100;

    message =
      `💰 <b>WIN! ALVO ${tpLevel} ATINGIDO! Lucro Travado.</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${symbol} | ${dirEmoji} ${side}\n` +
      `🎯 TP${tpLevel}: <b>${fmt(tpPrice)}</b> (+${tpPct.toFixed(2)}%)\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 <b>Resumo de Ganhos da Posição (Banca $${BANCA}):</b>\n` +
      `  · Com 10x: <b>+${fmtUSD(profit10)} Lucro</b>\n` +
      `  · Com 25x: <b>+${fmtUSD(profit25)} Lucro</b>\n` +
      `  · Com 50x: <b>+${fmtUSD(profit50)} Lucro</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📈 <b>Ganho adicional vs TP1:</b>\n` +
      `  · 10x: <b>+${fmtUSD(add10)}</b> | 25x: <b>+${fmtUSD(add25)}</b> | 50x: <b>+${fmtUSD(add50)}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🏆 <b>PARABÉNS PELO WIN!</b>\n` +
      `🛡️ Meta Banca $${BANCA}: Proteja o lucro e use o SAR como Stop Móvel.`;
  }

  try {
    await sendTelegramMessage(message);
    res.json({ ok: true });
  } catch (err: any) {
    handleError(res, err);
  }
});

// ── /radar ────────────────────────────────────────────────────────────────────

router.post("/radar", async (req, res) => {
  const { coins } = req.body as {
    coins: Array<{ symbol: string; d1: string; h4: string; h1: string; m15: string; m5: string }>;
  };

  if (!Array.isArray(coins) || coins.length === 0) {
    res.status(400).json({ error: "coins array required" });
    return;
  }

  const lines = coins.map(c => {
    const tfs     = [c.d1, c.h4, c.h1, c.m15, c.m5];
    const bullCnt = tfs.filter(t => t === "BULL").length;
    const bearCnt = tfs.filter(t => t === "BEAR").length;
    const status  =
      bullCnt >= 4 ? `🔥 LONG CONFIRMADO (${bullCnt}/5)` :
      bearCnt >= 4 ? `🔥 SHORT CONFIRMADO (${bearCnt}/5)` :
      bullCnt === 3 || bearCnt === 3 ? `⚠️ SINAL FRACO` : `🕐 AGUARDAR`;
    return `🪙 <b>${c.symbol}:</b> D1(${tfDot(c.d1)}) H4(${tfDot(c.h4)}) H1(${tfDot(c.h1)}) M15(${tfDot(c.m15)}) M5(${tfDot(c.m5)}) → ${status}`;
  });

  const now     = new Date().toLocaleTimeString("pt-BR");
  const message =
    `📊 <b>RELATÓRIO DE RADAR SNIPER</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    lines.join("\n") +
    `\n━━━━━━━━━━━━━━━━━━━━\n` +
    `⏱ ${now} · OKX SWAP · GPS D1·H4·H1·M15·M5`;

  try {
    await sendTelegramMessage(message);
    res.json({ ok: true });
  } catch (err: any) {
    handleError(res, err);
  }
});

// ── /retained (Termômetro BTC) ────────────────────────────────────────────────

router.post("/retained", async (req, res) => {
  const { symbol, side, price, strategies } = req.body as {
    symbol: string; side: string; price: number; strategies: string[];
  };

  const stratList = Array.isArray(strategies) ? strategies.join(" + ") : (strategies || "");
  const message =
    `⚠️ <b>SINAL RETIDO — TERMÔMETRO BTC</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 ${symbol} | ${side === "SHORT" ? "📉 SHORT" : "📈 LONG"}\n` +
    `🔍 Estratégia: <b>${stratList}</b>\n` +
    `💵 Preço: <b>${fmt(price)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🌡️ <b>Tendência da Altcoin é queda, mas BTC está em alta.</b>\n` +
    `Aguardando alinhamento do mestre para confirmar o SHORT.\n` +
    `→ Só entre quando BTC também mostrar fraqueza no M15.`;

  try {
    await sendTelegramMessage(message);
    res.json({ ok: true });
  } catch (err: any) {
    handleError(res, err);
  }
});

// ── /calm (Motor Anti-Ansiedade) ──────────────────────────────────────────────

router.post("/calm", async (req, res) => {
  const { symbol, side, entry, currentPrice, sl } = req.body as {
    symbol: string; side: string; entry: number; currentPrice: number; sl: number;
  };

  const drawdownPct = Math.abs(((currentPrice - entry) / entry) * 100).toFixed(2);
  const message =
    `🧠 <b>MANTENHA A DISCIPLINA!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 ${symbol} | ${side === "SHORT" ? "📉 SHORT" : "📈 LONG"}\n` +
    `💵 Entrada Média: $${fmt(entry)} | Atual: $${fmt(currentPrice)}\n` +
    `📊 Drawdown: <b>-${drawdownPct}%</b>\n` +
    `🛡️ SL: $${fmt(sl)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🧠 O preço está testando a região, mas o SAR Parabólico\n` +
    `e a Muralha 200 ainda garantem o movimento.\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 <b>Probabilidade de Win: 70%</b>\n` +
    `⛔ Não feche no emocional! Respeite o SL definido.`;

  try {
    await sendTelegramMessage(message);
    res.json({ ok: true });
  } catch (err: any) {
    handleError(res, err);
  }
});

// ── /anticipation (80% de confirmação — pré-sinal) ───────────────────────────

router.post("/anticipation", async (req, res) => {
  const { symbol, side, strategy, price, reason, confluenceCount } = req.body as {
    symbol: string; side: "LONG" | "SHORT";
    strategy: string; price: number;
    reason: string; confluenceCount: number;
  };

  if (!symbol || !side || !strategy || !price) {
    res.status(400).json({ error: "symbol, side, strategy and price are required" });
    return;
  }

  const dirEmoji = side === "LONG" ? "📈" : "📉";
  const dirLabel = side === "LONG" ? "🟢 LONG" : "🔴 SHORT";

  const stratEmoji =
    strategy === "Muralha 200"    ? "🏰" :
    strategy === "Surfe 200"      ? "🌊" :
    strategy === "Onda SAR"       ? "📡" :
    strategy === "Fibonacci 50%"  ? "📐" :
    strategy === "Exaustão Sniper"? "🎯" :
    strategy === "Fênix Reversão" ? "🔥" : "⚡";

  const message =
    `👀 <b>ANTECIPAÇÃO SNIPER — 80% de Confirmação</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 Ativo: <b>${symbol}</b>\n` +
    `${stratEmoji} Estratégia: <b>${strategy}</b> em formação\n` +
    `${dirEmoji} Direção esperada: <b>${dirLabel}</b>\n` +
    `💵 Preço atual: <b>${fmt(price)}</b>\n` +
    `📊 Confluência: <b>${confluenceCount}/5 TFs</b> alinhados\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔍 <b>Condição em formação:</b>\n${reason}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 <b>Prepare o gatilho!</b>\n` +
    `⏳ Aguardando confirmação final (volume/vela de fechamento).\n` +
    `⚠️ <b>NÃO ENTRE AINDA — espere o sinal 100%.</b>`;

  try {
    await sendTelegramMessage(message);
    res.json({ ok: true });
  } catch (err: any) {
    handleError(res, err);
  }
});

// ── /heartbeat (motor operacional — disparado pelo servidor) ──────────────────

router.post("/heartbeat", async (req, res) => {
  const message =
    `🔋 <b>Status Sniper: Motor operacional.</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📡 Monitorando 7 estratégias · OKX SWAP · GPS 5TF\n` +
    `⏱ Última varredura: ${new Date().toLocaleTimeString("pt-BR")}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🧘 <i>Paciência é a virtude do Trader!\n` +
    `O mercado sempre oferece oportunidade — espere a sua.</i>`;

  try {
    await sendTelegramMessage(message);
    res.json({ ok: true });
  } catch (err: any) {
    handleError(res, err);
  }
});

// ── /activate ─────────────────────────────────────────────────────────────────

router.post("/activate", async (req, res) => {
  try {
    await sendTelegramMessage(
      `✅ <b>TradeSniper AI PRO — Sistema Ativado</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📡 Monitorando OKX SWAP 24h\n` +
      `🪙 Ativos: BTC · ETH · SOL · DOGE · AXS · AVAX\n` +
      `💼 Banca de Referência: <b>$2.000</b>\n` +
      `🧠 <b>7 Estratégias Ativas:</b>\n` +
      `  🏰 Muralha 200 (com Buffer 0.2%)\n` +
      `  🌊 Surfe 200\n` +
      `  📡 Onda SAR Parabólico\n` +
      `  📐 Retração 50% Fibonacci\n` +
      `  🎯 Exaustão Sniper RSI(6)\n` +
      `  🔥 Fênix de Reversão (Volume + RSI &lt; 20)\n` +
      `  🛡️ Protocolo Risco Zero (SL no Break-Even)\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🌍 GPS Multi-Temporal: D1 · H4 · H1 · M15 · M5\n` +
      `🔥 Alta Prob: 4/5 TFs alinhados\n` +
      `🌡️ Termômetro BTC: bloqueia SHORTs se BTC em alta\n` +
      `🧠 Anti-Ansiedade: suporte psicológico em drawdown\n` +
      `💵 Entrada em Escada: 50% Mkt + 50% EMA21\n` +
      `🚀 Anti-Spam: Cooldown 10min por ativo\n` +
      `⏱ Varredura: A cada 30s · Radar: a cada 4h`
    );
    res.json({ ok: true });
  } catch (err: any) {
    handleError(res, err);
  }
});

export default router;
