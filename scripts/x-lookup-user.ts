/**
 * Look up X accounts' numeric IDs through the official API, for accounts.yaml.
 *   node scripts/x-lookup-user.ts yourhandle [more handles…]
 * Reads X_BEARER_TOKEN from .env (or the environment) inside this process and prints
 * only public profile fields. The token is never printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { XClient } from "../src/watch/x/client.ts";

const handles = process.argv.slice(2).map((h) => h.replace(/^@/, ""));
if (handles.length === 0) {
  console.error("usage: node scripts/x-lookup-user.ts <handle> [handle…]");
  process.exit(64);
}
const fileVars = existsSync(".env") ? (parseEnv(readFileSync(".env", "utf8")) as Record<string, string>) : {};
const token = (process.env.X_BEARER_TOKEN ?? fileVars.X_BEARER_TOKEN ?? "").trim();
if (!token) {
  console.error("X_BEARER_TOKEN is not set in .env");
  process.exit(1);
}

try {
  const { users, errors } = await new XClient({ bearerToken: token }).lookupUsers(handles);
  for (const u of users) {
    console.log(JSON.stringify({ handle: u.username, user_id: u.id, name: u.name, protected: u.protected ?? false }));
  }
  for (const e of errors) console.log(JSON.stringify({ not_found: e.value, detail: e.detail }));
} catch (err) {
  // XApiError messages hold the status and response body, never the token.
  console.error((err as Error).message.split(token).join("[REDACTED]"));
  process.exit(1);
}
