import { CURVE, RAYDIUM, RATES, curveInit, newCurve } from "@backflow/core";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSetAuthorityInstruction, createTransferInstruction, AuthorityType } from "@solana/spl-token";
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction, type TransactionInstruction as Ix } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { ata, predictedPoolKeys, type CpmmPool } from "../src/pool";
import { buildBuyTx, buildLaunchTx, buildSellTx, claimCpmmCreatorFeeInstructions, claimCreatorFeeInstructions, compile, cpmmBuyInstructions, cpmmSellInstructions } from "../src/tx";
import { checkUserTx, userTxPrograms, wsolAccountOf } from "../src/verify";

const SOL = 1_000_000_000n;
const R = RAYDIUM.devnet;
const programs = userTxPrograms("devnet");
const launchLab = new PublicKey(R.launchLabProgram);
const cpmmProgram = new PublicKey(R.cpmmProgram);
const cpmmAuth = new PublicKey(R.cpmmAuth);
const globalConfig = new PublicKey(R.globalConfigWsolCp);
const platformId = Keypair.generate().publicKey;
const user = Keypair.generate().publicKey;
const attacker = Keypair.generate().publicKey;
const blockhash = PublicKey.default.toBase58();
const init = curveInit({ supply: CURVE.supplyBaseUnits, totalSell: CURVE.sellOnCurveBaseUnits, totalFundRaising: CURVE.graduationTargetLamports, totalLocked: 0n, migrateFee: 0n });
const curve = newCurve(init, CURVE.sellOnCurveBaseUnits);
const coinMint = Keypair.generate().publicKey;
const keys = predictedPoolKeys(launchLab, coinMint, NATIVE_MINT, globalConfig, platformId, Keypair.generate().publicKey);
const fees = { priorityMicroLamports: 20_000 };

const pool: CpmmPool = {
  id: Keypair.generate().publicKey,
  configId: Keypair.generate().publicKey,
  poolCreator: user,
  vaultA: Keypair.generate().publicKey,
  vaultB: Keypair.generate().publicKey,
  mintLp: Keypair.generate().publicKey,
  mintA: NATIVE_MINT,
  mintB: coinMint,
  mintProgramA: TOKEN_PROGRAM_ID,
  mintProgramB: TOKEN_PROGRAM_ID,
  observationId: Keypair.generate().publicKey,
  status: 0,
  protocolFeesA: 0n,
  protocolFeesB: 0n,
  fundFeesA: 0n,
  fundFeesB: 0n,
  creatorFeesA: 0n,
  creatorFeesB: 0n,
  feeOn: 2,
  enableCreatorFee: true,
};

/** A shared lookup table like BACKFLOW_ALT: program ids and platform accounts, never per-user accounts. */
function sharedLut(extra: PublicKey[] = []) {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [TOKEN_PROGRAM_ID, NATIVE_MINT, globalConfig, platformId, keys.auth, keys.platformFeeVault, SystemProgram.programId, ...extra] },
  });
}

function launch(firstBuyLamports: bigint, creator = user) {
  return buildLaunchTx({
    programId: launchLab,
    globalConfig,
    platformId,
    creator,
    mint: Keypair.generate().publicKey,
    name: "Mochi",
    symbol: "MOCHI",
    uri: "https://gateway.pinata.cloud/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    decimals: 6,
    supply: CURVE.supplyBaseUnits,
    totalSell: CURVE.sellOnCurveBaseUnits,
    totalFundRaising: CURVE.graduationTargetLamports,
    initialCurve: curve,
    rates: RATES,
    firstBuyLamports,
    slippageBps: 100,
    blockhash,
    luts: [sharedLut()],
    fees,
  }).tx;
}

const trade = (side: "buy" | "sell") => (side === "buy" ? buildBuyTx : buildSellTx)({ owner: user, keys, curve, rates: RATES, amountIn: side === "buy" ? SOL : 1_000_000n, slippageBps: 100, blockhash, luts: [sharedLut()], fees }).tx;
const withIxs = (ixs: Ix[], payer = user, luts = [sharedLut()]) => compile(payer, ixs, blockhash, luts);
const check = (tx: VersionedTransaction) => checkUserTx(tx, user, programs);
/** Round-trip through bytes, the way the web receives it. */
const wire = (tx: VersionedTransaction) => VersionedTransaction.deserialize(tx.serialize());

describe("checkUserTx accepts every transaction Backflow builds for a user", () => {
  const cases: [string, () => VersionedTransaction][] = [
    ["launch without a first buy", () => launch(0n)],
    ["launch with a first buy", () => launch(SOL)],
    ["curve buy", () => trade("buy")],
    ["curve sell", () => trade("sell")],
    ["creator fee claim", () => withIxs([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }), ...claimCreatorFeeInstructions(launchLab, user)])],
    ["CPMM buy", () => withIxs(cpmmBuyInstructions({ owner: user, cpmmProgram, cpmmAuth, pool, coinMint, amountIn: SOL, minOut: 1n, fees }))],
    ["CPMM sell", () => withIxs(cpmmSellInstructions({ owner: user, cpmmProgram, cpmmAuth, pool, coinMint, amountIn: 1_000n, minOut: 1n, fees }))],
    ["CPMM creator fee claim", () => withIxs([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }), ...claimCpmmCreatorFeeInstructions({ creator: user, cpmmProgram, cpmmAuth, pool })])],
    ["a trade without a lookup table", () => buildBuyTx({ owner: user, keys, curve, rates: RATES, amountIn: SOL, slippageBps: 100, blockhash, fees }).tx],
  ];
  for (const [name, build] of cases) {
    it(name, () => {
      expect(check(wire(build()))).toEqual({ ok: true });
    });
  }
});

describe("checkUserTx refuses tampered transactions", () => {
  const expectBad = (tx: VersionedTransaction, reason: RegExp) => {
    const r = check(wire(tx));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  };
  const buyIxs = () => cpmmBuyInstructions({ owner: user, cpmmProgram, cpmmAuth, pool, coinMint, amountIn: SOL, minOut: 1n, fees });

  it("a transaction paid by another wallet", () => {
    expectBad(withIxs(buyIxs(), attacker), /fee payer/);
    expectBad(launch(SOL, attacker), /fee payer/);
  });

  it("an extra SOL transfer to someone else", () => {
    expectBad(withIxs([...buyIxs(), SystemProgram.transfer({ fromPubkey: user, toPubkey: attacker, lamports: SOL })]), /isn't your own wSOL/);
  });

  it("a SOL transfer whose destination hides in a lookup table", () => {
    expectBad(withIxs([...buyIxs(), SystemProgram.transfer({ fromPubkey: user, toPubkey: attacker, lamports: SOL })], user, [sharedLut([attacker])]), /isn't your own wSOL/);
  });

  it("other System instructions", () => {
    expectBad(withIxs([SystemProgram.assign({ accountPubkey: user, programId: attacker })]), /System/);
  });

  it("an SPL Approve, a SetAuthority or a token Transfer", () => {
    const mine = ata(user, coinMint);
    expectBad(withIxs([...buyIxs(), createApproveInstruction(mine, attacker, user, 10n ** 15n)]), /Approve/);
    expectBad(withIxs([...buyIxs(), createSetAuthorityInstruction(mine, user, AuthorityType.AccountOwner, attacker)]), /SetAuthority/);
    expectBad(withIxs([...buyIxs(), createTransferInstruction(mine, ata(attacker, coinMint), user, 1n)]), /unexpected token instruction 3/);
  });

  it("a token account closed to someone else", () => {
    const ixs = buyIxs();
    ixs[ixs.length - 1] = createCloseAccountInstruction(wsolAccountOf(user), attacker, user);
    expectBad(withIxs(ixs), /closed to someone else/);
  });

  it("an unknown program", () => {
    expectBad(withIxs([...buyIxs(), new TransactionInstruction({ programId: attacker, keys: [{ pubkey: user, isSigner: true, isWritable: true }], data: Buffer.from([1]) })]), /unexpected program/);
    // mainnet LaunchLab while the web runs on devnet
    expectBad(withIxs([new TransactionInstruction({ programId: new PublicKey(RAYDIUM["mainnet-beta"].launchLabProgram), keys: [], data: Buffer.from([1]) })]), /unexpected program/);
  });

  it("a token account created for someone else", () => {
    expectBad(withIxs([createAssociatedTokenAccountIdempotentInstruction(user, ata(attacker, coinMint), attacker, coinMint), ...buyIxs()]), /for someone else/);
  });

  it("an extreme priority fee", () => {
    expectBad(withIxs([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000_000 }), ...buyIxs()]), /priority fee/);
  });
});
