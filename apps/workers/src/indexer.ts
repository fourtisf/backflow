/**
 * Indexer: subscribes to LaunchLab activity under our PlatformConfig, parses trades, curve state, migrations and token balance changes into Postgres, and publishes live events to Redis.
 *
 * Skeleton (Milestone 1): runs, logs and serves /health. The job itself lands in
 * Milestone 3. See docs/SPEC.md §6.1.
 */
import { runWorker } from "./runner";

let announced = false;

runWorker({
  name: "indexer",
  intervalMs: 5000,
  milestone: 3,
  tick: async ({ log }) => {
    if (!announced) {
      log.info("indexer is a skeleton until milestone 3; nothing to do yet");
      announced = true;
    }
  },
});
