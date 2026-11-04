/** Harvest process (SPEC §3.4). */
import { harvestTick } from "./jobs/harvest";
import { runWorker } from "./runner";

runWorker({ name: "harvest", intervalMs: 60_000, tick: harvestTick });
