/**
 * Admin commands, run on the server only (there is no admin page or admin API):
 *
 *   pnpm admin overview                      settings, budgets, unclaimed fees, failures, held claims, wallet balances
 *   pnpm admin coins [--reported|--hidden]   newest coins with report counts
 *   pnpm admin reports <mint>                reports for one coin
 *   pnpm admin hide <mint> --reason "…"      hide a coin from the board
 *   pnpm admin unhide <mint>
 *   pnpm admin excluded                      addresses that earn no rewards
 *   pnpm admin exclude <address> [--coin <mint>] [--reason manual] [--note "…"]
 *   pnpm admin unexclude <address> [--coin <mint>]
 *   pnpm admin pause buybacks|payouts [--coin <mint>]
 *   pnpm admin resume buybacks|payouts [--coin <mint>] --yes
 *   pnpm admin claims                        recent vault claims
 *   pnpm admin approve-claim <id> --yes      release a claim held for a mismatch
 *   pnpm admin failed                        failed jobs and recent warnings
 *   pnpm admin retry-harvest <id>
 *   pnpm admin dead-letters                  indexer transactions that couldn't be applied
 *   pnpm admin resolve-dead-letter <stream> <signature> --yes
 *   pnpm admin log                           recent admin actions
 *
 * Add --json to any listing for machine-readable output. Every change is written to the audit log
 * (JobLog, job "admin") as cli:<user>@<host>, in the same transaction as the change.
 * Needs DATABASE_URL (the server's env file); `overview` also reads wallet balances over RPC.
 */
import { admin, getPrisma } from "@backflow/db";
import { hostname, userInfo } from "node:os";

const argv = process.argv.slice(2).filter((a) => a !== "--"); // pnpm may pass a bare "--"
/** Flags followed by a value; everything else starting with "--" is a switch (--yes, --json, --reported, --hidden). */
const VALUE_FLAGS = new Set(["--reason", "--coin", "--note", "--limit"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(argv[i - 1]!)));
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const [cmd, a1, a2] = positional;
const actor = `cli:${userInfo().username}@${hostname()}`;
const db = getPrisma();

const show = (v: unknown) => {
  const plain = JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
  if (has("json") || !Array.isArray(plain)) console.log(JSON.stringify(plain, null, 2));
  else if (!plain.length) console.log("(none)");
  else console.table(plain);
};
const sol = (lamports: bigint | null | undefined) => (lamports == null ? "–" : `${(Number(lamports) / 1e9).toFixed(4)} SOL`);
const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Error(`Missing ${what}. Run \`pnpm admin help\` for usage.`);
  return v;
};
/** --limit as a whole number from 1 to 500 (a typo must not reach the database as NaN). */
function limitOpt(dflt: number): number {
  const n = Number(opt("limit") ?? dflt);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : dflt;
}

const confirm = (what: string) => {
  if (!has("yes")) throw new Error(`${what} changes funds or who gets paid. Re-run with --yes to confirm.`);
};

async function balances(): Promise<Record<string, string>> {
  try {
    const { connection, cluster } = await import("@backflow/chain");
    const { PublicKey } = await import("@solana/web3.js");
    const conn = connection(cluster({ readOnly: true }));
    const out: Record<string, string> = {};
    for (const [name, env] of [["buyback", "BUYBACK_PUBKEY"], ["distributor", "DISTRIBUTOR_PUBKEY"], ["platform fee", "PLATFORM_FEE_PUBKEY"], ["treasury", "TREASURY_PUBKEY"]] as const) {
      const v = process.env[env];
      if (!v || v.startsWith("REPLACE")) continue;
      out[name] = sol(BigInt(await conn.getBalance(new PublicKey(v), "confirmed")));
    }
    return out;
  } catch (e) {
    return { note: `balances unavailable: ${(e as Error).message}` };
  }
}

async function main() {
  switch (cmd) {
    case "overview": {
      const o = await admin.adminOverview(db, process.env.PLATFORM_CONFIG_PUBKEY ?? null);
      show({ ...o, buybackBudgets: sol(o.buybackBudgets), unclaimedPlatformFees: sol(o.unclaimedPlatformFees), unclaimedHoldersPart: sol(o.unclaimedHoldersPart), walletBalances: await balances() });
      return;
    }
    case "coins":
      show((await admin.listCoins(db, { reportedOnly: has("reported"), hiddenOnly: has("hidden"), limit: limitOpt(50) })).map((c) => ({ mint: c.mint, ticker: c.ticker, status: c.status, hidden: c.hidden, reports: c.reports, otherFrontend: !c.launchedViaUs, buybacksPaused: c.buybacksPaused, payoutsPaused: c.payoutsPaused })));
      return;
    case "reports":
      show((await admin.coinReports(db, need(a1, "the coin mint"))).map((r) => ({ at: r.createdAt.toISOString(), reason: r.reason, reporter: r.by })));
      return;
    case "hide":
      await admin.setHidden(db, need(a1, "the coin mint"), true, opt("reason") ?? null, actor);
      console.log(`Hidden ${a1}.`);
      return;
    case "unhide":
      await admin.setHidden(db, need(a1, "the coin mint"), false, null, actor);
      console.log(`Unhidden ${a1}.`);
      return;
    case "excluded":
      show(await admin.listExcluded(db));
      return;
    case "exclude":
      confirm("Excluding an address"); // audit
      await admin.addExclusion(db, need(a1, "the address"), opt("coin") ?? "global", opt("reason") ?? "manual", opt("note") ?? null, actor);
      console.log(`Excluded ${a1} (${opt("coin") ?? "all coins"}).`);
      return;
    case "unexclude": {
      confirm("Removing an exclusion"); // audit
      const n = await admin.removeExclusion(db, need(a1, "the address"), opt("coin") ?? "global", actor);
      console.log(n ? `Removed the exclusion of ${a1}.` : "No such exclusion.");
      return;
    }
    case "pause":
    case "resume": {
      const kind = need(a1, "buybacks or payouts");
      if (kind !== "buybacks" && kind !== "payouts") throw new Error("Choose buybacks or payouts.");
      if (cmd === "resume") confirm(`Resuming ${kind}`);
      await admin.setPaused(db, kind, opt("coin") ?? "global", cmd === "pause", actor);
      console.log(`${cmd === "pause" ? "Paused" : "Resumed"} ${kind} (${opt("coin") ?? "all coins"}).`);
      return;
    }
    case "claims":
      show((await admin.listClaims(db, limitOpt(20))).map((c) => ({ id: c.id, stage: c.stage, status: c.status, claimed: sol(c.claimedLamports), expected: sol(c.expectedLamports), mismatchPct: c.mismatchPpm == null ? null : c.mismatchPpm / 10_000, at: c.createdAt.toISOString() })));
      return;
    case "approve-claim":
      confirm("Approving a held claim");
      await admin.approveHeldClaim(db, need(a1, "the claim id"), actor);
      console.log("Approved. The reconcile worker sends the transfers on its next run. Resume buybacks when you're satisfied: pnpm admin resume buybacks --yes");
      return;
    case "failed":
      show(await admin.failedJobs(db));
      return;
    case "retry-harvest":
      confirm("Retrying a harvest");
      await admin.retryHarvest(db, need(a1, "the harvest id"), actor);
      console.log("Re-queued. The harvest worker picks it up on its next run.");
      return;
    case "dead-letters":
      show(await admin.listDeadLetters(db));
      return;
    case "resolve-dead-letter":
      confirm("Resolving a dead letter");
      await admin.resolveDeadLetter(db, need(a1, "the stream"), need(a2, "the signature"), actor);
      console.log("Marked as resolved.");
      return;
    case "log":
      show((await admin.auditLog(db, limitOpt(50))).map((l) => ({ at: l.createdAt.toISOString(), who: l.key, action: l.message, data: JSON.stringify(l.data) })));
      return;
    default: {
      const { readFileSync } = await import("node:fs");
      const help = readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]!.replace(/^\/\*\*|^ \* ?/gm, "");
      console.log(help.trim());
      if (cmd && cmd !== "help") process.exitCode = 2;
    }
  }
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
