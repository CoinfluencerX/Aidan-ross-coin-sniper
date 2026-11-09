import type { Db } from "./db.ts";

export type LockResult =
  | { acquired: true; positionId: number }
  | { acquired: false; reason: "mint_already_locked" | "max_open_positions" };

export interface LockRequest {
  mint: string;
  maxOpenPositions: number;
  signalId?: number;
  now?: number;
}

/**
 * The one-shot buy lock. Call it BEFORE building or sending any buy.
 * - A mint can be locked once, ever, in this database (even if the attempt failed:
 *   a "failed" send may still have landed, so an automatic retry could double-buy).
 * - It also refuses while `maxOpenPositions` positions are still pending/open/closing.
 * Runs in a write transaction, so two signals racing for the same mint can't both win.
 */
export function acquireBuyLock(db: Db, req: LockRequest): LockResult {
  const now = req.now ?? Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT id FROM positions WHERE mint = ?").get(req.mint);
    if (existing) {
      db.exec("ROLLBACK");
      return { acquired: false, reason: "mint_already_locked" };
    }
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM positions WHERE status IN ('pending', 'open', 'closing')")
      .get() as { n: number };
    if (n >= req.maxOpenPositions) {
      db.exec("ROLLBACK");
      return { acquired: false, reason: "max_open_positions" };
    }
    const result = db
      .prepare(
        "INSERT INTO positions (mint, status, signal_id, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?)",
      )
      .run(req.mint, req.signalId ?? null, now, now);
    db.exec("COMMIT");
    return { acquired: true, positionId: Number(result.lastInsertRowid) };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export type PositionStatus = "pending" | "open" | "closing" | "closed" | "failed";

export function setPositionStatus(db: Db, positionId: number, status: PositionStatus, now = Date.now()): void {
  db.prepare("UPDATE positions SET status = ?, updated_at = ? WHERE id = ?").run(status, now, positionId);
}
