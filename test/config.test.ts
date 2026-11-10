import { describe, expect, it } from "vitest";
import { parseEnv, testAccountsFromEnv } from "../src/config/env.ts";
import { ConfigError, loadAppConfig, parseYamlConfig, withTestAccounts } from "../src/config/load.ts";
import {
  AccountsSchema,
  GuardrailsSchema,
  liveReadinessProblems,
  ValidatorSchema,
} from "../src/config/schemas.ts";
import { CONFIG_DIR, repoConfigObject, toYaml } from "./helpers.ts";

const accounts = (mutate: (o: any) => void) => {
  const o = repoConfigObject("accounts.yaml");
  mutate(o);
  return () => parseYamlConfig(toYaml(o), AccountsSchema, "accounts.yaml");
};
const guardrails = (mutate: (o: any) => void) => {
  const o = repoConfigObject("guardrails.yaml");
  mutate(o);
  return () => parseYamlConfig(toYaml(o), GuardrailsSchema, "guardrails.yaml");
};
const validator = (mutate: (o: any) => void) => {
  const o = repoConfigObject("validator.yaml");
  mutate(o);
  return () => parseYamlConfig(toYaml(o), ValidatorSchema, "validator.yaml");
};

describe("repo config files", () => {
  const cfg = loadAppConfig(CONFIG_DIR);

  it("load and validate", () => {
    expect(Object.keys(cfg.accounts.people)).toEqual(["adin_ross", "faze_banks"]);
  });

  it("keep the official X IDs exactly (no float rounding)", () => {
    expect(cfg.accounts.people.adin_ross!.x[0]).toMatchObject({ handle: "adinross", user_id: "759660076214853632", tier: 1 });
    expect(cfg.accounts.people.faze_banks!.x[0]).toMatchObject({ handle: "Banks", user_id: "363811679", tier: 1 });
  });

  it("block the known fake ADINROSS mint", () => {
    expect(cfg.accounts.blocked_mints.map((b) => b.mint)).toContain("Ce8nnx1XqLBEE6ChG44xEwcSsK6PS2uv4NX9B7bYpump");
  });

  it("ship placeholder guardrails that are NOT live-ready", () => {
    expect(cfg.guardrails.status).toBe("placeholder");
    expect(liveReadinessProblems(cfg.guardrails)).toHaveLength(3);
  });
});

describe("accounts.yaml rules", () => {
  it("rejects an unquoted (numeric) X user_id, which YAML would round", () => {
    expect(accounts((o) => (o.people.adin_ross.x[0].user_id = 759660076214853632))).toThrow(/numeric ID string/);
  });

  it("rejects a tier-1 buy trigger on a polling-only platform", () => {
    expect(accounts((o) => (o.people.adin_ross.instagram[0].tier = 1))).toThrow(/polling-only/);
  });

  it("rejects an account that is both watched and excluded", () => {
    expect(accounts((o) => o.exclude.x_handles.push("AdinRoss"))).toThrow(/both watched and excluded/);
  });

  it("rejects typos in keys instead of silently ignoring them", () => {
    expect(accounts((o) => (o.people.adin_ross.x[0].tierr = 1))).toThrow(ConfigError);
  });

  it("rejects a malformed blocked mint", () => {
    expect(accounts((o) => o.blocked_mints.push({ mint: "0OIl-not-base58", note: "x" }))).toThrow(/base58/);
  });
});

describe("validator.yaml rules", () => {
  it.each(["allowlisted_author", "address_in_post", "valid_pubkey", "is_mint", "blocked_mint"])(
    "core check %s can't be weakened",
    (id) => {
      expect(validator((o) => (o.checks[id] = "warn"))).toThrow(/core check/);
      expect(validator((o) => (o.checks[id] = "off"))).toThrow(/core check/);
    },
  );

  it("lets non-core checks be warn or off", () => {
    expect(validator((o) => (o.checks.sell_simulation = "warn"))).not.toThrow();
    expect(validator((o) => (o.checks.holder_concentration = "off"))).not.toThrow();
  });

  it("rejects unknown levels and unknown checks", () => {
    expect(validator((o) => (o.checks.sell_simulation = "maybe"))).toThrow(ConfigError);
    expect(validator((o) => (o.checks.made_up_check = "block"))).toThrow(ConfigError);
  });
});

describe("guardrails.yaml rules", () => {
  it("rejects a take-profit ladder that sells more than 100%", () => {
    expect(
      guardrails((o) => (o.exit.take_profit_ladder = [{ gain_pct: 50, sell_pct: 60 }, { gain_pct: 100, sell_pct: 50 }])),
    ).toThrow(/more than 100%/);
  });

  it("rejects a ladder whose gain targets don't increase", () => {
    expect(
      guardrails((o) => (o.exit.take_profit_ladder = [{ gain_pct: 100, sell_pct: 20 }, { gain_pct: 50, sell_pct: 20 }])),
    ).toThrow(/must increase/);
  });

  it("rejects a non-positive buy size", () => {
    expect(guardrails((o) => (o.buy.sol_per_buy = 0))).toThrow(ConfigError);
  });

  it("is live-ready once status is set, a ladder exists and some stop exists", () => {
    const g = guardrails((o) => {
      o.status = "set";
      o.exit.take_profit_ladder = [{ gain_pct: 10, sell_pct: 10 }];
      o.exit.max_hold_minutes = 1;
    })();
    expect(liveReadinessProblems(g)).toEqual([]);
  });
});

describe("parseYamlConfig", () => {
  it("rejects duplicate keys", () => {
    expect(() => parseYamlConfig("a: 1\na: 2\n", AccountsSchema, "dup.yaml")).toThrow(/YAML syntax error/);
  });
});

describe("test accounts from .env", () => {
  it("ships none in the public config", () => {
    expect(loadAppConfig(CONFIG_DIR).accounts.test_accounts.x).toEqual([]);
  });

  it("reads handle:user_id pairs from TEST_X_ACCOUNTS and adds them once", () => {
    const env = parseEnv({ TEST_X_ACCOUNTS: "TestPoster:1000000000000000001, Other_One:42" });
    const extra = testAccountsFromEnv(env);
    expect(extra).toEqual([
      { handle: "TestPoster", user_id: "1000000000000000001" },
      { handle: "Other_One", user_id: "42" },
    ]);
    const cfg = withTestAccounts(withTestAccounts(loadAppConfig(CONFIG_DIR), extra), extra);
    expect(cfg.accounts.test_accounts.x).toEqual(extra);
    expect(testAccountsFromEnv(parseEnv({}))).toEqual([]);
  });

  it("rejects a badly written TEST_X_ACCOUNTS", () => {
    for (const bad of ["TestPoster", "TestPoster:abc", "@TestPoster:12", "a:1;b:2"]) {
      expect(() => parseEnv({ TEST_X_ACCOUNTS: bad })).toThrow(/TEST_X_ACCOUNTS/);
    }
  });
});
