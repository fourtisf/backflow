import { defineConfig } from "vitest/config";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://backflow:backflow_dev@localhost:5432/backflow_test";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: { DATABASE_URL: TEST_DATABASE_URL },
  },
});
