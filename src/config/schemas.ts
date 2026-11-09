import { z } from "zod";

// ---------- shared ----------

// Quoted on purpose: an unquoted 18-digit X ID is parsed by YAML as a float and silently rounded.
const NUMERIC_ID_MSG = 'must be a numeric ID string, quoted in YAML (e.g. user_id: "759660076214853632")';
const numericId = z.string({ error: NUMERIC_ID_MSG }).regex(/^\d{1,20}$/, NUMERIC_ID_MSG);
const tier = z.union([z.literal(1), z.literal(2)]);
export const base58Address = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 Solana address");
const youtubeChannelId = z.string().regex(/^UC[\w-]{22}$/, "must be a YouTube channel ID (UC…)");

// ---------- accounts.yaml ----------

const XAccount = z.strictObject({ handle: z.string().min(1), user_id: numericId, tier });
const KickAccount = z.strictObject({
  slug: z.string().min(1),
  user_id: z.number().int().positive(),
  channel_id: z.number().int().positive().optional(),
  chatroom_id: z.number().int().positive().optional(),
  tier,
});
const TwitchAccount = z.strictObject({ login: z.string().min(1), user_id: numericId, tier });
const YouTubeAccount = z.strictObject({ name: z.string().min(1), channel_id: youtubeChannelId, tier });
const UsernameAccount = z.strictObject({ username: z.string().min(1), tier });
const DiscordServer = z.strictObject({
  server: z.string().min(1),
  guild_id: numericId,
  invite: z.url(),
  tier,
});
const TelegramChannel = z.strictObject({ channel: z.string().min(1), channel_id: numericId, tier });

/** Platforms that deliver posts by push/stream. Only these may hold tier-1 (buy-trigger) accounts. */
export const PUSH_PLATFORMS = ["x", "kick", "twitch", "telegram"] as const;

const Person = z.strictObject({
  x: z.array(XAccount).default([]),
  kick: z.array(KickAccount).default([]),
  twitch: z.array(TwitchAccount).default([]),
  youtube: z.array(YouTubeAccount).default([]),
  instagram: z.array(UsernameAccount).default([]),
  threads: z.array(UsernameAccount).default([]),
  tiktok: z.array(UsernameAccount).default([]),
  discord: z.array(DiscordServer).default([]),
  telegram: z.array(TelegramChannel).default([]),
});
export type Person = z.infer<typeof Person>;
export type Platform = keyof Person;

export const AccountsSchema = z
  .strictObject({
    people: z.record(z.string(), Person),
    exclude: z.strictObject({
      x_handles: z.array(z.string()).default([]),
      kick_slugs: z.array(z.string()).default([]),
      youtube_channel_ids: z.array(youtubeChannelId).default([]),
      tiktok_usernames: z.array(z.string()).default([]),
    }),
    blocked_mints: z.array(z.strictObject({ mint: base58Address, note: z.string().min(1) })).default([]),
    test_accounts: z.strictObject({
      x: z.array(z.strictObject({ handle: z.string().min(1), user_id: numericId })).default([]),
    }),
  })
  .superRefine((cfg, ctx) => {
    const watchedX = new Set<string>();
    const watchedKick = new Set<string>();
    for (const [person, accounts] of Object.entries(cfg.people)) {
      for (const [platform, list] of Object.entries(accounts) as [Platform, { tier: 1 | 2 }[]][]) {
        const isPush = (PUSH_PLATFORMS as readonly string[]).includes(platform);
        list.forEach((acct, i) => {
          if (acct.tier === 1 && !isPush) {
            ctx.addIssue({
              code: "custom",
              path: ["people", person, platform, i, "tier"],
              message: `${platform} is polling-only, so it can only be tier 2 (confirmation)`,
            });
          }
        });
      }
      accounts.x.forEach((a) => watchedX.add(a.handle.toLowerCase()));
      accounts.kick.forEach((a) => watchedKick.add(a.slug.toLowerCase()));
    }
    for (const h of cfg.exclude.x_handles) {
      if (watchedX.has(h.toLowerCase())) {
        ctx.addIssue({ code: "custom", path: ["exclude", "x_handles"], message: `@${h} is both watched and excluded` });
      }
    }
    for (const s of cfg.exclude.kick_slugs) {
      if (watchedKick.has(s.toLowerCase())) {
        ctx.addIssue({ code: "custom", path: ["exclude", "kick_slugs"], message: `kick/${s} is both watched and excluded` });
      }
    }
  });
export type AccountsConfig = z.infer<typeof AccountsSchema>;

// ---------- guardrails.yaml ----------

const nullablePositive = z.number().positive().nullable();

const TakeProfitStep = z.strictObject({
  gain_pct: z.number().positive(),
  sell_pct: z.number().positive().max(100),
});

export const GuardrailsSchema = z.strictObject({
  status: z.enum(["placeholder", "set"]),
  buy: z.strictObject({
    sol_per_buy: z.number().positive(),
    max_slippage_bps: z.number().int().min(0).max(10_000),
    priority_fee_micro_lamports: z.number().int().nonnegative(),
    jito_tip_lamports: z.number().int().nonnegative(),
    max_entry_mcap_usd: nullablePositive,
    max_price_multiple_vs_first_trade: nullablePositive,
    max_open_positions: z.number().int().positive(),
  }),
  confirmation: z.strictObject({
    first_signal_fraction: z.number().gt(0).max(1),
    second_source_window_seconds: z.number().int().positive(),
  }),
  exit: z
    .strictObject({
      take_profit_ladder: z.array(TakeProfitStep),
      trailing_stop_pct: z.number().positive().max(100).nullable(),
      stop_loss_pct: z.number().positive().max(100).nullable(),
      max_hold_minutes: nullablePositive,
      sell_on_source_deleted: z.boolean(),
      sell_on_liquidity_removed: z.boolean(),
      sell_on_creator_sell: z.boolean(),
    })
    .superRefine((exit, ctx) => {
      const ladder = exit.take_profit_ladder;
      const total = ladder.reduce((sum, s) => sum + s.sell_pct, 0);
      if (total > 100) {
        ctx.addIssue({ code: "custom", path: ["take_profit_ladder"], message: `sell_pct adds up to ${total}%, more than 100%` });
      }
      for (let i = 1; i < ladder.length; i++) {
        if (ladder[i]!.gain_pct <= ladder[i - 1]!.gain_pct) {
          ctx.addIssue({ code: "custom", path: ["take_profit_ladder", i, "gain_pct"], message: "gain_pct must increase step by step" });
        }
      }
    }),
});
export type Guardrails = z.infer<typeof GuardrailsSchema>;

/** Problems that make the guardrails unsafe for live trading. Empty list = ready. */
export function liveReadinessProblems(g: Guardrails): string[] {
  const problems: string[] = [];
  if (g.status !== "set") problems.push("guardrails.yaml still has status: placeholder");
  if (g.exit.take_profit_ladder.length === 0) problems.push("exit.take_profit_ladder is empty, so the bot would never take profit");
  if (g.exit.stop_loss_pct === null && g.exit.trailing_stop_pct === null && g.exit.max_hold_minutes === null) {
    problems.push("no stop_loss_pct, trailing_stop_pct or max_hold_minutes is set, so a crash would never trigger a sale");
  }
  return problems;
}

// ---------- validator.yaml ----------

const Level = z.enum(["block", "warn", "off"]);
/** Checks that enforce "the one rule". They can't be weakened in config. */
const Core = z.literal("block", { message: "core check: must stay `block`" });

export const ValidatorSchema = z.strictObject({
  checks: z.strictObject({
    // source
    allowlisted_author: Core,
    original_post: Level,
    address_in_post: Core,
    cross_account_match: Level,
    warning_post_filter: Level,
    // address
    valid_pubkey: Core,
    is_mint: Core,
    blocked_mint: Core,
    recent_mint: Level,
    name_matches_post: Level,
    // sellability
    freeze_authority_null: Level,
    no_dangerous_extensions: Level,
    transfer_fee_max: Level,
    sell_simulation: Level,
    mint_authority_revoked: Level,
    // market
    route_exists: Level,
    liquidity_depth: Level,
    holder_concentration: Level,
  }),
  params: z.strictObject({
    recent_mint_max_age_hours: z.number().positive(),
    transfer_fee_max_bps: z.number().int().min(0).max(10_000),
    warning_keywords: z.array(z.string().min(1)),
  }),
});
export type ValidatorConfig = z.infer<typeof ValidatorSchema>;
export type CheckId = keyof ValidatorConfig["checks"];
