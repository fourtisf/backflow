/** Payout process (SPEC §3.3). Checks every 10 s; pays every PAYOUT_INTERVAL_SEC (config/fees.json). */
import { payoutTick } from "./jobs/payout";
import { runWorker } from "./runner";

runWorker({ name: "payout", intervalMs: 10_000, tick: async (ctx) => void (await payoutTick(ctx)) });
