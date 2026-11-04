/**
 * Live data provider (Milestone 3+): reads the indexer's tables and relays
 * workers' live events from Redis pub/sub. Replaces the mock provider without
 * changing routes or the web app.
 */
import {
  CURVE,
  FEES,
  duplicateTickerMessage,
  isValidTicker,
  normalizeTicker,
  tickerKey,
  type BoardTab,
  type BuybackDTO,
  type CandleDTO,
  type CandleTf,
  type CoinDetail,
  type CoinRow,
  type HolderDTO,
  type LiveEvent,
  type StatsDTO,
  type TickerAvailability,
  type TradeDTO,
  type WalletRewardsDTO,
} from "@backflow/core";
import { buybackDto, coinDetail, coinRow, tradeDto, type Coin, type PrismaClient } from "@backflow/db";
import type { OnChain } from "../onchain";
import type { DataProvider } from "../provider";

export const LIVE_CHANNEL = "backflow:live";
const SPARK_POINTS = 32;
const INCINERATOR = "1nc1nerator11111111111111111111111111111111";

export interface Subscriber {
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", fn: (channel: string, message: string) => void): unknown;
  quit(): Promise<unknown>;
}

export interface LiveOptions {
  db: PrismaClient;
  chain: OnChain | null;
  sub: Subscriber | null;
  /** Wallets that never earn (hot wallets, treasury). */
  platformWallets: { address: string; label: string }[];
}

export class LiveProvider implements DataProvider {
  readonly mode = "live" as const;
  private readonly listeners = new Set<(e: LiveEvent) => void>();

  constructor(private readonly o: LiveOptions) {
    if (o.sub) {
      void o.sub.subscribe(LIVE_CHANNEL);
      o.sub.on("message", (_ch, msg) => {
        let e: LiveEvent;
        try {
          e = JSON.parse(msg) as LiveEvent;
        } catch {
          return;
        }
        for (const fn of this.listeners) fn(e);
      });
    }
  }

  private get db() {
    return this.o.db;
  }

  /** 24h sparkline: last close of each 45-minute bucket, from 15m candles. */
  private async sparks(mints: string[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (!mints.length) return out;
    const since = new Date(Date.now() - 86_400_000);
    const candles = await this.db.candle.findMany({ where: { coinMint: { in: mints }, tf: "15m", openTime: { gte: since } }, orderBy: { openTime: "asc" }, select: { coinMint: true, openTime: true, c: true } });
    const step = 86_400_000 / SPARK_POINTS;
    for (const m of mints) out.set(m, []);
    const buckets = new Map<string, number[]>();
    for (const c of candles) {
      const i = Math.min(SPARK_POINTS - 1, Math.floor((c.openTime.getTime() - since.getTime()) / step));
      const arr = buckets.get(c.coinMint) ?? new Array<number>(SPARK_POINTS).fill(NaN);
      arr[i] = Number(c.c);
      buckets.set(c.coinMint, arr);
    }
    for (const [m, arr] of buckets) {
      let last = arr.find((v) => !Number.isNaN(v)) ?? 0;
      out.set(m, arr.map((v) => (Number.isNaN(v) ? last : (last = v))));
    }
    return out;
  }

  async listCoins(tab: BoardTab, q: string): Promise<CoinRow[]> {
    const s = q.trim();
    const where: Record<string, unknown> = { hidden: false };
    if (s) where.OR = [{ name: { contains: s, mode: "insensitive" } }, { ticker: { contains: s, mode: "insensitive" } }, { mint: s }];
    if (tab === "near") where.status = "CURVE";
    if (tab === "raydium") where.status = "GRADUATED";
    const orderBy = tab === "new" ? { createdAt: "desc" as const } : tab === "raydium" ? { mcapUsd: "desc" as const } : tab === "near" ? { curveQuoteLamports: "desc" as const } : { vol24hUsd: "desc" as const };
    let coins = await this.db.coin.findMany({ where, orderBy, take: 100 });
    if (tab === "near") coins = coins.filter((c) => c.curveQuoteLamports * 2n >= c.graduationTargetLamports);
    const sp = await this.sparks(coins.map((c) => c.mint));
    return coins.map((c) => coinRow(c, sp.get(c.mint) ?? []));
  }

  private async visibleCoin(mint: string): Promise<Coin | null> {
    const c = await this.db.coin.findUnique({ where: { mint } });
    return c && !c.hidden ? c : null;
  }

  async getCoin(mint: string): Promise<CoinDetail | null> {
    const c = await this.visibleCoin(mint);
    if (!c) return null;
    const sp = await this.sparks([mint]);
    const solUsd = this.o.chain ? await this.o.chain.solUsd() : null;
    const poolFee = c.cpmmPoolId && this.o.chain ? await this.o.chain.cpmmFeePpm(c.cpmmPoolId) : null;
    return coinDetail(c, sp.get(mint) ?? [], solUsd, poolFee);
  }

  async candles(mint: string, tf: CandleTf): Promise<CandleDTO[] | null> {
    if (!(await this.visibleCoin(mint))) return null;
    const rows = await this.db.candle.findMany({ where: { coinMint: mint, tf }, orderBy: { openTime: "desc" }, take: 200 });
    return rows.reverse().map((r) => ({ t: r.openTime.getTime(), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), buyback: r.hasBuyback }));
  }

  async trades(mint: string, limit: number): Promise<TradeDTO[] | null> {
    if (!(await this.visibleCoin(mint))) return null;
    return (await this.db.trade.findMany({ where: { coinMint: mint }, orderBy: [{ blockTime: "desc" }, { eventIndex: "desc" }], take: limit })).map(tradeDto);
  }

  async coinBuybacks(mint: string, limit: number): Promise<BuybackDTO[] | null> {
    const c = await this.visibleCoin(mint);
    if (!c) return null;
    const rows = await this.db.buyback.findMany({ where: { coinMint: mint, status: "CONFIRMED" }, orderBy: { confirmedAt: "desc" }, take: limit });
    return rows.map((b) => buybackDto(b, c));
  }

  private async excluded(mint: string): Promise<Map<string, string>> {
    const m = new Map<string, string>([[INCINERATOR, "Burn address"]]);
    for (const w of this.o.platformWallets) if (w.address) m.set(w.address, w.label);
    for (const e of await this.db.excludedAccount.findMany({ where: { scope: { in: ["global", mint] } } })) m.set(e.address, e.note ?? "Excluded");
    return m;
  }

  async holders(mint: string): Promise<HolderDTO[] | null> {
    const c = await this.visibleCoin(mint);
    if (!c) return null;
    const ex = await this.excluded(mint);
    const rows = await this.db.holderState.findMany({ where: { coinMint: mint, balance: { gt: 0n } }, orderBy: { balance: "desc" }, take: 50 });
    const supply = c.supply > 0n ? c.supply : CURVE.supplyBaseUnits;
    const ppm = (b: bigint) => Number((b * 1_000_000n) / supply);
    const out: HolderDTO[] = [];
    if (c.status !== "GRADUATED") {
      const vault = supply - c.realBase;
      out.push({ wallet: c.poolId, label: "Bonding curve vault", balance: vault.toString(), supplyPpm: ppm(vault), excluded: true });
    } else {
      const held = await this.db.holderState.aggregate({ where: { coinMint: mint }, _sum: { balance: true } });
      const pool = supply - (held._sum.balance ?? 0n);
      out.push({ wallet: c.cpmmPoolId ?? c.poolId, label: "Raydium pool", balance: (pool > 0n ? pool : 0n).toString(), supplyPpm: ppm(pool > 0n ? pool : 0n), excluded: true });
    }
    for (const r of rows) out.push({ wallet: r.wallet, label: ex.get(r.wallet) ?? null, balance: r.balance.toString(), supplyPpm: ppm(r.balance), excluded: ex.has(r.wallet) });
    return out;
  }

  async buybacks(limit: number): Promise<BuybackDTO[]> {
    const rows = await this.db.buyback.findMany({ where: { status: "CONFIRMED", coin: { hidden: false } }, orderBy: { confirmedAt: "desc" }, take: limit, include: { coin: true } });
    return rows.map((b) => buybackDto(b, b.coin));
  }

  async stats(): Promise<StatsDTO> {
    const total = await this.db.coin.aggregate({ _sum: { paidToHoldersLamports: true } });
    const last = await this.db.setting.findUnique({ where: { key: "payout_last_at" } });
    const lastAt = last ? Date.parse(String(last.value)) : Date.now();
    const next = lastAt + FEES.payout.intervalSec * 1000;
    let liveFees: StatsDTO["liveFees"] = null;
    let solUsd: number | null = null;
    if (this.o.chain) {
      try {
        const r = await this.o.chain.rates();
        liveFees = { totalPpm: Number(r.totalPpm), raydiumPpm: Number(r.raydiumProtocolPpm), platformPpm: Number(r.platformFeePpm), creatorPpm: Number(r.creatorFeePpm) };
      } catch {
        liveFees = null;
      }
      solUsd = await this.o.chain.solUsd();
    }
    return {
      mode: "live",
      serverTime: new Date().toISOString(),
      totalPaidLamports: (total._sum.paidToHoldersLamports ?? 0n).toString(),
      nextPayoutAt: new Date(next > Date.now() ? next : Date.now() + FEES.payout.intervalSec * 1000).toISOString(),
      payoutIntervalSec: FEES.payout.intervalSec,
      solUsd,
      buybackThresholdLamports: FEES.buyback.thresholdLamports.toString(),
      liveFees,
    };
  }

  async walletRewards(address: string): Promise<WalletRewardsDTO> {
    const [states, pendings] = await Promise.all([this.db.holderState.findMany({ where: { wallet: address } }), this.db.pending.findMany({ where: { wallet: address } })]);
    const mints = [...new Set([...states.map((s) => s.coinMint), ...pendings.map((p) => p.coinMint)])];
    const coins = await this.db.coin.findMany({ where: { mint: { in: mints } } });
    const out: WalletRewardsDTO["coins"] = [];
    for (const c of coins) {
      const s = states.find((x) => x.coinMint === c.mint);
      const p = pendings.find((x) => x.coinMint === c.mint);
      const ex = await this.excluded(c.mint);
      const eligible = await this.db.holderState.aggregate({ where: { coinMint: c.mint, balance: { gt: 0n }, wallet: { notIn: [...ex.keys()] } }, _sum: { balance: true } });
      const bal = s?.balance ?? 0n;
      const elig = eligible._sum.balance ?? 0n;
      const mcap = Number(c.mcapUsd);
      out.push({
        mint: c.mint,
        ticker: c.ticker,
        name: c.name,
        avatarSeed: c.avatarSeed,
        imageUri: c.imageUri,
        balance: bal.toString(),
        sharePpm: elig > 0n && !ex.has(address) ? Number((bal * 1_000_000n) / elig) : 0,
        pending: (p?.amount ?? 0n).toString(),
        received: (s?.receivedTotal ?? 0n).toString(),
        priceUsd: mcap > 0 ? mcap / Number(CURVE.supplyTokens) : null,
      });
    }
    const created = await this.db.coin.findMany({ where: { creator: address } });
    const creatorCoins = await Promise.all(
      created.map(async (c) => {
        const earned = await this.db.trade.aggregate({ where: { coinMint: c.mint }, _sum: { creatorFee: true } });
        const cpmm = c.status === "GRADUATED" && c.cpmmPoolId && this.o.chain ? await this.o.chain.cpmmCreatorFees(address, c.cpmmPoolId, c.mint) : null;
        return {
          mint: c.mint,
          ticker: c.ticker,
          name: c.name,
          avatarSeed: c.avatarSeed,
          imageUri: c.imageUri,
          claimableLamports: "0",
          earnedLamports: (earned._sum.creatorFee ?? 0n).toString(),
          status: (c.status === "GRADUATED" ? "graduated" : c.status === "MIGRATING" ? "migrating" : "curve") as "graduated" | "migrating" | "curve",
          cpmmClaimable: cpmm ? { sol: cpmm.sol.toString(), tokens: cpmm.tokens.toString() } : null,
        };
      }),
    );
    const claimable = created.length && this.o.chain ? await this.o.chain.creatorClaimable(address) : null;
    return { wallet: address, coins: out, creatorCoins, creatorClaimableLamports: claimable == null ? null : claimable.toString() };
  }

  async tickerAvailable(input: string): Promise<TickerAvailability> {
    const ticker = normalizeTicker(input);
    if (!isValidTicker(ticker)) return { ticker, available: false, reason: "Letters and numbers only." };
    const key = tickerKey(ticker);
    const taken = (await this.db.coin.findUnique({ where: { tickerSlot: key } })) || (await this.db.launchIntent.findFirst({ where: { tickerKey: key, expiresAt: { gt: new Date() } } }));
    return { ticker, available: !taken, reason: taken ? duplicateTickerMessage(ticker) : null };
  }

  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async close(): Promise<void> {
    this.listeners.clear();
    await this.o.sub?.quit().catch(() => {});
  }
}
