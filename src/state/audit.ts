import type { Redactor } from "../log/redact.ts";
import type { Db } from "./db.ts";

/** Durable record of what the bot saw and decided, used for post-mortems and taxes. Always redacted. */
export function audit(db: Db, redactor: Redactor, kind: string, payload: unknown, now = Date.now()): void {
  db.prepare("INSERT INTO audit_log (at, kind, payload_json) VALUES (?, ?, ?)").run(
    now,
    kind,
    JSON.stringify(redactor.redact(payload) ?? null),
  );
}
