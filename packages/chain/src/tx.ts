/**
 * Transaction builders for every Backflow on-chain action. Instruction
 * builders come from @raydium-io/raydium-sdk-v2 0.2.81-alpha; we assemble
 * transactions ourselves so a launch and its first buy share ONE transaction
 * (SPEC §4) and so no Raydium HTTP API is needed (DECISIONS D-006).
 */
import { minOutWithSlippage, quoteBuy, quoteSell, type CurveState, type FeeRates } from "@backflow/core";
import {
  buyExactInInstruction,
  claimCreatorFee,
  claimPlatformFeeFromVault,
  collectCpFeeInstruction,
  getPdaMetadataKey,
  initializeV2,
  makeCollectCreatorFeeInstruction,
  makeSwapCpmmBaseInInstruction,
  sellExactInInstruction,
} from "@raydium-io/raydium-sdk-v2";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { ata, lockedPositionAddress, predictedPoolKeys, type CpmmPool, type LaunchPoolKeys } from "./pool";

const bn = (v: bigint) => new BN(v.toString());
export const U64_MAX = (1n << 64n) - 1n;
export const MAX_TX_BYTES = 1232;

export interface FeeOpts {
  /** Compute unit limit; omitted = runtime default. */
  computeUnits?: number;
  /** Priority fee in micro-lamports per CU. */
  priorityMicroLamports?: number;
}

function budgetIxs(o: FeeOpts): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];
  if (o.computeUnits) out.push(ComputeBudgetProgram.setComputeUnitLimit({ units: o.computeUnits }));
  if (o.priorityMicroLamports) out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.priorityMicroLamports }));
  return out;
}

/** Compile to a v0 transaction (with an optional lookup table) and check the size limit. */
export function compile(payer: PublicKey, ixs: TransactionInstruction[], blockhash: string, luts: AddressLookupTableAccount[] = []): VersionedTransaction {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(luts);
  const tx = new VersionedTransaction(msg);
  const size = serializedSize(tx);
  if (size > MAX_TX_BYTES) throw new Error(`transaction is ${size === Number.MAX_SAFE_INTEGER ? "far more than" : size} bytes, over the ${MAX_TX_BYTES}-byte limit${luts.length ? "" : " (add an address lookup table: pnpm alt:create)"}`);
  return tx;
}

/** Serialized size of a transaction, counting placeholder signatures. */
export function txSize(payer: PublicKey, ixs: TransactionInstruction[], luts: AddressLookupTableAccount[] = []): number {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message(luts);
  return serializedSize(new VersionedTransaction(msg));
}

/** web3.js throws while encoding very large transactions; treat that as "too big". */
function serializedSize(tx: VersionedTransaction): number {
  try {
    return tx.serialize().length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/* ------------------------------ wSOL helpers ------------------------------ */

function wrapSolIxs(owner: PublicKey, lamports: bigint): { account: PublicKey; ixs: TransactionInstruction[] } {
  const account = ata(owner, NATIVE_MINT);
  return {
    account,
    ixs: [
      createAssociatedTokenAccountIdempotentInstruction(owner, account, owner, NATIVE_MINT),
      ...(lamports > 0n ? [SystemProgram.transfer({ fromPubkey: owner, toPubkey: account, lamports }), createSyncNativeInstruction(account)] : []),
    ],
  };
}

function curveTradeIxs(side: "buy" | "sell", owner: PublicKey, k: LaunchPoolKeys, amountIn: bigint, minOut: bigint): TransactionInstruction[] {
  const userA = ata(owner, k.mintA, k.mintProgramA);
  const ixs: TransactionInstruction[] = [createAssociatedTokenAccountIdempotentInstruction(owner, userA, owner, k.mintA, k.mintProgramA)];
  const wsol = wrapSolIxs(owner, side === "buy" ? amountIn : 0n);
  ixs.push(...wsol.ixs);
  const args = [k.programId, owner, k.auth, k.configId, k.platformId, k.poolId, userA, wsol.account, k.vaultA, k.vaultB, k.mintA, k.mintB, k.mintProgramA, k.mintProgramB, k.platformFeeVault, k.creatorFeeVault] as const;
  ixs.push(side === "buy" ? buyExactInInstruction(...args, bn(amountIn), bn(minOut)) : sellExactInInstruction(...args, bn(amountIn), bn(minOut)));
  // unwrap: close the wSOL account back to SOL
  ixs.push(createCloseAccountInstruction(wsol.account, owner, owner));
  return ixs;
}

/* --------------------------------- launch ---------------------------------- */

export interface LaunchParams {
  programId: PublicKey;
  globalConfig: PublicKey;
  platformId: PublicKey;
  /** The user's wallet: payer and creator. */
  creator: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  decimals: number;
  supply: bigint;
  totalSell: bigint;
  totalFundRaising: bigint;
  /** Curve right after initialize, to quote the first buy. */
  initialCurve: CurveState;
  rates: FeeRates;
  firstBuyLamports: bigint;
  slippageBps: number;
  blockhash: string;
  luts?: AddressLookupTableAccount[];
  fees?: FeeOpts;
}

/**
 * initialize_v2 (SPL Token mint, constant-product curve, CPMM migration) and,
 * optionally, the creator's first buy in the same transaction. The mint
 * keypair must also sign (the caller adds that signature).
 */
export function buildLaunchTx(p: LaunchParams): { tx: VersionedTransaction; poolId: PublicKey; expectedTokens: bigint; minTokens: bigint } {
  const k = predictedPoolKeys(p.programId, p.mint, NATIVE_MINT, p.globalConfig, p.platformId, p.creator);
  const ixs: TransactionInstruction[] = [...budgetIxs({ computeUnits: p.firstBuyLamports > 0n ? 500_000 : 300_000, ...p.fees })];
  ixs.push(
    initializeV2(
      p.programId,
      p.creator,
      p.creator,
      p.globalConfig,
      p.platformId,
      k.auth,
      k.poolId,
      p.mint,
      NATIVE_MINT,
      k.vaultA,
      k.vaultB,
      getPdaMetadataKey(p.mint).publicKey,
      TOKEN_PROGRAM_ID,
      p.decimals,
      p.name,
      p.symbol,
      p.uri,
      { type: "ConstantCurve", totalSellA: bn(p.totalSell), migrateType: "cpmm", supply: bn(p.supply), totalFundRaisingB: bn(p.totalFundRaising) },
      new BN(0),
      new BN(0),
      new BN(0),
      0, // CpmmCreatorFeeOn.OnlyTokenB: creator fee after graduation in SOL only
    ),
  );
  let expectedTokens = 0n;
  let minTokens = 0n;
  if (p.firstBuyLamports > 0n) {
    const q = quoteBuy(p.initialCurve, p.firstBuyLamports, p.rates);
    expectedTokens = q.amountOut;
    minTokens = minOutWithSlippage(q.amountOut, p.slippageBps);
    ixs.push(...curveTradeIxs("buy", p.creator, k, p.firstBuyLamports, minTokens));
  }
  return { tx: compile(p.creator, ixs, p.blockhash, p.luts), poolId: k.poolId, expectedTokens, minTokens };
}

/* --------------------------------- trades ---------------------------------- */

export interface CurveTradeParams {
  owner: PublicKey;
  keys: LaunchPoolKeys;
  curve: CurveState;
  rates: FeeRates;
  /** Lamports in (buy) or token base units in (sell). */
  amountIn: bigint;
  slippageBps: number;
  blockhash: string;
  luts?: AddressLookupTableAccount[];
  fees?: FeeOpts;
}

export function buildBuyTx(p: CurveTradeParams): { tx: VersionedTransaction; expectedOut: bigint; minOut: bigint; amountIn: bigint } {
  const q = quoteBuy(p.curve, p.amountIn, p.rates);
  const minOut = minOutWithSlippage(q.amountOut, p.slippageBps);
  const ixs = [...budgetIxs({ computeUnits: 250_000, ...p.fees }), ...curveTradeIxs("buy", p.owner, p.keys, q.amountIn, minOut)];
  return { tx: compile(p.owner, ixs, p.blockhash, p.luts), expectedOut: q.amountOut, minOut, amountIn: q.amountIn };
}

export function buildSellTx(p: CurveTradeParams): { tx: VersionedTransaction; expectedOut: bigint; minOut: bigint } {
  const q = quoteSell(p.curve, p.amountIn, p.rates);
  const minOut = minOutWithSlippage(q.amountOut, p.slippageBps);
  const ixs = [...budgetIxs({ computeUnits: 250_000, ...p.fees }), ...curveTradeIxs("sell", p.owner, p.keys, p.amountIn, minOut)];
  return { tx: compile(p.owner, ixs, p.blockhash, p.luts), expectedOut: q.amountOut, minOut };
}

/** Instructions only, for the buyback worker (it signs with its own key). */
export function curveBuyInstructions(owner: PublicKey, keys: LaunchPoolKeys, amountIn: bigint, minOut: bigint, fees: FeeOpts = {}): TransactionInstruction[] {
  return [...budgetIxs({ computeUnits: 250_000, ...fees }), ...curveTradeIxs("buy", owner, keys, amountIn, minOut)];
}

/** CPMM swap SOL → coin (post-graduation buybacks). */
export function cpmmBuyInstructions(p: { owner: PublicKey; cpmmProgram: PublicKey; cpmmAuth: PublicKey; pool: CpmmPool; coinMint: PublicKey; amountIn: bigint; minOut: bigint; fees?: FeeOpts }): TransactionInstruction[] {
  const coinIsA = p.pool.mintA.equals(p.coinMint);
  const coinProgram = coinIsA ? p.pool.mintProgramA : p.pool.mintProgramB;
  const userCoin = ata(p.owner, p.coinMint, coinProgram);
  const wsol = wrapSolIxs(p.owner, p.amountIn);
  return [
    ...budgetIxs({ computeUnits: 200_000, ...p.fees }),
    createAssociatedTokenAccountIdempotentInstruction(p.owner, userCoin, p.owner, p.coinMint, coinProgram),
    ...wsol.ixs,
    makeSwapCpmmBaseInInstruction(
      p.cpmmProgram,
      p.owner,
      p.cpmmAuth,
      p.pool.configId,
      p.pool.id,
      wsol.account,
      userCoin,
      coinIsA ? p.pool.vaultB : p.pool.vaultA,
      coinIsA ? p.pool.vaultA : p.pool.vaultB,
      TOKEN_PROGRAM_ID,
      coinProgram,
      NATIVE_MINT,
      p.coinMint,
      p.pool.observationId,
      bn(p.amountIn),
      bn(p.minOut),
    ),
    createCloseAccountInstruction(wsol.account, p.owner, p.owner),
  ];
}

/** CPMM swap coin → SOL for a user (post-graduation sells). SOL arrives unwrapped. */
export function cpmmSellInstructions(p: { owner: PublicKey; cpmmProgram: PublicKey; cpmmAuth: PublicKey; pool: CpmmPool; coinMint: PublicKey; amountIn: bigint; minOut: bigint; fees?: FeeOpts }): TransactionInstruction[] {
  const coinIsA = p.pool.mintA.equals(p.coinMint);
  const coinProgram = coinIsA ? p.pool.mintProgramA : p.pool.mintProgramB;
  const userCoin = ata(p.owner, p.coinMint, coinProgram);
  const wsol = wrapSolIxs(p.owner, 0n);
  return [
    ...budgetIxs({ computeUnits: 200_000, ...p.fees }),
    ...wsol.ixs,
    makeSwapCpmmBaseInInstruction(
      p.cpmmProgram,
      p.owner,
      p.cpmmAuth,
      p.pool.configId,
      p.pool.id,
      userCoin,
      wsol.account,
      coinIsA ? p.pool.vaultA : p.pool.vaultB,
      coinIsA ? p.pool.vaultB : p.pool.vaultA,
      coinProgram,
      TOKEN_PROGRAM_ID,
      p.coinMint,
      NATIVE_MINT,
      p.pool.observationId,
      bn(p.amountIn),
      bn(p.minOut),
    ),
    createCloseAccountInstruction(wsol.account, p.owner, p.owner),
  ];
}

/** The pool creator collects CPMM creator fees after graduation (SPEC §2.2). wSOL is unwrapped. */
export function claimCpmmCreatorFeeInstructions(p: { creator: PublicKey; cpmmProgram: PublicKey; cpmmAuth: PublicKey; pool: CpmmPool }): TransactionInstruction[] {
  const a = ata(p.creator, p.pool.mintA, p.pool.mintProgramA);
  const b = ata(p.creator, p.pool.mintB, p.pool.mintProgramB);
  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(p.creator, a, p.creator, p.pool.mintA, p.pool.mintProgramA),
    createAssociatedTokenAccountIdempotentInstruction(p.creator, b, p.creator, p.pool.mintB, p.pool.mintProgramB),
    makeCollectCreatorFeeInstruction(p.cpmmProgram, p.creator, p.cpmmAuth, p.pool.id, p.pool.configId, p.pool.vaultA, p.pool.vaultB, p.pool.mintA, p.pool.mintB, a, b, p.pool.mintProgramA, p.pool.mintProgramB),
  ];
  if (p.pool.mintA.equals(NATIVE_MINT)) ixs.push(createCloseAccountInstruction(a, p.creator, p.creator));
  if (p.pool.mintB.equals(NATIVE_MINT)) ixs.push(createCloseAccountInstruction(b, p.creator, p.creator));
  return ixs;
}

/* --------------------------------- claims ---------------------------------- */

const vaultAuth = (programId: PublicKey, seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed, "utf8")], programId)[0];

/** Creator claims their LaunchLab creator fees (all their coins; DECISIONS D-007). Paid as wSOL, then unwrapped. */
export function claimCreatorFeeInstructions(programId: PublicKey, creator: PublicKey): TransactionInstruction[] {
  const recipient = ata(creator, NATIVE_MINT);
  const vault = PublicKey.findProgramAddressSync([creator.toBuffer(), NATIVE_MINT.toBuffer()], programId)[0];
  return [
    createAssociatedTokenAccountIdempotentInstruction(creator, recipient, creator, NATIVE_MINT),
    claimCreatorFee(programId, creator, vaultAuth(programId, "creator_fee_vault_auth_seed"), vault, recipient, NATIVE_MINT, TOKEN_PROGRAM_ID),
    createCloseAccountInstruction(recipient, creator, creator),
  ];
}

export function creatorFeeVault(programId: PublicKey, creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([creator.toBuffer(), NATIVE_MINT.toBuffer()], programId)[0];
}

export function platformFeeVault(programId: PublicKey, platformId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([platformId.toBuffer(), NATIVE_MINT.toBuffer()], programId)[0];
}

/** Platform claim-fee wallet sweeps the shared platform fee vault (SPEC §6.3), unwrapped to SOL. */
export function claimPlatformVaultInstructions(programId: PublicKey, platformId: PublicKey, claimWallet: PublicKey): TransactionInstruction[] {
  const recipient = ata(claimWallet, NATIVE_MINT);
  return [
    createAssociatedTokenAccountIdempotentInstruction(claimWallet, recipient, claimWallet, NATIVE_MINT),
    claimPlatformFeeFromVault(programId, platformId, claimWallet, vaultAuth(programId, "platform_fee_vault_auth_seed"), platformFeeVault(programId, platformId), recipient, NATIVE_MINT, TOKEN_PROGRAM_ID),
    createCloseAccountInstruction(recipient, claimWallet, claimWallet),
  ];
}

/** Harvest LP fees of a platform-owned locked CPMM position (Fee Key). u64::MAX = collect everything (raydium-cpi docs). */
export function harvestInstructions(p: { lockProgram: PublicKey; lockAuth: PublicKey; cpmmProgram: PublicKey; cpmmAuth: PublicKey; nftOwner: PublicKey; nftMint: PublicKey; pool: CpmmPool }): TransactionInstruction[] {
  const userA = ata(p.nftOwner, p.pool.mintA, p.pool.mintProgramA);
  const userB = ata(p.nftOwner, p.pool.mintB, p.pool.mintProgramB);
  return [
    createAssociatedTokenAccountIdempotentInstruction(p.nftOwner, userA, p.nftOwner, p.pool.mintA, p.pool.mintProgramA),
    createAssociatedTokenAccountIdempotentInstruction(p.nftOwner, userB, p.nftOwner, p.pool.mintB, p.pool.mintProgramB),
    collectCpFeeInstruction({
      programId: p.lockProgram,
      nftOwner: p.nftOwner,
      auth: p.lockAuth,
      nftMint: p.nftMint,
      nftAccount: ata(p.nftOwner, p.nftMint, TOKEN_PROGRAM_ID),
      lockPda: lockedPositionAddress(p.lockProgram, p.nftMint),
      poolId: p.pool.id,
      mintLp: p.pool.mintLp,
      userVaultA: userA,
      userVaultB: userB,
      poolVaultA: p.pool.vaultA,
      poolVaultB: p.pool.vaultB,
      mintA: p.pool.mintA,
      mintB: p.pool.mintB,
      lockLpVault: ata(p.lockAuth, p.pool.mintLp, TOKEN_PROGRAM_ID),
      lpFeeAmount: bn(U64_MAX),
      cpmmProgram: p.cpmmProgram,
      cpmmAuthProgram: p.cpmmAuth,
    }),
  ];
}

/* -------------------------------- transfers -------------------------------- */

export interface TokenTransfer {
  wallet: PublicKey;
  amount: bigint;
}

/**
 * Batched SPL transfers from the distributor's token account to each wallet's
 * associated token account (SPEC §3.3: recipients already hold the coin, so the
 * account exists and no rent is needed).
 */
export function payoutInstructions(distributor: PublicKey, mint: PublicKey, items: TokenTransfer[], fees: FeeOpts = {}): TransactionInstruction[] {
  const from = ata(distributor, mint);
  return [...budgetIxs({ computeUnits: 8_000 + items.length * 6_000, ...fees }), ...items.map((t) => createTransferInstruction(from, ata(t.wallet, mint), distributor, t.amount))];
}

/** Most transfers that fit in one transaction (measured, not guessed). */
export function maxTransfersPerTx(fees: FeeOpts = { priorityMicroLamports: 1 }, luts: AddressLookupTableAccount[] = []): number {
  const d = PublicKey.unique();
  const m = PublicKey.unique();
  let n = 1;
  for (; n < 64; n++) {
    const items = Array.from({ length: n + 1 }, () => ({ wallet: PublicKey.unique(), amount: 1n }));
    if (txSize(d, payoutInstructions(d, m, items, fees), luts) > MAX_TX_BYTES) break;
  }
  return n;
}

export function solTransferInstructions(from: PublicKey, to: PublicKey, lamports: bigint, fees: FeeOpts = {}): TransactionInstruction[] {
  return [...budgetIxs(fees), SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports })];
}
