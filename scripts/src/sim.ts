/**
 * `pnpm sim`: simulate trades on devnet so buybacks and payouts can be watched
 * end to end (CLAUDE.md "Commands to provide").
 *
 * It needs launching (Milestone 2) and curve trading (Milestone 4). Until then
 * the API's mock mode (DATA_MODE=mock, the default) simulates the same flow
 * in-process: run `pnpm dev` and watch the board.
 */
import { cluster } from "@backflow/chain";

const c = cluster();
console.log(`pnpm sim (cluster ${c})`);
console.log("Devnet trade simulation arrives with Milestone 4 (trading).");
console.log("For now, `pnpm dev` runs the API in mock mode, which simulates trades, buybacks and payouts.");
process.exitCode = 0;
