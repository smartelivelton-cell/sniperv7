/**
 * ☯️ SUN TZU: VENCER SEM LUTAR
 * Fusion of Tank + Surf: detects EMA200 infiltration and activates Momentum Surf mode.
 * Runs for all 10 monitored SWAP pairs with a 3-level Telegram notification system.
 */

import { logger } from "./logger";
import { notifySignalSent } from "./heartbeat";
import { startOKXTimeSync, forceSyncNow } from "./okxTime";
import { isSymbolBlocked, trackSignalMessage, buildAtiraKeyboard } from "./captainMode";
import {
  calculateEMA,
  calculateRSI,
  calculateOBV,
  type Candle,
} from "./indicators";

// ── Constants ──────────────────────────────────────────────────────────────────
const SYMBOLS           = ["BTC", "ETH", "SOL", "DOGE", "AXS", "AVAX", "BNB", "ADA", "POL", "XRP"];
const SCAN_INTERVAL_MS  = 45_000;         // 45s — offset from main (30s) and tank (60s)
const LVL1_COOLDOWN_MS  = 60 * 60 * 1000; // 1h per symbol for formation alert
const LVL2_COOLDOWN_MS  = 30 * 60 * 1000; // 30min per symbol for anticipation
const LVL3_COOLDOWN_MS  = 60 * 60 * 1000; // 1h per symbol for confirmation
const WIN_CHECK_MS      = 90_000;          // check active positions every 90s
const OKX_BASE          = "https://www.okx.com/api/v5";
const TZ                = "America/Sao_Paulo";

// ── State ──────────────────────────────────────────────────────────────────────
const lvl1Map  = new Map<string, number>(); // last Level 1 alert per symbol
const lvl2Map  = new Map<string, number>(); // last Level 2 alert per symbol
const lvl3Map  = new Map<string, number>(); // last Level 3 confirmation per symbol

// Active Sun Tzu positions (symbol → position data)
interface SunTzuPos {
  symbol:    string;
  direction: "LONG" | "SHORT";
  entry:     number;   // C1 price (40%)
  c2:        number;   // C2 = EMA200 reteste (60%)
  avgEntry:  number;   // weighted avg: 0.4*C1 + 0.6*C2
  openedAt:  number;
  win1Pct:   boolean;  // whether +1% notification was already sent
  trailSL:   number;   // trailing stop level (updates every M15 close)
}

const activePositions = new Map<string, SunTzuPos>();

// Kline cache (separate namespace from other scanners)
const klineCache = new Map<string, { data: Candle[]; ts: number }>();
const CACHE_TTL: Record<string, number> = {
  "5m": 25_000, "15m": 25_000, "1H": 300_000,
};

let sunTzuTimer:     ReturnType<typeof setInterval> | null = null;
let winMonitorTimer: ReturnType<typeof setInterval> | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────────
function nowBR(): string {
  return new Date().toLocaleString("pt-BR", { timeZone: TZ, hour12: false });
}
function fmt(n: number): string { return n >= 1 ? n.toFixed(2) : n.toFixed(6); }

// ── OKX Fetch ─────────────────────────────────────────────────────────────────
async function fetchKlines(symbol: string, bar: string, limit: number): Promise<Candle[]> {
  const key    = `stz-${symbol}-${bar}`;
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
  if (json.code !== "0") throw new Error(`OKX ${json.msg}`);

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

async function fetchLSRatio(symbol: string): Promise<number> {
  try {
    const instId = `${symbol}-USDT-SWAP`;
    const url    = `${OKX_BASE}/rubik/stat/contracts/long-short-account-ratio?instId=${instId}&period=5m&limit=2`;
    const res    = await fetch(url, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(5_000),
    });
    if (!res.ok) return 1.0;
    const json: any = await res.json();
    if (json.code !== "0" || !json.data?.[0]) return 1.0;
    return parseFloat(json.data[0][1]) || 1.0;
  } catch { return 1.0; }
}

async function fetchPrevLSRatio(symbol: string): Promise<number> {
  // Returns the 2nd most recent L/S ratio (to compare with current)
  try {
    const instId = `${symbol}-USDT-SWAP`;
    const url    = `${OKX_BASE}/rubik/stat/contracts/long-short-account-ratio?instId=${instId}&period=5m&limit=2`;
    const res    = await fetch(url, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(5_000),
    });
    if (!res.ok) return 1.0;
    const json: any = await res.json();
    if (json.code !== "0" || !json.data?.[1]) return 1.0;
    return parseFloat(json.data[1][1]) || 1.0;
  } catch { return 1.0; }
}

// ── Telegram ───────────────────────────────────────────────────────────────────
async function sendTg(text: string, replyMarkup?: object): Promise<number | null> {
  const token  = process.env.TELEGRAM_TOKEN  || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CHAT_ID         || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
      signal:  AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ body }, "SunTzu: Telegram non-OK");
      return null;
    }
    const json: any = await res.json();
    return json?.result?.message_id ?? null;
  } catch (err: any) {
    logger.warn({ err: err.message }, "SunTzu: Telegram send failed");
    return null;
  }
}

// ── Candle Pattern Detection ───────────────────────────────────────────────────
function isShootingStar(c: Candle): boolean {
  const body        = Math.abs(c.close - c.open);
  const range       = c.high - c.low;
  if (range < 0.0001) return false;
  const upperShadow = c.high - Math.max(c.open, c.close);
  const lowerShadow = Math.min(c.open, c.close) - c.low;
  return upperShadow > body * 2 && lowerShadow < body * 0.5 && body / range < 0.4;
}

function isDoji(c: Candle): boolean {
  const body  = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  return range > 0 && body / range < 0.12;
}

function detectReversalPattern(candle: Candle): string | null {
  if (isShootingStar(candle)) {
    // Distinguish: Shooting Star (bearish) vs Inverted Hammer
    const bearBody = candle.close < candle.open;
    return bearBody ? "Estrela Cadente 🌠" : "Martelo Invertido 🔨";
  }
  if (isDoji(candle)) return "Doji de Topo ⚖️";
  return null;
}

// ── Message Builders ───────────────────────────────────────────────────────────
function msgLevel1(symbol: string, price: number, ema200: number, rsi: number, distPct: string): string {
  return (
    `🏮 <b>SUN TZU: VENCER SEM LUTAR</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ <b>NÍVEL 1 — EM FORMAÇÃO</b>\n` +
    `🪙 ${symbol}-USDT-SWAP\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🧠 <b>INTELIGÊNCIA:</b>\n` +
    `• Preço: <b>${fmt(price)}</b>\n` +
    `• EMA200 (Muralha): <b>${fmt(ema200)}</b>\n` +
    `• Distância: <b>${distPct}%</b> da Muralha\n` +
    `• RSI(6): <b>${rsi.toFixed(0)}</b> (subindo)\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📡 STATUS: <b>Infiltração na Muralha</b>\n` +
    `🎯 O preço se aproxima da EMA200. Monitore o próximo candle M5 para rompimento.\n` +
    `⏰ ${nowBR()} (Brasília)`
  );
}

function msgLevel2(
  symbol: string, price: number, ema200: number, rsi: number,
  lsRatio: number, lsRatioPrev: number, entryTrigger: number,
  direction: "LONG" | "SHORT",
): string {
  const lsFalling = lsRatio < lsRatioPrev;
  const dirLabel  = direction === "LONG" ? "🟢 LONG (COMPRA)" : "🔴 SHORT (VENDA)";
  const dirEmoji  = direction === "LONG" ? "📈" : "📉";
  return (
    `🏮 <b>SUN TZU: VENCER SEM LUTAR</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⏳ <b>NÍVEL 2 — ANTECIPAÇÃO 80%</b>\n` +
    `🪙 ${symbol}-USDT-SWAP\n` +
    `${dirEmoji} DIREÇÃO: <b>${dirLabel}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🧠 <b>INTELIGÊNCIA:</b>\n` +
    `• Candle M5 fechou cruzando a EMA200!\n` +
    `• L/S Ratio: <b>${lsRatio.toFixed(2)}</b>${lsFalling ? " ↘️ em queda" : ""} (sardinhas ${lsRatio < 1 ? "vendendo" : "comprando"})\n` +
    `• RSI(6): <b>${rsi.toFixed(0)}</b>\n` +
    `• EMA200: <b>${fmt(ema200)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 <b>PREÇO EXATO DE ENTRADA:</b> <b>${fmt(entryTrigger)}</b>\n` +
    `(${direction === "LONG" ? "Máxima" : "Mínima"} do candle anterior ${direction === "LONG" ? "+" : "-"} 0.01%)\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ A Muralha está sendo infiltrada. Aguarde a Confirmação Sun Tzu (Nível 3).\n` +
    `⏰ ${nowBR()} (Brasília)`
  );
}

function msgLevel3(
  symbol: string, price: number, ema200: number, ema9: number, ema21: number,
  rsi: number, volRatio: number, c1: number, c2: number, avgEntry: number,
  direction: "LONG" | "SHORT",
): string {
  const dirLabel = direction === "LONG" ? "🟢 LONG (COMPRA)" : "🔴 SHORT (VENDA)";
  const dirEmoji = direction === "LONG" ? "📈" : "📉";
  const tp1Pct   = 1.0;
  const tp1      = direction === "LONG" ? avgEntry * (1 + tp1Pct / 100) : avgEntry * (1 - tp1Pct / 100);
  const sl       = direction === "LONG" ? ema200 * 0.997 : ema200 * 1.003;

  return (
    `🏮 <b>SUN TZU: VENCER SEM LUTAR</b>\n` +
    `<b>${symbol}-USDT-SWAP – DOMÍNIO TOTAL</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔥 STATUS: <b>BALEIAS NO VÁCUO</b>\n` +
    `${dirEmoji} DIREÇÃO: <b>${dirLabel}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🧠 <b>INTELIGÊNCIA:</b>\n` +
    `• EMA200 (Muralha infiltrada): <b>${fmt(ema200)}</b>\n` +
    `• EMA9 &gt; EMA21: <b>${fmt(ema9)}</b> &gt; <b>${fmt(ema21)}</b> ✅\n` +
    `• RSI(6): <b>${rsi.toFixed(0)}</b> (zona de força)\n` +
    `• Volume: <b>${volRatio.toFixed(1)}×</b> acima da média ✅\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚔️ <b>EMBOSCADA SUN TZU (2 CAMADAS):</b>\n` +
    `🔹 C1 (40% — Agora): <b>${fmt(c1)}</b>\n` +
    `🔹 C2 (60% — Reteste EMA200): <b>${fmt(c2)}</b>\n` +
    `📊 Preço Médio: <b>${fmt(avgEntry)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🏁 <b>MODO SURFE ATIVADO:</b>\n` +
    `• Marco de 1%: <b>${fmt(tp1)}</b> (Win registrado)\n` +
    `• TP fixos: <b>DESATIVADOS</b> — surfe até exaustão\n` +
    `• Trailing Stop: mínima do candle M15 anterior\n` +
    `• Sinal de saída: padrão de reversão M15 ou RSI < 50\n` +
    `🛡️ Stop Loss inicial: <b>${fmt(sl)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 "A Muralha 200 foi infiltrada. Surfe de momentum ativado. Alvos infinitos até exaustão do M15."\n` +
    `⏰ ${nowBR()} (Brasília)`
  );
}

function msgWin1Pct(symbol: string, direction: "LONG" | "SHORT", avgEntry: number, currentPrice: number): string {
  const dirEmoji = direction === "LONG" ? "📈" : "📉";
  return (
    `🏮 <b>SUN TZU: MARCO DE 1% ATINGIDO!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎉 <b>${symbol}-USDT-SWAP</b>\n` +
    `${dirEmoji} Direção: <b>${direction}</b>\n` +
    `💵 Entrada Média: <b>${fmt(avgEntry)}</b>\n` +
    `💵 Preço Atual: <b>${fmt(currentPrice)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ <b>Lucro garantido. Iniciando Modo Surfe M15.</b>\n` +
    `🛡️ Stop Loss movido para +0.5% (break-even real)\n` +
    `📡 Monitorando fechamento M15 para saída por exaustão\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 Deixe o Surfe correr. Só saia no padrão de reversão M15.\n` +
    `⏰ ${nowBR()} (Brasília)`
  );
}

function msgExitSignal(symbol: string, direction: "LONG" | "SHORT", currentPrice: number, pattern: string | null, obvFalling: boolean): string {
  const dirEmoji = direction === "LONG" ? "📈" : "📉";
  const reason = pattern
    ? `Padrão de reversão M15: <b>${pattern}</b>`
    : `RSI(6) M15 caiu abaixo de 50 + OBV ${obvFalling ? "caindo" : "divergindo"}`;
  return (
    `🏮 <b>SUN TZU: SINAL DE SAÍDA</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 <b>${symbol}-USDT-SWAP</b>\n` +
    `${dirEmoji} <b>${direction}</b> — <b>EXAUSTÃO DETECTADA</b>\n` +
    `💵 Preço atual: <b>${fmt(currentPrice)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔍 Motivo: ${reason}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ <b>AÇÃO: Feche a posição a mercado agora.</b>\n` +
    `♟️ Sun Tzu concluído. O general retira suas tropas.\n` +
    `⏰ ${nowBR()} (Brasília)`
  );
}

// ── Core scanner ───────────────────────────────────────────────────────────────
async function scanSunTzu(symbol: string): Promise<void> {
  const [m5s, m15s] = await Promise.all([
    fetchKlines(symbol, "5m",  60),
    fetchKlines(symbol, "15m", 50),
  ]);

  if (m5s.length < 26 || m15s.length < 22) return;

  const price     = m5s[m5s.length - 1].close;
  const prevCandle = m5s[m5s.length - 2];
  const m5Closes  = m5s.map(c => c.close);
  const m15Closes = m15s.map(c => c.close);

  // EMAs on M5
  const ema9Arr   = calculateEMA(m5Closes, 9);
  const ema21Arr  = calculateEMA(m5Closes, 21);
  const ema200Arr = calculateEMA(m5Closes, 200);
  const ema9      = ema9Arr[ema9Arr.length - 1];
  const ema21     = ema21Arr[ema21Arr.length - 1];
  const ema200    = ema200Arr[ema200Arr.length - 1] || 0;

  if (ema200 === 0) return;

  // RSI(6) on M5
  const rsiArr  = calculateRSI(m5Closes, 6);
  const currRsi = rsiArr[rsiArr.length - 1];

  // Volume
  const vols    = m5s.map(c => c.volume);
  const avgVol  = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const currVol = m5s[m5s.length - 1].volume;
  const volRatio = avgVol > 0 ? currVol / avgVol : 1;

  // Distance from EMA200
  const distPct = ((Math.abs(price - ema200) / ema200) * 100).toFixed(3);

  const now = Date.now();

  // ── LEVEL 1: EM FORMAÇÃO ───────────────────────────────────────────────────
  // Price within 0.15% of EMA200 + RSI > 50
  // Level 1 is logged internally only — Telegram is reserved for Level 2 & 3.
  const nearMuralha = parseFloat(distPct) < 0.15;
  if (nearMuralha && currRsi > 50) {
    const lastLvl1 = lvl1Map.get(symbol) ?? 0;
    if (now - lastLvl1 >= LVL1_COOLDOWN_MS) {
      lvl1Map.set(symbol, now);
      logger.info(
        { symbol, rsi: currRsi.toFixed(0), dist: distPct, price, ema200 },
        "SunTzu: Nível 1 — Em Formação (log interno — Telegram reservado para Nível 2 e 3)",
      );
    }
    return; // Don't check further levels when still approaching
  }

  // Cross detection: previous close was on other side of EMA200
  const prevClose    = prevCandle.close;
  const crossedAbove = prevClose < ema200 && price > ema200;
  const crossedBelow = prevClose > ema200 && price < ema200;
  const crossed      = crossedAbove || crossedBelow;
  const direction    = crossedAbove ? "LONG" : "SHORT";

  // ── LEVEL 2: ANTECIPAÇÃO 80% ───────────────────────────────────────────────
  // M5 candle just crossed EMA200
  if (crossed) {
    const [lsRatio, lsRatioPrev] = await Promise.all([
      fetchLSRatio(symbol),
      fetchPrevLSRatio(symbol),
    ]);
    const lsFalling = lsRatio < lsRatioPrev;
    // Sardines selling (SHORT interest rising) while price crosses up = Muralha falling
    const sardinhasSelling = direction === "LONG" && lsRatio < 1.0 && lsFalling;
    const sardinhaBuying   = direction === "SHORT" && lsRatio > 1.0 && !lsFalling;

    const lastLvl2 = lvl2Map.get(symbol) ?? 0;
    if (now - lastLvl2 >= LVL2_COOLDOWN_MS && (sardinhasSelling || sardinhaBuying || crossed)) {
      if (isSymbolBlocked(symbol)) {
        logger.info({ symbol }, "SunTzu: Nível 2 suprimido — Modo Escolta ativo para esta moeda");
      } else {
        lvl2Map.set(symbol, now);
        const entryTrigger = direction === "LONG"
          ? prevCandle.high * 1.0001
          : prevCandle.low  * 0.9999;

        // Estimate SL/TP for ATIRAR button (1:1 risk using 1% from entry)
        const slPct  = entryTrigger * 0.01;
        const estSl  = direction === "LONG" ? entryTrigger - slPct : entryTrigger + slPct;
        const estTp1 = direction === "LONG" ? entryTrigger + slPct : entryTrigger - slPct;
        const estTp2 = direction === "LONG" ? entryTrigger + slPct * 2 : entryTrigger - slPct * 2;
        const estTp3 = direction === "LONG" ? entryTrigger + slPct * 3 : entryTrigger - slPct * 3;

        // Guard: abort if any price field is invalid
        if (entryTrigger <= 0 || estSl <= 0 || estTp1 <= 0 || estTp2 <= 0 || estTp3 <= 0) {
          logger.error({ symbol, direction, entryTrigger, estSl, estTp1 }, "SunTzu: Nível 2 abortado — SL ou TP inválido (zero/NaN)");
          return;
        }

        logger.info({ symbol, direction, lsRatio, lsFalling }, "SunTzu: Nível 2 — Antecipação 80%");
        const msgId = await sendTg(
          msgLevel2(symbol, price, ema200, currRsi, lsRatio, lsRatioPrev, entryTrigger, direction),
          buildAtiraKeyboard({ symbol, direction, avgEntry: entryTrigger, sl: estSl, tp1: estTp1, tp2: estTp2, tp3: estTp3 }),
        );
        if (msgId !== null) trackSignalMessage(symbol, msgId);
        notifySignalSent();
      }
    }
  }

  // ── LEVEL 3: CONFIRMAÇÃO SUN TZU ──────────────────────────────────────────
  // EMA9 > EMA21 + Volume > 2x avg + Price above EMA200
  // Entry filter (for Hub): RSI > 60 + Volume > 1.5x + price crossed EMA200
  const ema9aboveEma21  = ema9 > ema21;
  const ema9belowEma21  = ema9 < ema21;
  const volAbove2x      = volRatio >= 2.0;
  const aboveEma200     = price > ema200;
  const belowEma200     = price < ema200;

  const confirmLong  = ema9aboveEma21 && volAbove2x && aboveEma200 && currRsi > 60;
  const confirmShort = ema9belowEma21 && volAbove2x && belowEma200 && currRsi < 40;

  if (confirmLong || confirmShort) {
    const dir3 = confirmLong ? "LONG" : "SHORT";
    const lastLvl3 = lvl3Map.get(symbol) ?? 0;
    if (now - lastLvl3 >= LVL3_COOLDOWN_MS) {
      lvl3Map.set(symbol, now);

      // Entry: C1=40% at current price, C2=60% at EMA200 reteste
      const c1  = price;
      const c2  = ema200;
      const avg = c1 * 0.40 + c2 * 0.60;

      // Store active position
      const trailSL = dir3 === "LONG"
        ? m15s[m15s.length - 2].low   // previous M15 low
        : m15s[m15s.length - 2].high; // previous M15 high

      activePositions.set(symbol, {
        symbol, direction: dir3,
        entry: c1, c2, avgEntry: avg,
        openedAt: now,
        win1Pct: false,
        trailSL,
      });

      if (isSymbolBlocked(symbol)) {
        logger.info({ symbol }, "SunTzu: Nível 3 suprimido — Modo Escolta ativo para esta moeda");
        return;
      }

      // Compute SL/TP from trailSL distance for ATIRAR callback
      const slDist = Math.abs(avg - trailSL);
      const tp1Lvl3 = dir3 === "LONG" ? avg + slDist     : avg - slDist;
      const tp2Lvl3 = dir3 === "LONG" ? avg + slDist * 2 : avg - slDist * 2;
      const tp3Lvl3 = dir3 === "LONG" ? avg + slDist * 3 : avg - slDist * 3;


      // Guard: abort if any price field is invalid
      if (avg <= 0 || trailSL <= 0 || tp1Lvl3 <= 0 || tp2Lvl3 <= 0 || tp3Lvl3 <= 0) {
        logger.error({ symbol, direction: dir3, avg, trailSL, tp1Lvl3 }, "SunTzu: Nível 3 abortado — SL ou TP inválido (zero/NaN)");
        return;
      }

      logger.info({ symbol, direction: dir3, score: "3/3", volRatio: volRatio.toFixed(2) }, "SunTzu: Nível 3 — Confirmação Sun Tzu");
      const msgId3 = await sendTg(msgLevel3(symbol, price, ema200, ema9, ema21, currRsi, volRatio, c1, c2, avg, dir3), buildAtiraKeyboard({ symbol, direction: dir3, avgEntry: avg, sl: trailSL, tp1: tp1Lvl3, tp2: tp2Lvl3, tp3: tp3Lvl3 }));
      if (msgId3 !== null) trackSignalMessage(symbol, msgId3);
      notifySignalSent();
    }
  }
}

// ── Active Position Monitor (Win 1% + Surf Mode + Exit) ───────────────────────
async function monitorActivePositions(): Promise<void> {
  for (const [symbol, pos] of activePositions.entries()) {
    try {
      const m15s = await fetchKlines(symbol, "15m", 20);
      if (m15s.length < 3) continue;

      const lastM15   = m15s[m15s.length - 1];
      const prevM15   = m15s[m15s.length - 2];
      const price     = lastM15.close;

      // Update trailing stop to previous M15 candle low/high
      const newTrail = pos.direction === "LONG" ? prevM15.low : prevM15.high;
      if (pos.direction === "LONG" && newTrail > pos.trailSL)
        pos.trailSL = newTrail;
      if (pos.direction === "SHORT" && newTrail < pos.trailSL)
        pos.trailSL = newTrail;

      // Check 1% win milestone
      const movePct = ((price - pos.avgEntry) / pos.avgEntry) * 100;
      const winReached = pos.direction === "LONG" ? movePct >= 1.0 : movePct <= -1.0;

      if (winReached && !pos.win1Pct) {
        pos.win1Pct = true;
        activePositions.set(symbol, pos);
        logger.info({ symbol, movePct: movePct.toFixed(2) }, "SunTzu: Marco 1% atingido");
        if (!isSymbolBlocked(symbol)) { await sendTg(msgWin1Pct(symbol, pos.direction, pos.avgEntry, price)); notifySignalSent(); }
      }

      // Check trailing stop hit
      const stopHit = pos.direction === "LONG" ? price <= pos.trailSL : price >= pos.trailSL;
      if (stopHit) {
        logger.info({ symbol, trailSL: pos.trailSL, price }, "SunTzu: Trailing stop atingido — encerrando");
        activePositions.delete(symbol);
        continue;
      }

      // Check M15 reversal pattern (only after 1% win to allow initial move)
      if (pos.win1Pct) {
        const m15Closes = m15s.map(c => c.close);
        const m15Rsi    = calculateRSI(m15Closes, 6);
        const m15RsiNow = m15Rsi[m15Rsi.length - 1];
        const obvArr    = calculateOBV(m15s);
        const obvNow    = obvArr[obvArr.length - 1];
        const obvPrev3  = obvArr[Math.max(0, obvArr.length - 4)];
        const obvFalling = obvNow < obvPrev3;

        const reversalPattern = detectReversalPattern(lastM15);
        const rsiExhausted = pos.direction === "LONG"
          ? m15RsiNow < 50
          : m15RsiNow > 50;

        const exitCondition = (reversalPattern && obvFalling) || rsiExhausted;

        if (exitCondition) {
          logger.info({ symbol, pattern: reversalPattern, rsi: m15RsiNow.toFixed(0) }, "SunTzu: Sinal de saída M15");
          if (!isSymbolBlocked(symbol)) { await sendTg(msgExitSignal(symbol, pos.direction, price, reversalPattern, obvFalling)); notifySignalSent(); }
          activePositions.delete(symbol);
        }
      }

      // Auto-expire positions older than 24h to prevent stale state
      if (Date.now() - pos.openedAt > 24 * 60 * 60 * 1000) {
        logger.info({ symbol }, "SunTzu: Posição expirada após 24h — removida");
        activePositions.delete(symbol);
      }

    } catch (err: any) {
      logger.warn({ symbol, err: err.message }, "SunTzu: erro monitorando posição");
    }
  }
}

// ── Cache clear (for external reset endpoint) ──────────────────────────────────
export function clearSunTzuCache(): void {
  klineCache.clear();
  lvl1Map.clear();
  lvl2Map.clear();
  lvl3Map.clear();
  logger.info("SunTzu: cache limpo — forçando nova conexão com OKX");
}

// ── Entry point ────────────────────────────────────────────────────────────────
export async function startSunTzuScanner(): Promise<void> {
  if (sunTzuTimer) return;
  startOKXTimeSync();
  logger.info({ symbols: SYMBOLS, intervalSeconds: SCAN_INTERVAL_MS / 1000 }, "SunTzu: Vencer Sem Lutar iniciado");

  const runAll = async () => {
    for (const symbol of SYMBOLS) {
      try {
        await scanSunTzu(symbol);
      } catch (err: any) {
        logger.warn({ symbol, err: err.message }, "SunTzu: erro em scanSunTzu");
      }
      await new Promise(r => setTimeout(r, 1_500));
    }
  };

  // First scan runs immediately
  runAll().catch(err => logger.error({ err }, "SunTzu: runAll error"));
  sunTzuTimer = setInterval(() => {
    runAll().catch(err => logger.error({ err }, "SunTzu: runAll error"));
  }, SCAN_INTERVAL_MS);

  // Active position monitor runs every 90s
  winMonitorTimer = setInterval(() => {
    if (activePositions.size > 0) {
      monitorActivePositions().catch(err => logger.error({ err }, "SunTzu: monitor error"));
    }
  }, WIN_CHECK_MS);
}
