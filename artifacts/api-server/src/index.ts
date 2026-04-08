import app from "./app";
import { logger } from "./lib/logger";
import { startHeartbeat } from "./lib/heartbeat";
import { startScanner } from "./lib/scanner";
import { startTankScanner } from "./lib/tankScanner";
import { startSunTzuScanner } from "./lib/sunTzuScanner";
import { startWarriorScanner } from "./lib/warriorScanner";
import { startSniperScanner } from "./lib/sniperConfluencia";
import { startOKXTimeSync } from "./lib/okxTime";
import { warmUpBacktest } from "./routes/backtest/index";

async function setupTelegramWebhook(): Promise<void> {
  const token = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { logger.warn("Webhook: TELEGRAM_TOKEN não configurado — webhook não registrado"); return; }

  const domain = process.env.WEBHOOK_DOMAIN || process.env.REPLIT_DEV_DOMAIN;
  if (!domain) { logger.warn("Webhook: REPLIT_DEV_DOMAIN não configurado — webhook não registrado"); return; }

  const webhookUrl = domain.startsWith("http")
    ? `${domain}/api/webhook/telegram`
    : `https://${domain}/api/webhook/telegram`;

  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: webhookUrl, drop_pending_updates: true }),
      signal:  AbortSignal.timeout(10_000),
    });
    const json: any = await res.json();
    if (json.ok) {
      logger.info({ webhookUrl }, "Webhook: Telegram webhook registrado com sucesso — botão ATIRAR ativo");
    } else {
      logger.warn({ json }, "Webhook: falha ao registrar Telegram webhook");
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "Webhook: erro ao registrar Telegram webhook");
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startOKXTimeSync();
  startHeartbeat();
  startScanner();
  startTankScanner();
  startSunTzuScanner();
  startWarriorScanner();
  startSniperScanner();
  warmUpBacktest();
  setupTelegramWebhook().catch(err => logger.warn({ err: err.message }, "Webhook: setup error"));
});
