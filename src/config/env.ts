import { z } from "zod";

/**
 * Env vars whose values must never appear in logs or the audit log.
 * RPC/gRPC URLs are included because providers put the API key in the URL.
 */
export const SECRET_ENV_KEYS = [
  "RPC_HTTP_URL",
  "RPC_WS_URL",
  "GRPC_URL",
  "GRPC_TOKEN",
  "ETH_RPC_URL",
  "BASE_RPC_URL",
  "X_BEARER_TOKEN",
  "KICK_CLIENT_SECRET",
  "TWITCH_CLIENT_SECRET",
  "TWITCH_EVENTSUB_SECRET",
  "TELEGRAM_BOT_TOKEN",
] as const;

const optionalUrl = z.url().optional();
const optionalString = z.string().min(1).optional();

export const EnvSchema = z.object({
  MODE: z.enum(["dry-run", "live"]).default("dry-run"),
  LIVE: z.enum(["0", "1"]).default("0"),
  DATA_DIR: z.string().min(1).default("data"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  RPC_HTTP_URL: optionalUrl,
  RPC_WS_URL: optionalUrl,
  GRPC_URL: optionalUrl,
  GRPC_TOKEN: optionalString,
  JITO_BLOCK_ENGINE_URL: optionalUrl,
  WALLET_KEYPAIR_PATH: optionalString,

  /**
   * Dry-run only. A public address that holds SOL, used as the trader in simulations before the
   * bot wallet is funded. Nothing is signed for it and nothing is sent. Ignored in live mode.
   */
  SIM_PAYER_PUBKEY: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 Solana address").optional(),

  // Optional. Only used to tell which chain a 0x address is on, for the manual-buy alert.
  ETH_RPC_URL: optionalUrl,
  BASE_RPC_URL: optionalUrl,

  X_BEARER_TOKEN: optionalString,
  /**
   * Dry-run only. Your own X account(s) for rehearsals, as "handle:user_id" (comma-separated for more).
   * Kept here, not in config/accounts.yaml, so it stays out of the public repo. Blocks live mode.
   */
  TEST_X_ACCOUNTS: z
    .string()
    .regex(/^\w{1,15}:\d{1,20}(\s*,\s*\w{1,15}:\d{1,20})*$/, 'must look like "handle:user_id" (comma-separated for more)')
    .optional(),
  KICK_CLIENT_ID: optionalString,
  KICK_CLIENT_SECRET: optionalString,
  TWITCH_CLIENT_ID: optionalString,
  TWITCH_CLIENT_SECRET: optionalString,
  /** Any random 10-100 character string you make up. Twitch signs its webhooks with it. */
  TWITCH_EVENTSUB_SECRET: z.string().min(10).max(100).optional(),

  // Kick and Twitch deliver by webhook, so they need a public https address that reaches this port.
  WEBHOOK_PUBLIC_URL: z.url({ protocol: /^https$/ }).optional(),
  WEBHOOK_PORT: z.string().regex(/^\d{2,5}$/).default("8787"),
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_OWNER_CHAT_ID: optionalString,
});

export type AppEnv = z.infer<typeof EnvSchema>;

const KNOWN_KEYS = Object.keys(EnvSchema.shape) as (keyof AppEnv)[];

/** Keep only the keys we know, and treat empty strings as unset (that's how .env.example ships). */
function pickKnown(raw: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of KNOWN_KEYS) {
    const value = raw[key]?.trim();
    if (value) out[key] = value;
  }
  return out;
}

/** Secret values present in the raw env, collected before validation so even invalid ones get redacted. */
export function collectSecretValues(raw: Record<string, string | undefined>): string[] {
  return SECRET_ENV_KEYS.map((k) => raw[k]?.trim()).filter((v): v is string => Boolean(v));
}

export class EnvError extends Error {
  override name = "EnvError";
}

export function parseEnv(raw: Record<string, string | undefined>): AppEnv {
  const result = EnvSchema.safeParse(pickKnown(raw));
  if (!result.success) {
    // Issue messages name the key and the rule, never the value.
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new EnvError(`Invalid .env: ${problems.join("; ")}`);
  }
  return result.data;
}

/** Test X accounts from TEST_X_ACCOUNTS, in the same shape as accounts.yaml test_accounts.x. */
export function testAccountsFromEnv(env: Pick<AppEnv, "TEST_X_ACCOUNTS">): { handle: string; user_id: string }[] {
  if (!env.TEST_X_ACCOUNTS) return [];
  return env.TEST_X_ACCOUNTS.split(",").map((pair) => {
    const [handle, user_id] = pair.trim().split(":") as [string, string];
    return { handle, user_id };
  });
}
