import { Router } from "express";
import { tankWarConfig, getTankWarStatus } from "../../lib/tankWarScanner";
import { logger } from "../../lib/logger";

const router = Router();

// ── GET /api/tankwar/status ───────────────────────────────────────────────────
router.get("/status", (_req, res) => {
  res.json(getTankWarStatus());
});

// ── GET /api/tankwar/config ───────────────────────────────────────────────────
router.get("/config", (_req, res) => {
  res.json({ ...tankWarConfig });
});

// ── PUT /api/tankwar/config ───────────────────────────────────────────────────
router.put("/config", (req, res) => {
  const body = req.body as { autoEnabled?: boolean; banca?: number };
  if (typeof body.autoEnabled === "boolean") tankWarConfig.autoEnabled = body.autoEnabled;
  if (typeof body.banca       === "number")  tankWarConfig.banca       = body.banca;
  logger.info({ tankWarConfig }, "TankWar: configuração atualizada");
  res.json({ ok: true, config: { ...tankWarConfig } });
});

export default router;
