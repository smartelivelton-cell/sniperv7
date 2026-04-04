import { logger } from "./logger";
import { notifySignalSent } from "./heartbeat";
import { isLowAssertivityHour } from "./backtestState";
import { logWin } from "./winsLog";
import { isSymbolBlocked, trackSignalMessage, buildAtiraKeyboard } from "./captainMode";
import {
  calculateEMA,
  calculateRSI,
  calculateATR,
  calculateParabolicSAR,
  calculateAvgVolume,
  computeTrend,
  calcSlTp,
  type Candle,
} from "./indicators";

// ── Constants ──────────────────────────────────────────────────────────────────
const SYMBOLS              = ["BTC", "ETH", "SOL", "DOGE", "AXS", "AVAX", "BNB", "ADA", "POL", "XRP"];
const SCAN_INTERVAL_MS     = 30_000;
const COOLDOWN_MS          = 2 * 60 * 1000;
const ANT_COOLDOWN_MS      = 30 * 60 * 1000;
const FORCE_COOLDOWN_MS    = 5 * 60 * 1000;
const SAR_PRE_COOLDOWN_MS  = 10 * 60 * 1000;
const OPPOSITE_COOLDOWN_MS  = 10 * 60 * 1000; // no signal flip within 10 min per asset
const CASCADE_COOLDOWN_MS   = 30 * 60 * 1000; // cascade alert per altcoin
const OB_CACHE_TTL          = 30_000;          // order book cache 30s
const TZ                = "America/Sao_Paulo";
const OKX_BASE          = "https://www.okx.com/api/v5";
const BANCA             = 2000;

// ── Types ──────────────────────────────────────────────────────────────────────
type Trend     = "BULL" | "BEAR" | "NEUTRAL";
type Direction = "LONG" | "SHORT";

interface MultiTrend { d1: Trend; h4: Trend; h1: Trend; m15: Trend; m5: Trend }

interface ActiveSig {
  id: string;
  symbol: string;
  direction: Direction;
  price: number;
  avgEntry: number;
  entry2: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  strategy: string;
  leverage: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
}

// ── Scanner state (in-memory, lives as long as the server) ────────────────────
const cooldownMap     = new Map<string, number>();
const seenIds         = new Set<string>();
const anticipationMap = new Map<string, number>();
const forceVolMap     = new Map<string, number>();
const prevM5RsiMap    = new Map<string, number>();
const prevEma200Map   = new Map<string, number>();
const activeSignals   = new Map<string, ActiveSig>();
// SAR curvature tracking: stores previous SAR gap ratio for each symbol
const prevSarDistMap    = new Map<string, number>();
const sarPreCooldownMap = new Map<string, number>();
// Direction filter: last fired signal direction per symbol
const lastSignalDirMap  = new Map<string, { direction: Direction; ts: number }>();
// Cascade monitor cooldown (per altcoin)
const cascadeCooldownMap = new Map<string, number>();
// Order book cache (for P50 liquidity analysis)
const orderBookCache = new Map<string, { bids: [number,number][]; asks: [number,number][]; ts: number }>();
const btcRef = {
  m5: "NEUTRAL" as Trend,
  h4: "NEUTRAL" as Trend,
  d1: "NEUTRAL" as Trend,
};

let scannerTimer: ReturnType<typeof setInterval> | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────────
function nowBR(): string {
  return new Date().toLocaleTimeString("pt-BR", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
function fmt(n: number): string    { return n > 1 ? n.toFixed(2) : n.toFixed(6); }
function fmtUSD(n: number): string { return `$${n.toFixed(2)}`; }
function absPct(a: number, b: number): number { return Math.abs(((b - a) / a) * 100); }
function tfDot(t: string): string  { return t === "BULL" ? "🟢" : t === "BEAR" ? "🔴" : "🟡"; }
function profitRow(label: string, pct: number): string {
  return `  ${label} → 10x: <b>+${fmtUSD(BANCA * 10 * pct / 100)}</b> | 25x: <b>+${fmtUSD(BANCA * 25 * pct / 100)}</b> | 50x: <b>+${fmtUSD(BANCA * 50 * pct / 100)}</b>`;
}
function confluenceScore(mt: MultiTrend, dir: Direction): number {
  const check = dir === "LONG" ? "BULL" : "BEAR";
  return [mt.d1, mt.h4, mt.h1, mt.m15, mt.m5].filter(t => t === check).length;
}

const STRAT_EMOJI: Record<string, string> = {
  "Muralha 200":       "🏰",
  "Muralha Buffer":    "🏰",
  "Muralha + SAR":     "🏰",
  "Surfe 200":         "🌊",
  "Onda SAR":          "📡",
  "Pré-Gatilho SAR":   "📡",
  "GPS Full + SAR":    "🎯",
  "Fibonacci 50%":     "📐",
  "Exaustão Sniper":   "🎯",
  "Fênix Reversão":    "🔥",
  "Confirmação 100%":  "💯",
  "Movimento de Força":"⚡",
  "SINAL MESTRE":      "🚀",
};

// ── OKX fetch with cache ───────────────────────────────────────────────────────
const klineCache = new Map<string, { data: Candle[]; ts: number }>();
const CACHE_TTL: Record<string, number> = {
  "5m": 25_000, "15m": 25_000, "1H": 300_000, "4H": 3_600_000, "1D": 3_600_000,
};

async function fetchKlines(symbol: string, bar: string, limit: number): Promise<Candle[]> {
  const key    = `${symbol}-${bar}`;
  const ttl    = CACHE_TTL[bar] ?? 25_000;
  const cached = klineCache.get(key);
  if (cached && Date.now() - cached.ts < ttl) return cached.data;

  const instId = `${symbol}-USDT-SWAP`;
  const url    = `${OKX_BASE}/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`;
  const res    = await fetch(url, {
    headers: { Accept: "application/json" },
    signal:  AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`OKX HTTP ${res.status} for ${symbol} ${bar}`);
  const json: any = await res.json();
  if (json.code !== "0") throw new Error(`OKX error: ${json.msg}`);

  const candles: Candle[] = ([...json.data as string[][]] ).reverse().map(k => ({
    openTime: parseInt(k[0]),
    open:     parseFloat(k[1]),
    high:     parseFloat(k[2]),
    low:      parseFloat(k[3]),
    close:    parseFloat(k[4]),
    volume:   parseFloat(k[5]),
  }));
  klineCache.set(key, { data: candles, ts: Date.now() });
  return candles;
}

// ── Order Book fetch (for P50 liquidity analysis) ──────────────────────────────
async function fetchOrderBook(symbol: string): Promise<{ bids: [number,number][]; asks: [number,number][] } | null> {
  const cached = orderBookCache.get(symbol);
  if (cached && Date.now() - cached.ts < OB_CACHE_TTL) return cached;
  try {
    const instId = `${symbol}-USDT-SWAP`;
    const url    = `${OKX_BASE}/market/books?instId=${instId}&sz=20`;
    const res    = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const json: any = await res.json();
    if (json.code !== "0" || !json.data?.[0]) return null;
    const raw  = json.data[0];
    const bids = (raw.bids as string[][]).map(b => [parseFloat(b[0]), parseFloat(b[1])] as [number,number]);
    const asks = (raw.asks as string[][]).map(a => [parseFloat(a[0]), parseFloat(a[1])] as [number,number]);
    orderBookCache.set(symbol, { bids, asks, ts: Date.now() });
    return { bids, asks };
  } catch {
    return null;
  }
}

// ── P50 liquidity imbalance: returns deviation of midpoint from current price ──
function analyzeP50(bids: [number,number][], asks: [number,number][], price: number): { hasImbalance: boolean; p50Price: number; deviationPct: number } {
  const totalBid = bids.reduce((s, [, v]) => s + v, 0);
  const totalAsk = asks.reduce((s, [, v]) => s + v, 0);
  const total    = totalBid + totalAsk;
  if (total === 0) return { hasImbalance: false, p50Price: price, deviationPct: 0 };

  // Merge all levels sorted descending by price, accumulate volume to find P50
  const levels = [
    ...bids.map(([p, v]) => ({ price: p, vol: v })),
    ...asks.map(([p, v]) => ({ price: p, vol: v })),
  ].sort((a, b) => b.price - a.price);

  let cum = 0;
  let p50Price = price;
  for (const lv of levels) {
    cum += lv.vol;
    if (cum >= total * 0.5) { p50Price = lv.price; break; }
  }
  const deviationPct = Math.abs(p50Price - price) / price * 100;
  return { hasImbalance: deviationPct > 0.15, p50Price, deviationPct };
}

// ── Telegram sender ────────────────────────────────────────────────────────────
async function sendTg(text: string, replyMarkup?: object): Promise<number | null> {
  const token  = process.env.TELEGRAM_TOKEN  || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CHAT_ID         || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    logger.warn("Scanner: Telegram credentials not configured — skipping send");
    return null;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
      signal:  AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ body }, "Scanner: Telegram non-OK response");
      return null;
    }
    const json: any = await res.json();
    return json?.result?.message_id ?? null;
  } catch (err: any) {
    logger.warn({ err: err.message }, "Scanner: Telegram send failed");
    return null;
  }
}

// ── Message builders ────────────────────────────────────────────────────────────

function buildP50AlertMsg(symbol: string, price: number, p50Price: number, deviationPct: number): string {
  const side = p50Price > price ? "ACIMA" : "ABAIXO";
  return (
    `⚠️ <b>MURALHA COM RISCO DE ESTOURO — LIQUIDEZ P50 DETECTADA</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 ${symbol}-USDT-SWAP\n` +
    `💵 Preço Atual: <b>${fmt(price)}</b>\n` +
    `📊 Liquidez P50: <b>${fmt(p50Price)}</b> (${deviationPct.toFixed(3)}% ${side} do preço)\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔥 Concentração de liquidez detectada no Order Book.\n` +
    `🎯 <b>Ajuste o ponto de entrada para: ${fmt(p50Price)}</b>\n` +
    `⚠️ Risco de "estouro" da Muralha em direção ao P50!\n` +
    `⏰ ${nowBR()} (Brasília)`
  );
}

function buildCascadeMsg(symbol: string, direction: Direction, price: number, volRatio: number): string {
  const dirEmoji = direction === "LONG" ? "📈" : "📉";
  const forceType = direction === "LONG" ? "compradora" : "vendedora";
  const dirLabel = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  return (
    `🔥 <b>EFEITO CASCATA DETECTADO!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 ${symbol}-USDT-SWAP\n` +
    `${dirEmoji} <b>${symbol} confirmada em 3 TFs (M5 · M15 · H1)</b>\n` +
    `💥 Força ${forceType} isolada — Independente do BTC!\n` +
    `📊 Volume 24h: <b>${volRatio.toFixed(1)}× acima da média</b>\n` +
    `💵 Preço: <b>${fmt(price)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${dirLabel} — Alta Probabilidade de continuação\n` +
    `⚠️ Confirme entrada no M5 antes de executar!\n` +
    `⏰ ${nowBR()} (Brasília)`
  );
}

function buildSignalMsg(
  sig: ActiveSig,
  reason: string,
  mt: MultiTrend,
  confluenceCount: number,
  isHighProb: boolean,
  lowAssertivity = false,
  btcContraWarning = "",
): string {
  const dirEmoji = sig.direction === "LONG" ? "📈" : "📉";
  const dirLabel = sig.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const slPct    = absPct(sig.avgEntry, sig.sl).toFixed(2);
  const tp1Pct   = absPct(sig.avgEntry, sig.tp1);
  const tp2Pct   = absPct(sig.avgEntry, sig.tp2);
  const tp3Pct   = absPct(sig.avgEntry, sig.tp3);
  const isMaster = sig.strategy === "SINAL MESTRE";
  const isRev    = sig.strategy === "Fênix Reversão";
  const emoji    = STRAT_EMOJI[sig.strategy] ?? "⚡";
  const h4Label  = mt.h4 === "BULL" ? "H4:🟢" : mt.h4 === "BEAR" ? "H4:🔴" : "";
  const gpsLine  = `\n📡 GPS: D1(${tfDot(mt.d1)}) H4(${tfDot(mt.h4)}) H1(${tfDot(mt.h1)}) M15(${tfDot(mt.m15)}) M5(${tfDot(mt.m5)})`;
  const header   =
    isHighProb ? `🔥 <b>SINAL DE ALTA PROBABILIDADE! (${confluenceCount}/5 TFs)</b>` :
    isMaster   ? `🚀 <b>SINAL MESTRE DETECTADO!</b>` :
    isRev      ? `🔥 <b>FÊNIX DE REVERSÃO DETECTADO!</b>` :
    `${emoji} <b>SINAL SNIPER DETECTADO!</b>`;

  return (
    `${header}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${isRev ? "⚠️ <b>OPERAÇÃO DE REVERSÃO — ALVO CURTO</b>\n" : ""}` +
    `${lowAssertivity ? "⚠️ <b>Horário de Baixa Assertividade Histórica — reduza o tamanho da posição!</b>\n" : ""}` +
    `${btcContraWarning ? btcContraWarning + "\n" : ""}` +
    `🪙 Ativo: <b>${sig.symbol}-USDT-SWAP</b>\n` +
    `${emoji} Estratégia: <b>${sig.strategy}</b>\n` +
    `⏱ Timeframe: <b>M5/M15</b>${h4Label ? ` · ${h4Label}` : ""}${gpsLine}\n` +
    `${dirEmoji} Direção: <b>${dirLabel}</b>\n` +
    `🎚 Alavancagem: <b>${sig.leverage}x</b>\n` +
    `📝 ${reason}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 <b>ENTRADA EM ESCADA (50% + 50%):</b>\n` +
    `  🔹 Entrada 1 (50% Mkt): <b>${fmt(sig.price)}</b>\n` +
    `  🔹 Entrada 2 (50% EMA21): <b>${fmt(sig.entry2)}</b>\n` +
    `  📊 Preço Médio: <b>${fmt(sig.avgEntry)}</b>\n` +
    `🛡️ Stop Loss: <b>${fmt(sig.sl)}</b> (-${slPct}%)\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 <b>ALVOS (a partir da média):</b>\n` +
    `  TP1: <b>${fmt(sig.tp1)}</b> (+${tp1Pct.toFixed(2)}%) ← Risco Zero\n` +
    `  TP2: <b>${fmt(sig.tp2)}</b> (+${tp2Pct.toFixed(2)}%)\n` +
    `  TP3: <b>${fmt(sig.tp3)}</b> (+${tp3Pct.toFixed(2)}%)\n` +
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
    `Ao atingir TP1, mova o SL para o ponto de entrada!\n` +
    `⏰ ${nowBR()} (Brasília)`
  );
}

function buildWinMsg(sig: ActiveSig, tpLevel: 1 | 2 | 3): string {
  const dirEmoji = sig.direction === "LONG" ? "📈" : "📉";
  const tpPrice  = tpLevel === 1 ? sig.tp1 : tpLevel === 2 ? sig.tp2 : sig.tp3;
  const tpPct    = absPct(sig.avgEntry, tpPrice);
  const p10 = BANCA * 10 * tpPct / 100;
  const p25 = BANCA * 25 * tpPct / 100;
  const p50 = BANCA * 50 * tpPct / 100;

  if (tpLevel === 1) {
    return (
      `✅ <b>ALVO 1 ATINGIDO! Protocolo Risco Zero Ativado.</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🪙 ${sig.symbol}-USDT-SWAP | ${dirEmoji} ${sig.direction}\n` +
      `🎯 TP1: <b>${fmt(tpPrice)}</b> (+${tpPct.toFixed(2)}%)\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🛡️ <b>PROTOCOLO RISCO ZERO + TRAILING SAR:</b>\n` +
      `• Mova o Stop Loss para o Breakeven: <b>${fmt(sig.avgEntry)}</b>\n` +
      `• Siga o rastro do SAR Parabólico (Parabolic SAR) para maximizar o lucro.\n` +
      `• Conforme o SAR avançar a seu favor, ajuste o stop para o nível do SAR atual.\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 <b>Ganhos Parciais (Banca $${BANCA}):</b>\n` +
      `  · 10x: <b>+${fmtUSD(p10)}</b>\n` +
      `  · 25x: <b>+${fmtUSD(p25)}</b>\n` +
      `  · 50x: <b>+${fmtUSD(p50)}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🎯 Próximo alvo: TP2 — mantenha a posição restante com Stop no Breakeven!\n` +
      `⏰ ${nowBR()} (Brasília)`
    );
  }
  const tp1Pct = absPct(sig.avgEntry, sig.tp1);
  const addPct = tpPct - tp1Pct;
  return (
    `💰 <b>WIN! ALVO ${tpLevel} ATINGIDO! Lucro Travado.</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 ${sig.symbol}-USDT-SWAP | ${dirEmoji} ${sig.direction}\n` +
    `🎯 TP${tpLevel}: <b>${fmt(tpPrice)}</b> (+${tpPct.toFixed(2)}%)\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>Resumo de Ganhos (Banca $${BANCA}):</b>\n` +
    `  · 10x: <b>+${fmtUSD(p10)}</b> | 25x: <b>+${fmtUSD(p25)}</b> | 50x: <b>+${fmtUSD(p50)}</b>\n` +
    `📈 <b>Ganho adicional vs TP1:</b>\n` +
    `  · 10x: <b>+${fmtUSD(BANCA * 10 * addPct / 100)}</b> | 25x: <b>+${fmtUSD(BANCA * 25 * addPct / 100)}</b> | 50x: <b>+${fmtUSD(BANCA * 50 * addPct / 100)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🏆 <b>PARABÉNS PELO WIN!</b>\n` +
    `🛡️ Meta Banca $${BANCA}: Proteja o lucro e use o SAR como Stop Móvel.\n` +
    `⏰ ${nowBR()} (Brasília)`
  );
}

function buildRetainedMsg(symbol: string, direction: Direction, price: number, strategies: string[]): string {
  const stratList = strategies.join(" + ");
  return (
    `⚠️ <b>SINAL RETIDO — TERMÔMETRO BTC</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 ${symbol}-USDT-SWAP | ${direction === "SHORT" ? "📉 SHORT" : "📈 LONG"}\n` +
    `🔍 Estratégia: <b>${stratList}</b>\n` +
    `💵 Preço: <b>${fmt(price)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🌡️ <b>Divergência M5 do BTC — macro não confirmado.</b>\n` +
    `Aguardando H4/D1 da Altcoin ou alinhamento do BTC no M5.\n` +
    `⏰ ${nowBR()} (Brasília)`
  );
}

function buildAnticipationMsg(symbol: string, dir: Direction, strategy: string, price: number, reason: string, count: number): string {
  const dirEmoji = dir === "LONG" ? "📈" : "📉";
  const dirLabel = dir === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  return (
    `📊 <b>ANTECIPAÇÃO 80% — POSIÇÃO EM FORMAÇÃO</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 Ativo: <b>${symbol}-USDT-SWAP</b>\n` +
    `📐 Setup: <b>${strategy}</b>\n` +
    `${dirEmoji} Direção Esperada: <b>${dirLabel}</b>\n` +
    `💵 Preço Atual: <b>${fmt(price)}</b>\n` +
    `📡 GPS Confluência: <b>${count}/5</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📝 ${reason}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ <b>Aguardar confirmação antes de entrar!</b>\n` +
    `⏰ ${nowBR()} (Brasília)`
  );
}

function buildForceMsg(symbol: string, dir: Direction, price: number, volRatio: number, m5Rsi: number): string {
  const dirLabel = dir === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  return (
    `⚡ <b>MOVIMENTO DE FORÇA DETECTADO!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 Ativo: <b>${symbol}-USDT-SWAP</b>\n` +
    `📊 Volume M5: <b>${volRatio.toFixed(1)}× acima da média (10 velas)</b>\n` +
    `🔬 RSI(6) M5: <b>${m5Rsi.toFixed(0)}</b>\n` +
    `📈 Direção Momentum: <b>${dirLabel}</b>\n` +
    `💵 Preço: <b>${fmt(price)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ <b>Volume 50%+ acima da média — potencial rompimento antes do cruzamento de médias.</b>\n` +
    `Monitore o fechamento da vela M5 para confirmação de entrada!\n` +
    `⏰ ${nowBR()} (Brasília)`
  );
}

// ── TP/SL tracker ─────────────────────────────────────────────────────────────
async function checkActiveSignals(symbol: string, price: number): Promise<void> {
  for (const [id, sig] of activeSignals) {
    if (sig.symbol !== symbol) continue;
    const isLong = sig.direction === "LONG";

    if ((isLong && price <= sig.sl) || (!isLong && price >= sig.sl)) {
      activeSignals.delete(id);
      continue;
    }
    if (!sig.tp1Hit && ((isLong && price >= sig.tp1) || (!isLong && price <= sig.tp1))) {
      sig.tp1Hit = true;
      const tp1Pct = absPct(sig.avgEntry, sig.tp1);
      logWin({ symbol: sig.symbol, strategy: sig.strategy, direction: sig.direction,
        tpLevel: 1, profitPct: tp1Pct, leverage: sig.leverage,
        avgEntry: sig.avgEntry, tpPrice: sig.tp1 });
      if (!isSymbolBlocked(sig.symbol)) { await sendTg(buildWinMsg(sig, 1)); notifySignalSent(); }
    }
    if (sig.tp1Hit && !sig.tp2Hit && ((isLong && price >= sig.tp2) || (!isLong && price <= sig.tp2))) {
      sig.tp2Hit = true;
      const tp2Pct = absPct(sig.avgEntry, sig.tp2);
      logWin({ symbol: sig.symbol, strategy: sig.strategy, direction: sig.direction,
        tpLevel: 2, profitPct: tp2Pct, leverage: sig.leverage,
        avgEntry: sig.avgEntry, tpPrice: sig.tp2 });
      if (!isSymbolBlocked(sig.symbol)) { await sendTg(buildWinMsg(sig, 2)); notifySignalSent(); }
    }
    if (sig.tp2Hit && !sig.tp3Hit && ((isLong && price >= sig.tp3) || (!isLong && price <= sig.tp3))) {
      sig.tp3Hit = true;
      const tp3Pct = absPct(sig.avgEntry, sig.tp3);
      logWin({ symbol: sig.symbol, strategy: sig.strategy, direction: sig.direction,
        tpLevel: 3, profitPct: tp3Pct, leverage: sig.leverage,
        avgEntry: sig.avgEntry, tpPrice: sig.tp3 });
      if (!isSymbolBlocked(sig.symbol)) { await sendTg(buildWinMsg(sig, 3)); notifySignalSent(); }
      activeSignals.delete(id);
    }
  }
}

// ── Coin scanner ───────────────────────────────────────────────────────────────
async function scanCoin(symbol: string): Promise<void> {
  try {
    const [c5m, c15m, cH1, cH4, cD1] = await Promise.all([
      fetchKlines(symbol, "5m",  50),
      fetchKlines(symbol, "15m", 300),
      fetchKlines(symbol, "1H",  50),
      fetchKlines(symbol, "4H",  250),
      fetchKlines(symbol, "1D",  250),
    ]);

    if (c15m.length < 20 || cH4.length < 22) return;

    // ── M15 main indicators ──────────────────────────────────────────────────
    const closes   = c15m.map(c => c.close);
    const ema9arr  = calculateEMA(closes, 9);
    const ema21arr = calculateEMA(closes, 21);
    const ema200arr= calculateEMA(closes, 200);
    const rsi6arr  = calculateRSI(closes, 6);
    const sarData  = calculateParabolicSAR(c15m);
    const avgVol   = calculateAvgVolume(c15m, 20);
    const atr      = calculateATR(c15m.slice(-20), 14);

    const last   = closes.length - 1;
    const price  = closes[last];
    const curr9  = ema9arr[last];
    const curr21 = ema21arr[last];
    const curr200= ema200arr[last];
    const currRsi= rsi6arr[last];
    const currSar= sarData[last];
    const prevSar= sarData[last - 1];
    const prevClose   = closes[last - 1];
    const prevEma200  = ema200arr[last - 1];
    const lastCandle  = c15m[last];
    const prevCandle  = c15m[last - 1];

    const m15Trend: Trend = price > curr200 ? "BULL" : price < curr200 ? "BEAR" : "NEUTRAL";

    // ── SAR curvature tracking ────────────────────────────────────────────────
    // Distance = |price - sar| / price (normalised so we can compare across coins)
    const currSarDist = currSar ? Math.abs(price - currSar.sar) / price : 1;
    const prevSarDist = prevSarDistMap.get(symbol) ?? currSarDist;
    prevSarDistMap.set(symbol, currSarDist);
    // curvatureRatio > 1 means gap is shrinking; ≥ 5 means 80%+ shrinkage in 1 scan cycle (~2 M15 candles)
    const sarCurvatureRatio = prevSarDist > 0 && currSarDist > 0 ? prevSarDist / currSarDist : 1;
    const sarApproaching80  = sarCurvatureRatio >= 5;  // gap shrank ≥80%
    const sarNearFlip       = currSarDist < 0.001;      // within 0.1% of price

    // ── H4 trend ─────────────────────────────────────────────────────────────
    const h4Closes = cH4.map(c => c.close);
    const h4ema21  = calculateEMA(h4Closes, 21);
    const h4ema200 = calculateEMA(h4Closes, 200);
    const h4Last   = h4Closes.length - 1;
    const h4Price  = h4Closes[h4Last];
    const h4Trend: Trend =
      h4ema200.length > 0 && h4Last >= h4ema200.length - 1
        ? h4Price > h4ema200[h4Last] && h4Price > h4ema21[h4Last] ? "BULL"
        : h4Price < h4ema200[h4Last] && h4Price < h4ema21[h4Last] ? "BEAR"
        : "NEUTRAL"
        : "NEUTRAL";

    const m5Trend  = computeTrend(c5m.map(c => c.close), 21);
    const h1Trend  = computeTrend(cH1.map(c => c.close), 21);
    const d1Trend  = computeTrend(cD1.map(c => c.close), 200);

    const multiTrend: MultiTrend = { d1: d1Trend, h4: h4Trend, h1: h1Trend, m15: m15Trend, m5: m5Trend };

    // ── Update BTC reference ─────────────────────────────────────────────────
    if (symbol === "BTC") {
      btcRef.m5 = m5Trend;
      btcRef.h4 = h4Trend;
      btcRef.d1 = d1Trend;
    }

    // ── TP/SL tracking for active signals ────────────────────────────────────
    await checkActiveSignals(symbol, price);

    // ── Gatilho de Cascata de Altcoins (M5 > M15 > H1) ───────────────────────
    // If M5, M15, H1 all agree AND 24h volume > 3× average → high-probability alert
    if (symbol !== "BTC") {
      const sameDir = m5Trend !== "NEUTRAL" && m5Trend === m15Trend && m15Trend === h1Trend;
      if (sameDir) {
        const d1Avg     = cD1.length >= 5 ? calculateAvgVolume(cD1.slice(-21, -1), Math.min(20, cD1.length - 1)) : 0;
        const d1LastVol = cD1[cD1.length - 1]?.volume ?? 0;
        const highVol24h = d1Avg > 0 && d1LastVol > d1Avg * 3;
        if (highVol24h) {
          const cascKey   = `${symbol}-cascade`;
          const lastCasc  = cascadeCooldownMap.get(cascKey) ?? 0;
          if (Date.now() - lastCasc >= CASCADE_COOLDOWN_MS) {
            cascadeCooldownMap.set(cascKey, Date.now());
            const cascDir = m5Trend === "BULL" ? "LONG" : "SHORT" as Direction;
            const volRatio = d1LastVol / d1Avg;
            logger.info({ symbol, cascDir, volRatio: volRatio.toFixed(1) }, "Scanner: Efeito Cascata detectado");
            await sendTg(buildCascadeMsg(symbol, cascDir, price, volRatio));
            notifySignalSent();
          }
        }
      }
    }

    // ── M5 indicators ────────────────────────────────────────────────────────
    const m5Closes   = c5m.map(c => c.close);
    const m5Rsi6arr  = calculateRSI(m5Closes, 6);
    const m5RsiLast  = m5Rsi6arr[m5Rsi6arr.length - 1] ?? 50;
    const prevM5Rsi  = prevM5RsiMap.get(symbol) ?? m5RsiLast;

    const m5AvgVol10 = calculateAvgVolume(c5m.slice(-11, -1), 10); // avg of last 10 velas (excluding current)
    const m5LastIdx  = c5m.length - 1;
    const m5LastVol  = c5m[m5LastIdx]?.volume ?? 0;
    const m5VolRatio = m5AvgVol10 > 0 ? m5LastVol / m5AvgVol10 : 0;

    // ── V7: Body/Wick breakout filter ────────────────────────────────────────
    const body         = Math.abs(lastCandle.close - lastCandle.open);
    const upperWick    = lastCandle.high - Math.max(lastCandle.close, lastCandle.open);
    const lowerWick    = Math.min(lastCandle.close, lastCandle.open) - lastCandle.low;
    const totalRange   = lastCandle.high - lastCandle.low;
    const bodyPct      = totalRange > 0 ? body / totalRange : 0;
    const bodyDominant = body > (upperWick + lowerWick) * 2;
    const isBreakoutCandle = bodyPct > 0.7 && lastCandle.volume >= avgVol * 1.5 && bodyDominant;

    // ── EMA9 inclination ─────────────────────────────────────────────────────
    const ema9Slope    = curr9 - (ema9arr[last - 1] ?? curr9);
    const ema9Inclining = ema9Slope > curr9 * 0.0002;
    const ema9Declining = ema9Slope < -curr9 * 0.0002;

    // ── M5 proximity radar ───────────────────────────────────────────────────
    const m5DistCurr = curr200 > 0 ? Math.abs(m5Closes[m5LastIdx] - curr200) / curr200 : 1;
    const m5DistPrev = curr200 > 0 && m5LastIdx >= 3
      ? Math.abs(m5Closes[m5LastIdx - 3] - curr200) / curr200
      : m5DistCurr;
    const approachingFast  = m5DistPrev - m5DistCurr > 0.003;
    const m5VolSurge       = m5LastIdx >= 1 && c5m[m5LastIdx]?.volume > (c5m[m5LastIdx - 1]?.volume ?? 0) * 1.3;
    const preBreakoutSignal = approachingFast && m5VolSurge && m5DistCurr < 0.008;

    // ── GPS helpers ──────────────────────────────────────────────────────────
    const bearCount  = [d1Trend, h4Trend, h1Trend, m15Trend, m5Trend].filter(t => t === "BEAR").length;
    const bullCount  = [d1Trend, h4Trend, h1Trend, m15Trend, m5Trend].filter(t => t === "BULL").length;
    const bullGPS    = m15Trend === "BULL" && h4Trend === "BULL";
    const bearGPS    = m15Trend === "BEAR" && h4Trend === "BEAR";
    const near200    = curr200 > 0 && Math.abs(price - curr200) / curr200 < 0.002;
    const near9      = Math.abs(price - curr9) / curr9 < 0.001;
    const near21     = Math.abs(price - curr21) / curr21 < 0.001;
    const nearAnyEma = near200 || near9 || near21;

    // ────────────────────────────────────────────────────────────────────────
    // ── FEATURE: Antecipação por Volume M5 (50%+ acima da média 10 velas) ──
    // Fires BEFORE EMA crossover — independent alert
    // ────────────────────────────────────────────────────────────────────────
    if (m5VolRatio >= 1.5 && m5Trend !== "NEUTRAL") {
      const forceDir = m5Trend === "BULL" ? "LONG" : "SHORT" as Direction;
      const forceKey = `${symbol}-force`;
      const lastForce = forceVolMap.get(forceKey) ?? 0;
      if (Date.now() - lastForce >= FORCE_COOLDOWN_MS) {
        forceVolMap.set(forceKey, Date.now());
        logger.info({ symbol, volRatio: m5VolRatio.toFixed(2) }, "Scanner: Movimento de Força detected");
        await sendTg(buildForceMsg(symbol, forceDir, price, m5VolRatio, m5RsiLast));
        notifySignalSent();
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // ── FEATURE: Antecipação 80% Imediata — Surfe 200 Otimizado ─────────────
    // Price within 0.2% of EMA200 + RSI exhaustion → fire immediately
    // ────────────────────────────────────────────────────────────────────────
    const near200_02pct = curr200 > 0 && Math.abs(price - curr200) / curr200 < 0.002;
    const rsiExhaustLong  = currRsi < 30;
    const rsiExhaustShort = currRsi > 70;

    if (near200_02pct && (rsiExhaustLong || rsiExhaustShort)) {
      const imm80Dir    = rsiExhaustLong ? "LONG" : "SHORT" as Direction;
      const imm80Key    = `${symbol}-${imm80Dir}-imm80`;
      const lastImm80   = anticipationMap.get(imm80Key) ?? 0;
      if (Date.now() - lastImm80 >= ANT_COOLDOWN_MS) {
        anticipationMap.set(imm80Key, Date.now());
        const distPct   = ((Math.abs(price - curr200) / curr200) * 100).toFixed(3);
        const imm80Reason = `Preço a ${distPct}% da EMA200 · RSI(6) M15: ${currRsi.toFixed(0)} (zona de exaustão) · Disparado automaticamente`;
        logger.info({ symbol, imm80Dir, distPct }, "Scanner: Antecipação 80% imediata (Surfe 200)");
        await sendTg(buildAnticipationMsg(symbol, imm80Dir, "Surfe 200 — Antecipação Imediata", price, imm80Reason, Math.max(bullCount, bearCount)));
        notifySignalSent();
      }
    }

    // ── Módulo P50 & Liquidez Real (Order Book Muralha) ──────────────────────
    // When price is within 0.5% of EMA200, check order book for P50 imbalance
    const nearMuralha = curr200 > 0 && Math.abs(price - curr200) / curr200 < 0.005;
    if (nearMuralha) {
      const ob = await fetchOrderBook(symbol);
      if (ob) {
        const p50 = analyzeP50(ob.bids, ob.asks, price);
        if (p50.hasImbalance) {
          logger.info({ symbol, p50Price: p50.p50Price, pct: p50.deviationPct.toFixed(3) }, "Scanner: P50 liquidity imbalance at Muralha");
          await sendTg(buildP50AlertMsg(symbol, price, p50.p50Price, p50.deviationPct));
          notifySignalSent();
        }
      }
    }

    // ── Collect raw signals ──────────────────────────────────────────────────
    type Raw = { direction: Direction; strategy: string; leverage: number; reason: string };
    const rawSignals: Raw[] = [];

    // 1 — Muralha & Suporte 200
    if (near200 && bullGPS && currRsi < 30)
      rawSignals.push({ direction: "LONG",  strategy: "Muralha 200", leverage: 50, reason: `🏰 EMA200 suporte institucional | RSI(6): ${currRsi.toFixed(0)}` });
    if (near200 && bearGPS && currRsi > 70)
      rawSignals.push({ direction: "SHORT", strategy: "Muralha 200", leverage: 50, reason: `🏰 EMA200 resistência institucional | RSI(6): ${currRsi.toFixed(0)}` });

    // 2 — Surfe 200
    const crossedAbove200 = prevClose < prevEma200 && price > curr200;
    const crossedBelow200 = prevClose > prevEma200 && price < curr200;
    const bigVolume = lastCandle.volume > avgVol * 2;
    if (crossedAbove200 && bigVolume && h4Trend === "BULL") {
      const tag = isBreakoutCandle ? "⚡ ROMPIMENTO (Corpo>70% + Vol≥1.5×)" : "🌊 Rompimento";
      rawSignals.push({ direction: "LONG",  strategy: "Surfe 200", leverage: isBreakoutCandle ? 35 : 25,
        reason: `${tag} acima EMA200 · Vol ${(lastCandle.volume / avgVol).toFixed(1)}× · Corpo ${Math.round(bodyPct * 100)}%` });
    }
    if (crossedBelow200 && bigVolume && h4Trend === "BEAR") {
      const tag = isBreakoutCandle ? "⚡ ROMPIMENTO (Corpo>70% + Vol≥1.5×)" : "🌊 Rompimento";
      rawSignals.push({ direction: "SHORT", strategy: "Surfe 200", leverage: isBreakoutCandle ? 35 : 25,
        reason: `${tag} abaixo EMA200 · Vol ${(lastCandle.volume / avgVol).toFixed(1)}× · Corpo ${Math.round(bodyPct * 100)}%` });
    }
    if (preBreakoutSignal && bullGPS)
      rawSignals.push({ direction: "LONG",  strategy: "Muralha Buffer", leverage: 25, reason: `🔭 RADAR M5: aceleração detectada + vol ↑. Rompimento da EMA200 antecipado!` });
    if (preBreakoutSignal && bearGPS)
      rawSignals.push({ direction: "SHORT", strategy: "Muralha Buffer", leverage: 25, reason: `🔭 RADAR M5: aceleração detectada + vol ↑. Queda na EMA200 antecipada!` });

    // 3 — Onda SAR
    const sarFlippedUp   = prevSar && !prevSar.isLong && currSar?.isLong;
    const sarFlippedDown = prevSar && prevSar.isLong && !currSar?.isLong;
    if (sarFlippedUp   && ema9Inclining && bullGPS)
      rawSignals.push({ direction: "LONG",  strategy: "Onda SAR", leverage: 25, reason: `📡 SAR ▲ + EMA9 inclinando (${ema9Slope > 0 ? "+" : ""}${(ema9Slope / curr9 * 100).toFixed(3)}%/vela) — sync confirmado` });
    if (sarFlippedDown && ema9Declining && bearGPS)
      rawSignals.push({ direction: "SHORT", strategy: "Onda SAR", leverage: 25, reason: `📡 SAR ▼ + EMA9 declinando (${(ema9Slope / curr9 * 100).toFixed(3)}%/vela) — sync confirmado` });
    if (sarFlippedUp   && !ema9Inclining && bullGPS)
      rawSignals.push({ direction: "LONG",  strategy: "Onda SAR", leverage: 15, reason: "📡 SAR virou ▲ — aguardando EMA9 sincronizar (alavancagem reduzida)" });
    if (sarFlippedDown && !ema9Declining && bearGPS)
      rawSignals.push({ direction: "SHORT", strategy: "Onda SAR", leverage: 15, reason: "📡 SAR virou ▼ — aguardando EMA9 sincronizar (alavancagem reduzida)" });

    // 3A — Pré-Gatilho SAR (curvatura: gap encolheu ≥80% em ~2 velas M15)
    // currSar.isLong=false → SAR bearish (acima do preço) → se gap está encolhendo, price subindo → pré-LONG
    // currSar.isLong=true  → SAR bullish (abaixo do preço) → se gap está encolhendo, price caindo → pré-SHORT
    if (currSar && sarApproaching80) {
      const sarPreKey = `${symbol}-${currSar.isLong ? "SHORT" : "LONG"}-sar-pre`;
      const lastSarPre = sarPreCooldownMap.get(sarPreKey) ?? 0;
      if (Date.now() - lastSarPre >= SAR_PRE_COOLDOWN_MS) {
        const shrinkPct = ((1 - 1 / sarCurvatureRatio) * 100).toFixed(0);
        if (!currSar.isLong && bullGPS && currRsi > 40) {
          sarPreCooldownMap.set(sarPreKey, Date.now());
          rawSignals.push({ direction: "LONG", strategy: "Pré-Gatilho SAR", leverage: 20,
            reason: `📡 SAR PRÉ-GATILHO ▲: gap encolheu ${shrinkPct}% em 2 velas · Dist: ${(currSarDist * 100).toFixed(3)}% · RSI(6): ${currRsi.toFixed(0)}` });
        }
        if (currSar.isLong && bearGPS && currRsi < 60) {
          sarPreCooldownMap.set(sarPreKey, Date.now());
          rawSignals.push({ direction: "SHORT", strategy: "Pré-Gatilho SAR", leverage: 20,
            reason: `📡 SAR PRÉ-GATILHO ▼: gap encolheu ${shrinkPct}% em 2 velas · Dist: ${(currSarDist * 100).toFixed(3)}% · RSI(6): ${currRsi.toFixed(0)}` });
        }
      }
    }

    // 3B — Muralha + SAR Hibridização: preço toca EMA200 + SAR a ≤ 0.1% de virar
    // Entra antecipado pois a Muralha serve como suporte/resistência real
    if (near200 && sarNearFlip && currSar) {
      if (bullGPS && !currSar.isLong)
        rawSignals.push({ direction: "LONG",  strategy: "Muralha + SAR", leverage: 35,
          reason: `🏰 EMA200 suporte + SAR a ${(currSarDist * 100).toFixed(3)}% de virar ▲ — entrada antecipada antes do flip!` });
      if (bearGPS && currSar.isLong)
        rawSignals.push({ direction: "SHORT", strategy: "Muralha + SAR", leverage: 35,
          reason: `🏰 EMA200 resistência + SAR a ${(currSarDist * 100).toFixed(3)}% de virar ▼ — entrada antecipada antes do flip!` });
    }

    // 3C — GPS Full + SAR: GPS 5/5 + SAR ≤ 0.1% de virar → máxima precisão
    if (sarNearFlip && currSar) {
      if (bullCount === 5 && !currSar.isLong)
        rawSignals.push({ direction: "LONG",  strategy: "GPS Full + SAR", leverage: 50,
          reason: `🎯 GPS 5/5 BULL + SAR a ${(currSarDist * 100).toFixed(3)}% de virar ▲ — ALTA PRECISÃO! Confluência máxima.` });
      if (bearCount === 5 && currSar.isLong)
        rawSignals.push({ direction: "SHORT", strategy: "GPS Full + SAR", leverage: 50,
          reason: `🎯 GPS 5/5 BEAR + SAR a ${(currSarDist * 100).toFixed(3)}% de virar ▼ — ALTA PRECISÃO! Confluência máxima.` });
    }

    // 4 — Fibonacci 50%
    const isStrongCandle = prevCandle.volume > avgVol * 3;
    if (isStrongCandle) {
      const range   = Math.abs(prevCandle.close - prevCandle.open);
      const bullPrev = prevCandle.close > prevCandle.open;
      const fib50   = bullPrev ? prevCandle.open + range * 0.5 : prevCandle.close + range * 0.5;
      const atFib50 = Math.abs(price - fib50) / fib50 < 0.0015;
      if (atFib50 && bullPrev  && bullGPS) rawSignals.push({ direction: "LONG",  strategy: "Fibonacci 50%", leverage: 25, reason: `📐 Retração 50% após vela de força (${(prevCandle.volume / avgVol).toFixed(1)}× vol)` });
      if (atFib50 && !bullPrev && bearGPS) rawSignals.push({ direction: "SHORT", strategy: "Fibonacci 50%", leverage: 25, reason: `📐 Retração 50% após vela de força (${(prevCandle.volume / avgVol).toFixed(1)}× vol)` });
    }

    // 5 — Exaustão Sniper RSI(6)
    if (nearAnyEma && bullGPS && currRsi < 25) rawSignals.push({ direction: "LONG",  strategy: "Exaustão Sniper", leverage: 50, reason: `🎯 RSI(6) exaustão venda: ${currRsi.toFixed(0)} — toque na média` });
    if (nearAnyEma && bearGPS && currRsi > 75) rawSignals.push({ direction: "SHORT", strategy: "Exaustão Sniper", leverage: 50, reason: `🎯 RSI(6) exaustão compra: ${currRsi.toFixed(0)} — toque na média` });

    // 6 — Muralha Buffer antecipação SHORT
    const approachFromAbove = price > curr200 && near200;
    if (approachFromAbove && h4Trend === "BEAR" && currRsi > 75)
      rawSignals.push({ direction: "SHORT", strategy: "Muralha Buffer", leverage: 50, reason: `🏰 Antecipação: 0.2% da EMA200 | H4 BEAR | RSI(6): ${currRsi.toFixed(0)}` });

    // 7 — Fênix de Reversão
    const farBelow    = curr200 > 0 && (curr200 - price) / curr200 > 0.02;
    const greenCandle = lastCandle.close > lastCandle.open;
    const volSpike30  = lastCandle.volume > avgVol * 1.3;
    if (farBelow && currRsi < 20 && greenCandle && volSpike30)
      rawSignals.push({ direction: "LONG", strategy: "Fênix Reversão", leverage: 25,
        reason: `🔥 REVERSÃO: ${((curr200 - price) / curr200 * 100).toFixed(1)}% abaixo EMA200 | RSI(6): ${currRsi.toFixed(0)} | Vol: ${(lastCandle.volume / avgVol).toFixed(1)}× ⚠️ ALVO CURTO` });

    // 8 — Gatilho de Volatilidade RSI/Volume M5
    const rsiSpiked    = Math.abs(m5RsiLast - prevM5Rsi) >= 15;
    const m5VolDoubled = m5VolRatio >= 2;
    const volatilityTrigger = rsiSpiked || m5VolDoubled;
    if (volatilityTrigger && m5Trend !== "NEUTRAL") {
      const vtDir = m5Trend === "BULL" ? "LONG" : "SHORT" as Direction;
      const vtReason = rsiSpiked
        ? `⚡ RSI(6) M5 deslocou ${Math.abs(m5RsiLast - prevM5Rsi).toFixed(0)} pts (${prevM5Rsi.toFixed(0)} → ${m5RsiLast.toFixed(0)}) — Momentum explosivo`
        : `⚡ Volume M5 ${m5VolRatio.toFixed(1)}× acima da média — Pressão ${vtDir === "LONG" ? "compradora" : "vendedora"} confirmada`;
      rawSignals.push({ direction: vtDir, strategy: "Confirmação 100%", leverage: 50, reason: vtReason });
    }
    prevM5RsiMap.set(symbol, m5RsiLast);

    // ── Antecipação 80% GPS (no raw signals path) ────────────────────────────
    if (rawSignals.length === 0) {
      const now80     = Date.now();
      const near80    = curr200 > 0 && Math.abs(price - curr200) / curr200 < 0.02;
      const preLong   = currRsi >= 30 && currRsi <= 40;
      const preShort  = currRsi >= 60 && currRsi <= 70;
      const bull80    = bullCount >= 3 && (near80 || preLong);
      const bear80    = bearCount >= 3 && (near80 || preShort);

      if (bull80 || bear80) {
        const ant80Dir   = bull80 ? "LONG" : "SHORT" as Direction;
        const antKey     = `${symbol}-${ant80Dir}-anticipation`;
        const lastAnt    = anticipationMap.get(antKey) ?? 0;
        if (now80 - lastAnt >= ANT_COOLDOWN_MS) {
          anticipationMap.set(antKey, now80);
          const ant80Strategy = near80 ? "Muralha 200" : "Exaustão Sniper";
          const ant80Reason   = near80
            ? `Preço a ${((Math.abs(price - curr200) / curr200) * 100).toFixed(2)}% da EMA200 · GPS ${bull80 ? bullCount : bearCount}/5 ${bull80 ? "BULL" : "BEAR"}`
            : `RSI(6) em ${currRsi.toFixed(0)} (zona de pré-exaustão) · GPS ${bull80 ? bullCount : bearCount}/5 ${bull80 ? "BULL" : "BEAR"}\n→ Aguardando toque na média e volume confirmador.`;
          logger.info({ symbol, ant80Dir }, "Scanner: Antecipação 80% GPS");
          await sendTg(buildAnticipationMsg(symbol, ant80Dir, ant80Strategy, price, ant80Reason, Math.max(bullCount, bearCount)));
          notifySignalSent();
        }
      }
      return;
    }

    // ── Cooldown per asset ───────────────────────────────────────────────────
    const now = Date.now();
    if (now - (cooldownMap.get(symbol) ?? 0) < COOLDOWN_MS) return;

    // ── Dominant direction ───────────────────────────────────────────────────
    const longRaws = rawSignals.filter(s => s.direction === "LONG");
    const shortRaws= rawSignals.filter(s => s.direction === "SHORT");
    const dominant = longRaws.length >= shortRaws.length && longRaws.length > 0 ? longRaws : shortRaws;
    if (dominant.length === 0) return;

    const direction  = dominant[0].direction;
    const strategies = dominant.map(s => s.strategy);
    const isMaster   = strategies.length > 1;
    const strategy   = isMaster ? "SINAL MESTRE" : strategies[0];
    const leverage   = Math.max(...dominant.map(s => s.leverage));
    const reason     = dominant.map(s => s.reason).join(" | ");

    // ── Trava Inteligente BTC (Filtro de Correlação) ────────────────────────
    // BTC extreme bear (D1+H4 ambos BEAR) + altcoin LONG → não bloqueia, ETIQUETA
    // BTC M5 diverge sem suporte macro da Altcoin → retém (bloqueia)
    let btcContraWarning = "";
    if (symbol !== "BTC") {
      const btcM5         = btcRef.m5;
      const extremeBtcBear = btcRef.d1 === "BEAR" && btcRef.h4 === "BEAR";

      if (direction === "SHORT" && btcM5 === "BULL") {
        const macroSupports = multiTrend.h4 === "BEAR" || multiTrend.d1 === "BEAR";
        if (!macroSupports) {
          logger.info({ symbol, direction, btcM5 }, "Scanner: signal retained by BTC thermometer (no macro backup)");
          await sendTg(buildRetainedMsg(symbol, direction, price, strategies));
          notifySignalSent();
          return;
        }
        logger.info({ symbol, direction }, "Scanner: BTC M5 diverges but macro H4/D1 supports → releasing signal");
      }

      if (direction === "LONG" && btcM5 === "BEAR") {
        if (extremeBtcBear) {
          // BTC in full macro bear: LABEL instead of block (Trava Inteligente)
          btcContraWarning =
            `⚠️ <b>Aviso de Risco: Contra-tendência Majoritária (BTC).</b>\n` +
            `BTC em queda extrema (D1🔴 H4🔴). Opere com 50% da mão ou aguarde Pivot no M15.`;
          logger.info({ symbol, direction }, "Scanner: BTC extreme bear — labeling LONG with contra-trend warning");
        } else {
          const macroSupports = multiTrend.h4 === "BULL" || multiTrend.d1 === "BULL";
          if (!macroSupports) {
            logger.info({ symbol, direction, btcM5 }, "Scanner: signal retained by BTC thermometer (no macro backup)");
            await sendTg(buildRetainedMsg(symbol, direction, price, strategies));
            notifySignalSent();
            return;
          }
          logger.info({ symbol, direction }, "Scanner: BTC M5 diverges but macro H4/D1 supports → releasing signal");
        }
      }
    }

    // ── Confluence scoring ───────────────────────────────────────────────────
    const count = confluenceScore(multiTrend, direction);
    const isHighProb = count >= 4;

    // ── Entry escada ─────────────────────────────────────────────────────────
    const entry2   = direction === "LONG" ? Math.min(curr21, curr9) : Math.max(curr21, curr9);
    const avgEntry = (price + entry2) / 2;
    const { sl, tp1, tp2, tp3 } = calcSlTp(price, direction, atr);
    const id = `${symbol}-${direction}-${Math.floor(now / COOLDOWN_MS)}`;

    // ── Filtro de Direção Majoritária ──────────────────────────────────────────
    // If the last signal for this symbol was the OPPOSITE direction within 10min,
    // consult H4 to decide which one wins. H4 BEAR blocks LONG; H4 BULL blocks SHORT.
    const lastDir = lastSignalDirMap.get(symbol);
    if (lastDir && now - lastDir.ts < OPPOSITE_COOLDOWN_MS && lastDir.direction !== direction) {
      if (h4Trend === "BEAR" && direction === "LONG") {
        logger.info({ symbol, direction, h4Trend }, "Scanner: LONG bloqueado pelo Filtro de Direção (H4 BEAR dentro de 10min)");
        return;
      }
      if (h4Trend === "BULL" && direction === "SHORT") {
        logger.info({ symbol, direction, h4Trend }, "Scanner: SHORT bloqueado pelo Filtro de Direção (H4 BULL dentro de 10min)");
        return;
      }
      // H4 agrees with new direction → allow override
      logger.info({ symbol, direction, h4Trend }, "Scanner: sinal oposto liberado — H4 confirma nova direção");
    }

    if (!seenIds.has(id)) {
      // ── Captain Mode: block if escort active for this coin ──────────────────
      if (isSymbolBlocked(symbol)) {
        logger.info({ symbol }, "Scanner: signal suprimido — Modo Escolta ativo para esta moeda");
        return;
      }

      seenIds.add(id);
      cooldownMap.set(symbol, now);
      lastSignalDirMap.set(symbol, { direction, ts: now });

      const sig: ActiveSig = {
        id, symbol, direction, price, avgEntry, entry2, sl, tp1, tp2, tp3,
        strategy, leverage, tp1Hit: false, tp2Hit: false, tp3Hit: false,
      };
      activeSignals.set(id, sig);

      const isSurfe200Signal = strategies.includes("Surfe 200");
      const lowAssertivity   = isSurfe200Signal && isLowAssertivityHour(symbol);
      if (lowAssertivity) logger.info({ symbol }, "Scanner: Surfe 200 low assertivity hour → warning added");

      logger.info({ symbol, direction, strategy, price }, "Scanner: signal fired → Telegram");
      const msgId = await sendTg(
        buildSignalMsg(sig, reason, multiTrend, count, isHighProb, lowAssertivity, btcContraWarning),
        buildAtiraKeyboard({ symbol, direction, avgEntry, sl, tp1, tp2, tp3 }),
      );
      if (msgId !== null) trackSignalMessage(symbol, msgId);
      notifySignalSent();
    }
  } catch (err: any) {
    logger.warn({ symbol, err: err.message }, "Scanner: scanCoin error");
  }
}

// ── Main scan loop ─────────────────────────────────────────────────────────────
async function runScanCycle(): Promise<void> {
  // BTC must be scanned first so btcRef is populated for altcoin checks
  await scanCoin("BTC");
  await Promise.allSettled(
    SYMBOLS.filter(s => s !== "BTC").map(s => scanCoin(s)),
  );
}

// ── Public API ─────────────────────────────────────────────────────────────────
export function startScanner(): void {
  if (scannerTimer) return;
  logger.info({ symbols: SYMBOLS, intervalSeconds: SCAN_INTERVAL_MS / 1000 }, "Server-side scanner started");

  // First run immediately, then on interval
  runScanCycle().catch(err => logger.warn({ err: err.message }, "Scanner: initial cycle error"));

  scannerTimer = setInterval(() => {
    runScanCycle().catch(err => logger.warn({ err: err.message }, "Scanner: cycle error"));
  }, SCAN_INTERVAL_MS);

  scannerTimer.unref();
}

export function stopScanner(): void {
  if (scannerTimer) {
    clearInterval(scannerTimer);
    scannerTimer = null;
    logger.info("Server-side scanner stopped");
  }
}

/** Clear all in-memory caches — forces a fresh fetch from OKX on the next cycle. */
export function clearScannerCache(): void {
  klineCache.clear();
  orderBookCache.clear();
  cooldownMap.clear();
  anticipationMap.clear();
  forceVolMap.clear();
  prevM5RsiMap.clear();
  prevEma200Map.clear();
  prevSarDistMap.clear();
  sarPreCooldownMap.clear();
  lastSignalDirMap.clear();
  cascadeCooldownMap.clear();
  logger.info("Scanner: cache limpo — forçando nova conexão com OKX");
}
