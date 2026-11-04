import { defineConfig } from "vitest/config";

const url = process.env.TEST_API_DATABASE_URL ?? "postgresql://backflow:backflow_dev@localhost:5432/backflow_test_api";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: { DATABASE_URL: url, TEST_API_DATABASE_URL: url },
  },
});
