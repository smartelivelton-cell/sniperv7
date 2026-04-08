import { Router } from "express";
import { sniperConfig, getSniperStatus } from "../../lib/sniperConfluencia";
import { logger } from "../../lib/logger";

const router = Router();

// ── GET /api/sniper/status ────────────────────────────────────────────────────
router.get("/status", (_req, res) => {
  res.json(getSniperStatus());
});

// ── GET /api/sniper/config ────────────────────────────────────────────────────
router.get("/config", (_req, res) => {
  res.json({ ...sniperConfig });
});

// ── PUT /api/sniper/config ────────────────────────────────────────────────────
router.put("/config", (req, res) => {
  const body = req.body as { autoEnabled?: boolean };
  if (typeof body.autoEnabled === "boolean") {
    sniperConfig.autoEnabled = body.autoEnabled;
    logger.info({ sniperConfig }, "Sniper: configuração atualizada");
  }
  res.json({ ok: true, config: { ...sniperConfig } });
});

export default router;
