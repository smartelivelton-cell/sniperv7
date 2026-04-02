import { Router } from "express";
import { getTodayWins, getAllWins } from "../../lib/winsLog";

const router = Router();

router.get("/today", (_req, res) => {
  res.json({ wins: getTodayWins() });
});

router.get("/all", (_req, res) => {
  res.json({ wins: getAllWins() });
});

export default router;
