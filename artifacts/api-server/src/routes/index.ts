import { Router, type IRouter } from "express";
import healthRouter from "./health";
import anthropicRouter from "./anthropic/index";
import tradesRouter from "./trades/index";
import analysisRouter from "./analysis/index";
import monitorRouter from "./monitor/index";
import telegramRouter from "./telegram/index";
import backtestRouter from "./backtest/index";
import winsRouter from "./wins/index";
import webhookRouter from "./webhook/index";
import warriorRouter from "./warrior/index";
import sniperRouter from "./sniper/index";
import { clearScannerCache } from "../lib/scanner";
import { clearTankCache } from "../lib/tankScanner";
import { clearSunTzuCache } from "../lib/sunTzuScanner";
import { forceSyncNow, getClockDriftMs } from "../lib/okxTime";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/anthropic", anthropicRouter);
router.use("/trades", tradesRouter);
router.use("/analysis", analysisRouter);
router.use("/monitor", monitorRouter);
router.use("/telegram", telegramRouter);
router.use("/backtest", backtestRouter);
router.use("/wins", winsRouter);
router.use("/webhook", webhookRouter);
router.use("/warrior", warriorRouter);
router.use("/sniper", sniperRouter);

// ── /reset — Protocolo de Reinicialização Limpa ────────────────────────────────
router.post("/reset", async (_req, res) => {
  try {
    logger.info("Reset: Protocolo de Reinicialização Limpa iniciado");

    // 1. Clear all scanner caches (forces fresh OKX fetch on next cycle)
    clearScannerCache();
    clearTankCache();
    clearSunTzuCache();

    // 2. Re-sync clock with OKX exchange
    await forceSyncNow();
    const driftMs = getClockDriftMs();

    logger.info({ driftMs }, "Reset: Protocolo concluído — caches limpos, relógio sincronizado");

    res.json({
      ok: true,
      message: "Protocolo de Reinicialização Limpa executado com sucesso",
      clearedCaches: ["scanner", "tankScanner", "sunTzuScanner"],
      clockDriftMs: driftMs,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    logger.warn({ err: err.message }, "Reset: erro durante reinicialização");
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
