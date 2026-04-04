import { Router } from "express";
import { handleAtirar } from "../../lib/captainMode";
import { logger } from "../../lib/logger";

const router = Router();

router.post("/telegram", async (req, res) => {
  const update = req.body;

  if (update?.callback_query) {
    const { id: callbackQueryId, data } = update.callback_query as { id: string; data: string };

    if (typeof data === "string" && data.startsWith("atirar:")) {
      const parts = data.split(":");
      const symbol    = parts[1] ?? "";
      const direction = (parts[2] ?? "LONG") as "LONG" | "SHORT";

      if (!symbol) {
        logger.warn({ data }, "Webhook: callback_data mal formada — ignorando");
        res.json({ ok: true });
        return;
      }

      logger.info({ symbol, direction }, "Webhook: ATIRAR recebido");

      // Run async so we can respond to Telegram immediately (5s deadline)
      handleAtirar(symbol, direction, callbackQueryId).catch(err =>
        logger.warn({ err: err.message }, "Webhook: handleAtirar error"),
      );
    }
  }

  res.json({ ok: true });
});

export default router;
