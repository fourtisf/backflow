/**
 * Payout worker: every payout interval, sends each wallet its pending tokens in batched SPL transfers, applying forfeiture and the minimum payout.
 *
 * Skeleton (Milestone 1): runs, logs and serves /health. The job itself lands in
 * Milestone 6. See docs/SPEC.md §3.3.
 */
import { runWorker } from "./runner";

let announced = false;

runWorker({
  name: "payout",
  intervalMs: 10000,
  milestone: 6,
  tick: async ({ log }) => {
    if (!announced) {
      log.info("payout is a skeleton until milestone 6; nothing to do yet");
      announced = true;
    }
  },
});
