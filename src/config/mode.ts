import type { AppEnv } from "./env.ts";

export type Mode = "dry-run" | "live";

/**
 * The master switch for real trading. While this is false the bot refuses to start in live
 * mode, whatever .env and the command line say. Only the owner turns it on, after the guardrails
 * session and their own live tests. Nobody else, and no automated step, should change it.
 */
export const LIVE_TRADING_AVAILABLE = false;

export class ModeError extends Error {
  override name = "ModeError";
}

export function isMode(value: string): value is Mode {
  return value === "dry-run" || value === "live";
}

/**
 * Live needs three independent switches: `--mode live` on the command line,
 * MODE=live and LIVE=1 in .env. Anything less runs dry, or refuses loudly
 * when live was asked for on the CLI but .env doesn't agree.
 */
export function resolveMode(
  cliMode: Mode | undefined,
  env: Pick<AppEnv, "MODE" | "LIVE">,
  liveAvailable: boolean = LIVE_TRADING_AVAILABLE,
): Mode {
  if ((cliMode ?? "dry-run") === "dry-run") return "dry-run";

  if (env.MODE !== "live" || env.LIVE !== "1") {
    throw new ModeError(
      "Live mode needs --mode live AND MODE=live AND LIVE=1 in .env. Refusing to start.",
    );
  }
  if (!liveAvailable) {
    throw new ModeError(
      "Live mode isn't available yet: it is switched off in code (LIVE_TRADING_AVAILABLE in src/config/mode.ts). Use --mode dry-run.",
    );
  }
  return "live";
}
