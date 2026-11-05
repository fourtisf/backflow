import { NATIVE_MINT } from "@solana/spl-token";
/**
 * LaunchLab pool state, CPMM pool state and derived account keys.
 * Layouts from @raydium-io/raydium-sdk-v2 0.2.81-alpha (launchpad/layout.ts, cpmm/layout.ts)
 * and raydium-cpi locking-cpi/states.rs (LockedCpLiquidityState).
 */
import type { CurveState, CpmmPoolState } from "@backflow/core";
import {
  CpmmConfigInfoLayout,
  CpmmPoolInfoLayout,
  LaunchpadPool,
  getCpLockPda,
  getPdaCpiEvent,
  getPdaCreatorVault,
  getPdaLaunchpadAuth,
  getPdaLaunchpadPoolId,
  getPdaLaunchpadVaultId,
  getPdaPlatformVault,
} from "@raydium-io/raydium-sdk-v2";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";

const big = (v: { toString(): string }) => BigInt(v.toString());

/** LaunchLab pool status (IDL PoolStatus). */
export enum PoolStatus {
  /** Bonding curve trading. */
  Fund = 0,
  /** Curve complete, waiting for migration. */
  Migrate = 1,
  /** Migrated to the AMM/CPMM pool. */
  Trade = 2,
}

export interface LaunchPool {
  id: PublicKey;
  status: PoolStatus;
  migrateType: number;
  decimalsA: number;
  decimalsB: number;
  supply: bigint;
  totalSellA: bigint;
  virtualA: bigint;
  virtualB: bigint;
  realA: bigint;
  realB: bigint;
  totalFundRaisingB: bigint;
  protocolFee: bigint;
  platformFee: bigint;
  migrateFee: bigint;
  configId: PublicKey;
  platformId: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  creator: PublicKey;
  mintProgramA: PublicKey;
  mintProgramB: PublicKey;
}

export function decodeLaunchPool(id: PublicKey, data: Buffer): LaunchPool {
  const d = LaunchpadPool.decode(data);
  const flag = Number(d.mintProgramFlag);
  return {
    id,
    status: Number(d.status) as PoolStatus,
    migrateType: Number(d.migrateType),
    decimalsA: Number(d.mintDecimalsA),
    decimalsB: Number(d.mintDecimalsB),
    supply: big(d.supply),
    totalSellA: big(d.totalSellA),
    virtualA: big(d.virtualA),
    virtualB: big(d.virtualB),
    realA: big(d.realA),
    realB: big(d.realB),
    totalFundRaisingB: big(d.totalFundRaisingB),
    protocolFee: big(d.protocolFee),
    platformFee: big(d.platformFee),
    migrateFee: big(d.migrateFee),
    configId: d.configId,
    platformId: d.platformId,
    mintA: d.mintA,
    mintB: d.mintB,
    vaultA: d.vaultA,
    vaultB: d.vaultB,
    creator: d.creator,
    // bit0 = base mint, bit1 = quote mint; 0 = SPL Token, 1 = Token-2022 (SDK util.ts)
    mintProgramA: flag & 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    mintProgramB: flag & 2 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
  };
}

export async function fetchLaunchPool(conn: Connection, id: PublicKey): Promise<LaunchPool | null> {
  const acc = await conn.getAccountInfo(id, "confirmed");
  return acc ? decodeLaunchPool(id, acc.data) : null;
}

export function curveStateOf(p: LaunchPool): CurveState {
  return { virtualBase: p.virtualA, virtualQuote: p.virtualB, realBase: p.realA, realQuote: p.realB, totalSellBase: p.totalSellA };
}

/** Every account a curve trade needs, derived from the pool. */
export interface LaunchPoolKeys {
  programId: PublicKey;
  auth: PublicKey;
  eventAuthority: PublicKey;
  poolId: PublicKey;
  configId: PublicKey;
  platformId: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  mintProgramA: PublicKey;
  mintProgramB: PublicKey;
  platformFeeVault: PublicKey;
  creatorFeeVault: PublicKey;
  creator: PublicKey;
}

export function launchPoolKeys(programId: PublicKey, p: Pick<LaunchPool, "id" | "configId" | "platformId" | "mintA" | "mintB" | "vaultA" | "vaultB" | "mintProgramA" | "mintProgramB" | "creator">): LaunchPoolKeys {
  return {
    programId,
    auth: getPdaLaunchpadAuth(programId).publicKey,
    eventAuthority: getPdaCpiEvent(programId).publicKey,
    poolId: p.id,
    configId: p.configId,
    platformId: p.platformId,
    mintA: p.mintA,
    mintB: p.mintB,
    vaultA: p.vaultA,
    vaultB: p.vaultB,
    mintProgramA: p.mintProgramA,
    mintProgramB: p.mintProgramB,
    platformFeeVault: getPdaPlatformVault(programId, p.platformId, p.mintB).publicKey,
    creatorFeeVault: getPdaCreatorVault(programId, p.creator, p.mintB).publicKey,
    creator: p.creator,
  };
}

/** Pool keys for a pool that does not exist yet (launch + first buy in one tx). */
export function predictedPoolKeys(programId: PublicKey, mintA: PublicKey, mintB: PublicKey, configId: PublicKey, platformId: PublicKey, creator: PublicKey): LaunchPoolKeys {
  const poolId = getPdaLaunchpadPoolId(programId, mintA, mintB).publicKey;
  return launchPoolKeys(programId, {
    id: poolId,
    configId,
    platformId,
    mintA,
    mintB,
    vaultA: getPdaLaunchpadVaultId(programId, poolId, mintA).publicKey,
    vaultB: getPdaLaunchpadVaultId(programId, poolId, mintB).publicKey,
    mintProgramA: TOKEN_PROGRAM_ID,
    mintProgramB: TOKEN_PROGRAM_ID,
    creator,
  });
}

/* ---------------------------------- CPMM ---------------------------------- */

export interface CpmmPool {
  id: PublicKey;
  configId: PublicKey;
  poolCreator: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  mintLp: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  mintProgramA: PublicKey;
  mintProgramB: PublicKey;
  observationId: PublicKey;
  status: number;
  protocolFeesA: bigint;
  protocolFeesB: bigint;
  fundFeesA: bigint;
  fundFeesB: bigint;
  creatorFeesA: bigint;
  creatorFeesB: bigint;
  /** 0 BothToken, 1 OnlyTokenA, 2 OnlyTokenB. */
  feeOn: number;
  enableCreatorFee: boolean;
}

export function decodeCpmmPool(id: PublicKey, data: Buffer): CpmmPool {
  const d = CpmmPoolInfoLayout.decode(data);
  return {
    id,
    configId: d.configId,
    poolCreator: d.poolCreator,
    vaultA: d.vaultA,
    vaultB: d.vaultB,
    mintLp: d.mintLp,
    mintA: d.mintA,
    mintB: d.mintB,
    mintProgramA: d.mintProgramA,
    mintProgramB: d.mintProgramB,
    observationId: d.observationId,
    status: Number(d.status),
    protocolFeesA: big(d.protocolFeesMintA),
    protocolFeesB: big(d.protocolFeesMintB),
    fundFeesA: big(d.fundFeesMintA),
    fundFeesB: big(d.fundFeesMintB),
    creatorFeesA: big(d.creatorFeesMintA),
    creatorFeesB: big(d.creatorFeesMintB),
    feeOn: Number(d.feeOn),
    enableCreatorFee: Boolean(d.enableCreatorFee),
  };
}

/**
 * Swap reserves and fee settings for trading `coinMint` against SOL in this pool.
 * Reserves = vault balance − protocol − fund − creator fees still held in the vault.
 */
export async function fetchCpmmState(conn: Connection, pool: CpmmPool, coinMint: PublicKey): Promise<CpmmPoolState> {
  const [va, vb, cfgAcc] = await Promise.all([
    conn.getTokenAccountBalance(pool.vaultA, "confirmed"),
    conn.getTokenAccountBalance(pool.vaultB, "confirmed"),
    conn.getAccountInfo(pool.configId, "confirmed"),
  ]);
  if (!cfgAcc) throw new Error(`CPMM AmmConfig ${pool.configId.toBase58()} not found`);
  const cfg = CpmmConfigInfoLayout.decode(cfgAcc.data);
  const resA = BigInt(va.value.amount) - pool.protocolFeesA - pool.fundFeesA - pool.creatorFeesA;
  const resB = BigInt(vb.value.amount) - pool.protocolFeesB - pool.fundFeesB - pool.creatorFeesB;
  const coinIsA = pool.mintA.equals(coinMint);
  // feeOn: 0 BothToken (input token), 1 OnlyTokenA, 2 OnlyTokenB
  const creatorFeeToken: CpmmPoolState["creatorFeeToken"] = pool.feeOn === 0 ? "both" : (pool.feeOn === 1) === coinIsA ? "base" : "quote";
  return {
    reserveBase: coinIsA ? resA : resB,
    reserveQuote: coinIsA ? resB : resA,
    tradeFeePpm: big(cfg.tradeFeeRate),
    creatorFeePpm: pool.enableCreatorFee ? big(cfg.creatorFeeRate) : 0n,
    creatorFeeToken,
  };
}

export async function fetchCpmmPool(conn: Connection, id: PublicKey): Promise<CpmmPool | null> {
  const acc = await conn.getAccountInfo(id, "confirmed");
  return acc ? decodeCpmmPool(id, acc.data) : null;
}

/* ------------------------ Burn & Earn locked position ---------------------- */

export interface LockedCpPosition {
  lockedLpAmount: bigint;
  claimedLpAmount: bigint;
  unclaimedLpAmount: bigint;
  poolId: PublicKey;
  feeNftMint: PublicKey;
  lockedOwner: PublicKey;
  lockedLpMint: PublicKey;
}

/** LockedCpLiquidityState: 8 disc + 4×u64 + u128 + u64 + 4×pubkey + 8×u64 (raydium-cpi). */
export function decodeLockedCpPosition(data: Buffer): LockedCpPosition {
  let o = 8;
  const u64 = () => {
    const v = data.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const pk = () => {
    const v = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    return v;
  };
  const lockedLpAmount = u64();
  const claimedLpAmount = u64();
  const unclaimedLpAmount = u64();
  u64(); // last_lp
  o += 16; // last_k u128
  u64(); // recent_epoch
  return { lockedLpAmount, claimedLpAmount, unclaimedLpAmount, poolId: pk(), feeNftMint: pk(), lockedOwner: pk(), lockedLpMint: pk() };
}

export function lockedPositionAddress(lockProgram: PublicKey, feeNftMint: PublicKey): PublicKey {
  return getCpLockPda(lockProgram, feeNftMint).publicKey;
}

export function ata(owner: PublicKey, mint: PublicKey, program: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, program);
}

/** Trade fee (ppm) of a CPMM pool's AmmConfig. */
export async function cpmmPoolTradeFeePpm(conn: Connection, poolId: PublicKey): Promise<number | null> {
  const acc = await conn.getAccountInfo(poolId, "confirmed");
  if (!acc) return null;
  const pool = decodeCpmmPool(poolId, acc.data);
  const cfg = await conn.getAccountInfo(pool.configId, "confirmed");
  return cfg ? Number(CpmmConfigInfoLayout.decode(cfg.data).tradeFeeRate.toString()) : null;
}

/**
 * Why a LaunchLab pool under our platform config is not one we can serve, or null if it is. Anyone can
 * launch under our platform config from another frontend, with another quote token, curve or migration.
 * Our quotes, minOut and graduation handling assume wSOL, our GlobalConfig and CPMM migration (audit).
 */
export function poolProblem(p: Pick<LaunchPool, "configId" | "mintB" | "migrateType">, globalConfig: PublicKey): string | null {
  if (!p.mintB.equals(NATIVE_MINT)) return "its quote token isn't SOL";
  if (!p.configId.equals(globalConfig)) return "it uses a different Raydium curve config";
  if (p.migrateType !== 1) return "it doesn't move to a Raydium CPMM pool";
  return null;
}
