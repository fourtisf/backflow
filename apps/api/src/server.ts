import { buildApp } from "./app";
import { MockProvider } from "./mock/provider";
import type { DataProvider } from "./provider";

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? "0.0.0.0";
const mode = process.env.DATA_MODE ?? "mock";

function makeProvider(): DataProvider {
  if (mode === "mock") return new MockProvider();
  // The Postgres-backed provider arrives with the indexer (Milestone 3).
  throw new Error(`DATA_MODE=${mode} is not available yet. Use DATA_MODE=mock.`);
}

const origins = process.env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean);

const app = await buildApp({
  provider: makeProvider(),
  logger: true,
  corsOrigins: origins && origins.length ? origins : true,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port, host });
app.log.info(`api listening on ${host}:${port} (data mode: ${mode})`);
