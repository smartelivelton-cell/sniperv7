import { logger } from "./logger";
import { notifySignalSent } from "./heartbeat";
import { isSymbolBlocked, registerTrade, trackSignalMessage, buildAtiraKeyboard } from "./captainMode";
import {
  calculateEMA,
  calculateRSI,
  calculateATR,
  calculateParabolicSAR,
  calculateAvgVolume,
  calculateKDJ,
  calculateMACD,
  calculateBB,
  calculateOBV,
  calculateVWAP,
  type Candle,
} from "./indicators";

// ── Constants ──────────────────────────────────────────────────────────────────
const SYMBOLS          = ["BTC", "ETH", "SOL", "DOGE", "AXS", "AVAX", "BNB", "ADA", "POL", "XRP"];
const SCAN_INTERVAL_MS = 60_000;           // 60s — offset from main 30s scanner
const COOLDOWN_MS      = 30 * 60 * 1000;  // 30min per symbol
const ABS_COOLDOWN_MS  = 30 * 60 * 1000;  // 30min for absorption alerts
const OKX_BASE         = "https://www.okx.com/api/v5";
const TZ               = "America/Sao_Paulo";
const MIN_SCORE        = 6;               // minimum points to fire (3+ criteria)

// ── State ──────────────────────────────────────────────────────────────────────
const cooldownMap      = new Map<string, number>();
const absorptionMap    = new Map<string, number>();
const klineCache       = new Map<string, { data: Candle[]; ts: number }>();

let tankTimer: ReturnType<typeof setInterval> | null = null;

const CACHE_TTL: Record<string, number> = {
  "5m": 25_000, "15m": 25_000, "1H": 300_000,
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function nowBR(): string {
  return new Date().toLocaleString("pt-BR", { timeZone: TZ, hour12: false });
}

function fmt(n: number): string {
  return n >= 1 ? n.toFixed(2) : n.toFixed(6);
}

// ── OKX Fetch ─────────────────────────────────────────────────────────────────
async function fetchKlines(symbol: string, bar: string, limit: number): Promise<Candle[]> {
  const key    = `tank-${symbol}-${bar}`;
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

  const candles: Candle[] = ([...json.data as string[][]]).reverse().map(k => ({
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

async function fetchLongShortRatio(symbol: string): Promise<number> {
  try {
    const instId = `${symbol}-USDT-SWAP`;
    const url    = `${OKX_BASE}/rubik/stat/contracts/long-short-account-ratio?instId=${instId}&period=5m&limit=1`;
    const res    = await fetch(url, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(5_000),
    });
    if (!res.ok) return 1.0;
    const json: any = await res.json();
    // OKX returns: [[timestamp, longShortRatio], ...]
    if (json.code !== "0" || !json.data?.[0]) return 1.0;
    const ratio = parseFloat(json.data[0][1]);
    return isNaN(ratio) ? 1.0 : ratio;
  } catch {
    return 1.0;
  }
}

async function fetchOrderBook(symbol: string): Promise<{ bids: [number, number][]; asks: [number, number][] } | null> {
  try {
    const instId = `${symbol}-USDT-SWAP`;
    const url    = `${OKX_BASE}/market/books?instId=${instId}&sz=20`;
    const res    = await fetch(url, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    if (json.code !== "0" || !json.data?.[0]) return null;
    const raw  = json.data[0];
    const bids = (raw.bids as string[][]).map(b => [parseFloat(b[0]), parseFloat(b[1])] as [number, number]);
    const asks = (raw.asks as string[][]).map(a => [parseFloat(a[0]), parseFloat(a[1])] as [number, number]);
    return { bids, asks };
  } catch {
    return null;
  }
}

function getP50Price(bids: [number, number][], asks: [number, number][], fallback: number): number {
  const levels = [
    ...bids.map(([p, v]) => ({ price: p, vol: v })),
    ...asks.map(([p, v]) => ({ price: p, vol: v })),
  ].sort((a, b) => b.price - a.price);
  const total = levels.reduce((s, l) => s + l.vol, 0);
  let cum = 0;
  for (const lv of levels) {
    cum += lv.vol;
    if (cum >= total * 0.5) return lv.price;
  }
  return fallback;
}

// ── Telegram ───────────────────────────────────────────────────────────────────
async function sendTg(text: string, replyMarkup?: object): Promise<number | null> {
  const token  = process.env.TELEGRAM_TOKEN  || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CHAT_ID         || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    logger.warn("TankScanner: Telegram credentials not set");
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
      logger.warn({ body }, "TankScanner: Telegram non-OK response");
      return null;
    }
    const json: any = await res.json();
    return json?.result?.message_id ?? null;
  } catch (err: any) {
    logger.warn({ err: err.message }, "TankScanner: Telegram send failed");
    return null;
  }
}

// ── Message Builders ───────────────────────────────────────────────────────────
function buildTankMsg(
  symbol:    string,
  direction: "LONG" | "SHORT",
  score:     number,
  price:     number,
  ema9:      number,
  ema200:    number,
  p50:       number,
  vwap:      number,
  volRatio:  number,
  votes:     string[],
  sl: number, tp1: number, tp2: number, tp3: number,
): string {
  const dirLabel  = direction === "LONG" ? "🟢 LONG (COMPRA)" : "🔴 SHORT (VENDA)";
  const dirEmoji  = direction === "LONG" ? "📈" : "📉";
  const scoreTag  = score >= 9 ? "SNIPER BALEIA" : score >= 7 ? "CONFLUÊNCIA MESTRE" : "ALERTA TÁTICO";

  // Weighted average entry: C1=20%, C2=30%, C3=30%, C4=20%
  const avgEntry = price * 0.20 + ema9 * 0.30 + ema200 * 0.30 + p50 * 0.20;
  const pct = (a: number, b: number) => ((Math.abs(a - b) / b) * 100).toFixed(2);

  const tps  = direction === "LONG"
    ? `🏁 TP1: <b>${fmt(tp1)}</b> (+${pct(tp1, avgEntry)}%) ← Proteção de Lucro\n` +
      `🏁 TP2: <b>${fmt(tp2)}</b> (+${pct(tp2, avgEntry)}%) ← Meta do Dia\n` +
      `🏁 TP3: <b>${fmt(tp3)}</b> (+${pct(tp3, avgEntry)}%) ← Surfe Total`
    : `🏁 TP1: <b>${fmt(tp1)}</b> (+${pct(tp1, avgEntry)}%) ← Proteção de Lucro\n` +
      `🏁 TP2: <b>${fmt(tp2)}</b> (+${pct(tp2, avgEntry)}%) ← Meta do Dia\n` +
      `🏁 TP3: <b>${fmt(tp3)}</b> (+${pct(tp3, avgEntry)}%) ← Surfe Total`;

  const volWarn = volRatio >= 2
    ? `Volume de compra ${volRatio.toFixed(1)}x acima da média. Blindagem ativa contra falsos rompimentos. Siga a esteira do VWAP!`
    : `Confluência confirmada nos ${score}/10 indicadores. Escale a entrada nas 4 camadas.`;

  return (
    `🐋 <b>OPERACIONAL: TANQUE DE GUERRA</b>\n` +
    `<b>${symbol}-USDT-SWAP – CONFLUÊNCIA MESTRE</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔥 STATUS: <b>${scoreTag} (${score}/10)</b> ${dirEmoji} DIREÇÃO: <b>${dirLabel}</b>\n` +
    `⏱ TIMEFRAMES: M5 | M15 | H1\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>TRIBUNAL DE INDICADORES (VOTOS):</b>\n` +
    `${votes.join("\n")}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚔️ <b>ESTRATÉGIA DE ARTILHARIA (4 CAMADAS):</b>\n` +
    `🔹 C1 (Atual):       <b>${fmt(price)}</b>  (20%)\n` +
    `🔹 C2 (EMA 9):       <b>${fmt(ema9)}</b>  (30%)\n` +
    `🔹 C3 (EMA 200):     <b>${fmt(ema200)}</b>  (30%)\n` +
    `🔹 C4 (P50 Liquidez):<b>${fmt(p50)}</b>  (20%)\n` +
    `📊 Preço Médio Estimado: <b>${fmt(avgEntry)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 <b>ALVOS DE DESTRUIÇÃO:</b>\n` +
    `${tps}\n` +
    `🛡️ STOP LOSS: <b>${fmt(sl)}</b> (-${pct(sl, avgEntry)}%)\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 VWAP: <b>${fmt(vwap)}</b>\n` +
    `⚠️ AVISO DO TANQUE: "${volWarn}"\n` +
    `⏰ ${nowBR()} (Brasília)`
  );
}

function buildAbsorptionMsg(symbol: string, price: number, volRatio: number): string {
  return (
    `🛡️ <b>ABSORÇÃO DETECTADA — TANQUE DE GUERRA</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 ${symbol}-USDT-SWAP\n` +
    `💵 Preço: <b>${fmt(price)}</b>\n` +
    `📊 Volume: <b>${volRatio.toFixed(1)}× acima da média</b>\n` +
    `⚠️ Preço sem movimento relevante em 3 candles M5 (range < 0.1%).\n` +
    `🐋 Possível acumulação/distribuição silenciosa de baleia.\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 Aguarde rompimento direcional antes de entrar.\n` +
    `⏰ ${nowBR()} (Brasília)`
  );
}

// ── Core scanner ───────────────────────────────────────────────────────────────
async function scanTank(symbol: string): Promise<void> {
  // ── 1. Fetch data ──────────────────────────────────────────────────────────
  const [m5s, m15s] = await Promise.all([
    fetchKlines(symbol, "5m",  100),
    fetchKlines(symbol, "15m",  80),
  ]);

  if (m5s.length < 30 || m15s.length < 26) return;

  const price     = m5s[m5s.length - 1].close;
  const m5Closes  = m5s.map(c => c.close);
  const m15Closes = m15s.map(c => c.close);

  // ── 2. Compute indicators ─────────────────────────────────────────────────
  // RSI(6) on M5
  const rsiArr  = calculateRSI(m5Closes, 6);
  const currRsi = rsiArr[rsiArr.length - 1];

  // EMA 9 and 200 on M15
  const ema9Arr  = calculateEMA(m15Closes, 9);
  const ema9     = ema9Arr[ema9Arr.length - 1];
  const ema200Arr = calculateEMA(m15Closes, 200);
  const ema200   = ema200Arr[ema200Arr.length - 1] || 0;

  // SAR on M5
  const sarArr  = calculateParabolicSAR(m5s);
  const currSar = sarArr[sarArr.length - 1];

  // KDJ on M15 — detect crossover in last 2 bars
  const kdjArr  = calculateKDJ(m15s);
  const kdjNow  = kdjArr[kdjArr.length - 1];
  const kdjPrev = kdjArr[kdjArr.length - 2] ?? kdjNow;
  const kdjBullCross = kdjNow.k > kdjNow.d && kdjPrev.k <= kdjPrev.d;
  const kdjBearCross = kdjNow.k < kdjNow.d && kdjPrev.k >= kdjPrev.d;

  // Bollinger Bands on M15 — detect expansion
  const bbArr  = calculateBB(m15Closes);
  const bbNow  = bbArr[bbArr.length - 1];
  const bbPrev = bbArr[bbArr.length - 2] ?? bbNow;
  const bbExpanding = bbNow.width > bbPrev.width;

  // MACD on M15
  const macdData = calculateMACD(m15Closes);
  const histNow  = macdData.histogram[macdData.histogram.length - 1];
  const histPrev = macdData.histogram[macdData.histogram.length - 2] ?? histNow;
  const macdBull = histNow > 0 && histNow > histPrev;
  const macdBear = histNow < 0 && histNow < histPrev;

  // OBV on M5
  const obvArr    = calculateOBV(m5s);
  const obvNow    = obvArr[obvArr.length - 1];
  const obvLag    = obvArr[Math.max(0, obvArr.length - 4)];
  const obvRising  = obvNow > obvLag;
  const obvFalling = obvNow < obvLag;

  // VWAP from last 48 M5 candles (~4h session)
  const vwap = calculateVWAP(m5s.slice(-48));

  // Price vs EMA200
  const aboveEma200 = ema200 > 0 && price > ema200;
  const belowEma200 = ema200 > 0 && price < ema200;

  // Volume
  const avgVol  = calculateAvgVolume(m5s, 20);
  const currVol = m5s[m5s.length - 1].volume;
  const volRatio = avgVol > 0 ? currVol / avgVol : 1;

  // ── 3. Fetch external data in parallel ────────────────────────────────────
  const [lsRatio, ob] = await Promise.all([
    fetchLongShortRatio(symbol),
    fetchOrderBook(symbol),
  ]);
  const p50 = ob ? getP50Price(ob.bids, ob.asks, price) : price;

  // ── 4. Absorption Filter ──────────────────────────────────────────────────
  if (volRatio >= 2) {
    const last3    = m5s.slice(-3);
    const rangeHi  = Math.max(...last3.map(c => c.high));
    const rangeLo  = Math.min(...last3.map(c => c.low));
    const rangePct = (rangeHi - rangeLo) / price;
    if (rangePct < 0.001) {
      const absKey  = `${symbol}-abs`;
      const lastAbs = absorptionMap.get(absKey) ?? 0;
      if (Date.now() - lastAbs >= ABS_COOLDOWN_MS) {
        absorptionMap.set(absKey, Date.now());
        logger.info({ symbol, volRatio: volRatio.toFixed(2) }, "TankScanner: absorção detectada");
        await sendTg(buildAbsorptionMsg(symbol, price, volRatio));
        notifySignalSent();
      }
    }
  }

  // ── 5. Tribunal — score each side (2 pts per criterion, 5 criteria = 10 max) ─
  type CriteriaRow = {
    label: string;
    oscLabel: string;
    bull: boolean;
    bear: boolean;
  };

  const criteria: CriteriaRow[] = [
    {
      label:    "Osciladores: RSI & KDJ",
      oscLabel: `RSI(6) M5: ${currRsi.toFixed(0)} | KDJ: K${kdjNow.k.toFixed(1)} / D${kdjNow.d.toFixed(1)}`,
      bull:     currRsi < 30 || kdjBullCross,
      bear:     currRsi > 70 || kdjBearCross,
    },
    {
      label:    "Tendência: SAR + Bollinger",
      oscLabel: `SAR ${currSar.isLong ? "abaixo" : "acima"} do preço | BB ${bbExpanding ? "abrindo" : "contraindo"}`,
      bull:     currSar.isLong && bbExpanding,
      bear:     !currSar.isLong && bbExpanding,
    },
    {
      label:    "Muralha: EMA 200",
      oscLabel: `EMA200: ${fmt(ema200)} | Preço ${aboveEma200 ? "acima (suporte)" : "abaixo (resistência)"}`,
      bull:     aboveEma200,
      bear:     belowEma200,
    },
    {
      label:    "Fluxo 🐋: OBV & MACD",
      oscLabel: `OBV ${obvRising ? "subindo" : "caindo"} | MACD hist ${histNow > 0 ? "positivo" : "negativo"}`,
      bull:     obvRising && macdBull,
      bear:     obvFalling && macdBear,
    },
    {
      label:    "Fluxo 🐋: L.S Ratio & Volume",
      oscLabel: `L/S Ratio: ${lsRatio.toFixed(2)} | Vol: ${volRatio.toFixed(1)}×`,
      bull:     lsRatio > 1.05,
      bear:     lsRatio < 0.95,
    },
  ];

  let longScore  = 0;
  let shortScore = 0;
  const longVotes:  string[] = [];
  const shortVotes: string[] = [];

  for (const c of criteria) {
    if (c.bull) {
      longScore += 2;
      longVotes.push(`✅ ${c.label} (${c.oscLabel})`);
    } else {
      longVotes.push(`❌ ${c.label} (${c.oscLabel})`);
    }
    if (c.bear) {
      shortScore += 2;
      shortVotes.push(`✅ ${c.label} (${c.oscLabel})`);
    } else {
      shortVotes.push(`❌ ${c.label} (${c.oscLabel})`);
    }
  }

  // ── 6. Cooldown guard ─────────────────────────────────────────────────────
  const lastFire = cooldownMap.get(symbol) ?? 0;
  if (Date.now() - lastFire < COOLDOWN_MS) return;

  // ── 7. Fire ───────────────────────────────────────────────────────────────
  const atr = calculateATR(m5s.slice(-20));

  if (longScore >= MIN_SCORE && longScore >= shortScore) {
    if (isSymbolBlocked(symbol)) {
      logger.info({ symbol }, "TankScanner: LONG suprimido — Modo Escolta ativo para esta moeda");
      return;
    }
    const slDist = Math.max(atr * 1.5, price * 0.005);
    const sl     = price - slDist;
    const tp1    = price + slDist;
    const tp2    = price + slDist * 2;
    const tp3    = price + slDist * 3;
    cooldownMap.set(symbol, Date.now());
    registerTrade({ symbol, direction: "LONG", avgEntry: price, sl, tp1, tp2, tp3 });
    logger.info({ symbol, score: longScore }, "TankScanner: LONG sinal TANQUE disparado");
    const tankMsgId = await sendTg(buildTankMsg(symbol, "LONG", longScore, price, ema9, ema200, p50, vwap, volRatio, longVotes, sl, tp1, tp2, tp3), buildAtiraKeyboard(symbol, "LONG"));
    if (tankMsgId !== null) trackSignalMessage(tankMsgId);
    notifySignalSent();

  } else if (shortScore >= MIN_SCORE) {
    if (isSymbolBlocked(symbol)) {
      logger.info({ symbol }, "TankScanner: SHORT suprimido — Modo Escolta ativo para esta moeda");
      return;
    }
    const slDist = Math.max(atr * 1.5, price * 0.005);
    const sl     = price + slDist;
    const tp1    = price - slDist;
    const tp2    = price - slDist * 2;
    const tp3    = price - slDist * 3;
    cooldownMap.set(symbol, Date.now());
    registerTrade({ symbol, direction: "SHORT", avgEntry: price, sl, tp1, tp2, tp3 });
    logger.info({ symbol, score: shortScore }, "TankScanner: SHORT sinal TANQUE disparado");
    const tankMsgId = await sendTg(buildTankMsg(symbol, "SHORT", shortScore, price, ema9, ema200, p50, vwap, volRatio, shortVotes, sl, tp1, tp2, tp3), buildAtiraKeyboard(symbol, "SHORT"));
    if (tankMsgId !== null) trackSignalMessage(tankMsgId);
    notifySignalSent();
  }
}

/** Clear all in-memory caches — forces a fresh fetch from OKX on the next cycle. */
export function clearTankCache(): void {
  klineCache.clear();
  cooldownMap.clear();
  absorptionMap.clear();
  logger.info("TankScanner: cache limpo — forçando nova conexão com OKX");
}

// ── Entry point ────────────────────────────────────────────────────────────────
export async function startTankScanner(): Promise<void> {
  if (tankTimer) return;
  logger.info({ symbols: SYMBOLS, intervalSeconds: SCAN_INTERVAL_MS / 1000 }, "TankScanner: Tanque de Guerra iniciado");

  const runAll = async () => {
    for (const symbol of SYMBOLS) {
      try {
        await scanTank(symbol);
      } catch (err: any) {
        logger.warn({ symbol, err: err.message }, "TankScanner: erro em scanTank");
      }
      // 1.5s between coins to respect OKX rate limits
      await new Promise(r => setTimeout(r, 1_500));
    }
  };

  // First scan runs immediately
  runAll().catch(err => logger.error({ err }, "TankScanner: runAll error"));
  tankTimer = setInterval(() => {
    runAll().catch(err => logger.error({ err }, "TankScanner: runAll error"));
  }, SCAN_INTERVAL_MS);
}
