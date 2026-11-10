import type { Mode } from "../config/mode.ts";
import type { PositionView } from "../exit/manager.ts";
import type { TelegramCommand } from "./telegram.ts";

/**
 * What each Telegram command does. Kept apart from the network code so it can be tested directly.
 * No command can start a buy.
 */

export interface ControlHooks {
  mode: Mode;
  startedAt: number;
  now: () => number;
  /** Whether the bot will act on a validated signal. /kill turns this off, /arm back on. */
  isArmed: () => boolean;
  setArmed: (armed: boolean) => void;
  positions: () => PositionView[];
  /** Flags positions to be sold on the next price check. Returns how many. */
  panicSell: (positionId?: number) => number;
  watching: () => string[];
  stats: () => Record<string, unknown>;
}

const HELP = [
  "/status  what the bot is watching and holding",
  "/sell  sell everything now (/sell 3 sells only position 3)",
  "/kill  stop buying. Open positions are still managed and sold by the rules",
  "/arm  allow buying again after /kill",
  "/help  this list",
].join("\n");

const pct = (n: number | undefined) => (n === undefined ? "?" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);

export function handleCommand(cmd: TelegramCommand, h: ControlHooks): string {
  switch (cmd.name) {
    case "start":
    case "help":
      return HELP;
    case "status": {
      const up = Math.round((h.now() - h.startedAt) / 60_000);
      const pos = h.positions();
      const lines = [
        `Mode: ${h.mode}${h.mode === "dry-run" ? " (nothing real is traded)" : ""}`,
        `Buying: ${h.isArmed() ? "ARMED" : "OFF (/kill was sent)"}`,
        `Up ${up} min. Watching: ${h.watching().join(", ") || "nothing"}`,
        pos.length === 0 ? "No open positions." : `Open positions: ${pos.length}`,
        ...pos.map(
          (p) =>
            `#${p.id} ${p.mint.slice(0, 4)}…${p.mint.slice(-4)}${p.simulated ? " (paper)" : ""}: ${pct(p.gainPct)} now, peak ${pct(p.peakGainPct)}, holding ${p.heldPct.toFixed(0)}%, in ${p.costSol.toFixed(4)} SOL, out ${p.proceedsSol.toFixed(4)} SOL, ${Math.round(p.ageMinutes)} min old`,
        ),
      ];
      return lines.join("\n");
    }
    case "sell": {
      const arg = cmd.args[0];
      const id = arg !== undefined ? Number(arg) : undefined;
      if (id !== undefined && (!Number.isInteger(id) || id <= 0)) return "Use /sell to sell everything, or /sell <position number>.";
      const n = h.panicSell(id);
      if (n === 0) return id !== undefined ? `Position ${id} isn't open.` : "No open positions to sell.";
      return `Selling ${n === 1 ? "1 position" : `${n} positions`} now${h.mode === "dry-run" ? " (paper sale)" : ""}. I'll confirm when it's done.`;
    }
    case "kill":
      h.setArmed(false);
      return "Buying is OFF. No new coin will be bought. Open positions are still managed. Send /arm to turn buying back on, or /sell to exit positions.";
    case "arm":
      h.setArmed(true);
      return "Buying is ARMED again.";
    default:
      return `Unknown command /${cmd.name}.\n${HELP}`;
  }
}
