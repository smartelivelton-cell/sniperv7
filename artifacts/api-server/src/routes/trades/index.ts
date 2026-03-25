import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { tradesTable } from "@workspace/db";
import { CreateTradeBody, ListTradesQueryParams } from "@workspace/api-zod";
import { eq, sql, and, gte, lt, sum, count } from "drizzle-orm";

const router: IRouter = Router();

router.get("/", async (req, res) => {
  const query = ListTradesQueryParams.parse(req.query);
  
  let trades;
  if (query.date) {
    const startOfDay = new Date(query.date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(query.date);
    endOfDay.setHours(23, 59, 59, 999);
    
    trades = await db
      .select()
      .from(tradesTable)
      .where(
        and(
          gte(tradesTable.createdAt, startOfDay),
          lt(tradesTable.createdAt, endOfDay)
        )
      )
      .orderBy(tradesTable.createdAt);
  } else {
    trades = await db
      .select()
      .from(tradesTable)
      .orderBy(tradesTable.createdAt);
  }

  const mapped = trades.map((t) => ({
    ...t,
    entryPrice: parseFloat(t.entryPrice),
    exitPrice: t.exitPrice ? parseFloat(t.exitPrice) : null,
    size: parseFloat(t.size),
    leverage: parseFloat(t.leverage),
    pnl: parseFloat(t.pnl),
  }));

  res.json(mapped);
});

router.post("/", async (req, res) => {
  const body = CreateTradeBody.parse(req.body);
  
  const [trade] = await db
    .insert(tradesTable)
    .values({
      symbol: body.symbol,
      direction: body.direction,
      entryPrice: String(body.entryPrice),
      exitPrice: body.exitPrice !== undefined ? String(body.exitPrice) : null,
      size: String(body.size),
      leverage: String(body.leverage),
      pnl: String(body.pnl),
      result: body.result,
      notes: body.notes ?? null,
    })
    .returning();

  res.status(201).json({
    ...trade,
    entryPrice: parseFloat(trade.entryPrice),
    exitPrice: trade.exitPrice ? parseFloat(trade.exitPrice) : null,
    size: parseFloat(trade.size),
    leverage: parseFloat(trade.leverage),
    pnl: parseFloat(trade.pnl),
  });
});

router.get("/daily-pnl", async (req, res) => {
  const dateStr = (req.query.date as string) || new Date().toISOString().split("T")[0];
  
  const startOfDay = new Date(dateStr);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(dateStr);
  endOfDay.setHours(23, 59, 59, 999);

  const trades = await db
    .select()
    .from(tradesTable)
    .where(
      and(
        gte(tradesTable.createdAt, startOfDay),
        lt(tradesTable.createdAt, endOfDay)
      )
    );

  const totalPnl = trades.reduce((sum, t) => sum + parseFloat(t.pnl), 0);
  const winCount = trades.filter((t) => t.result === "win").length;
  const lossCount = trades.filter((t) => t.result === "loss").length;

  res.json({
    date: dateStr,
    totalPnl,
    tradeCount: trades.length,
    winCount,
    lossCount,
  });
});

export default router;
