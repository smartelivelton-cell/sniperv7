import { Router } from "express";
import { createHmac } from "crypto";
import { warriorConfig, getWarriorStatus, type WarriorConfig } from "../../lib/warriorScanner";
import { logger } from "../../lib/logger";

const router = Router();

const OKX_BASE = "https://www.okx.com/api/v5";

// ── OKX Authenticated request helper ─────────────────────────────────────────
function okxSign(timestamp: string, method: string, path: string, secretKey: string): string {
  const preHash = timestamp + method + path;
  return createHmac("sha256", secretKey).update(preHash).digest("base64");
}

async function fetchOkxBalance(): Promise<{ available: number; equity: number; currency: string } | null> {
  const apiKey    = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;

  if (!apiKey || !secretKey || !passphrase) return null;

  try {
    const timestamp = new Date().toISOString();
    const path      = "/api/v5/account/balance?ccy=USDT";
    const sign      = okxSign(timestamp, "GET", path, secretKey);

    const res = await fetch(`${OKX_BASE}/account/balance?ccy=USDT`, {
      headers: {
        "OK-ACCESS-KEY":        apiKey,
        "OK-ACCESS-SIGN":       sign,
        "OK-ACCESS-TIMESTAMP":  timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase,
        "x-simulated-trading":  "0",
        "Accept":               "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "Warrior: OKX balance request failed");
      return null;
    }

    const json: any = await res.json();
    if (json.code !== "0" || !json.data?.[0]) {
      logger.warn({ code: json.code, msg: json.msg }, "Warrior: OKX balance API error");
      return null;
    }

    const details = json.data[0].details ?? [];
    const usdt = details.find((d: any) => d.ccy === "USDT");
    if (!usdt) return { available: 0, equity: 0, currency: "USDT" };

    return {
      available: parseFloat(usdt.availBal ?? "0"),
      equity:    parseFloat(usdt.eq ?? "0"),
      currency:  "USDT",
    };
  } catch (err: any) {
    logger.warn({ err: err.message }, "Warrior: erro ao buscar saldo OKX");
    return null;
  }
}

// ── GET /api/warrior/status ───────────────────────────────────────────────────
router.get("/status", (_req, res) => {
  res.json(getWarriorStatus());
});

// ── GET /api/warrior/balance ──────────────────────────────────────────────────
router.get("/balance", async (_req, res) => {
  const hasKeys = !!(process.env.OKX_API_KEY && process.env.OKX_SECRET_KEY && process.env.OKX_PASSPHRASE);
  if (!hasKeys) {
    res.json({ configured: false, balance: null });
    return;
  }
  const balance = await fetchOkxBalance();
  res.json({ configured: true, balance });
});

// ── GET /api/warrior/config ───────────────────────────────────────────────────
router.get("/config", (_req, res) => {
  res.json({ ...warriorConfig });
});

// ── PUT /api/warrior/config ───────────────────────────────────────────────────
router.put("/config", (req, res) => {
  const body = req.body as Partial<WarriorConfig>;
  if (typeof body.autoEnabled  === "boolean") warriorConfig.autoEnabled  = body.autoEnabled;
  if (typeof body.banca        === "number")  warriorConfig.banca        = body.banca;
  if (typeof body.leverage     === "number")  warriorConfig.leverage     = body.leverage;
  if (typeof body.dailyGoal    === "number")  warriorConfig.dailyGoal    = body.dailyGoal;
  if (Array.isArray(body.enabledStrats))      warriorConfig.enabledStrats = body.enabledStrats;

  logger.info({ warriorConfig }, "Warrior: configuração atualizada");
  res.json({ ok: true, config: { ...warriorConfig } });
});

export default router;
