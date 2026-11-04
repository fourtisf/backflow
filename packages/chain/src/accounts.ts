/** Decoders for the LaunchLab and CPMM accounts the scripts read. */
import { CpmmConfigInfoLayout, LaunchpadConfig, PlatformConfig } from "@raydium-io/raydium-sdk-v2";
import type { Connection, PublicKey } from "@solana/web3.js";

export interface GlobalConfigInfo {
  curveType: number;
  index: number;
  migrateFee: bigint;
  tradeFeeRate: bigint;
  maxShareFeeRate: bigint;
  minSupplyA: bigint;
  maxLockRate: bigint;
  minSellRateA: bigint;
  minMigrateRateA: bigint;
  minFundRaisingB: bigint;
  mintB: string;
  /** Not in the SDK layout; read from byte 243 (IDL: requires_platform_auth). */
  requiresPlatformAuth: number | null;
}

const big = (v: { toString(): string }) => BigInt(v.toString());
const text = (bytes: number[]) => Buffer.from(bytes).toString("utf8").replace(/\0+$/, "");

export async function readGlobalConfig(conn: Connection, id: PublicKey): Promise<GlobalConfigInfo | null> {
  const acc = await conn.getAccountInfo(id);
  if (!acc) return null;
  const d = LaunchpadConfig.decode(acc.data);
  return {
    curveType: d.curveType,
    index: d.index,
    migrateFee: big(d.migrateFee),
    tradeFeeRate: big(d.tradeFeeRate),
    maxShareFeeRate: big(d.maxShareFeeRate),
    minSupplyA: big(d.minSupplyA),
    maxLockRate: big(d.maxLockRate),
    minSellRateA: big(d.minSellRateA),
    minMigrateRateA: big(d.minMigrateRateA),
    minFundRaisingB: big(d.minFundRaisingB),
    mintB: d.mintB.toBase58(),
    requiresPlatformAuth: acc.data.length > 243 ? acc.data[243]! : null,
  };
}

export interface PlatformInfo {
  epoch: bigint;
  platformClaimFeeWallet: string;
  platformLockNftWallet: string;
  platformScale: bigint;
  creatorScale: bigint;
  burnScale: bigint;
  feeRate: bigint;
  creatorFeeRate: bigint;
  name: string;
  web: string;
  img: string;
  cpConfigId: string;
  platformCpCreator: string;
  platformVestingWallet: string;
  platformVestingScale: bigint;
  transferFeeExtensionAuth: string;
  restrictGlobalConfig: number;
  restrictCurveParam: number;
}

export async function readPlatform(conn: Connection, id: PublicKey): Promise<PlatformInfo | null> {
  const acc = await conn.getAccountInfo(id);
  if (!acc) return null;
  const d = PlatformConfig.decode(acc.data);
  return {
    epoch: big(d.epoch),
    platformClaimFeeWallet: d.platformClaimFeeWallet.toBase58(),
    platformLockNftWallet: d.platformLockNftWallet.toBase58(),
    platformScale: big(d.platformScale),
    creatorScale: big(d.creatorScale),
    burnScale: big(d.burnScale),
    feeRate: big(d.feeRate),
    creatorFeeRate: big(d.creatorFeeRate),
    name: text(d.name),
    web: text(d.web),
    img: text(d.img),
    cpConfigId: d.cpConfigId.toBase58(),
    platformCpCreator: d.platformCpCreator.toBase58(),
    platformVestingWallet: d.platformVestingWallet.toBase58(),
    platformVestingScale: big(d.platformVestingScale),
    transferFeeExtensionAuth: d.transferFeeExtensionAuth.toBase58(),
    restrictGlobalConfig: d.restrictGlobalConfig,
    restrictCurveParam: d.restrictCurveParam,
  };
}

export interface AmmConfigInfo {
  id: string;
  index: number;
  disableCreatePool: boolean;
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
  creatorFeeRate: bigint;
  createPoolFee: bigint;
}

/** All CPMM AmmConfig accounts (fee tiers) on the cluster. */
export async function readAmmConfigs(conn: Connection, cpmmProgram: PublicKey): Promise<AmmConfigInfo[]> {
  const accs = await conn.getProgramAccounts(cpmmProgram, { filters: [{ dataSize: CpmmConfigInfoLayout.span }] });
  return accs
    .map(({ pubkey, account }) => {
      const d = CpmmConfigInfoLayout.decode(account.data);
      return {
        id: pubkey.toBase58(),
        index: d.index,
        disableCreatePool: d.disableCreatePool,
        tradeFeeRate: big(d.tradeFeeRate),
        protocolFeeRate: big(d.protocolFeeRate),
        fundFeeRate: big(d.fundFeeRate),
        creatorFeeRate: big(d.creatorFeeRate),
        createPoolFee: big(d.createPoolFee),
      };
    })
    .sort((a, b) => a.index - b.index);
}

/** The enabled tier whose trade fee is closest to `targetPpm` (SPEC §2.2: closest to 1%). */
export function pickTier(tiers: AmmConfigInfo[], targetPpm: bigint): AmmConfigInfo | null {
  const usable = tiers.filter((t) => !t.disableCreatePool);
  let best: AmmConfigInfo | null = null;
  for (const t of usable) {
    const dist = t.tradeFeeRate > targetPpm ? t.tradeFeeRate - targetPpm : targetPpm - t.tradeFeeRate;
    const bestDist = best ? (best.tradeFeeRate > targetPpm ? best.tradeFeeRate - targetPpm : targetPpm - best.tradeFeeRate) : null;
    if (bestDist === null || dist < bestDist) best = t;
  }
  return best;
}
