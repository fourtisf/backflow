/**
 * The API's chain access (live mode): fee rates, SOL/USD, creator vault
 * balances, pool fee tiers, and building unsigned transactions for wallets.
 * The API never holds user keys; it only returns transactions to sign.
 */
import {
  RATES,
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
  claimCreatorFeeInstructions,
  compile,
  connection,
  creatorFeeVault,
  curveStateOf,
  cpmmPoolTradeFeePpm,
  fetchLaunchPool,
  launchPoolKeys,
  loadLuts,
  readGlobalConfig,
  readPlatform,
  solUsd,
  type PriceSource,
} from "@backflow/chain";
import { ComputeBudgetProgram, Keypair, PublicKey, type AddressLookupTableAccount, type Connection } from "@solana/web3.js";

const cache = <T>(ms: number) => {
  let at = 0;
  let v: T | undefined;
  return async (f: () => Promise<T>): Promise<T> => {
    if (v !== undefined && Date.now() - at < ms) return v;
    v = await f();
    at = Date.now();
    return v;
  };
};

export class OnChain {
  readonly conn: Connection;
  readonly A = addresses();
  readonly platformId: PublicKey;
  private luts: AddressLookupTableAccount[] = [];
  private ratesC = cache<FeeRates>(600_000);
  private solC = cache<number | null>(30_000);
  private poolFee = new Map<string, number | null>();
  private migrateFeeC = cache<bigint>(3_600_000);

  constructor(platformConfig: string, private readonly priceSource: PriceSource, private readonly priorityMicroLamports: number) {
    this.conn = connection();
    this.platformId = new PublicKey(platformConfig);
    const alt = process.env.BACKFLOW_ALT;
    if (alt) void loadLuts(this.conn, alt.split(",")).then((l) => (this.luts = l)).catch(() => {});
  }

  rates(): Promise<FeeRates> {
    return this.ratesC(async () => {
      const [gc, pc] = await Promise.all([readGlobalConfig(this.conn, this.A.globalConfig), readPlatform(this.conn, this.platformId)]);
      if (!gc || !pc) return RATES;
      const n = FEES.platformFeeSplit;
      const holders = (pc.feeRate * n.holdersNumerator) / n.holdersDenominator;
      return { raydiumProtocolPpm: gc.tradeFeeRate, platformFeePpm: pc.feeRate, creatorFeePpm: pc.creatorFeeRate, holdersPpm: holders, platformSharePpm: pc.feeRate - holders, totalPpm: gc.tradeFeeRate + pc.feeRate + pc.creatorFeeRate, totalTargetPpm: RATES.totalTargetPpm };
    });
  }

  solUsd(): Promise<number | null> {
    return this.solC(() => solUsd(this.priceSource).catch(() => null));
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

  private migrateFee(): Promise<bigint> {
    return this.migrateFeeC(async () => (await readGlobalConfig(this.conn, this.A.globalConfig))?.migrateFee ?? 0n);
  }

  private fees() {
    return { priorityMicroLamports: this.priorityMicroLamports };
  }

  async quote(poolId: string, side: "buy" | "sell", amount: bigint, slippageBps: number): Promise<QuoteDTO | null> {
    const pool = await fetchLaunchPool(this.conn, new PublicKey(poolId));
    if (!pool || pool.status !== 0) return null;
    const s = curveStateOf(pool);
    const rates = await this.rates();
    if (side === "buy") {
      const q = quoteBuy(s, amount, rates);
      return { side, amountIn: q.amountIn.toString(), expectedOut: q.amountOut.toString(), minOut: minOutWithSlippage(q.amountOut, slippageBps).toString(), feeLamports: q.fees.total.toString(), priceImpactPpm: Number(priceChangePpm(spotPrice(s), spotPrice(applyBuy(s, q)))), completesCurve: q.completesCurve };
    }
    const q = quoteSell(s, amount, rates);
    return { side, amountIn: amount.toString(), expectedOut: q.amountOut.toString(), minOut: minOutWithSlippage(q.amountOut, slippageBps).toString(), feeLamports: q.fees.total.toString(), priceImpactPpm: Number(priceChangePpm(spotPrice(s), spotPrice(applySell(s, q)))), completesCurve: false };
  }

  async tradeTx(owner: string, poolId: string, side: "buy" | "sell", amount: bigint, slippageBps: number) {
    const pool = await fetchLaunchPool(this.conn, new PublicKey(poolId));
    if (!pool) throw new Error("pool not found");
    if (pool.status !== 0) throw new Error("This coin has left the bonding curve. Trade it on Raydium.");
    const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
    const p = { owner: new PublicKey(owner), keys: launchPoolKeys(this.A.launchLabProgram, pool), curve: curveStateOf(pool), rates: await this.rates(), amountIn: amount, slippageBps, blockhash, luts: this.luts, fees: this.fees() };
    return side === "buy" ? buildBuyTx(p) : buildSellTx(p);
  }

  /** Launch + first buy in one transaction; the server-generated mint key signs, then is discarded. */
  async launchTx(p: { creator: string; name: string; symbol: string; uri: string; firstBuyLamports: bigint; slippageBps: number }) {
    const mint = Keypair.generate();
    const c = FEES.curve;
    const init = curveInit({ supply: c.supplyBaseUnits, totalSell: c.sellOnCurveBaseUnits, totalFundRaising: c.graduationTargetLamports, totalLocked: 0n, migrateFee: await this.migrateFee() });
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
