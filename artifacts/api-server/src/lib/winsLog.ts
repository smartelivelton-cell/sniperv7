import fs from "fs";
import path from "path";
import { logger } from "./logger";

const WINS_FILE = path.join(process.cwd(), "historico_wins.json");

export interface WinEntry {
  id: string;
  symbol: string;
  strategy: string;
  direction: "LONG" | "SHORT";
  tpLevel: 1 | 2 | 3;
  profitPct: number;
  leverage: number;
  avgEntry: number;
  tpPrice: number;
  timestamp: string;
  timestampBR: string;
  dateBR: string;
}

// Last-valid-cache: returned when the JSON file is missing, empty, or truncated.
let _lastValidCache: WinEntry[] = [];

function readWins(): WinEntry[] {
  try {
    const raw = fs.readFileSync(WINS_FILE, "utf8");
    if (!raw || raw.trim() === "") {
      logger.warn("winsLog: historico_wins.json está vazio — retornando último cache válido");
      return _lastValidCache;
    }
    const parsed = JSON.parse(raw) as WinEntry[];
    _lastValidCache = parsed; // update cache on every successful read
    return parsed;
  } catch (err: any) {
    logger.warn(
      { err: err.message, file: WINS_FILE },
      "winsLog: falha ao carregar JSON (Unexpected end of input?) — retornando último cache válido",
    );
    return _lastValidCache;
  }
}

function writeWins(entries: WinEntry[]): void {
  try {
    fs.writeFileSync(WINS_FILE, JSON.stringify(entries, null, 2), "utf8");
  } catch (err: any) {
    logger.warn({ err: err.message }, "winsLog: failed to write file");
  }
}

export function logWin(
  entry: Omit<WinEntry, "id" | "timestamp" | "timestampBR" | "dateBR">,
): void {
  const wins = readWins();
  const now = new Date();
  const timestampBR = now.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const dateBR = now.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const newEntry: WinEntry = {
    ...entry,
    id: `${entry.symbol}-tp${entry.tpLevel}-${now.getTime()}`,
    timestamp: now.toISOString(),
    timestampBR,
    dateBR,
  };
  wins.push(newEntry);
  writeWins(wins);
  logger.info(
    { symbol: entry.symbol, tp: entry.tpLevel, pct: entry.profitPct.toFixed(2) },
    "winsLog: WIN registered",
  );
}

export function getTodayWins(): WinEntry[] {
  const wins = readWins();
  const todayBR = new Date().toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return wins.filter((w) => w.dateBR === todayBR);
}

export function getAllWins(): WinEntry[] {
  return readWins();
}
