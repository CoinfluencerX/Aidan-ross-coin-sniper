/**
 * Finds your Telegram chat id, so you can put it in .env as TELEGRAM_OWNER_CHAT_ID.
 *
 *   1. Put TELEGRAM_BOT_TOKEN in .env (from @BotFather).
 *   2. Open your bot in Telegram and send it any message, e.g. "hi".
 *   3. node scripts/telegram-chat-id.ts
 *
 * Reads the token from .env in this process and never prints it.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const token = (existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")).TELEGRAM_BOT_TOKEN : undefined)?.trim();
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN isn't set in .env");
  process.exit(1);
}
const call = async (method: string) => {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { signal: AbortSignal.timeout(10_000) });
    return (await res.json()) as { ok?: boolean; description?: string; result?: unknown };
  } catch {
    return { ok: false, description: "network error" };
  }
};
const me = await call("getMe");
if (!me.ok) {
  console.error(`Telegram rejected the token: ${me.description ?? "unknown error"}`);
  process.exit(1);
}
console.log(`Bot: @${(me.result as { username?: string }).username}`);
const updates = await call("getUpdates");
const chats = new Map<number, string>();
for (const u of (updates.result as { message?: { chat?: { id?: number; username?: string; first_name?: string; type?: string } } }[]) ?? []) {
  const c = u.message?.chat;
  if (c?.id !== undefined) chats.set(c.id, `${c.type ?? "chat"} ${c.username ? "@" + c.username : (c.first_name ?? "")}`.trim());
}
if (chats.size === 0) {
  console.log("No messages yet. Open the bot in Telegram, send it any message, then run this again.");
} else {
  for (const [id, who] of chats) console.log(`TELEGRAM_OWNER_CHAT_ID=${id}    (${who})`);
  console.log("Copy the line for YOUR chat into .env.");
}
