import type {
  BoardTab,
  BuybackDTO,
  CandleDTO,
  CandleTf,
  CoinDetail,
  CoinRow,
  HolderDTO,
  LiveEvent,
  StatsDTO,
  TickerAvailability,
  TradeDTO,
  WalletRewardsDTO,
  RewardHistoryItem,
  BuybackDetailDTO,
  CreditRow,
  PlatformStatsDTO,
} from "@backflow/core";

/**
 * Where the API gets its data. Milestone 1 ships a mock provider (a port of the
 * prototype's simulation). Milestone 3 adds a provider backed by Postgres and
 * the indexer; routes and the web app do not change.
 */
export interface DataProvider {
  readonly mode: "mock" | "live";
  listCoins(tab: BoardTab, q: string): Promise<CoinRow[]>;
  getCoin(mint: string): Promise<CoinDetail | null>;
  candles(mint: string, tf: CandleTf): Promise<CandleDTO[] | null>;
  trades(mint: string, limit: number): Promise<TradeDTO[] | null>;
  coinBuybacks(mint: string, limit: number): Promise<BuybackDTO[] | null>;
  holders(mint: string): Promise<HolderDTO[] | null>;
  buybacks(limit: number): Promise<BuybackDTO[]>;
  stats(): Promise<StatsDTO>;
  walletRewards(address: string): Promise<WalletRewardsDTO>;
  tickerAvailable(ticker: string): Promise<TickerAvailability>;
  walletHistory(address: string, limit: number): Promise<RewardHistoryItem[]>;
  buybackDetail(id: string): Promise<BuybackDetailDTO | null>;
  buybackCredits(id: string): Promise<CreditRow[] | null>;
  platformStats(): Promise<PlatformStatsDTO>;
  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(fn: (e: LiveEvent) => void): () => void;
  close(): Promise<void>;
}
