/**
 * Mock data provider: a server-side port of the simulation in
 * prototype/backflow.html. Every number it serves is simulated. The API marks
 * itself `mode: "mock"` so the UI can say so.
 *
 * Amounts are kept as bigint base units, like the real provider will.
 */
import {
  BUYBACK,
  CURVE,
  LAMPORTS_PER_SOL,
  PAYOUT,
  PPM,
  RATES,
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
  type RewardHistoryItem,
  type BuybackDetailDTO,
  type CreditRow,
  type PlatformStatsDTO,
  type HolderRiskDTO,
  type ProfileDTO,
} from "@backflow/core";
import { Lru } from "../cache";
import type { DataProvider } from "../provider";
import { Dice, b58, clamp, hash, mulberry } from "./rng";

/** Simulated SOL/USD. The live provider reads Pyth or Jupiter. */
export const MOCK_SOL_USD = 165;
/** Most simulated wallets kept in memory (least recently used are dropped). */
export const MOCK_WALLETS_MAX = 2_000;
/** Demo acceleration of fee accrual, as in the prototype. */
const SPEED = 60;
/** Share of supply held by wallets that earn (the rest sits in the curve/pool). */
const ELIGIBLE_PPM = 650_000n;
const HOLDERS_FRACTION = Number(RATES.holdersPpm) / 1e6;
const SOL = Number(LAMPORTS_PER_SOL);
const TOKEN_UNIT = 10 ** CURVE.decimals;
const SUPPLY_TOKENS = Number(CURVE.supplyTokens);
const GRAD = CURVE.graduationTargetLamports;
const GRAD_SOL = Number(GRAD) / SOL;
const MINUTE = 60_000;
const SPARK_POINTS = 32;
const SPARK_STEP_MS = (24 * 60 * MINUTE) / SPARK_POINTS;

const NAMES: ReadonlyArray<readonly [string, string]> = [
  ["Mochi", "MOCHI"], ["Tidepool", "TIDE"], ["Glorp", "GLORP"], ["Bubbo", "BUBBO"], ["Neon Newt", "NEWT"],
  ["Kelp Cartel", "KELP"], ["Sir Barnacle", "BARN"], ["Undertow", "TOW"], ["Pebble", "PEB"], ["Ripcurrent", "RIP"],
  ["Sardine Gang", "SARD"], ["Lumen Squid", "SQUID"], ["Coral Kid", "CORAL"], ["Driftwood", "DRIFT"],
  ["Snorkel", "SNRK"], ["Big Wave Dave", "DAVE"], ["Plankton Inc", "PLNK"], ["Moray", "MORAY"],
];
const DESCS = [
  "A small blue thing that refuses to sell.", "Holders get paid every time the tide comes in.",
  "Started as a joke in a group chat. The chat got bigger.", "Round, loud, and paid out in its own coin.",
  "Glows in the dark. Pays holders in the light.", "An organized crime family of seaweed.",
  "Has been stuck to the same rock since launch.", "It pulls you back in. That is the whole idea.",
  "Small rock. Big community. No roadmap.", "Do not swim against it.",
  "They travel in schools and never sell alone.", "Bioluminescent and slightly menacing.",
  "Born on the reef, raised on buybacks.", "Floated in from somewhere. Staying for the rewards.",
  "Breathes underwater, holds forever.", "Dave surfs. Dave holds. Be like Dave.",
  "Tiny workers powering the whole ocean.", "Hides in the rocks and waits for buybacks.",
];

interface Candle1m {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  bb: boolean;
}

interface MockCoin {
  mint: string;
  poolId: string;
  cpmmPoolId: string | null;
  name: string;
  ticker: string;
  desc: string;
  seed: number;
  creator: string;
  createdAt: number;
  graduated: boolean;
  curveLamports: bigint;
  holders: number;
  vaultLamports: bigint;
  mcap: number;
  mcap24hAgo: number;
  vol24: number;
  paidLamports: bigint;
  bbCount: number;
  spark: number[];
  sparkAt: number;
  series: Candle1m[] | null;
  trades: TradeDTO[];
  buys: BuybackDTO[];
  topHolders: { wallet: string; ppm: number }[];
  x: string | null;
  tg: string | null;
  web: string | null;
}

interface Holding {
  bal: bigint;
  pending: bigint;
  received: bigint;
}

function curveMcap(lamports: bigint): number {
  const s = clamp(Number(lamports) / SOL, 0, GRAD_SOL);
  return 5800 + 68000 * Math.pow(s / GRAD_SOL, 1.7);
}
function priceUsd(c: MockCoin): number {
  return c.mcap / SUPPLY_TOKENS;
}
/** Lamports per whole token, 9-decimal string. */
function priceLamportsOf(c: MockCoin): string {
  return ((priceUsd(c) / MOCK_SOL_USD) * SOL).toFixed(9);
}
function lamportsOf(solAmount: number): bigint {
  return BigInt(Math.max(0, Math.round(solAmount * SOL)));
}
/** Token base units bought for `lamports` at the coin's current price. */
function tokensFor(c: MockCoin, lamports: bigint): bigint {
  const usd = (Number(lamports) / SOL) * MOCK_SOL_USD;
  return BigInt(Math.max(0, Math.round((usd / priceUsd(c)) * TOKEN_UNIT)));
}
function changePct(c: MockCoin): number {
  return c.mcap24hAgo > 0 ? (c.mcap / c.mcap24hAgo - 1) * 100 : 0;
}

export interface MockOptions {
  /** Tick interval. 0 disables the timer (tests call `step()`). */
  tickMs?: number;
  now?: () => number;
  seed?: number;
}

export class MockProvider implements DataProvider {
  readonly mode = "mock" as const;
  private readonly d: Dice;
  private readonly now: () => number;
  private readonly coins: MockCoin[] = [];
  private readonly events: BuybackDTO[] = [];
  /** Simulated holdings per wallet, bounded (audit L7): a public demo can't be filled up with random addresses. */
  private readonly wallets = new Lru<string, Map<string, Holding>>(MOCK_WALLETS_MAX);
  private readonly listeners = new Set<(e: LiveEvent) => void>();
  private timer: NodeJS.Timeout | null = null;
  private nextPayoutAt: number;
  private payoutRound = 0;
  private tickN = 0;
  private bbSeq = 0;

  constructor(opts: MockOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.d = new Dice(mulberry(opts.seed ?? 20261104));
    const t0 = this.now();
    for (let i = 0; i < NAMES.length; i++) this.coins.push(this.makeCoin(i, t0));
    this.seedEvents(t0);
    this.nextPayoutAt = t0 + 42_000;
    const tickMs = opts.tickMs ?? 1000;
    if (tickMs > 0) {
      this.timer = setInterval(() => this.step(), tickMs);
      this.timer.unref?.();
    }
  }

  /* ------------------------------ generation ------------------------------ */

  private makeCoin(i: number, t0: number): MockCoin {
    const d = this.d;
    const [name, ticker] = NAMES[i]!;
    const graduated = i % 3 === 0 || i === 4;
    // Mints are stable across restarts: derived from the ticker, ending in "back".
    const mintRng = mulberry(hash("mint:" + ticker));
    const mint = b58(mintRng, 39) + "back";
    const poolId = b58(mintRng, 44);
    const curveLamports = graduated ? GRAD : lamportsOf(d.r(4, 80));
    const ageMin = graduated ? d.ri(900, 9000) : d.ri(4, 700);
    const c: MockCoin = {
      mint,
      poolId,
      cpmmPoolId: graduated ? b58(mintRng, 44) : null,
      name,
      ticker,
      desc: DESCS[i]!,
      seed: hash(ticker) + 7,
      creator: d.addr(44),
      createdAt: t0 - ageMin * MINUTE,
      graduated,
      curveLamports,
      holders: graduated ? d.ri(1400, 9800) : d.ri(40, 980),
      vaultLamports: lamportsOf(d.r(0.05, 0.9) * (Number(BUYBACK.thresholdLamports) / SOL)),
      mcap: 0,
      mcap24hAgo: 0,
      vol24: 0,
      paidLamports: 0n,
      bbCount: 0,
      spark: [],
      sparkAt: t0,
      series: null,
      trades: [],
      buys: [],
      topHolders: [],
      x: d.rnd() > 0.2 ? `https://x.com/${ticker.toLowerCase()}` : null,
      tg: d.rnd() > 0.4 ? `https://t.me/${ticker.toLowerCase()}` : null,
      web: d.rnd() > 0.35 ? `https://${ticker.toLowerCase()}.example` : null,
    };
    let chg: number;
    if (graduated) {
      c.mcap = d.r(160e3, 2.6e6);
      c.vol24 = d.r(0.35, 1.6) * c.mcap;
      chg = d.r(-28, 64);
    } else {
      c.mcap = curveMcap(c.curveLamports) * d.r(0.97, 1.03);
      c.vol24 = d.r(0.6, 4.5) * c.mcap;
      chg = d.r(-35, 190);
    }
    c.mcap24hAgo = c.mcap / (1 + chg / 100);
    const paidSol = ((c.vol24 * HOLDERS_FRACTION) / MOCK_SOL_USD) * d.r(0.8, 3.5);
    c.paidLamports = lamportsOf(paidSol);
    c.bbCount = Math.max(1, Math.round(Number(c.paidLamports) / Number(BUYBACK.thresholdLamports)));
    c.spark = this.genSpark(c);
    return c;
  }

  private genSpark(c: MockCoin): number[] {
    const n = SPARK_POINTS;
    const start = c.mcap24hAgo;
    const w = [0];
    for (let i = 1; i < n; i++) w.push(w[i - 1]! + (this.d.rnd() - 0.5));
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const bridge = w[i]! - t * w[n - 1]!;
      out.push(Math.max(1000, start + (c.mcap - start) * t + bridge * c.mcap * 0.035));
    }
    out[n - 1] = c.mcap;
    return out;
  }

  private newBuyback(c: MockCoin, lamports: bigint, tokens: bigint, holders: number, at: number): BuybackDTO {
    this.bbSeq++;
    return {
      id: `mock-${c.ticker.toLowerCase()}-${this.bbSeq}`,
      coinMint: c.mint,
      ticker: c.ticker,
      name: c.name,
      avatarSeed: c.seed,
      imageUri: null,
      signature: this.d.sig(),
      status: "confirmed",
      solSpentLamports: lamports.toString(),
      tokensBought: tokens.toString(),
      holderCount: holders,
      createdAt: new Date(at).toISOString(),
    };
  }

  private seedEvents(t0: number): void {
    const th = BUYBACK.thresholdLamports;
    const out: BuybackDTO[] = [];
    let t = t0;
    for (let k = 0; k < 14; k++) {
      const c = this.d.pick(this.coins);
      t -= this.d.r(9, 40) * 1000;
      out.push(this.newBuyback(c, th, tokensFor(c, th), c.holders, t));
    }
    this.events.push(...out);
  }

  private genTrade(c: MockCoin, at: number): TradeDTO {
    const isBuy = this.d.rnd() > 0.42;
    const solAmt = +this.d.r(0.05, isBuy ? 4.5 : 3).toFixed(3);
    const q = lamportsOf(solAmt);
    return {
      signature: this.d.sig(),
      wallet: this.d.addr(44),
      side: isBuy ? "buy" : "sell",
      quoteLamports: q.toString(),
      tokenAmount: tokensFor(c, q).toString(),
      blockTime: new Date(at).toISOString(),
      isBuyback: false,
    };
  }

  /** Candles, trades, buybacks and holders, generated on first open (as in the prototype). */
  private ensureDetail(c: MockCoin): void {
    if (c.series) return;
    const d = this.d;
    const n = 1200;
    const vol = c.graduated ? 0.009 : 0.014;
    const drift = c.graduated ? 0.0002 : 0.0016;
    const closes = new Array<number>(n);
    closes[n - 1] = c.mcap;
    for (let i = n - 1; i > 0; i--) closes[i - 1] = Math.max(4200, closes[i]! / (1 + drift + (d.rnd() - 0.5) * vol * 2));
    const lastOpen = Math.floor(this.now() / MINUTE) * MINUTE;
    c.series = [];
    for (let i = 0; i < n; i++) {
      const o = i ? closes[i - 1]! : closes[0]! * 0.995;
      const cl = closes[i]!;
      const h = Math.max(o, cl) * (1 + d.rnd() * 0.006);
      const l = Math.min(o, cl) * (1 - d.rnd() * 0.006);
      c.series.push({ t: lastOpen - (n - 1 - i) * MINUTE, o, h, l, c: cl, bb: d.rnd() < 0.07 });
    }
    const now = this.now();
    let t = now;
    for (let k = 0; k < 16; k++) {
      t -= d.r(6, 50) * 1000;
      c.trades.push(this.genTrade(c, t));
    }
    if (!c.buys.length) {
      const th = BUYBACK.thresholdLamports;
      let bt = now;
      for (let k = 0; k < 8; k++) {
        bt -= d.r(60, 300) * 1000;
        const tk = BigInt(Math.round(Number(tokensFor(c, th)) * d.r(0.9, 1.1)));
        c.buys.push(this.newBuyback(c, th, tk, c.holders - d.ri(0, 40), bt));
      }
    }
    let left = 0.62;
    for (let k = 0; k < 9; k++) {
      const p = left * d.r(0.06, 0.16);
      left -= p;
      c.topHolders.push({ wallet: d.addr(44), ppm: Math.round(p * 1e6) });
    }
    c.topHolders.sort((a, b) => b.ppm - a.ppm);
  }

  /* ------------------------------- simulation ------------------------------ */

  private emit(e: LiveEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a broken listener must not stop the simulation */
      }
    }
  }

  private checkGrad(c: MockCoin): void {
    if (!c.graduated && c.curveLamports >= GRAD) {
      c.graduated = true;
      c.curveLamports = GRAD;
      c.cpmmPoolId = this.d.addr(44);
      this.emit({ type: "graduated", mint: c.mint, cpmmPoolId: c.cpmmPoolId });
    }
  }

  private buyback(c: MockCoin, at: number): void {
    const th = BUYBACK.thresholdLamports;
    c.vaultLamports -= th;
    const tk = tokensFor(c, th);
    const ev = this.newBuyback(c, th, tk, c.holders, at);
    this.events.unshift(ev);
    if (this.events.length > 80) this.events.pop();
    c.buys.unshift(ev);
    if (c.buys.length > 60) c.buys.pop();
    c.paidLamports += th;
    c.bbCount++;
    if (c.graduated) c.mcap *= 1.003;
    else {
      c.curveLamports = c.curveLamports + (th * 98n) / 100n;
      if (c.curveLamports > GRAD) c.curveLamports = GRAD;
      c.mcap = curveMcap(c.curveLamports);
      this.checkGrad(c);
    }
    if (c.series) c.series[c.series.length - 1]!.bb = true;
    const eligible = (CURVE.supplyBaseUnits * ELIGIBLE_PPM) / PPM;
    for (const holdings of this.wallets.values()) {
      const h = holdings.get(c.mint);
      if (h && h.bal > 0n) {
        const bal = h.bal < eligible ? h.bal : eligible;
        h.pending += (tk * bal) / eligible;
      }
    }
    this.emit({ type: "buyback", buyback: ev, paidToHoldersLamports: c.paidLamports.toString(), buybackCount: c.bbCount });
  }

  private payout(at: number): void {
    this.payoutRound++;
    const paid: string[] = [];
    for (const [wallet, holdings] of this.wallets.entries()) {
      let any = false;
      for (const h of holdings.values()) {
        if (h.pending > 0n) {
          h.bal += h.pending;
          h.received += h.pending;
          h.pending = 0n;
          any = true;
        }
      }
      if (any) paid.push(wallet);
    }
    this.nextPayoutAt = at + PAYOUT.intervalSec * 1000;
    this.emit({ type: "payout", round: this.payoutRound, nextPayoutAt: new Date(this.nextPayoutAt).toISOString(), wallets: paid });
  }

  /** Advance the simulation by one tick (1 second of demo time). */
  step(): void {
    const d = this.d;
    const at = this.now();
    this.tickN++;
    for (const c of this.coins) {
      const usdPerSec = (c.vol24 / 86400) * SPEED * d.r(0.4, 1.6);
      c.vaultLamports += lamportsOf((usdPerSec * HOLDERS_FRACTION) / MOCK_SOL_USD);
      if (c.graduated) c.mcap *= 1 + (d.rnd() - 0.485) * 0.006;
      else {
        const next = Number(c.curveLamports) / SOL + (d.rnd() - 0.44) * 0.22;
        c.curveLamports = lamportsOf(clamp(next, 0, GRAD_SOL));
        c.mcap = curveMcap(c.curveLamports) * (1 + (d.rnd() - 0.5) * 0.004);
        this.checkGrad(c);
      }
      if (c.vaultLamports >= BUYBACK.thresholdLamports) this.buyback(c, at);
      if (c.series) {
        const open = Math.floor(at / MINUTE) * MINUTE;
        const last = c.series[c.series.length - 1]!;
        if (open > last.t) {
          c.series.push({ t: open, o: last.c, h: Math.max(last.c, c.mcap), l: Math.min(last.c, c.mcap), c: c.mcap, bb: false });
          if (c.series.length > 1440) c.series.shift();
        } else {
          last.c = c.mcap;
          last.h = Math.max(last.h, c.mcap);
          last.l = Math.min(last.l, c.mcap);
        }
      }
      c.spark[c.spark.length - 1] = c.mcap;
      if (at - c.sparkAt >= SPARK_STEP_MS) {
        c.sparkAt = at;
        c.spark.push(c.mcap);
        if (c.spark.length > SPARK_POINTS) c.spark.shift();
      }
      if (d.rnd() < 0.02) c.holders = Math.max(1, c.holders + (d.rnd() < 0.7 ? 1 : -1));
      if (d.rnd() < 0.05) {
        const tr = this.genTrade(c, at);
        c.trades.unshift(tr);
        if (c.trades.length > 60) c.trades.pop();
        this.emit({ type: "trade", mint: c.mint, trade: tr });
      }
      this.emit({
        type: "price",
        mint: c.mint,
        mcapUsd: c.mcap,
        priceUsd: priceUsd(c),
        priceLamports: priceLamportsOf(c),
        change24hPct: changePct(c),
        vol24hUsd: c.vol24,
        curveQuoteLamports: c.curveLamports.toString(),
        holderCount: c.holders,
        t: at,
      });
      this.emit({ type: "vault", mint: c.mint, buybackBudgetLamports: c.vaultLamports.toString() });
    }
    if (at >= this.nextPayoutAt) this.payout(at);
  }

  /* --------------------------------- reads --------------------------------- */

  private row(c: MockCoin): CoinRow {
    return {
      mint: c.mint,
      name: c.name,
      ticker: c.ticker,
      avatarSeed: c.seed,
      imageUri: null,
      createdAt: new Date(c.createdAt).toISOString(),
      status: c.graduated ? "graduated" : "curve",
      mcapUsd: c.mcap,
      change24hPct: changePct(c),
      vol24hUsd: c.vol24,
      curveQuoteLamports: c.curveLamports.toString(),
      graduationTargetLamports: GRAD.toString(),
      paidToHoldersLamports: c.paidLamports.toString(),
      buybackBudgetLamports: c.vaultLamports.toString(),
      holderCount: c.holders,
      spark: [...c.spark],
    };
  }

  private byMint(mint: string): MockCoin | undefined {
    return this.coins.find((c) => c.mint === mint);
  }

  async listCoins(tab: BoardTab, q: string, mints?: string[]): Promise<CoinRow[]> {
    let arr = [...this.coins];
    if (mints) arr = arr.filter((c) => mints.includes(c.mint));
    const s = q.trim().toLowerCase();
    if (s) arr = arr.filter((c) => c.name.toLowerCase().includes(s) || c.ticker.toLowerCase().includes(s) || c.mint === q.trim());
    if (tab === "trending") arr.sort((a, b) => b.vol24 - a.vol24);
    if (tab === "new") arr.sort((a, b) => b.createdAt - a.createdAt);
    if (tab === "near") arr = arr.filter((c) => !c.graduated && c.curveLamports * 2n >= GRAD).sort((a, b) => (b.curveLamports > a.curveLamports ? 1 : -1));
    if (tab === "raydium") arr = arr.filter((c) => c.graduated).sort((a, b) => b.mcap - a.mcap);
    return arr.map((c) => this.row(c));
  }

  async getCoin(mint: string): Promise<CoinDetail | null> {
    const c = this.byMint(mint);
    if (!c) return null;
    const p = priceUsd(c);
    return {
      ...this.row(c),
      description: c.desc,
      website: c.web,
      x: c.x,
      telegram: c.tg,
      creator: c.creator,
      poolId: c.poolId,
      cpmmPoolId: c.cpmmPoolId,
      buybackCount: c.bbCount,
      supply: CURVE.supplyBaseUnits.toString(),
      decimals: CURVE.decimals,
      priceUsd: p,
      priceLamports: priceLamportsOf(c),
      poolFeePpm: null,
    };
  }

  async candles(mint: string, tf: CandleTf): Promise<CandleDTO[] | null> {
    const c = this.byMint(mint);
    if (!c) return null;
    this.ensureDetail(c);
    const k = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 }[tf];
    const step = k * MINUTE;
    const out: CandleDTO[] = [];
    let cur: CandleDTO | null = null;
    for (const x of c.series!) {
      const open = Math.floor(x.t / step) * step;
      if (!cur || cur.t !== open) {
        if (cur) out.push(cur);
        cur = { t: open, o: x.o, h: x.h, l: x.l, c: x.c, buyback: x.bb, v: 0 };
      } else {
        cur.h = Math.max(cur.h, x.h);
        cur.l = Math.min(cur.l, x.l);
        cur.c = x.c;
        cur.buyback = cur.buyback || x.bb;
      }
    }
    if (cur) out.push(cur);
    // simulated volume, deterministic per candle
    for (const o of out) o.v = +(((Math.abs(Math.sin(o.t / 6e4)) * c.vol24) / MOCK_SOL_USD / 1440) * k).toFixed(3);
    return out.slice(-200);
  }

  async trades(mint: string, limit: number): Promise<TradeDTO[] | null> {
    const c = this.byMint(mint);
    if (!c) return null;
    this.ensureDetail(c);
    return c.trades.slice(0, limit);
  }

  async coinBuybacks(mint: string, limit: number): Promise<BuybackDTO[] | null> {
    const c = this.byMint(mint);
    if (!c) return null;
    this.ensureDetail(c);
    return c.buys.slice(0, limit);
  }

  async holders(mint: string): Promise<HolderDTO[] | null> {
    const c = this.byMint(mint);
    if (!c) return null;
    this.ensureDetail(c);
    const supply = CURVE.supplyBaseUnits;
    const vaultPpm = c.graduated ? 98_100 : 384_000;
    const rows: HolderDTO[] = [
      {
        wallet: c.graduated ? c.cpmmPoolId ?? c.poolId : c.poolId,
        label: c.graduated ? "Raydium pool" : "Bonding curve vault",
        balance: ((supply * BigInt(vaultPpm)) / PPM).toString(),
        supplyPpm: vaultPpm,
        excluded: true,
      },
    ];
    for (const h of c.topHolders) {
      rows.push({ wallet: h.wallet, label: null, balance: ((supply * BigInt(h.ppm)) / PPM).toString(), supplyPpm: h.ppm, excluded: false });
    }
    return rows;
  }

  async buybacks(limit: number): Promise<BuybackDTO[]> {
    return this.events.slice(0, limit);
  }

  async stats(): Promise<StatsDTO> {
    const total = this.coins.reduce((s, c) => s + c.paidLamports, 0n);
    return {
      mode: "mock",
      serverTime: new Date(this.now()).toISOString(),
      totalPaidLamports: total.toString(),
      nextPayoutAt: new Date(this.nextPayoutAt).toISOString(),
      payoutIntervalSec: PAYOUT.intervalSec,
      solUsd: MOCK_SOL_USD,
      buybackThresholdLamports: BUYBACK.thresholdLamports.toString(),
      liveFees: null,
    };
  }

  /** Any wallet gets three simulated holdings (as the prototype's connect() does). */
  private holdingsFor(address: string): Map<string, Holding> {
    let h = this.wallets.get(address);
    if (h) return h;
    h = new Map();
    const u = BigInt(TOKEN_UNIT);
    const seeds: Array<[string, number, number, number]> = [
      ["MOCHI", 18.4e6, 212e3, 1.84e6],
      ["KELP", 6.2e6, 41e3, 402e3],
      ["GLORP", 31e6, 0, 96e4],
    ];
    for (const [ticker, bal, pending, received] of seeds) {
      const c = this.coins.find((x) => x.ticker === ticker);
      if (c) h.set(c.mint, { bal: BigInt(bal) * u, pending: BigInt(pending) * u, received: BigInt(received) * u });
    }
    this.wallets.set(address, h);
    return h;
  }

  async walletRewards(address: string): Promise<WalletRewardsDTO> {
    const holdings = this.holdingsFor(address);
    const eligible = (CURVE.supplyBaseUnits * ELIGIBLE_PPM) / PPM;
    const coins = [...holdings.entries()].flatMap(([mint, h]) => {
      const c = this.byMint(mint);
      if (!c) return [];
      return [
        {
          mint,
          ticker: c.ticker,
          name: c.name,
          avatarSeed: c.seed,
          imageUri: null,
          balance: h.bal.toString(),
          sharePpm: Number((h.bal * PPM) / eligible),
          pending: h.pending.toString(),
          received: h.received.toString(),
          priceUsd: priceUsd(c),
        },
      ];
    });
    const moray = this.coins.find((c) => c.ticker === "MORAY");
    const creatorCoins = moray
      ? [
          {
            mint: moray.mint,
            ticker: moray.ticker,
            name: moray.name,
            avatarSeed: moray.seed,
            imageUri: null,
            claimableLamports: lamportsOf(0.42).toString(),
            earnedLamports: lamportsOf(3.18).toString(),
            status: moray.graduated ? ("graduated" as const) : ("curve" as const),
            cpmmClaimable: moray.graduated ? { sol: lamportsOf(0.05).toString(), tokens: "0" } : null,
          },
        ]
      : [];
    return { wallet: address, coins, creatorCoins, creatorClaimableLamports: creatorCoins.length ? lamportsOf(0.42).toString() : null };
  }

  async tickerAvailable(input: string): Promise<TickerAvailability> {
    const ticker = normalizeTicker(input);
    if (!isValidTicker(ticker)) return { ticker, available: false, reason: "Letters and numbers only." };
    const taken = this.coins.some((c) => tickerKey(c.ticker) === tickerKey(ticker));
    return { ticker, available: !taken, reason: taken ? duplicateTickerMessage(ticker) : null };
  }

  async walletHistory(address: string, limit: number): Promise<RewardHistoryItem[]> {
    const holdings = this.holdingsFor(address);
    const out: RewardHistoryItem[] = [];
    for (const e of this.events) {
      const h = holdings.get(e.coinMint);
      if (!h) continue;
      out.push({ kind: "credit", coinMint: e.coinMint, ticker: e.ticker, amount: ((BigInt(e.tokensBought) * 28n) / 1000n).toString(), at: e.createdAt, signature: e.signature, buybackId: e.id });
    }
    return out.slice(0, limit);
  }

  private findBuyback(id: string): BuybackDTO | undefined {
    return this.events.find((e) => e.id === id) ?? this.coins.flatMap((c) => c.buys).find((b) => b.id === id);
  }

  async buybackDetail(id: string): Promise<BuybackDetailDTO | null> {
    const b = this.findBuyback(id);
    if (!b) return null;
    const credits = (await this.buybackCredits(id))!;
    const credited = credits.reduce((s, c) => s + BigInt(c.amount), 0n);
    const end = Date.parse(b.createdAt);
    return { ...b, venue: "curve", windowStart: new Date(end - 3_600_000).toISOString(), windowEnd: b.createdAt, carriedIn: "0", dustCarried: (BigInt(b.tokensBought) - credited).toString(), creditedTotal: credited.toString(), creditCount: credits.length, credited: true };
  }

  async buybackCredits(id: string): Promise<CreditRow[] | null> {
    const b = this.findBuyback(id);
    if (!b) return null;
    const rnd = mulberry(hash(id));
    const weights = Array.from({ length: 12 }, () => BigInt(Math.floor(rnd() * 1e9) + 1) * 3600n);
    const sum = weights.reduce((a, c) => a + c, 0n);
    const total = BigInt(b.tokensBought);
    return weights
      .map((w) => ({ wallet: b58(rnd, 44), weight: w.toString(), amount: ((total * w) / sum).toString() }))
      .sort((a, c) => (BigInt(c.amount) > BigInt(a.amount) ? 1 : -1));
  }

  async platformStats(): Promise<PlatformStatsDTO> {
    const paid = this.coins.reduce((s, c) => s + c.paidLamports, 0n);
    const vol = this.coins.reduce((s, c) => s + lamportsOf(c.vol24 / MOCK_SOL_USD), 0n);
    const top = [...this.coins].sort((a, b) => (b.paidLamports > a.paidLamports ? 1 : -1)).slice(0, 10);
    return {
      mode: "mock",
      coins: this.coins.length,
      graduated: this.coins.filter((c) => c.graduated).length,
      trades: this.coins.reduce((s, c) => s + c.bbCount * 40, 0),
      volumeLamports: vol.toString(),
      platformFeesLamports: ((vol * RATES.platformFeePpm) / PPM).toString(),
      buybacks: this.coins.reduce((s, c) => s + c.bbCount, 0),
      paidToHoldersLamports: paid.toString(),
      payoutTransfers: this.payoutRound * 37,
      forfeitures: this.payoutRound * 2,
      holdersEarning: this.coins.reduce((s, c) => s + c.holders, 0),
      topCoins: top.map((c) => this.row(c)),
    };
  }

  async holderRisk(mint: string): Promise<HolderRiskDTO | null> {
    const c = this.byMint(mint);
    if (!c) return null;
    this.ensureDetail(c);
    const top10 = c.topHolders.slice(0, 10).reduce((s, h) => s + h.ppm, 0);
    return { creatorPpm: Math.round(c.topHolders[0]!.ppm / 3), top10Ppm: top10, earlyPpm: Math.round(top10 / 4), earlyWallets: 3, holders: c.holders };
  }

  async profile(address: string): Promise<ProfileDTO> {
    return { wallet: address, created: this.coins.filter((c) => c.creator === address).map((c) => this.row(c)), rewards: await this.walletRewards(address) };
  }

  async report(mint: string): Promise<boolean> {
    return !!this.byMint(mint);
  }

  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}
