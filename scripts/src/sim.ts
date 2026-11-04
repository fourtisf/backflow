/**
 * `pnpm sim`: random buys and sells on a Backflow coin on DEVNET, so buybacks
 * and payouts can be watched end to end (CLAUDE.md "Commands to provide").
 *
 *   pnpm sim -- --mint <coin mint>            trade an existing coin
 *   pnpm sim -- --launch                      launch a test coin first (needs SIM_METADATA_URI)
 *   options: --wallets 5  --trades 50  --delay 4000  --max-sol 0.5
 *
 * Wallets are kept in SIM_WALLET_DIR (default ~/.config/backflow/sim, never the
 * repo). They are funded by devnet airdrop, or from SIM_FUNDER_KEYPAIR_PATH.
 * Refuses to run on mainnet, whatever the environment says.
 */
import { CURVE, FEES, RATES, curveInit, newCurve, parseCluster, tickerKey, type FeeRates } from "@backflow/core";
import {
  addresses,
  ata,
  buildBuyTx,
  buildLaunchTx,
  buildSellTx,
  connection,
  curveStateOf,
  fetchLaunchPool,
  launchPoolKeys,
  loadKeypair,
  readGlobalConfig,
  readPlatform,
  REPO_ROOT,
  arg,
  flag,
} from "@backflow/chain";
import { getPdaLaunchpadPoolId } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type VersionedTransaction } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

if (parseCluster(process.env.SOLANA_CLUSTER) !== "devnet") {
  console.error("pnpm sim only runs on devnet.");
  process.exit(1);
}

const conn = connection("devnet");
const A = addresses("devnet");
const dir = resolve((process.env.SIM_WALLET_DIR ?? join(homedir(), ".config/backflow/sim")).replace(/^~(?=$|\/)/, homedir()));
if (dir === REPO_ROOT || dir.startsWith(REPO_ROOT + "/")) throw new Error("SIM_WALLET_DIR must be outside the repo");
mkdirSync(dir, { recursive: true, mode: 0o700 });

const nWallets = Number(arg("wallets") ?? 5);
const nTrades = Number(arg("trades") ?? 50);
const delay = Number(arg("delay") ?? 4000);
const maxSol = Number(arg("max-sol") ?? 0.5);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const platformId = new PublicKey(process.env.PLATFORM_CONFIG_PUBKEY ?? "");

function wallet(i: number): Keypair {
  const p = join(dir, `sim-${i}.json`);
  if (!existsSync(p)) writeFileSync(p, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]));
}

async function fund(w: Keypair, min: number) {
  const bal = await conn.getBalance(w.publicKey);
  if (bal >= min * LAMPORTS_PER_SOL) return;
  const funderPath = process.env.SIM_FUNDER_KEYPAIR_PATH;
  if (funderPath) {
    const f = loadKeypair("SIM_FUNDER_KEYPAIR_PATH");
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: f.publicKey, toPubkey: w.publicKey, lamports: Math.round(min * 2 * LAMPORTS_PER_SOL) })), [f]);
  } else {
    const sig = await conn.requestAirdrop(w.publicKey, Math.round(Math.min(2, Math.max(1, min * 1.5)) * LAMPORTS_PER_SOL)); // devnet caps airdrops at ~2 SOL
    await conn.confirmTransaction(sig, "confirmed");
  }
  console.log(`funded ${w.publicKey.toBase58()}`);
}

async function send(tx: VersionedTransaction, signer: Keypair): Promise<string> {
  tx.sign([signer]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  // confirm against the transaction's own blockhash (a blockhash fetched after sending only waits longer)
  const lastValidBlockHeight = (await conn.getBlockHeight("confirmed")) + 150;
  await conn.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/** The fee rates the programs will actually charge (GlobalConfig protocol fee + our PlatformConfig), not the config file's. */
let ratesCache: FeeRates | null = null;
async function liveRates(): Promise<FeeRates> {
  if (ratesCache) return ratesCache;
  const [gc, pc] = await Promise.all([readGlobalConfig(conn, A.globalConfig), readPlatform(conn, platformId)]);
  if (!gc || !pc) return RATES;
  const n = FEES.platformFeeSplit;
  const holdersPpm = (pc.feeRate * n.holdersNumerator) / n.holdersDenominator;
  ratesCache = { raydiumProtocolPpm: gc.tradeFeeRate, platformFeePpm: pc.feeRate, creatorFeePpm: pc.creatorFeeRate, holdersPpm, platformSharePpm: pc.feeRate - holdersPpm, totalPpm: gc.tradeFeeRate + pc.feeRate + pc.creatorFeeRate, totalTargetPpm: FEES.rates.totalTargetPpm };
  return ratesCache;
}

async function launch(creator: Keypair): Promise<PublicKey> {
  const uri = process.env.SIM_METADATA_URI;
  if (!uri) throw new Error("Set SIM_METADATA_URI to a metadata JSON (upload one through the launch page or Pinata).");
  const gc = await readGlobalConfig(conn, A.globalConfig);
  const init = curveInit({ supply: CURVE.supplyBaseUnits, totalSell: CURVE.sellOnCurveBaseUnits, totalFundRaising: CURVE.graduationTargetLamports, totalLocked: 0n, migrateFee: gc?.migrateFee ?? 0n });
  const mint = Keypair.generate();
  const symbol = `SIM${Math.floor(Math.random() * 9000 + 1000)}`;
  const { blockhash } = await conn.getLatestBlockhash();
  const r = buildLaunchTx({ programId: A.launchLabProgram, globalConfig: A.globalConfig, platformId, creator: creator.publicKey, mint: mint.publicKey, name: `Sim ${symbol}`, symbol, uri, decimals: CURVE.decimals, supply: CURVE.supplyBaseUnits, totalSell: CURVE.sellOnCurveBaseUnits, totalFundRaising: CURVE.graduationTargetLamports, initialCurve: newCurve(init, CURVE.sellOnCurveBaseUnits), rates: await liveRates(), firstBuyLamports: 100_000_000n, slippageBps: 300, blockhash });
  r.tx.sign([mint]);
  const sig = await send(r.tx, creator);
  console.log(`launched $${symbol} (${tickerKey(symbol)}) mint ${mint.publicKey.toBase58()}  ${sig}`);
  return mint.publicKey;
}

async function main() {
  if (!process.env.PLATFORM_CONFIG_PUBKEY) throw new Error("Set PLATFORM_CONFIG_PUBKEY (pnpm platform:create).");
  const wallets = Array.from({ length: nWallets }, (_, i) => wallet(i));
  for (const w of wallets) await fund(w, maxSol + 0.1);
  const mint = flag("launch") ? await launch(wallets[0]!) : new PublicKey(arg("mint") ?? "");
  const poolId = getPdaLaunchpadPoolId(A.launchLabProgram, mint, NATIVE_MINT).publicKey;
  for (let i = 0; i < nTrades; i++) {
    const pool = await fetchLaunchPool(conn, poolId);
    if (!pool) throw new Error("pool not found");
    if (pool.status !== 0) {
      console.log("the curve is complete; stopping");
      break;
    }
    const w = wallets[Math.floor(Math.random() * wallets.length)]!;
    const keys = launchPoolKeys(A.launchLabProgram, pool);
    const { blockhash } = await conn.getLatestBlockhash();
    let held = 0n;
    try {
      held = BigInt((await conn.getTokenAccountBalance(ata(w.publicKey, mint))).value.amount);
    } catch {
      held = 0n;
    }
    const sell = held > 0n && Math.random() < 0.35;
    try {
      if (sell) {
        const amount = (held * BigInt(Math.floor(Math.random() * 90 + 10))) / 100n;
        const r = buildSellTx({ owner: w.publicKey, keys, curve: curveStateOf(pool), rates: await liveRates(), amountIn: amount, slippageBps: 300, blockhash });
        console.log(`sell ${amount} by ${w.publicKey.toBase58().slice(0, 4)}  ${await send(r.tx, w)}`);
      } else {
        const lamports = BigInt(Math.floor((0.01 + Math.random() * (maxSol - 0.01)) * LAMPORTS_PER_SOL));
        const r = buildBuyTx({ owner: w.publicKey, keys, curve: curveStateOf(pool), rates: await liveRates(), amountIn: lamports, slippageBps: 300, blockhash });
        console.log(`buy ${Number(lamports) / 1e9} SOL by ${w.publicKey.toBase58().slice(0, 4)}  ${await send(r.tx, w)}`);
      }
    } catch (e) {
      console.log(`trade failed: ${(e as Error).message.split("\n")[0]}`);
    }
    await sleep(delay);
  }
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
