import { logger } from "./logger";

const TELEGRAM_API = "https://api.telegram.org";
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const CHECK_INTERVAL_MS     = 60 * 1000;       // check every 1 minute

let lastSignalTs = Date.now();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function notifySignalSent(): void {
  lastSignalTs = Date.now();
  logger.debug({ lastSignalTs }, "Signal timestamp updated — heartbeat reset");
}

async function sendHeartbeat(): Promise<void> {
  const token  = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    logger.warn("Heartbeat: TELEGRAM_TOKEN or CHAT_ID not configured — skipping");
    return;
  }

  const now = new Date();
  const timeStr = now.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

  const text =
    `🔋 <b>Status Sniper: Motor operacional.</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📡 Monitorando 7 estratégias · OKX SWAP · GPS 5TF\n` +
    `⏱ ${timeStr} — Sem sinais nos últimos 30 min\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🧘 <i>Paciência é a virtude do Trader!\n` +
    `O mercado sempre oferece oportunidade — espere a sua.</i>`;

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) {
      logger.info("Heartbeat sent to Telegram");
    } else {
      const body = await res.text();
      logger.warn({ body }, "Heartbeat: Telegram returned non-OK status");
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "Heartbeat: failed to send — will retry next cycle");
  }
}

export function startHeartbeat(): void {
  if (heartbeatTimer) return;

  logger.info({ intervalMinutes: 30 }, "Heartbeat service started");

  heartbeatTimer = setInterval(async () => {
    const sinceLastSignal = Date.now() - lastSignalTs;
    if (sinceLastSignal >= HEARTBEAT_INTERVAL_MS) {
      await sendHeartbeat();
      lastSignalTs = Date.now();
    }
  }, CHECK_INTERVAL_MS);

  heartbeatTimer.unref();
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
