import { Router } from "express";
import { handleAtirar, type TradeData } from "../../lib/captainMode";
import { handleWarriorContinue } from "../../lib/warriorScanner";
import { logger } from "../../lib/logger";

const router = Router();

/**
 * POST /api/webhook/telegram
 * Receives callback_query updates from Telegram when the captain clicks ATIRAR
 * or when the user replies YES/NO to a Warrior loss message.
 *
 * callback_data formats:
 *   atirar:SYM:L|S:avgEntry:sl:tp1:tp2:tp3
 *   warrior_continue:YES | warrior_continue:NO
 */
router.post("/telegram", async (req, res) => {
  const update = req.body;

  if (update?.callback_query) {
    const { id: callbackQueryId, data } = update.callback_query as { id: string; data: string };

    if (typeof data === "string") {
      // ── ATIRAR button (captain mode) ─────────────────────────────────────
      if (data.startsWith("atirar:")) {
        const parts = data.split(":");
        const symbol    = parts[1] ?? "";
        const dir       = parts[2] ?? "L";
        const avgEntry  = parseFloat(parts[3] ?? "0");
        const sl        = parseFloat(parts[4] ?? "0");
        const tp1       = parseFloat(parts[5] ?? "0");
        const tp2       = parseFloat(parts[6] ?? "0");
        const tp3       = parseFloat(parts[7] ?? "0");

        if (!symbol || isNaN(avgEntry) || isNaN(sl) || isNaN(tp1)) {
          logger.warn({ data }, "Webhook: callback_data inválida — ignorando");
          res.json({ ok: true });
          return;
        }

        const direction: "LONG" | "SHORT" = dir === "L" ? "LONG" : "SHORT";
        const trade: TradeData = { symbol, direction, avgEntry, sl, tp1, tp2, tp3 };

        logger.info({ symbol, direction, avgEntry, sl, tp1 }, "Webhook: ATIRAR recebido");
        handleAtirar(trade, callbackQueryId).catch(err =>
          logger.warn({ err: err.message }, "Webhook: handleAtirar error"),
        );
      }

      // ── WARRIOR continue YES/NO ───────────────────────────────────────────
      else if (data.startsWith("warrior_continue:")) {
        const reply = data.split(":")[1] as "YES" | "NO";
        logger.info({ reply }, "Webhook: Warrior continue recebido");
        handleWarriorContinue(reply);

        // Answer the callback so the button spinner disappears
        const token = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        if (token && callbackQueryId) {
          const msg = reply === "YES" ? "✅ Scanner retomado!" : "❌ Operações suspensas por hoje.";
          fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ callback_query_id: callbackQueryId, text: msg }),
            signal:  AbortSignal.timeout(5_000),
          }).catch(() => {});
        }
      }
    }
  }

  res.json({ ok: true });
});

export default router;
