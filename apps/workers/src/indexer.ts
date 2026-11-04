/** Indexer process (SPEC §6.1). */
import { excludedFor } from "./ctx";
import { indexAllMints, indexPlatform, refreshStats, type IndexerState } from "./jobs/indexer";
import { runWorker } from "./runner";

const state: IndexerState = { solUsd: null };
let lastStats = 0;
let lastPrice = 0;

runWorker({
  name: "indexer",
  intervalMs: Number(process.env.INDEXER_INTERVAL_MS ?? 3000),
  wakeChannel: "backflow:indexer:wake",
  tick: async (ctx) => {
    if (Date.now() - lastPrice > 30_000) {
      state.solUsd = (await ctx.chain.solUsd()) ?? state.solUsd;
      lastPrice = Date.now();
    }
    await indexPlatform(ctx, state);
    await indexAllMints(ctx, state);
    if (Date.now() - lastStats > 30_000) {
      await refreshStats(ctx, state, (mint) => excludedFor(ctx, mint));
      lastStats = Date.now();
    }
  },
});
