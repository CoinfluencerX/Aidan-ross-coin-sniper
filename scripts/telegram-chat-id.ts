/**
 * Finds your Telegram chat id, so you can put it in .env as TELEGRAM_OWNER_CHAT_ID.
 *
 *   1. Put TELEGRAM_BOT_TOKEN in .env (from @BotFather).
 *   2. Open your bot in Telegram and send it any message, e.g. "hi".
 *   3. node scripts/telegram-chat-id.ts
 *
 * It also lists any group or channel the bot has been added to, for TELEGRAM_ALERT_CHAT_IDS.
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
// Ask for group and channel events too: being added to a group arrives as "my_chat_member".
const updates = await call(`getUpdates?allowed_updates=${encodeURIComponent(JSON.stringify(["message", "my_chat_member", "channel_post"]))}`);
type Chat = { id?: number; username?: string; first_name?: string; title?: string; type?: string };
const chats = new Map<number, Chat>();
for (const u of (updates.result as { message?: { chat?: Chat }; my_chat_member?: { chat?: Chat }; channel_post?: { chat?: Chat } }[]) ?? []) {
  const c = u.message?.chat ?? u.my_chat_member?.chat ?? u.channel_post?.chat;
  if (c?.id !== undefined) chats.set(c.id, c);
}
if (chats.size === 0) {
  console.log("No messages yet. Open the bot in Telegram, send it any message, then run this again.");
  console.log("For a friends' group: add the bot to the group, send any message there, then run this again.");
} else {
  for (const [id, c] of chats) {
    if (c.type === "private" || c.type === undefined) console.log(`TELEGRAM_OWNER_CHAT_ID=${id}    (your private chat: ${c.username ? "@" + c.username : (c.first_name ?? "")})`);
    else console.log(`TELEGRAM_ALERT_CHAT_IDS=${id}    (${c.type} "${c.title ?? ""}": gets coin alerts only)`);
  }
  console.log("Copy the line you need into .env. Your own chat is the OWNER one; a friends' group is an ALERT one.");
}
