import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";
import {
  AccountsSchema,
  GuardrailsSchema,
  ValidatorSchema,
  type AccountsConfig,
  type Guardrails,
  type ValidatorConfig,
} from "./schemas.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function parseYamlConfig<S extends z.ZodType>(text: string, schema: S, label: string): z.infer<S> {
  let data: unknown;
  try {
    data = parse(text, { uniqueKeys: true });
  } catch (err) {
    throw new ConfigError(`${label}: YAML syntax error: ${(err as Error).message}`);
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`${label} is invalid:\n  - ${problems.join("\n  - ")}`);
  }
  return result.data;
}

function loadFile<S extends z.ZodType>(dir: string, file: string, schema: S): z.infer<S> {
  const path = join(dir, file);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`Missing config file: ${path}`);
  }
  return parseYamlConfig(text, schema, file);
}

export interface AppConfig {
  accounts: AccountsConfig;
  guardrails: Guardrails;
  validator: ValidatorConfig;
}

export function loadAppConfig(configDir: string): AppConfig {
  return {
    accounts: loadFile(configDir, "accounts.yaml", AccountsSchema),
    guardrails: loadFile(configDir, "guardrails.yaml", GuardrailsSchema),
    validator: loadFile(configDir, "validator.yaml", ValidatorSchema),
  };
}

/** Add test accounts that came from .env (TEST_X_ACCOUNTS) to the ones in accounts.yaml, without duplicates. */
export function withTestAccounts(config: AppConfig, extra: { handle: string; user_id: string }[]): AppConfig {
  if (extra.length === 0) return config;
  const seen = new Set(config.accounts.test_accounts.x.map((a) => a.user_id));
  const added = extra.filter((a) => !seen.has(a.user_id) && seen.add(a.user_id));
  return { ...config, accounts: { ...config.accounts, test_accounts: { x: [...config.accounts.test_accounts.x, ...added] } } };
}
