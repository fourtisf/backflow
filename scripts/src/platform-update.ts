/**
 * Update Backflow's PlatformConfig (one change per transaction, at most one per Solana epoch).
 *
 *   pnpm platform:update -- --sync                 compare chain with config/fees.json and propose the change
 *   pnpm platform:update -- --fee-rate 6750        platform fee (ppm)
 *   pnpm platform:update -- --creator-fee 1750     creator fee (ppm; only through updateAll)
 *   pnpm platform:update -- --cp-config <pubkey>   CPMM AmmConfig for graduations
 *   pnpm platform:update -- --cp-creator <pubkey>  platformCpCreator (leave unset: DECISIONS D-005)
 *   pnpm platform:update -- --claim-wallet <pubkey> | --lock-nft-wallet <pubkey>
 *   pnpm platform:update -- --require-cpmm         curve rule: launches under our platform must migrate to CPMM
 *
 * Add --send to sign with PLATFORM_ADMIN_KEYPAIR_PATH (devnet), or --squads <vault> to print unsigned
 * transactions for the multisig (mainnet). Without either it is a dry run.
 */
import { FEES, RATES, ppmPct } from "@backflow/core";
import { addresses, arg, cluster, connection, flag, loadKeypair, readPlatform } from "@backflow/chain";
import {
  LaunchpadCurveRuleField,
  LaunchpadCurveRuleOp,
  createPlatformCurveRuleIns,
  getPdaPlatformCurveRule,
  getPdaPlatformId,
  updatePlatformConfig,
  updatePlatformCurveRuleIns,
} from "@raydium-io/raydium-sdk-v2";
import { PublicKey, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";

const bn = (v: bigint | number) => new BN(v.toString());

async function main() {
  const c = cluster();
  const conn = connection(c);
  const A = addresses(c);
  const squads = arg("squads");
  const adminKp = squads || !flag("send") ? null : loadKeypair("PLATFORM_ADMIN_KEYPAIR_PATH");
  const adminPk = squads ? new PublicKey(squads) : adminKp ? adminKp.publicKey : loadKeypair("PLATFORM_ADMIN_KEYPAIR_PATH").publicKey;
  const platformId = getPdaPlatformId(A.launchLabProgram, adminPk).publicKey;
  const p = await readPlatform(conn, platformId);
  if (!p) throw new Error(`No platform at ${platformId.toBase58()} for admin ${adminPk.toBase58()}.`);
  console.log(`platform ${platformId.toBase58()} (epoch ${p.epoch})`);
  console.log(`  feeRate ${p.feeRate} (${ppmPct(p.feeRate)})  creatorFeeRate ${p.creatorFeeRate} (${ppmPct(p.creatorFeeRate)})  scales ${p.platformScale}/${p.creatorScale}/${p.burnScale}`);
  console.log(`  cpConfig ${p.cpConfigId}  cpCreator ${p.platformCpCreator}  restrictCurveParam ${p.restrictCurveParam}`);

  const prog = A.launchLabProgram;
  const txs: { label: string; ixs: TransactionInstruction[] }[] = [];
  const update = (label: string, info: Parameters<typeof updatePlatformConfig>[3]) => txs.push({ label, ixs: [updatePlatformConfig(prog, adminPk, platformId, info)] });
  const all = (over: Partial<{ creatorFeeRate: bigint; feeRate: bigint }>) =>
    update(`updateAll ${JSON.stringify(over, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`, {
      type: "updateAll",
      value: {
        platformClaimFeeWallet: new PublicKey(p.platformClaimFeeWallet),
        platformLockNftWallet: new PublicKey(p.platformLockNftWallet),
        platformVestingWallet: new PublicKey(p.platformVestingWallet),
        cpConfigId: new PublicKey(p.cpConfigId),
        migrateCpLockNftScale: { platformScale: bn(FEES.migrateCpLockNftScale.platformScale), creatorScale: bn(FEES.migrateCpLockNftScale.creatorScale), burnScale: bn(FEES.migrateCpLockNftScale.burnScale) },
        feeRate: bn(over.feeRate ?? p.feeRate),
        name: p.name,
        web: p.web,
        img: p.img,
        transferFeeExtensionAuth: new PublicKey(p.transferFeeExtensionAuth),
        creatorFeeRate: bn(over.creatorFeeRate ?? p.creatorFeeRate),
        platformVestingScale: bn(p.platformVestingScale),
      },
    });

  if (flag("sync")) {
    const needFee = p.feeRate !== RATES.platformFeePpm;
    const needCreator = p.creatorFeeRate !== RATES.creatorFeePpm;
    if (needCreator) all({ feeRate: RATES.platformFeePpm, creatorFeeRate: RATES.creatorFeePpm });
    else if (needFee) update(`updateFeeRate ${RATES.platformFeePpm}`, { type: "updateFeeRate", value: bn(RATES.platformFeePpm) });
    if (!txs.length) console.log("\nChain matches config/fees.json. Nothing to do.");
  }
  if (arg("fee-rate")) update(`updateFeeRate ${arg("fee-rate")}`, { type: "updateFeeRate", value: bn(BigInt(arg("fee-rate")!)) });
  if (arg("creator-fee")) all({ creatorFeeRate: BigInt(arg("creator-fee")!) });
  if (arg("cp-config")) txs.push({ label: `updateCpConfigId ${arg("cp-config")}`, ixs: [updatePlatformConfig(prog, adminPk, platformId, { type: "updateCpConfigId", value: new PublicKey(arg("cp-config")!) })] });
  if (arg("cp-creator")) update(`updatePlatformCpCreator ${arg("cp-creator")}`, { type: "updatePlatformCpCreator", value: new PublicKey(arg("cp-creator")!) });
  if (arg("claim-wallet")) update(`updateClaimFeeWallet ${arg("claim-wallet")}`, { type: "updateClaimFeeWallet", value: new PublicKey(arg("claim-wallet")!) });
  if (arg("lock-nft-wallet")) update(`updateLockNftWallet ${arg("lock-nft-wallet")}`, { type: "updateLockNftWallet", value: new PublicKey(arg("lock-nft-wallet")!) });
  if (flag("require-cpmm")) {
    const rule = getPdaPlatformCurveRule(prog, platformId, A.globalConfig).publicKey;
    const exists = await conn.getAccountInfo(rule);
    const ixs: TransactionInstruction[] = [];
    if (!exists) ixs.push(createPlatformCurveRuleIns(prog, adminPk, platformId, A.globalConfig, rule));
    ixs.push(updatePlatformCurveRuleIns(prog, adminPk, platformId, A.globalConfig, rule, 0, [{ field: LaunchpadCurveRuleField.MigrateType, op: LaunchpadCurveRuleOp.Eq, value: new BN(1) }]));
    txs.push({ label: `curve rule ${rule.toBase58()}: migrate_type = 1 (CPMM)`, ixs });
    if (p.restrictCurveParam !== 1) update("updateRestrictCurveParam 1 (next epoch: one platform update per epoch)", { type: "updateRestrictCurveParam", value: new BN(1) });
  }
  if (!txs.length) {
    if (!flag("sync")) console.log("\nNothing requested. See the header of scripts/src/platform-update.ts.");
    return;
  }
  const platformUpdates = txs.filter((t) => t.label.startsWith("update")).length;
  if (platformUpdates > 1) console.log(`\nNote: ${platformUpdates} platform updates requested; the program accepts one per epoch. Send them in separate epochs.`);
  for (const t of txs) {
    const tx = new Transaction().add(...t.ixs);
    tx.feePayer = adminPk;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    console.log(`\n${t.label}`);
    if (squads) {
      console.log(bs58.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
      continue;
    }
    if (!adminKp) {
      console.log("  dry run (add --send or --squads <vault>)");
      continue;
    }
    console.log(`  sent: ${await sendAndConfirmTransaction(conn, tx, [adminKp], { commitment: "confirmed" })}`);
    if (platformUpdates > 1) break; // one per epoch
  }
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
