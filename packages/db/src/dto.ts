/**
 * Mappers from database rows to the API/WebSocket payload types in
 * @backflow/core. Shared by the API (live provider) and the workers (events).
 */
import { BUYBACK, CURVE, type BuybackDTO, type CoinDetail, type CoinRow, type TradeDTO } from "@backflow/core";
import type { Buyback, Coin, Trade } from "@prisma/client";

const status = (s: Coin["status"]): CoinRow["status"] => (s === "GRADUATED" ? "graduated" : s === "MIGRATING" ? "migrating" : "curve");
const num = (d: { toString(): string } | null | undefined) => (d == null ? null : Number(d.toString()));

export function coinRow(c: Coin, spark: number[]): CoinRow {
  const mcap = num(c.mcapUsd);
  return {
    mint: c.mint,
    name: c.name,
    ticker: c.ticker,
    avatarSeed: c.avatarSeed,
    imageUri: c.imageUri,
    createdAt: c.createdAt.toISOString(),
    status: status(c.status),
    mcapUsd: mcap && mcap > 0 ? mcap : null,
    change24hPct: num(c.change24hPct),
    vol24hUsd: num(c.vol24hUsd),
    curveQuoteLamports: c.curveQuoteLamports.toString(),
    graduationTargetLamports: c.graduationTargetLamports.toString(),
    paidToHoldersLamports: c.paidToHoldersLamports.toString(),
    buybackBudgetLamports: c.buybackBudget.toString(),
    holderCount: c.holderCount,
    spark,
  };
}

export function coinDetail(c: Coin, spark: number[], solUsd: number | null, poolFeePpm: number | null): CoinDetail {
  const row = coinRow(c, spark);
  const priceLamports = c.priceLamportsPerToken.toString();
  const pl = Number(priceLamports);
  return {
    ...row,
    description: c.description,
    website: c.website,
    x: c.x,
    telegram: c.telegram,
    creator: c.creator,
    poolId: c.poolId,
    cpmmPoolId: c.cpmmPoolId,
    buybackCount: c.buybackCount,
    supply: c.supply.toString(),
    decimals: c.decimals,
    priceUsd: solUsd != null && pl > 0 ? (pl / 1e9) * solUsd : row.mcapUsd != null ? row.mcapUsd / Number(CURVE.supplyTokens) : null,
    priceLamports: pl > 0 ? priceLamports : null,
    poolFeePpm,
  };
}

export function tradeDto(t: Trade): TradeDTO {
  return {
    signature: t.signature,
    wallet: t.wallet,
    side: t.side === "BUY" ? "buy" : "sell",
    quoteLamports: t.quoteLamports.toString(),
    tokenAmount: t.tokenAmount.toString(),
    blockTime: t.blockTime.toISOString(),
    isBuyback: t.isBuyback,
  };
}

export function buybackDto(b: Buyback, c: Pick<Coin, "ticker" | "name" | "avatarSeed" | "imageUri">): BuybackDTO {
  return {
    id: b.id,
    coinMint: b.coinMint,
    ticker: c.ticker,
    name: c.name,
    avatarSeed: c.avatarSeed,
    imageUri: c.imageUri,
    signature: b.signature,
    status: b.status.toLowerCase() as BuybackDTO["status"],
    solSpentLamports: b.solSpent.toString(),
    tokensBought: b.tokensBought.toString(),
    holderCount: b.holderCount,
    createdAt: (b.confirmedAt ?? b.createdAt).toISOString(),
  };
}

export const THRESHOLD = BUYBACK.thresholdLamports;
