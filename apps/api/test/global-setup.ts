import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup() {
  const url = process.env.TEST_API_DATABASE_URL ?? "postgresql://backflow:backflow_dev@localhost:5432/backflow_test_api";
  try {
    execSync("pnpm exec prisma migrate deploy", { cwd: fileURLToPath(new URL("../../../packages/db", import.meta.url)), env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  } catch (e) {
    const err = e as { stderr?: Buffer; stdout?: Buffer };
    throw new Error(`could not migrate the test database (is Postgres running?):\n${err.stderr?.toString() ?? ""}${err.stdout?.toString() ?? ""}`);
  }
}
