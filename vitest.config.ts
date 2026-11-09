import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    // node:sqlite is stable enough for us but still flagged experimental on Node 22.
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});
