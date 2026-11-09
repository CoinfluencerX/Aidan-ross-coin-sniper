import type { AppEnv } from "./env.ts";

export type Mode = "dry-run" | "live";

/**
 * Flipped to true only once the executor milestone (M3+) ships and the owner has
 * run the live tests themselves. Until then the bot refuses to start in live mode.
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
      "Live mode isn't available yet: the executor ships in M3. Use --mode dry-run.",
    );
  }
  return "live";
}
