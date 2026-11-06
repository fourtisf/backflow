/**
 * The API's chain access (live mode): fee rates, SOL/USD, creator vault
 * balances, pool fee tiers, and building unsigned transactions for wallets.
 * The API never holds user keys; it only returns transactions to sign.
 */
import {
  RAYDIUM,
  RATES,
  cpmmBuyImpactPpm,
  cpmmSellImpactPpm,
  quoteCpmmBuy,
  quoteCpmmSell,
  curveInit,
  newCurve,
  priceChangePpm,
  quoteBuy,
  quoteSell,
  minOutWithSlippage,
  spotPrice,
  applyBuy,
  applySell,
  FEES,
  type FeeRates,
  type QuoteDTO,
} from "@backflow/core";
import {
  addresses,
  buildBuyTx,
  buildLaunchTx,
  buildSellTx,
  claimCpmmCreatorFeeInstructions,
  claimCreatorFeeInstructions,
  cluster,
  compile,
  connection,
  cpmmBuyInstructions,
  cpmmSellInstructions,
  fetchCpmmPool,
  fetchCpmmState,
  creatorFeeVault,
  curveStateOf,
  cpmmPoolTradeFeePpm,
  fetchLaunchPool,
  launchPoolKeys,
  loadLuts,
  readGlobalConfig,
  readPlatform,
  solUsd,
  type GlobalConfigInfo,
  type PlatformInfo,
  type PriceSource, poolProblem } from "@backflow/chain";
import { ComputeBudgetProgram, Keypair, PublicKey, type AddressLookupTableAccount, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { cached } from "./cache";

export interface CoinRefLike {
  mint: string;
  poolId: string;
  cpmmPoolId: string | null;
  status: string;
}

/** Cached value with in-flight merging: concurrent callers share one fetch (audit M3). */
const cache = <T>(ms: number) => cached<T>(ms);

export type LookupTableState = "ok" | "loading" | "not_configured";

export class OnChain {
  readonly conn: Connection;
  readonly A = addresses();
  readonly platformId: PublicKey;
  private luts: AddressLookupTableAccount[] = [];
  private lutState: LookupTableState = "not_configured";
  private lutTimer: ReturnType<typeof setTimeout> | null = null;
  private ratesC = cache<FeeRates>(600_000);
  private solC = cache<number | null>(30_000);
  private poolFee = new Map<string, number | null>();
  private globalC = cache<GlobalConfigInfo | null>(60_000);
  private platformC = cache<PlatformInfo | null>(60_000);

  constructor(
    platformConfig: string,
    private readonly priceSource: PriceSource,
    private readonly priorityMicroLamports: number,
    private readonly log: { warn(o: object, msg: string): void; info(o: object, msg: string): void } = console,
  ) {
    this.conn = connection();
    this.platformId = new PublicKey(platformConfig);
    const alt = (process.env.BACKFLOW_ALT ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (alt.length) {
      this.lutState = "loading";
      this.loadLookupTables(alt, 0);
    }
  }

  /**
   * The address lookup table keeps launch transactions under the size limit. Load it at startup and keep
   * retrying with backoff until it loads; /health and /status report "degraded" meanwhile (chain audit L1).
   */
  private loadLookupTables(addrs: string[], attempt: number): void {
    loadLuts(this.conn, addrs)
      .then((l) => {
        if (l.length !== addrs.length) throw new Error(`found ${l.length} of ${addrs.length} lookup tables`);
        this.luts = l;
        this.lutState = "ok";
        this.log.info({ tables: addrs.length }, "address lookup table loaded");
      })
      .catch((e: unknown) => {
        const delay = Math.min(60_000, 2_000 * 2 ** attempt);
        this.log.warn({ err: (e as Error).message, retryInMs: delay }, "address lookup table not loaded yet");
        this.lutTimer = setTimeout(() => this.loadLookupTables(addrs, attempt + 1), delay);
        this.lutTimer.unref?.();
      });
  }

  lookupTable(): LookupTableState {
    return this.lutState;
  }

  close(): void {
    if (this.lutTimer) clearTimeout(this.lutTimer);
  }

  private globalConfig(): Promise<GlobalConfigInfo | null> {
    return this.globalC(() => readGlobalConfig(this.conn, this.A.globalConfig));
  }

  private platform(): Promise<PlatformInfo | null> {
    return this.platformC(() => readPlatform(this.conn, this.platformId));
  }

  rates(): Promise<FeeRates> {
    return this.ratesC(async () => {
      const [gc, pc] = await Promise.all([this.globalConfig(), this.platform()]);
      if (!gc || !pc) return RATES;
      const n = FEES.platformFeeSplit;
      const holders = (pc.feeRate * n.holdersNumerator) / n.holdersDenominator;
      return { raydiumProtocolPpm: gc.tradeFeeRate, platformFeePpm: pc.feeRate, creatorFeePpm: pc.creatorFeeRate, holdersPpm: holders, platformSharePpm: pc.feeRate - holders, totalPpm: gc.tradeFeeRate + pc.feeRate + pc.creatorFeeRate, totalTargetPpm: RATES.totalTargetPpm };
    });
  }

  solUsd(): Promise<number | null> {
    return this.solC(() => solUsd(this.priceSource).catch(() => null));
  }

  /** Whether a mint account exists (a launch that landed); null when the RPC can't tell (D-058). */
  async mintExists(mint: string): Promise<boolean | null> {
    try {
      return (await this.conn.getAccountInfo(new PublicKey(mint), "confirmed")) != null;
    } catch {
      return null;
    }
  }

  async creatorClaimable(creator: string): Promise<bigint | null> {
    try {
      const r = await this.conn.getTokenAccountBalance(creatorFeeVault(this.A.launchLabProgram, new PublicKey(creator)), "confirmed");
      return BigInt(r.value.amount);
    } catch {
      return 0n;
    }
  }

  /** Real post-graduation trade fee of a CPMM pool (SPEC §2.2: show it on the coin page). */
  async cpmmFeePpm(poolId: string): Promise<number | null> {
    if (this.poolFee.has(poolId)) return this.poolFee.get(poolId)!;
    try {
      const fee = await cpmmPoolTradeFeePpm(this.conn, new PublicKey(poolId));
      this.poolFee.set(poolId, fee);
      return fee;
    } catch {
      return null;
    }
  }

  private fees() {
    return { priorityMicroLamports: this.priorityMicroLamports };
  }

  private cpmmAddrs() {
    const r = RAYDIUM[cluster()];
    return { cpmmProgram: new PublicKey(r.cpmmProgram), cpmmAuth: new PublicKey(r.cpmmAuth) };
  }

  /** Exact quote: bonding curve before graduation, the CPMM pool after (SPEC §5.2, §3.4). */
  async quote(coin: CoinRefLike, side: "buy" | "sell", amount: bigint, slippageBps: number): Promise<QuoteDTO | null> {
    if (coin.cpmmPoolId && coin.status === "GRADUATED") {
      const pool = await fetchCpmmPool(this.conn, new PublicKey(coin.cpmmPoolId));
      if (!pool) return null;
      const st = await fetchCpmmState(this.conn, pool, new PublicKey(coin.mint));
      const q = side === "buy" ? quoteCpmmBuy(st, amount) : quoteCpmmSell(st, amount);
      const impact = side === "buy" ? cpmmBuyImpactPpm(st, amount) : cpmmSellImpactPpm(st, amount);
      const fee = side === "buy" ? q.tradeFee + (q.creatorFeeOnInput ? q.creatorFee : 0n) : q.creatorFeeOnInput ? 0n : q.creatorFee;
      return { side, amountIn: amount.toString(), expectedOut: q.amountOut.toString(), minOut: minOutWithSlippage(q.amountOut, slippageBps).toString(), feeLamports: fee.toString(), priceImpactPpm: Number(impact), completesCurve: false };
    }
    const pool = await fetchLaunchPool(this.conn, new PublicKey(coin.poolId));
    if (!pool || pool.status !== 0 || poolProblem(pool, this.A.globalConfig)) return null;
    const s = curveStateOf(pool);
    const rates = await this.rates();
    if (side === "buy") {
      const q = quoteBuy(s, amount, rates);
      return { side, amountIn: q.amountIn.toString(), expectedOut: q.amountOut.toString(), minOut: minOutWithSlippage(q.amountOut, slippageBps).toString(), feeLamports: q.fees.total.toString(), priceImpactPpm: Number(priceChangePpm(spotPrice(s), spotPrice(applyBuy(s, q)))), completesCurve: q.completesCurve };
    }
    const q = quoteSell(s, amount, rates);
    return { side, amountIn: amount.toString(), expectedOut: q.amountOut.toString(), minOut: minOutWithSlippage(q.amountOut, slippageBps).toString(), feeLamports: q.fees.total.toString(), priceImpactPpm: Number(priceChangePpm(spotPrice(s), spotPrice(applySell(s, q)))), completesCurve: false };
  }

  async tradeTx(owner: string, coin: CoinRefLike, side: "buy" | "sell", amount: bigint, slippageBps: number, minOutFloor?: bigint): Promise<{ tx: VersionedTransaction; expectedOut: bigint; minOut: bigint }> {
    const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
    const user = new PublicKey(owner);
    if (coin.cpmmPoolId && coin.status === "GRADUATED") {
      const pool = await fetchCpmmPool(this.conn, new PublicKey(coin.cpmmPoolId));
      if (!pool) throw new Error("Raydium pool not found.");
      const st = await fetchCpmmState(this.conn, pool, new PublicKey(coin.mint));
      const q = side === "buy" ? quoteCpmmBuy(st, amount) : quoteCpmmSell(st, amount);
      const built = minOutWithSlippage(q.amountOut, slippageBps);
      const minOut = minOutFloor != null && minOutFloor > built ? minOutFloor : built; // never below what the user was shown (audit)
      const args = { owner: user, ...this.cpmmAddrs(), pool, coinMint: new PublicKey(coin.mint), amountIn: amount, minOut, fees: this.fees() };
      const ixs = side === "buy" ? cpmmBuyInstructions(args) : cpmmSellInstructions(args);
      return { tx: compile(user, ixs, blockhash, this.luts), expectedOut: q.amountOut, minOut };
    }
    const pool = await fetchLaunchPool(this.conn, new PublicKey(coin.poolId));
    if (!pool) throw new Error("pool not found");
    const problem = poolProblem(pool, this.A.globalConfig);
    if (problem) throw new Error(`This coin can't be traded on Rebuy: ${problem}.`);
    if (pool.status !== 0) throw new Error("This coin is moving to Raydium. Try again in a minute.");
    const p = { owner: user, keys: launchPoolKeys(this.A.launchLabProgram, pool), curve: curveStateOf(pool), rates: await this.rates(), amountIn: amount, slippageBps, minOutFloor, blockhash, luts: this.luts, fees: this.fees() };
    return side === "buy" ? buildBuyTx(p) : buildSellTx(p);
  }

  /** CPMM creator fees accrued in a graduated pool, if `creator` is the pool creator. */
  async cpmmCreatorFees(creator: string, cpmmPoolId: string, coinMint: string): Promise<{ sol: bigint; tokens: bigint } | null> {
    const pool = await fetchCpmmPool(this.conn, new PublicKey(cpmmPoolId)).catch(() => null);
    if (!pool || pool.poolCreator.toBase58() !== creator) return null;
    const coinIsA = pool.mintA.toBase58() === coinMint;
    return { sol: coinIsA ? pool.creatorFeesB : pool.creatorFeesA, tokens: coinIsA ? pool.creatorFeesA : pool.creatorFeesB };
  }

  async claimCpmmCreatorTx(creator: string, cpmmPoolId: string): Promise<VersionedTransaction> {
    const pool = await fetchCpmmPool(this.conn, new PublicKey(cpmmPoolId));
    if (!pool) throw new Error("Raydium pool not found.");
    if (pool.poolCreator.toBase58() !== creator) throw new Error("Only the pool creator can claim these fees.");
    const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
    const owner = new PublicKey(creator);
    return compile(owner, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityMicroLamports }), ...claimCpmmCreatorFeeInstructions({ creator: owner, ...this.cpmmAddrs(), pool })], blockhash, this.luts);
  }

  /** Launch + first buy in one transaction; the server-generated mint key signs, then is discarded. */
  async launchTx(p: { creator: string; name: string; symbol: string; uri: string; firstBuyLamports: bigint; slippageBps: number }, mintKeypair?: Keypair) {
    const mint = mintKeypair ?? Keypair.generate();
    const c = FEES.curve;
    const [gc, pc] = await Promise.all([this.globalConfig(), this.platform()]);
    if (!gc || !pc) throw new Error("LaunchLab global config or platform config not found");
    const init = curveInit({ supply: c.supplyBaseUnits, totalSell: c.sellOnCurveBaseUnits, totalFundRaising: c.graduationTargetLamports, totalLocked: 0n, migrateFee: gc.migrateFee });
    const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
    const r = buildLaunchTx({
      programId: this.A.launchLabProgram,
      globalConfig: this.A.globalConfig,
      platformId: this.platformId,
      creator: new PublicKey(p.creator),
      mint: mint.publicKey,
      name: p.name,
      symbol: p.symbol,
      uri: p.uri,
      decimals: c.decimals,
      supply: c.supplyBaseUnits,
      totalSell: c.sellOnCurveBaseUnits,
      totalFundRaising: c.graduationTargetLamports,
      initialCurve: newCurve(init, c.sellOnCurveBaseUnits),
      rates: await this.rates(),
      firstBuyLamports: p.firstBuyLamports,
      slippageBps: p.slippageBps,
      blockhash,
      luts: this.luts,
      fees: this.fees(),
      // chain audit H4: pass the platform curve-rule / allow-config PDAs when the configs require them
      restrictCurveParam: pc.restrictCurveParam !== 0,
      requiresPlatformAuth: gc.requiresPlatformAuth === 1,
    });
    r.tx.sign([mint]);
    return { ...r, mint: mint.publicKey.toBase58() };
  }

  async claimCreatorTx(creator: string) {
    const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
    const owner = new PublicKey(creator);
    return compile(owner, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityMicroLamports }), ...claimCreatorFeeInstructions(this.A.launchLabProgram, owner)], blockhash, this.luts);
  }

  async walletSol(address: string): Promise<bigint> {
    return BigInt(await this.conn.getBalance(new PublicKey(address), "confirmed"));
  }

  slot(): Promise<number> {
    return this.conn.getSlot("confirmed");
  }
}
