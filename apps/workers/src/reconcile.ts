/** Reconcile process (SPEC §6.3, §10). */
import { reconcileTick } from "./jobs/reconcile";
import { runWorker } from "./runner";

runWorker({ name: "reconcile", intervalMs: 60_000, tick: reconcileTick });
