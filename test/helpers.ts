import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { loadAppConfig, withTestAccounts, type AppConfig } from "../src/config/load.ts";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const CONFIG_DIR = join(REPO_ROOT, "config");

export function tempDir(prefix = "sniper-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Load a repo config file as a plain object so a test can tweak it. */
export function repoConfigObject(file: string): any {
  return parse(readFileSync(join(CONFIG_DIR, file), "utf8"));
}

/** A made-up X account that plays the owner's rehearsal account in tests. */
export const TEST_X_ACCOUNT = { handle: "TestPoster", user_id: "1000000000000000001" };

/** The same account, the way it's written in .env. */
export const TEST_X_ACCOUNTS_ENV = `${TEST_X_ACCOUNT.handle}:${TEST_X_ACCOUNT.user_id}`;

/** The repo config plus the made-up test account, the way TEST_X_ACCOUNTS in .env adds one. */
export function loadTestConfig(): AppConfig {
  return withTestAccounts(loadAppConfig(CONFIG_DIR), [TEST_X_ACCOUNT]);
}

export const toYaml = (obj: unknown): string => stringify(obj);

/** Fake secrets used across tests. None of these may ever appear in output. */
export const FAKE_SECRETS = {
  RPC_HTTP_URL: "https://mainnet.helius-rpc.com/?api-key=rpc-secret-abc12345",
  RPC_WS_URL: "wss://mainnet.helius-rpc.com/?api-key=rpc-secret-abc12345",
  GRPC_URL: "https://grpc.example.com/grpcsecretpath987",
  GRPC_TOKEN: "grpc-token-zyx98765",
  X_BEARER_TOKEN: "AAAAAAAAAAAAAAAAAAAAAtestbearer",
  TELEGRAM_BOT_TOKEN: "123456:telegram-secret-token",
  KICK_CLIENT_SECRET: "kick-secret-55555",
  TWITCH_CLIENT_SECRET: "twitch-secret-66666",
} as const;

/** The distinctive part of each fake secret, to grep output for. */
export const SECRET_NEEDLES = [
  "rpc-secret-abc12345",
  "grpcsecretpath987",
  "grpc-token-zyx98765",
  "AAAAAAAAAAAAAAAAAAAAAtestbearer",
  "telegram-secret-token",
  "kick-secret-55555",
  "twitch-secret-66666",
];
