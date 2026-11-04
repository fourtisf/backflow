/** Buyback process (SPEC §3.1–3.2). */
import { buybackTick } from "./jobs/buyback";
import { runWorker } from "./runner";

runWorker({ name: "buyback", intervalMs: Number(process.env.BUYBACK_INTERVAL_MS ?? 5000), tick: buybackTick });
