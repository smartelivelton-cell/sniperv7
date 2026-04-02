import { Router, type IRouter } from "express";
import healthRouter from "./health";
import anthropicRouter from "./anthropic/index";
import tradesRouter from "./trades/index";
import analysisRouter from "./analysis/index";
import monitorRouter from "./monitor/index";
import telegramRouter from "./telegram/index";
import backtestRouter from "./backtest/index";
import winsRouter from "./wins/index";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/anthropic", anthropicRouter);
router.use("/trades", tradesRouter);
router.use("/analysis", analysisRouter);
router.use("/monitor", monitorRouter);
router.use("/telegram", telegramRouter);
router.use("/backtest", backtestRouter);
router.use("/wins", winsRouter);

export default router;
