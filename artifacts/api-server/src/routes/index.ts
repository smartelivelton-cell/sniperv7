import { Router, type IRouter } from "express";
import healthRouter from "./health";
import anthropicRouter from "./anthropic/index";
import tradesRouter from "./trades/index";
import analysisRouter from "./analysis/index";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/anthropic", anthropicRouter);
router.use("/trades", tradesRouter);
router.use("/analysis", analysisRouter);

export default router;
