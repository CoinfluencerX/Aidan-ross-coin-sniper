import type { AppEnv } from "../config/env.ts";
import type { AccountsConfig } from "../config/schemas.ts";
import type { FetchFn } from "../extract/expand.ts";
import type { Logger } from "../log/logger.ts";
import { buildKickWatchList, ensureKickSubscriptions, KickClient, KickWatcher, verifyKickWatchList } from "../watch/kick.ts";
import type { PipelineDeps } from "../watch/pipeline.ts";
import { buildTwitchWatchList, ensureTwitchSubscriptions, TwitchClient, TwitchWatcher, verifyTwitchWatchList } from "../watch/twitch.ts";
import { startWebhookServer, type WebhookHandler } from "../watch/webhook/server.ts";

export const KICK_PATH = "/webhooks/kick";
export const TWITCH_PATH = "/webhooks/twitch";

export interface WebhookWatchers {
  sources: string[];
  port: number;
  stats(): Record<string, unknown>;
  close(): Promise<void>;
}

/**
 * Starts the Kick and Twitch watchers when their keys are in .env. Both are optional: if one
 * can't be set up, the reason is logged and the bot keeps running on the sources that work.
 * Returns undefined when neither is configured.
 */
export async function startWebhookWatchers(o: {
  env: AppEnv;
  accounts: AccountsConfig;
  pipeline: PipelineDeps;
  log: Logger;
  fetch?: FetchFn | undefined;
  /** Test hook: listen on this port instead of WEBHOOK_PORT. */
  port?: number;
  host?: string;
}): Promise<WebhookWatchers | undefined> {
  const { env, log } = o;
  const routes: Record<string, WebhookHandler> = {};
  const stats: Record<string, () => unknown> = {};
  const afterListen: (() => Promise<void>)[] = [];
  const base = env.WEBHOOK_PUBLIC_URL?.replace(/\/+$/, "");

  const kickList = buildKickWatchList(o.accounts);
  if (env.KICK_CLIENT_ID && env.KICK_CLIENT_SECRET && kickList.length > 0) {
    try {
      const client = new KickClient({ clientId: env.KICK_CLIENT_ID, clientSecret: env.KICK_CLIENT_SECRET, ...(o.fetch ? { fetch: o.fetch } : {}) });
      await verifyKickWatchList(client, kickList, log);
      const watcher = new KickWatcher({ accounts: kickList, fetchPublicKey: () => client.publicKeyPem(), pipeline: o.pipeline, log });
      routes[KICK_PATH] = (req) => watcher.handle(req);
      stats.kick = () => watcher.stats;
      afterListen.push(async () => {
        await ensureKickSubscriptions(client, kickList, log);
        log.info("kick.ready", {
          note: `In the Kick developer app, the webhook URL must be ${base ?? "<your public https URL>"}${KICK_PATH}`,
        });
      });
    } catch (err) {
      log.warn("kick.unavailable", { error: (err as Error).message });
    }
  } else if (kickList.length > 0) {
    log.info("kick.not_configured", { note: "KICK_CLIENT_ID / KICK_CLIENT_SECRET not set: Kick isn't watched" });
  }

  const twitchList = buildTwitchWatchList(o.accounts);
  if (env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET && twitchList.length > 0) {
    if (!env.TWITCH_EVENTSUB_SECRET || !base) {
      log.warn("twitch.unavailable", { error: "Twitch also needs TWITCH_EVENTSUB_SECRET and WEBHOOK_PUBLIC_URL in .env" });
    } else {
      try {
        const secret = env.TWITCH_EVENTSUB_SECRET;
        const client = new TwitchClient({ clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET, ...(o.fetch ? { fetch: o.fetch } : {}) });
        await verifyTwitchWatchList(client, twitchList, log);
        const watcher = new TwitchWatcher({ accounts: twitchList, secret, fetchTitle: (id) => client.channelTitle(id), pipeline: o.pipeline, log });
        routes[TWITCH_PATH] = (req) => watcher.handle(req);
        stats.twitch = () => watcher.stats;
        // Twitch calls back to verify the URL as soon as we subscribe, so the server must be listening first.
        afterListen.push(() => ensureTwitchSubscriptions(client, twitchList, base + TWITCH_PATH, secret, log));
      } catch (err) {
        log.warn("twitch.unavailable", { error: (err as Error).message });
      }
    }
  } else if (twitchList.length > 0) {
    log.info("twitch.not_configured", { note: "TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set: Twitch isn't watched" });
  }

  const sources = Object.keys(stats);
  if (sources.length === 0) return undefined;
  const server = await startWebhookServer({ port: o.port ?? Number(env.WEBHOOK_PORT), ...(o.host ? { host: o.host } : {}), routes, log });
  for (const step of afterListen) {
    try {
      await step();
    } catch (err) {
      log.warn("webhook.subscribe_failed", { error: (err as Error).message });
    }
  }
  return {
    sources,
    port: server.port,
    stats: () => Object.fromEntries(Object.entries(stats).map(([k, f]) => [k, f()])),
    close: () => server.close(),
  };
}
