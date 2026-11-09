import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Append-only list of migrations. Never edit a shipped entry. Add a new one.
 * PRAGMA user_version tracks how many have run.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE signals (
    id           INTEGER PRIMARY KEY,
    source       TEXT    NOT NULL,           -- x | kick | twitch | ...
    account_id   TEXT    NOT NULL,           -- numeric platform ID of the author
    post_id      TEXT    NOT NULL,
    mint         TEXT    NOT NULL,
    received_at  INTEGER NOT NULL,           -- unix ms
    raw_json     TEXT,                       -- redacted
    UNIQUE (source, post_id, mint)
  );

  CREATE TABLE decisions (
    id          INTEGER PRIMARY KEY,
    signal_id   INTEGER NOT NULL REFERENCES signals(id),
    check_id    TEXT    NOT NULL,
    result      TEXT    NOT NULL CHECK (result IN ('pass', 'warn', 'block', 'off')),
    detail      TEXT,
    created_at  INTEGER NOT NULL
  );

  -- One row per mint, ever. The row is written BEFORE any transaction is sent,
  -- so a restart or a duplicate signal can't buy the same coin twice.
  CREATE TABLE positions (
    id          INTEGER PRIMARY KEY,
    mint        TEXT    NOT NULL UNIQUE,
    status      TEXT    NOT NULL CHECK (status IN ('pending', 'open', 'closing', 'closed', 'failed')),
    signal_id   INTEGER REFERENCES signals(id),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE trades (
    id            INTEGER PRIMARY KEY,
    position_id   INTEGER NOT NULL REFERENCES positions(id),
    side          TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
    signature     TEXT    UNIQUE,
    lamports      INTEGER,
    token_amount  TEXT,                     -- raw u64 as string
    status        TEXT    NOT NULL CHECK (status IN ('simulated', 'sent', 'confirmed', 'failed')),
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE audit_log (
    id            INTEGER PRIMARY KEY,
    at            INTEGER NOT NULL,
    kind          TEXT    NOT NULL,
    payload_json  TEXT    NOT NULL           -- redacted
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function userVersion(db: Db): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

export function migrate(db: Db): void {
  const current = userVersion(db);
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema v${current} is newer than this code (v${MIGRATIONS.length}). Refusing to run.`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Opens (creating if needed) the SQLite file and brings the schema up to date. Pass ":memory:" in tests. */
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}
