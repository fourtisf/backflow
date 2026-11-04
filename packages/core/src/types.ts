/**
 * API and WebSocket payload types shared by apps/api and apps/web.
 *
 * On-chain amounts travel as decimal strings of base units (bigint does not
 * survive JSON). USD figures are derived display values and travel as numbers.
 */

/** Lamports as a decimal string, e.g. "1000000000" = 1 SOL. */
export type LamportsStr = string;
/** Token base units as a decimal string (6 decimals for Backflow coins). */
export type TokenStr = string;

export type CoinStatus = "curve" | "migrating" | "graduated";
export type BoardTab = "trending" | "new" | "near" | "raydium";
export type CandleTf = "1m" | "5m" | "15m";
export type DataMode = "mock" | "live";

export interface CoinRow {
  mint: string;
  name: string;
  ticker: string;
  /** Procedural avatar seed used when there is no image. */
  avatarSeed: number;
  imageUri: string | null;
  createdAt: string;
  status: CoinStatus;
  /** Market cap in USD. null when the price is unknown. */
  mcapUsd: number | null;
  change24hPct: number | null;
  vol24hUsd: number | null;
  /** SOL in the bonding curve (quote reserve). */
  curveQuoteLamports: LamportsStr;
  graduationTargetLamports: LamportsStr;
  /** Total SOL spent on buybacks for holders. */
  paidToHoldersLamports: LamportsStr;
  /** Buyback budget waiting to be spent (the "vault"). */
  buybackBudgetLamports: LamportsStr;
  holderCount: number;
  /** 24h market-cap sparkline in USD, oldest first. */
  spark: number[];
}

export interface CoinDetail extends CoinRow {
  description: string | null;
  website: string | null;
  x: string | null;
  telegram: string | null;
  creator: string;
  poolId: string;
  cpmmPoolId: string | null;
  buybackCount: number;
  supply: TokenStr;
  decimals: number;
  /** USD per whole token. null when unknown. */
  priceUsd: number | null;
  /** Lamports per whole token, as a decimal string with fraction. null when unknown. */
  priceLamports: string | null;
  /** Real post-graduation pool fee, in ppm. null before graduation or if unverified. */
  poolFeePpm: number | null;
}

export interface TradeDTO {
  signature: string;
  wallet: string;
  side: "buy" | "sell";
  quoteLamports: LamportsStr;
  tokenAmount: TokenStr;
  blockTime: string;
  isBuyback: boolean;
}

export type TxStatus = "pending" | "sent" | "confirmed" | "failed";

export interface BuybackDTO {
  id: string;
  coinMint: string;
  ticker: string;
  name: string;
  avatarSeed: number;
  imageUri: string | null;
  signature: string | null;
  status: TxStatus;
  solSpentLamports: LamportsStr;
  tokensBought: TokenStr;
  holderCount: number;
  createdAt: string;
}

export interface HolderDTO {
  wallet: string;
  /** Display label for excluded accounts, e.g. "Bonding curve vault". */
  label: string | null;
  balance: TokenStr;
  /** Share of total supply, ppm. */
  supplyPpm: number;
  excluded: boolean;
}

export interface CandleDTO {
  /** Candle open time, ms since epoch. */
  t: number;
  /** Market cap in USD. */
  o: number;
  h: number;
  l: number;
  c: number;
  buyback: boolean;
}

export interface StatsDTO {
  mode: DataMode;
  serverTime: string;
  totalPaidLamports: LamportsStr;
  nextPayoutAt: string;
  payoutIntervalSec: number;
  solUsd: number | null;
  buybackThresholdLamports: LamportsStr;
  /** Fee rates read from chain (protocol from GlobalConfig, ours from PlatformConfig). null in mock mode or when unreadable. */
  liveFees: { totalPpm: number; raydiumPpm: number; platformPpm: number; creatorPpm: number } | null;
}

export interface WalletCoinRewards {
  mint: string;
  ticker: string;
  name: string;
  avatarSeed: number;
  imageUri: string | null;
  balance: TokenStr;
  /** Share of eligible (earning) supply, ppm. */
  sharePpm: number;
  pending: TokenStr;
  received: TokenStr;
  priceUsd: number | null;
}

export interface CreatorCoin {
  mint: string;
  ticker: string;
  name: string;
  avatarSeed: number;
  imageUri: string | null;
  claimableLamports: LamportsStr;
  earnedLamports: LamportsStr;
  status: CoinStatus;
  /** Creator fees waiting in the coin's Raydium pool after graduation (claimed per coin). null before graduation. */
  cpmmClaimable: { sol: LamportsStr; tokens: TokenStr } | null;
}

export interface WalletRewardsDTO {
  wallet: string;
  coins: WalletCoinRewards[];
  creatorCoins: CreatorCoin[];
  /** LaunchLab keeps one creator-fee vault per creator (all their coins), so one claim takes this whole amount. */
  creatorClaimableLamports: LamportsStr | null;
}

export interface QuoteDTO {
  side: "buy" | "sell";
  amountIn: LamportsStr;
  expectedOut: string;
  minOut: string;
  feeLamports: LamportsStr;
  priceImpactPpm: number;
  completesCurve: boolean;
}

export interface BuiltTxDTO {
  /** base64 serialized VersionedTransaction, ready for the wallet to sign. */
  tx: string;
  expectedOut: string;
  minOut: string;
}

export interface LaunchTxDTO extends BuiltTxDTO {
  mint: string;
  poolId: string;
}

export interface TickerAvailability {
  ticker: string;
  available: boolean;
  reason: string | null;
}

export interface ApiError {
  error: string;
  message: string;
}

/* ------------------------------ live events ------------------------------ */

export interface LiveTrade {
  type: "trade";
  mint: string;
  trade: TradeDTO;
}
export interface LivePrice {
  type: "price";
  mint: string;
  mcapUsd: number | null;
  priceUsd: number | null;
  /** Lamports per whole token, decimal string. */
  priceLamports: string | null;
  change24hPct: number | null;
  vol24hUsd: number | null;
  curveQuoteLamports: LamportsStr;
  holderCount: number;
  t: number;
}
export interface LiveVault {
  type: "vault";
  mint: string;
  buybackBudgetLamports: LamportsStr;
}
export interface LiveBuyback {
  type: "buyback";
  buyback: BuybackDTO;
  paidToHoldersLamports: LamportsStr;
  buybackCount: number;
}
export interface LivePayout {
  type: "payout";
  round: number;
  nextPayoutAt: string;
  /** Wallets paid this round. Clients check whether they are included. */
  wallets: string[];
}
export interface LiveGraduated {
  type: "graduated";
  mint: string;
  cpmmPoolId: string | null;
}
export interface LiveCoinCreated {
  type: "coin_created";
  coin: CoinRow;
}
export interface LiveHello {
  type: "hello";
  stats: StatsDTO;
}

export type LiveEvent =
  | LiveTrade
  | LivePrice
  | LiveVault
  | LiveBuyback
  | LivePayout
  | LiveGraduated
  | LiveCoinCreated
  | LiveHello;
