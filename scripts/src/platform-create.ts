/**
 * Create Backflow's LaunchLab PlatformConfig (the "Platform PDA") with the
 * fees from config/fees.json.
 *
 *   pnpm platform:create            # dry run: checks, prints params, simulates
 *   pnpm platform:create --send     # sends the transaction
 *   pnpm platform:create --airdrop  # devnet only: airdrop 1 SOL to the admin first
 *   pnpm platform:create --squads <vault>  # mainnet: print an unsigned transaction for a Squads
 *                                    multisig vault to approve. The PDA is derived from the admin key and
 *                                    can never move, so the mainnet platform must be created BY the multisig.
 *
 * Idempotent: if the PDA for the admin key already exists, it prints it and
 * compares it with config instead of sending anything.
 *
 * Verified against @raydium-io/raydium-sdk-v2 0.2.81-alpha (docs/DECISIONS.md D-004).
 */
import { BRAND, CURVE, FEES, PPM, RATES, ppmPct } from "@backflow/core";
import { createPlatformConfig, getPdaPlatformId } from "@raydium-io/raydium-sdk-v2";
import { LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { pickTier, readAmmConfigs, readGlobalConfig, readPlatform, type PlatformInfo } from "@backflow/chain";
import { addresses, arg, cluster, connection, flag, loadKeypair, pubkeyFrom, rpcUrl } from "@backflow/chain";

const bn = (v: bigint) => new BN(v.toString());
const ok = (b: boolean) => (b ? "ok  " : "FAIL");

function comparePlatform(p: PlatformInfo): string[] {
  const s = FEES.migrateCpLockNftScale;
  const diffs: string[] = [];
  if (p.feeRate !== RATES.platformFeePpm) diffs.push(`feeRate on chain ${p.feeRate}, config ${RATES.platformFeePpm}`);
  if (p.creatorFeeRate !== RATES.creatorFeePpm) diffs.push(`creatorFeeRate on chain ${p.creatorFeeRate}, config ${RATES.creatorFeePpm}`);
  if (p.platformScale !== s.platformScale || p.creatorScale !== s.creatorScale || p.burnScale !== s.burnScale) {
    diffs.push(`lock scales on chain ${p.platformScale}/${p.creatorScale}/${p.burnScale}, config ${s.platformScale}/${s.creatorScale}/${s.burnScale}`);
  }
  return diffs;
}

async function main() {
  const c = cluster();
  const conn = connection(c);
  const A = addresses(c);
  console.log(`cluster ${c}  rpc ${rpcUrl(c).replace(/api-key=[^&]+/, "api-key=…")}`);

  const squads = arg("squads");
  const adminKp = squads ? null : loadKeypair("PLATFORM_ADMIN_KEYPAIR_PATH");
  const admin = { publicKey: squads ? new PublicKey(squads) : adminKp!.publicKey };
  const claimFeeWallet = pubkeyFrom("PLATFORM_FEE_WALLET_KEYPAIR_PATH");
  // The Fee Key NFT owner must also pay the harvest tx fee (SDK derives the NFT ATA from feePayer),
  // so it defaults to the platform fee wallet, a hot key the harvest worker holds.
  const lockNftWallet = pubkeyFrom("PLATFORM_LOCK_NFT_WALLET", claimFeeWallet);
  const vestingWallet = pubkeyFrom("PLATFORM_VESTING_WALLET", PublicKey.default);
  const transferFeeAuth = pubkeyFrom("TRANSFER_FEE_EXTENSION_AUTH", admin.publicKey);
  const { publicKey: platformId } = getPdaPlatformId(A.launchLabProgram, admin.publicKey);

  console.log(`admin            ${admin.publicKey.toBase58()}`);
  console.log(`platform PDA     ${platformId.toBase58()}`);

  if (flag("airdrop")) {
    if (c !== "devnet") throw new Error("--airdrop is devnet only");
    const sig = await conn.requestAirdrop(admin.publicKey, LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    console.log(`airdropped 1 SOL: ${sig}`);
  }

  const existing = await readPlatform(conn, platformId);
  if (existing) {
    console.log("\nPlatform already exists:");
    console.log(JSON.stringify(existing, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    const diffs = comparePlatform(existing);
    if (diffs.length) {
      console.log("\nOn-chain values differ from config/fees.json:\n  " + diffs.join("\n  "));
      console.log("Use updatePlatformConfig (one update per epoch; creator fee only via updateAll).");
      process.exitCode = 2;
    } else console.log("\nMatches config/fees.json.");
    console.log(`\nPLATFORM_CONFIG_PUBKEY=${platformId.toBase58()}`);
    return;
  }

  // ---- GlobalConfig checks (VERIFY: protocol fee and floors) ----
  const gc = await readGlobalConfig(conn, A.globalConfig);
  if (!gc) throw new Error(`GlobalConfig ${A.globalConfig.toBase58()} not found on ${c}.`);
  const supply = CURVE.supplyBaseUnits;
  const sell = CURVE.sellOnCurveBaseUnits;
  const locked = CURVE.vestingLocked * 10n ** BigInt(CURVE.decimals);
  const migrate = supply - sell - locked;
  console.log(`\nGlobalConfig ${A.globalConfig.toBase58()} (curve ${gc.curveType}, index ${gc.index}, quote ${gc.mintB})`);
  console.log(`  trade_fee_rate     ${gc.tradeFeeRate} (${ppmPct(gc.tradeFeeRate)})   config expects ${RATES.raydiumProtocolPpm} (${ppmPct(RATES.raydiumProtocolPpm)})`);
  console.log(`  migrate_fee        ${gc.migrateFee}`);
  console.log(`  max_share_fee_rate ${gc.maxShareFeeRate}`);
  console.log(`  requires_platform_auth ${gc.requiresPlatformAuth ?? "n/a"}`);
  console.log(`  ${ok(supply >= gc.minSupplyA * 10n ** BigInt(CURVE.decimals))} supply ${supply} >= min_base_supply ${gc.minSupplyA} × 10^${CURVE.decimals}`);
  console.log(`  ${ok(sell * PPM >= supply * gc.minSellRateA)} sold on curve ${sell} >= ${gc.minSellRateA} ppm of supply`);
  console.log(`  ${ok(migrate * PPM >= supply * gc.minMigrateRateA)} left for pool ${migrate} >= ${gc.minMigrateRateA} ppm of supply`);
  console.log(`  ${ok(locked * PPM <= supply * gc.maxLockRate)} locked ${locked} <= ${gc.maxLockRate} ppm of supply`);
  console.log(`  ${ok(CURVE.graduationTargetLamports >= gc.minFundRaisingB)} graduation ${CURVE.graduationTargetLamports} >= min_quote_fund_raising ${gc.minFundRaisingB}`);
  if (gc.tradeFeeRate !== RATES.raydiumProtocolPpm) {
    const total = gc.tradeFeeRate + RATES.platformFeePpm + RATES.creatorFeePpm;
    console.log(`\nThe live Raydium protocol fee is ${ppmPct(gc.tradeFeeRate)}, so traders would pay ${ppmPct(total)}, not ${ppmPct(RATES.totalPpm)}.`);
    console.log("SPEC §2.1: do not change rates silently. The owner decides. Re-run with --accept-protocol-fee to continue anyway.");
    if (!flag("accept-protocol-fee")) {
      process.exitCode = 3;
      return;
    }
  }
  if (gc.requiresPlatformAuth === 1) {
    console.log("\nThis GlobalConfig requires platform authorization from Raydium. Launches may fail until Raydium allows our platform.");
  }

  // ---- CPMM fee tier (SPEC §2.2: closest to 1%) ----
  let cpConfigId: PublicKey;
  const envCp = process.env.CP_CONFIG_ID;
  const tiers = await readAmmConfigs(conn, A.cpmmProgram);
  console.log(`\nCPMM AmmConfig tiers on ${c}:`);
  for (const t of tiers) {
    console.log(
      `  #${t.index} ${t.id}  trade ${ppmPct(t.tradeFeeRate)}  protocol ${t.protocolFeeRate} ppm of fee  fund ${t.fundFeeRate} ppm of fee  creator ${ppmPct(t.creatorFeeRate)}${t.disableCreatePool ? "  (disabled)" : ""}`,
    );
  }
  if (arg("cp-config")) cpConfigId = new PublicKey(arg("cp-config")!);
  else if (envCp && !envCp.startsWith("REPLACE")) cpConfigId = new PublicKey(envCp);
  else {
    const pick = pickTier(tiers, 10_000n);
    if (!pick) throw new Error("No usable CPMM AmmConfig found. Pass --cp-config <pubkey>.");
    cpConfigId = new PublicKey(pick.id);
    console.log(`  picked #${pick.index} (closest to 1%)`);
  }

  // ---- build ----
  const site = (process.env.PUBLIC_SITE_URL || `https://${BRAND.domain}`).replace(/\/$/, "");
  const s = FEES.migrateCpLockNftScale;
  const params = {
    programId: A.launchLabProgram.toBase58(),
    platformAdmin: admin.publicKey.toBase58(),
    platformClaimFeeWallet: claimFeeWallet.toBase58(),
    platformLockNftWallet: lockNftWallet.toBase58(),
    platformVestingWallet: vestingWallet.toBase58(),
    platformId: platformId.toBase58(),
    cpConfigId: cpConfigId.toBase58(),
    transferFeeExtensionAuth: transferFeeAuth.toBase58(),
    migrateCpLockNftScale: { platformScale: s.platformScale.toString(), creatorScale: s.creatorScale.toString(), burnScale: s.burnScale.toString() },
    feeRate: `${RATES.platformFeePpm} (${ppmPct(RATES.platformFeePpm)})`,
    creatorFeeRate: `${RATES.creatorFeePpm} (${ppmPct(RATES.creatorFeePpm)})`,
    name: BRAND.name,
    web: site,
    img: `${site}/icon.svg`,
    platformVestingScale: "0",
  };
  console.log("\ncreate_platform_config params:");
  console.log(JSON.stringify(params, null, 2));

  const ix = createPlatformConfig(
    A.launchLabProgram,
    admin.publicKey,
    claimFeeWallet,
    lockNftWallet,
    vestingWallet,
    platformId,
    cpConfigId,
    transferFeeAuth,
    { platformScale: bn(s.platformScale), creatorScale: bn(s.creatorScale), burnScale: bn(s.burnScale) },
    bn(RATES.platformFeePpm),
    bn(RATES.creatorFeePpm),
    params.name,
    params.web,
    params.img,
    new BN(0),
  );
  const tx = new Transaction().add(ix);
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  if (squads) {
    console.log("\nUnsigned transaction for the Squads vault (base58, import it in Squads → Developers → TX builder):");
    console.log(bs58.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
    console.log(`\nAfter it executes: PLATFORM_CONFIG_PUBKEY=${platformId.toBase58()}`);
    return;
  }
  tx.sign(adminKp!);

  const sim = await conn.simulateTransaction(tx);
  console.log("\nsimulation:", sim.value.err ? `FAILED ${JSON.stringify(sim.value.err)}` : "ok");
  for (const l of sim.value.logs ?? []) console.log("  " + l);
  if (sim.value.err) {
    process.exitCode = 4;
    return;
  }

  if (!flag("send")) {
    console.log("\nDry run. Nothing was sent. Re-run with --send to create the platform.");
    return;
  }
  const sig = await sendAndConfirmTransaction(conn, tx, [adminKp!], { commitment: "confirmed" });
  console.log(`\nsent: ${sig}`);
  const created = await readPlatform(conn, platformId);
  if (!created) throw new Error("Transaction confirmed but the platform account was not found.");
  const diffs = comparePlatform(created);
  console.log(diffs.length ? `\nMISMATCH:\n  ${diffs.join("\n  ")}` : "\nCreated and matches config/fees.json.");
  console.log(`\nAdd to .env:\nPLATFORM_CONFIG_PUBKEY=${platformId.toBase58()}\nCP_CONFIG_ID=${cpConfigId.toBase58()}`);
}

main().catch((e) => {
  console.error("\n" + ((e as Error).message ?? e));
  process.exit(1);
});
