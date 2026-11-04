/**
 * Reconcile worker: claims the shared platform fee vault, moves holders' and platform parts to the buyback wallet and treasury, and checks claimed vs. accrued within 0.5%.
 *
 * Skeleton (Milestone 1): runs, logs and serves /health. The job itself lands in
 * Milestone 9. See docs/SPEC.md §6.3.
 */
import { runWorker } from "./runner";

let announced = false;

runWorker({
  name: "reconcile",
  intervalMs: 60000,
  milestone: 9,
  tick: async ({ log }) => {
    if (!announced) {
      log.info("reconcile is a skeleton until milestone 9; nothing to do yet");
      announced = true;
    }
  },
});
