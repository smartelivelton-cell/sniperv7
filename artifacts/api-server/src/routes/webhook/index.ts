import { Router } from "express";
import { handleAtirar, type TradeData } from "../../lib/captainMode";
import { logger } from "../../lib/logger";

const router = Router();

/**
 * POST /api/webhook/telegram
 * Receives callback_query updates from Telegram when the captain clicks ATIRAR.
 * callback_data format: atirar:SYM:L|S:avgEntry:sl:tp1:tp2:tp3
 * All trade data is embedded in the button — no server memory lookup needed.
 */
router.post("/telegram", async (req, res) => {
  const update = req.body;

  if (update?.callback_query) {
    const { id: callbackQueryId, data } = update.callback_query as { id: string; data: string };

    if (typeof data === "string" && data.startsWith("atirar:")) {
      const parts = data.split(":");
      // parts: [0]=atirar [1]=SYM [2]=L|S [3]=entry [4]=sl [5]=tp1 [6]=tp2 [7]=tp3
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

      // Run async so we respond to Telegram within their 5-second deadline
      handleAtirar(trade, callbackQueryId).catch(err =>
        logger.warn({ err: err.message }, "Webhook: handleAtirar error"),
      );
    }
  }

  res.json({ ok: true });
});

export default router;
