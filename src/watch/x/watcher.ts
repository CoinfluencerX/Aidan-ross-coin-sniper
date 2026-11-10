import type { Mode } from "../../config/mode.ts";
import type { AccountsConfig, ValidatorConfig } from "../../config/schemas.ts";
import type { FetchFn } from "../../extract/expand.ts";
import type { OcrEngine } from "../../extract/ocr.ts";
import type { Logger } from "../../log/logger.ts";
import type { Db } from "../../state/db.ts";
import type { ChainPresence } from "../../evm/locate.ts";
import { processPost } from "../pipeline.ts";
import type { AddressSignal, Assessment, EvmSighting, WatchedAccount, XPath } from "../signal.ts";
import { POST_QUERY, XApiError, type XClient } from "./client.ts";
import { fromActivityEvent, fromFilteredStream, normalizeTweet, type XPost } from "./normalize.ts";
import { runStreamLoop } from "./stream.ts";

export const RULE_TAG = "gta6-sniper";

export class WatchConfigError extends Error {
  override name = "WatchConfigError";
}

/** Every X account to watch. Test accounts are included in dry-run only. */
export function buildWatchList(accounts: AccountsConfig, mode: Mode): WatchedAccount[] {
  const out: WatchedAccount[] = [];
  for (const [person, p] of Object.entries(accounts.people)) {
    for (const a of p.x) out.push({ userId: a.user_id, handle: a.handle, person, tier: a.tier, isTest: false });
  }
  if (mode === "dry-run") {
    for (const a of accounts.test_accounts.x) out.push({ userId: a.user_id, handle: a.handle, person: "test", tier: 1, isTest: true });
  }
  const ids = new Set<string>();
  for (const a of out) {
    if (ids.has(a.userId)) throw new WatchConfigError(`X user_id ${a.userId} (@${a.handle}) is listed twice`);
    ids.add(a.userId);
  }
  return out;
}

/**
 * Re-resolves every handle through the X API and refuses to start if one now points at a
 * different numeric ID (renamed / squatted handle) or no longer exists. IDs stay the source of truth.
 */
export async function verifyWatchList(client: XClient, list: readonly WatchedAccount[], log: Logger): Promise<void> {
  const { users, errors } = await client.lookupUsers(list.map((a) => a.handle));
  const byHandle = new Map(users.map((u) => [u.username.toLowerCase(), u]));
  const problems: string[] = [];
  for (const a of list) {
    const u = byHandle.get(a.handle.toLowerCase());
    if (!u) problems.push(`@${a.handle} was not found on X`);
    else if (u.id !== a.userId) problems.push(`@${a.handle} now resolves to id ${u.id}, config says ${a.userId}`);
    else if (u.protected) log.warn("x.account.protected", { handle: a.handle, note: "protected accounts' posts are not delivered" });
  }
  if (problems.length) throw new WatchConfigError(`accounts.yaml doesn't match X: ${problems.join("; ")}`);
  if (errors.length) log.warn("x.lookup.partial_errors", { errors });
  log.info("x.accounts.verified", { count: list.length, handles: list.map((a) => a.handle) });
}

/**
 * Creates post.create subscriptions for any watched ID that doesn't have one, and removes OUR
 * subscriptions (tagged "gta6-sniper:…") for accounts that are no longer watched. That's what
 * drops the dry-run test account when the bot is started in live mode: X bills per delivered
 * post, so a leftover subscription would cost money for posts the bot ignores. Safe to re-run.
 */
export async function ensureActivitySubscriptions(client: XClient, list: readonly WatchedAccount[], log: Logger) {
  const existing = await client.listActivitySubscriptions();
  const watched = new Set(list.map((a) => a.userId));
  const removed: string[] = [];
  for (const s of existing) {
    if (!s.tag?.startsWith(`${RULE_TAG}:`) || !s.filter.user_id || watched.has(s.filter.user_id)) continue;
    try {
      await client.deleteActivitySubscription(s.subscription_id);
      removed.push(s.tag.slice(RULE_TAG.length + 1));
    } catch (err) {
      log.warn("x.activity.unsubscribe_failed", { tag: s.tag, error: (err as Error).message });
    }
  }
  const have = new Set(existing.filter((s) => s.event_type === "post.create").map((s) => s.filter.user_id));
  const created: string[] = [];
  for (const a of list) {
    if (have.has(a.userId)) continue;
    try {
      await client.createActivitySubscription(a.userId, `${RULE_TAG}:${a.handle}`);
      created.push(a.handle);
    } catch (err) {
      // A concurrent create can race us into DuplicateSubscription. That's fine.
      if (err instanceof XApiError && /duplicate/i.test(err.body)) continue;
      throw err;
    }
  }
  log.info("x.activity.subscriptions", { existing: have.size, created, removed });
  return { created, removed };
}

export function streamRuleValue(list: readonly WatchedAccount[]): string {
  return list.map((a) => `from:${a.userId}`).join(" OR ");
}

/** Keeps exactly one Filtered Stream rule with our tag, matching the current watch list. */
export async function ensureStreamRule(client: XClient, list: readonly WatchedAccount[], log: Logger) {
  const value = streamRuleValue(list);
  const rules = await client.getStreamRules();
  const ours = rules.filter((r) => r.tag === RULE_TAG);
  if (ours.length === 1 && ours[0]!.value === value) {
    log.info("x.filtered_stream.rule", { status: "unchanged", value });
    return;
  }
  await client.deleteStreamRules(ours.map((r) => r.id));
  await client.addStreamRule(value, RULE_TAG);
  log.info("x.filtered_stream.rule", { status: ours.length ? "replaced" : "created", value });
}

export interface XWatcherOptions {
  client: XClient;
  accounts: AccountsConfig;
  validator: ValidatorConfig;
  watchList: readonly WatchedAccount[];
  db: Db;
  log: Logger;
  mode: Mode;
  ocr?: OcrEngine | undefined;
  fetch?: FetchFn | undefined;
  onSignal: (s: AddressSignal, a: Assessment, signalId: number) => void;
  /** Ethereum-style 0x address in an official post: alert only, never bought. */
  onEvm?: ((s: EvmSighting, a: Assessment) => void) | undefined;
  locateEvm?: ((address: string) => Promise<ChainPresence[]>) | undefined;
  paths?: readonly XPath[];
  stallMs?: number;
}

export class XWatcher {
  readonly #o: XWatcherOptions;
  readonly #byId: Map<string, WatchedAccount>;
  readonly #seenPosts = new Set<string>();
  readonly #pending = new Set<Promise<void>>();
  stats = { events: 0, posts: 0, ignoredAuthors: 0, duplicates: 0, signals: 0, evm: 0 };

  constructor(o: XWatcherOptions) {
    this.#o = o;
    this.#byId = new Map(o.watchList.map((a) => [a.userId, a]));
  }

  /** Runs every enabled path until `signal` aborts or every path fails for good. Returns the paths that failed. */
  async run(signal: AbortSignal): Promise<{ failedPaths: XPath[] }> {
    const paths = this.#o.paths ?? (["activity", "filtered_stream"] as const);
    const failed: XPath[] = [];
    const allFailed = new AbortController();
    const inner = AbortSignal.any([signal, allFailed.signal]);
    const loop = (path: XPath) =>
      runStreamLoop({
        name: path,
        signal: inner,
        log: this.#o.log,
        ...(this.#o.stallMs !== undefined ? { stallMs: this.#o.stallMs } : {}),
        open: (s) =>
          path === "activity"
            ? this.#o.client.openStream("/2/activity/stream", {}, s)
            : this.#o.client.openStream("/2/tweets/search/stream", POST_QUERY, s),
        onMessage: (msg, at) => this.#onMessage(path, msg, at),
        onFatal: () => {
          failed.push(path);
          if (failed.length === paths.length) allFailed.abort();
        },
      });
    await Promise.all(paths.map(loop));
    await this.drain();
    return { failedPaths: failed };
  }

  /** Waits for posts still being processed (OCR, link expansion). */
  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.all([...this.#pending]);
  }

  #onMessage(path: XPath, msg: unknown, receivedAt: number): void {
    this.stats.events++;
    let post: XPost | null;
    if (path === "activity") {
      const e = fromActivityEvent(msg);
      post = e.post;
      if (!post) {
        this.#o.log.debug("x.activity.event_skipped", { event_type: e.eventType });
        return;
      }
    } else {
      post = fromFilteredStream(msg);
      if (!post) return;
    }
    const p = this.handlePost(post, path, receivedAt).then(
      () => undefined,
      (err) => this.#o.log.error("x.post.failed", { post_id: post.id, error: err }),
    );
    this.#pending.add(p);
    void p.finally(() => this.#pending.delete(p));
  }

  /** Core path for one post from either stream. Public for tests. */
  async handlePost(post: XPost, path: XPath, receivedAt: number): Promise<AddressSignal[]> {
    const { log, accounts, db } = this.#o;
    const account = this.#byId.get(post.authorId);
    if (!account) {
      // The one rule: only allowlisted numeric IDs. Never a handle or display name.
      this.stats.ignoredAuthors++;
      log.info("x.post.ignored_author", { path, post_id: post.id, author_id: post.authorId });
      return [];
    }
    if (this.#seenPosts.has(post.id)) {
      this.stats.duplicates++;
      log.debug("x.post.duplicate", { path, post_id: post.id });
      return [];
    }
    this.#seenPosts.add(post.id);
    this.stats.posts++;

    let full = post;
    if (post.mediaMissing) {
      try {
        const r = await this.#o.client.getPost(post.id);
        if (r.data) full = normalizeTweet(r.data, r.includes) ?? post;
      } catch (err) {
        log.warn("x.post.hydrate_failed", { post_id: post.id, error: (err as Error).message });
      }
    }

    // The streams don't always say what a post refers to. Text that starts "RT @name:" is a repost
    // of someone else's words, whatever the payload claims: look it up, and if that fails treat it
    // as a repost of an unknown author (which the validator blocks).
    if (full.kind === "original" && /^RT @\w{1,15}:/.test(full.content.text)) {
      let looked: XPost | null = null;
      try {
        const r = await this.#o.client.getPost(post.id);
        looked = r.data ? normalizeTweet(r.data, r.includes) : null;
      } catch (err) {
        log.warn("x.post.hydrate_failed", { post_id: post.id, error: (err as Error).message });
      }
      full = looked && looked.kind !== "original" ? looked : { ...full, kind: "repost", referenced: [] };
    }

    const result = await processPost(
      {
        source: "x",
        path,
        id: post.id,
        url: `https://x.com/${account.handle}/status/${post.id}`,
        account,
        kind: full.kind,
        // A reply, quote or repost only counts when the post it points at is by a TIER-1 account.
        // A tier-2 account must never be able to trigger a buy, not even through a tier-1 repost of it.
        referencesWatchedAuthor: full.referenced.length > 0 && full.referenced.every((r) => r.authorId !== undefined && this.#byId.get(r.authorId)?.tier === 1),
        createdAt: full.createdAt,
        content: full.content,
      },
      receivedAt,
      {
        accounts,
        validator: this.#o.validator,
        db,
        log,
        ocr: this.#o.ocr,
        fetch: this.#o.fetch,
        onSignal: this.#o.onSignal,
        onEvm: this.#o.onEvm,
        locateEvm: this.#o.locateEvm,
      },
    );
    this.stats.signals += result.newSignals;
    this.stats.evm += result.evm.length;
    return result.signals;
  }
}
