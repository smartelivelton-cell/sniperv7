import { logger } from "./logger";

const OKX_TIME_URL = "https://www.okx.com/api/v5/public/time";
const SYNC_INTERVAL_MS   = 5 * 60 * 1000;  // re-sync every 5 minutes
const WARN_DRIFT_MS      = 2_000;           // warn if local clock drifts > 2s from OKX

let _driftMs        = 0;   // local - OKX (positive = local is ahead)
let _lastSyncMs     = 0;
let _syncTimer: ReturnType<typeof setInterval> | null = null;

/** Milliseconds that local clock is ahead of OKX exchange clock. */
export function getClockDriftMs(): number {
  return _driftMs;
}

async function syncOnce(): Promise<void> {
  try {
    const t0  = Date.now();
    const res = await fetch(OKX_TIME_URL, { signal: AbortSignal.timeout(5_000) });
    const t1  = Date.now();
    if (!res.ok) {
      logger.warn({ status: res.status }, "OKXTime: sync HTTP error — skipping");
      return;
    }
    const json = await res.json() as { code: string; data: Array<{ ts: string }> };
    if (json.code !== "0" || !json.data?.[0]?.ts) {
      logger.warn({ json }, "OKXTime: unexpected response format");
      return;
    }
    const okxTs   = parseInt(json.data[0].ts, 10); // OKX timestamp in ms
    const localTs = Math.round((t0 + t1) / 2);     // midpoint of the round-trip
    _driftMs      = localTs - okxTs;
    _lastSyncMs   = Date.now();

    if (Math.abs(_driftMs) > WARN_DRIFT_MS) {
      logger.warn(
        { driftMs: _driftMs, localTs, okxTs },
        `OKXTime: ⚠️ clock drift ${_driftMs > 0 ? "+" : ""}${_driftMs}ms — risco de erro de Timestamp!`,
      );
    } else {
      logger.info({ driftMs: _driftMs }, "OKXTime: sync OK — relógio sincronizado com a Exchange");
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "OKXTime: sync failed — verifique a conexão com OKX");
  }
}

/** Start periodic OKX clock sync. Safe to call multiple times (idempotent). */
export function startOKXTimeSync(): void {
  if (_syncTimer) return;
  logger.info({ intervalMinutes: SYNC_INTERVAL_MS / 60_000 }, "OKXTime: iniciando sincronização de relógio com OKX");
  syncOnce(); // run immediately on startup
  _syncTimer = setInterval(syncOnce, SYNC_INTERVAL_MS);
}

/** Force an immediate re-sync and clear cached drift. */
export async function forceSyncNow(): Promise<void> {
  _driftMs    = 0;
  _lastSyncMs = 0;
  await syncOnce();
}
