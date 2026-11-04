import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Apply migrations to the test database once per run. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://backflow:backflow_dev@localhost:5432/backflow_test";
  execSync("pnpm exec prisma migrate deploy", { cwd: fileURLToPath(new URL("../../../packages/db", import.meta.url)), env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
