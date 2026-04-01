import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const OKX_TIME_URL = "https://www.okx.com/api/v5/public/time";
const TELEGRAM_API = "https://api.telegram.org";

async function checkOKX(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(OKX_TIME_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json() as { code: string };
    if (json.code !== "0") return { ok: false, error: `OKX code ${json.code}` };
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

async function checkTelegram(): Promise<{ ok: boolean; botName?: string; error?: string }> {
  const token  = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return { ok: false, error: "TELEGRAM_TOKEN or CHAT_ID not configured" };
  }

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json() as { ok: boolean; result?: { username: string } };
    if (!json.ok) return { ok: false, error: "Telegram API returned ok=false" };
    return { ok: true, botName: json.result?.username };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/health", async (_req, res) => {
  const [okx, telegram] = await Promise.all([checkOKX(), checkTelegram()]);

  const healthy = okx.ok && telegram.ok;
  const status  = healthy ? "healthy" : "unhealthy";

  const body = {
    status,
    timestamp: new Date().toISOString(),
    services: {
      okx: {
        ok: okx.ok,
        latencyMs: okx.latencyMs,
        error: okx.error,
      },
      telegram: {
        ok: telegram.ok,
        botName: telegram.botName,
        error: telegram.error,
      },
    },
  };

  if (!healthy) {
    logger.warn({ body }, "Health check FAILED");
  }

  res.status(healthy ? 200 : 500).json(body);
});

export default router;
