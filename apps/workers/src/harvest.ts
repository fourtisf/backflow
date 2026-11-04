/**
 * Harvest worker: harvests the platform Fee Key for each graduated pool and credits SOL and coin tokens per SPEC §2.2.
 *
 * Skeleton (Milestone 1): runs, logs and serves /health. The job itself lands in
 * Milestone 7. See docs/SPEC.md §3.4.
 */
import { runWorker } from "./runner";

let announced = false;

runWorker({
  name: "harvest",
  intervalMs: 60000,
  milestone: 7,
  tick: async ({ log }) => {
    if (!announced) {
      log.info("harvest is a skeleton until milestone 7; nothing to do yet");
      announced = true;
    }
  },
});
