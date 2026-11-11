import type { FetchFn } from "../extract/expand.ts";
import type { Logger } from "../log/logger.ts";

/**
 * Telegram: alerts out, a few commands in. Your own bot, talking only to your own chat.
 *
 * - Commands are accepted from ONE chat id (TELEGRAM_OWNER_CHAT_ID). Anyone else is ignored and logged,
 *   including everyone in the alert chats, which only ever receive.
 * - Commands sent while the bot was offline are discarded at startup, so an old /sell can't fire on restart.
 * - Telegram can never trigger a buy. It can only stop buying, sell, or report.
 * - The bot token is part of the API URL, so no error or log line here ever includes the URL.
 */

const API = "https://api.telegram.org";

export interface TelegramCommand {
  name: string;
  args: string[];
}

export function parseCommand(text: string): TelegramCommand | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const [head, ...args] = t.split(/\s+/);
  const name = head!.slice(1).split("@")[0]!.toLowerCase();
  return name ? { name, args } : null;
}

interface Update {
  update_id: number;
  message?: { chat?: { id?: number }; text?: string; date?: number };
}

export class Telegram {
  readonly #token: string;
  readonly #owner: string;
  readonly #alertChats: string[];
  readonly #fetch: FetchFn;
  readonly #log: Logger;
  readonly #sleep: (ms: number) => Promise<void>;
  #offset: number | undefined;
  stats = { sent: 0, sendFailures: 0, commands: 0, ignored: 0, broadcast: 0, broadcastFailures: 0 };

  constructor(o: { token: string; ownerChatId: string; alertChatIds?: string[]; log: Logger; fetch?: FetchFn; sleep?: (ms: number) => Promise<void> }) {
    this.#token = o.token;
    this.#owner = o.ownerChatId.trim();
    // The owner already gets the full alert, so the owner's chat is never also an alert chat.
    this.#alertChats = [...new Set((o.alertChatIds ?? []).map((id) => id.trim()))].filter((id) => id && id !== this.#owner);
    this.#fetch = o.fetch ?? fetch;
    this.#log = o.log;
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async #call<T>(method: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.#fetch(`${API}/bot${this.#token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`Telegram ${method}: ${(err as Error).name === "TimeoutError" ? "timed out" : "network error"}`);
    }
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !json.ok) throw new Error(`Telegram ${method}: HTTP ${res.status}${json.description ? ` ${json.description}` : ""}`);
    return json.result as T;
  }

  /** Sends a plain-text message to the owner. Never throws: an alert that fails to send must not stop a trade. */
  async send(text: string): Promise<boolean> {
    const safe = this.#log.redactor.redactString(text).slice(0, 4000);
    try {
      await this.#call("sendMessage", { chat_id: this.#owner, text: safe, disable_web_page_preview: true }, 8_000);
      this.stats.sent++;
      return true;
    } catch (err) {
      this.stats.sendFailures++;
      this.#log.warn("telegram.send_failed", { error: (err as Error).message });
      return false;
    }
  }

  get alertChatCount(): number {
    return this.#alertChats.length;
  }

  /**
   * Sends a public alert to every extra chat (TELEGRAM_ALERT_CHAT_IDS), all at once. Returns how
   * many got it. Never throws, and one chat failing doesn't stop the others. The owner's chat is
   * not included: use send() for that.
   */
  async broadcast(text: string): Promise<number> {
    if (this.#alertChats.length === 0) return 0;
    const safe = this.#log.redactor.redactString(text).slice(0, 4000);
    const results = await Promise.all(
      this.#alertChats.map(async (chat_id) => {
        try {
          await this.#call("sendMessage", { chat_id, text: safe, disable_web_page_preview: true }, 8_000);
          return true;
        } catch (err) {
          this.#log.warn("telegram.broadcast_failed", { chat_id, error: (err as Error).message });
          return false;
        }
      }),
    );
    const ok = results.filter(Boolean).length;
    this.stats.broadcast += ok;
    this.stats.broadcastFailures += results.length - ok;
    return ok;
  }

  /** Checks the token works. Returns the bot's username. */
  async whoAmI(): Promise<string> {
    return (await this.#call<{ username?: string }>("getMe", {}, 8_000)).username ?? "(unnamed bot)";
  }

  /** Drops everything sent before now, so only commands sent while we're running count. */
  async discardBacklog(): Promise<void> {
    const pending = await this.#call<Update[]>("getUpdates", { offset: -1, timeout: 0 }, 8_000);
    const last = pending.at(-1);
    this.#offset = last ? last.update_id + 1 : undefined;
  }

  /** Long-polls for commands until `signal` aborts. Handler errors are logged and replied, never thrown. */
  async listen(signal: AbortSignal, onCommand: (cmd: TelegramCommand) => Promise<string> | string): Promise<void> {
    while (!signal.aborted) {
      let updates: Update[];
      try {
        updates = await this.#call<Update[]>("getUpdates", { timeout: 25, allowed_updates: ["message"], ...(this.#offset !== undefined ? { offset: this.#offset } : {}) }, 32_000, signal);
      } catch (err) {
        if (signal.aborted) return;
        this.#log.warn("telegram.poll_failed", { error: (err as Error).message });
        await this.#sleep(3_000);
        continue;
      }
      for (const u of updates) {
        this.#offset = u.update_id + 1;
        const chatId = u.message?.chat?.id;
        const text = u.message?.text;
        if (chatId === undefined || text === undefined) continue;
        if (String(chatId) !== this.#owner) {
          this.stats.ignored++;
          this.#log.warn("telegram.ignored_sender", { chat_id: chatId, note: "not the owner chat: command ignored" });
          continue;
        }
        const cmd = parseCommand(text);
        if (!cmd) continue;
        this.stats.commands++;
        this.#log.info("telegram.command", { command: cmd.name, args: cmd.args });
        let reply: string;
        try {
          reply = await onCommand(cmd);
        } catch (err) {
          reply = `That command failed: ${(err as Error).message}`;
        }
        await this.send(reply);
      }
    }
  }
}
