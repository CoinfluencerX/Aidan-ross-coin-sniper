import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createRedactor } from "../src/log/redact.ts";
import { audit } from "../src/state/audit.ts";
import { migrate, openDb, SCHEMA_VERSION } from "../src/state/db.ts";
import { acquireBuyLock, setPositionStatus } from "../src/state/positions.ts";
import { tempDir } from "./helpers.ts";

const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "Ce8nnx1XqLBEE6ChG44xEwcSsK6PS2uv4NX9B7bYpump";

describe("openDb / migrate", () => {
  it("creates the schema and records its version", () => {
    const db = openDb(":memory:");
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(["audit_log", "decisions", "positions", "signals", "trades"]);
  });

  it("is idempotent", () => {
    const db = openDb(":memory:");
    expect(() => migrate(db)).not.toThrow();
  });

  it("refuses a database written by newer code", () => {
    const path = join(tempDir(), "future.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openDb(path)).toThrow(/newer than this code/);
  });
});

describe("acquireBuyLock (one-shot)", () => {
  it("locks a mint once; a duplicate signal can't buy again", () => {
    const db = openDb(":memory:");
    expect(acquireBuyLock(db, { mint: MINT_A, maxOpenPositions: 5 })).toMatchObject({ acquired: true });
    expect(acquireBuyLock(db, { mint: MINT_A, maxOpenPositions: 5 })).toEqual({ acquired: false, reason: "mint_already_locked" });
  });

  it("survives a restart (the lock is on disk before any send)", () => {
    const path = join(tempDir(), "dry-run.sqlite");
    const first = openDb(path);
    expect(acquireBuyLock(first, { mint: MINT_A, maxOpenPositions: 5 }).acquired).toBe(true);
    first.close();
    const second = openDb(path);
    expect(acquireBuyLock(second, { mint: MINT_A, maxOpenPositions: 5 })).toEqual({ acquired: false, reason: "mint_already_locked" });
  });

  it("never retries a failed mint automatically (a 'failed' send may have landed)", () => {
    const db = openDb(":memory:");
    const lock = acquireBuyLock(db, { mint: MINT_A, maxOpenPositions: 5 });
    if (!lock.acquired) throw new Error("expected lock");
    setPositionStatus(db, lock.positionId, "failed");
    expect(acquireBuyLock(db, { mint: MINT_A, maxOpenPositions: 5 })).toEqual({ acquired: false, reason: "mint_already_locked" });
  });

  it("enforces max open positions across mints, and frees the slot when one closes", () => {
    const db = openDb(":memory:");
    const a = acquireBuyLock(db, { mint: MINT_A, maxOpenPositions: 1 });
    if (!a.acquired) throw new Error("expected lock");
    expect(acquireBuyLock(db, { mint: MINT_B, maxOpenPositions: 1 })).toEqual({ acquired: false, reason: "max_open_positions" });
    setPositionStatus(db, a.positionId, "closed");
    expect(acquireBuyLock(db, { mint: MINT_B, maxOpenPositions: 1 }).acquired).toBe(true);
  });

  it("leaves no transaction open after a refusal", () => {
    const db = openDb(":memory:");
    acquireBuyLock(db, { mint: MINT_A, maxOpenPositions: 1 });
    acquireBuyLock(db, { mint: MINT_A, maxOpenPositions: 1 });
    expect(() => db.exec("BEGIN IMMEDIATE; COMMIT;")).not.toThrow();
  });
});

describe("audit", () => {
  it("stores redacted payloads", () => {
    const db = openDb(":memory:");
    audit(db, createRedactor(["SUPERSECRETVALUE123"]), "boot", { url: "https://x/SUPERSECRETVALUE123", privateKey: "k" }, 1);
    const row = db.prepare("SELECT at, kind, payload_json FROM audit_log").get() as { at: number; kind: string; payload_json: string };
    expect(row.kind).toBe("boot");
    expect(row.payload_json).not.toContain("SUPERSECRETVALUE123");
    expect(JSON.parse(row.payload_json)).toEqual({ url: "https://x/[REDACTED]", privateKey: "[REDACTED]" });
  });
});
