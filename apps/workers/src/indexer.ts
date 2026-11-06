/** Indexer process (SPEC §6.1). */
import { excludedFor } from "./ctx";
import { fillMetadata, indexAllMints, indexPlatform, refreshStats, type IndexerState } from "./jobs/indexer";
import { runWorker } from "./runner";

const state: IndexerState = { solUsd: null };
let lastStats = 0;
let lastPrice = 0;
/** Every coin's board numbers (volume, holders, change) refresh this often; coins with new trades or
 *  balance changes are refreshed in the same tick they were indexed (D-055). */
const STATS_EVERY_MS = 15_000;

/** One failing step (an RPC error on one transaction, a slow metadata host) must not stop the others (D-055). */
async function step(ctx: Parameters<Parameters<typeof runWorker>[0]["tick"]>[0], name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (e) {
    ctx.log.error({ err: e }, `indexer step ${name} failed`);
  }
}

runWorker({
  name: "indexer",
  intervalMs: Number(process.env.INDEXER_INTERVAL_MS ?? 3000),
  wakeChannel: "backflow:indexer:wake",
  tick: async (ctx) => {
    if (Date.now() - lastPrice > 30_000) {
      await step(ctx, "price", async () => {
        state.solUsd = (await ctx.chain.solUsd()) ?? state.solUsd;
      });
      lastPrice = Date.now();
    }
    await step(ctx, "platform", () => indexPlatform(ctx, state));
    await step(ctx, "mints", () => indexAllMints(ctx, state));
    await step(ctx, "metadata", () => fillMetadata(ctx)); // outside every DB transaction, strict limits
    if (Date.now() - lastStats > STATS_EVERY_MS) {
      state.touched?.clear();
      await step(ctx, "stats", () => refreshStats(ctx, state, (mint) => excludedFor(ctx, mint)));
      lastStats = Date.now();
    } else if (state.touched?.size) {
      const only = [...state.touched].filter(Boolean);
      state.touched.clear();
      await step(ctx, "stats (new activity)", () => refreshStats(ctx, state, (mint) => excludedFor(ctx, mint), only));
    }
  },
});
