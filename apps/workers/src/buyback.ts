/**
 * Buyback worker: when a coin's buyback budget reaches the threshold, quotes, splits by the impact cap, buys on the curve (or CPMM after graduation), and records each step (pending → sent → confirmed/failed).
 *
 * Skeleton (Milestone 1): runs, logs and serves /health. The job itself lands in
 * Milestone 5. See docs/SPEC.md §3.1.
 */
import { runWorker } from "./runner";

let announced = false;

runWorker({
  name: "buyback",
  intervalMs: 5000,
  milestone: 5,
  tick: async ({ log }) => {
    if (!announced) {
      log.info("buyback is a skeleton until milestone 5; nothing to do yet");
      announced = true;
    }
  },
});
