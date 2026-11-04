/**
 * The chain operations workers need, behind one interface so job logic can be
 * tested against a fake. RealChain implements it with @backflow/chain.
 */
import { CURVE, FEES, type FeeRates } from "@backflow/core";
import {
  addresses,
  ata,
  broadcast,
  checkPrevious,
  claimPlatformVaultInstructions,
  cluster,
  connection,
  cpmmBuyInstructions,
  curveBuyInstructions,
  curveStateOf,
  decodeCpmmPool,
  decodeLockedCpPosition,
  fetchCpmmState,
  fetchLaunchPool,
  harvestInstructions,
  launchPoolKeys,
  loadKeypair,
  lockedPositionAddress,
  parseLaunchLabTx,
  payoutInstructions,
  platformFeeVault,
  prepare,
  prepareBuilt,
  readGlobalConfig,
  readPlatform,
  solUsd,
  statusOf,
  tokenBalanceChanges,
  waitForLanding,
  type BalanceChange,
  type LandedStatus,
  type LaunchPool,
  type ParsedLaunchLabTx,
  type PreparedTx,
  type PriceSource,
} from "@backflow/chain";
import { maxBuyWithinImpact, maxCpmmBuyWithinImpact, quoteBuy, quoteCpmmBuy, RAYDIUM } from "@backflow/core";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createTransferInstruction } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";

export interface Prepared {
  signature: string;
  lastValidBlockHeight: number;
  /** Set when the transaction used a different venue than planned (e.g. Jupiter). */
  venue?: "CURVE" | "CPMM" | "JUPITER";
}

export interface CoinRef {
  mint: string;
  poolId: string;
  cpmmPoolId: string | null;
  graduated: boolean;
}

export interface BuybackPlan {
  venue: "CURVE" | "CPMM";
  /** Largest gross lamports within the impact cap, ≤ budget. */
  maxChunk(budget: bigint): bigint;
  /** Expected tokens for a spend. */
  expectedOut(amount: bigint): bigint;
}

export interface TokenMetadata {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

export interface TxEffects {
  tokenDeltas: BalanceChange[];
  slot: number;
  blockTime: number | null;
}

export interface Wallets {
  buyback: string;
  distributor: string;
  claim: string;
  treasury: string;
  lockNft: string;
}

export interface Chain {
  readonly wallets: Wallets;
  readonly platformConfig: string;
  readonly launchLabProgram: string;
  currentSlot(): Promise<number>;
  /** Signatures for an address newer than `until`, oldest first. */
  signaturesSince(address: string, until: string | null, max: number): Promise<{ signature: string; slot: number; failed: boolean; blockTime: number | null }[]>;
  parsedTx(signature: string): Promise<ParsedLaunchLabTx | null>;
  launchPool(poolId: string): Promise<LaunchPool | null>;
  liveRates(): Promise<FeeRates>;
  solUsd(): Promise<number | null>;
  tokenMetadata(uri: string): Promise<TokenMetadata | null>;
  buybackPlan(coin: CoinRef, capBps: number): Promise<BuybackPlan | null>;
  prepareBuyback(coin: CoinRef, amount: bigint, minOut: bigint): Promise<Prepared>;
  existingTokenAccounts(mint: string, wallets: string[]): Promise<Set<string>>;
  prepareTransfers(mint: string, items: { wallet: string; amount: bigint }[]): Promise<Prepared>;
  tokenBalance(owner: string, mint: string): Promise<bigint>;
  solBalance(owner: string): Promise<bigint>;
  platformVaultBalance(): Promise<bigint>;
  prepareVaultClaim(): Promise<Prepared>;
  prepareClaimTransfers(outs: { to: string; lamports: bigint }[]): Promise<Prepared>;
  findFeeKey(cpmmPoolId: string): Promise<string | null>;
  harvestableLp(feeKeyMint: string): Promise<bigint>;
  prepareHarvest(coin: CoinRef, feeKeyMint: string): Promise<Prepared>;
  prepareHarvestSettle(mint: string, lamportsToBuyback: bigint, tokensToDistributor: bigint): Promise<Prepared>;
  broadcast(p: Prepared): Promise<void>;
  wait(signature: string, lastValidBlockHeight: number): Promise<LandedStatus>;
  check(signature: string, lastValidBlockHeight: number | null): Promise<LandedStatus>;
  txEffects(signature: string): Promise<TxEffects | null>;
}

export interface RealChainConfig {
  platformConfig: string;
  priorityMicroLamports: number;
  priceSource: PriceSource;
}

/** Live implementation. Keys are loaded from the paths in env (never from the repo). */
export class RealChain implements Chain {
  readonly wallets: Wallets;
  readonly platformConfig: string;
  readonly launchLabProgram: string;
  private readonly conn: Connection;
  private readonly A: ReturnType<typeof addresses>;
  private readonly raydium = RAYDIUM[cluster()];
  private readonly prepared = new Map<string, PreparedTx>();
  private keys: { buyback?: Keypair; distributor?: Keypair; claim?: Keypair } = {};
  private ratesCache: { at: number; rates: FeeRates } | null = null;

  constructor(private readonly cfg: RealChainConfig) {
    this.conn = connection();
    this.A = addresses();
    this.platformConfig = cfg.platformConfig;
    this.launchLabProgram = this.A.launchLabProgram.toBase58();
    const pub = (name: string) => {
      try {
        return loadKeypair(name).publicKey.toBase58();
      } catch {
        return "";
      }
    };
    const claim = pub("PLATFORM_FEE_WALLET_KEYPAIR_PATH");
    this.wallets = {
      buyback: pub("BUYBACK_WALLET_KEYPAIR_PATH"),
      distributor: pub("DISTRIBUTOR_WALLET_KEYPAIR_PATH"),
      claim,
      treasury: process.env.TREASURY_PUBKEY && !process.env.TREASURY_PUBKEY.startsWith("REPLACE") ? process.env.TREASURY_PUBKEY : "",
      lockNft: process.env.PLATFORM_LOCK_NFT_WALLET || claim,
    };
  }

  private key(which: "buyback" | "distributor" | "claim"): Keypair {
    const env = { buyback: "BUYBACK_WALLET_KEYPAIR_PATH", distributor: "DISTRIBUTOR_WALLET_KEYPAIR_PATH", claim: "PLATFORM_FEE_WALLET_KEYPAIR_PATH" }[which];
    return (this.keys[which] ??= loadKeypair(env));
  }

  private fees() {
    return { priorityMicroLamports: this.cfg.priorityMicroLamports };
  }

  private async keep(payer: Keypair, ixs: TransactionInstruction[]): Promise<Prepared> {
    const p = await prepare(this.conn, payer, ixs);
    this.prepared.set(p.signature, p);
    return { signature: p.signature, lastValidBlockHeight: p.lastValidBlockHeight };
  }

  currentSlot() {
    return this.conn.getSlot("confirmed");
  }

  async signaturesSince(address: string, until: string | null, max: number) {
    const out: { signature: string; slot: number; failed: boolean; blockTime: number | null }[] = [];
    let before: string | undefined;
    while (out.length < max) {
      const page = await this.conn.getSignaturesForAddress(new PublicKey(address), { before, until: until ?? undefined, limit: 1000 }, "confirmed");
      if (!page.length) break;
      for (const s of page) out.push({ signature: s.signature, slot: s.slot, failed: !!s.err, blockTime: s.blockTime ?? null });
      before = page[page.length - 1]!.signature;
      if (page.length < 1000) break;
    }
    return out.reverse(); // oldest first
  }

  async parsedTx(signature: string) {
    const tx = await this.conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    return tx ? parseLaunchLabTx(tx, signature, this.launchLabProgram) : null;
  }

  launchPool(poolId: string) {
    return fetchLaunchPool(this.conn, new PublicKey(poolId));
  }

  /** Protocol fee from the GlobalConfig, platform and creator fees from our PlatformConfig (cached 10 min). */
  async liveRates(): Promise<FeeRates> {
    if (this.ratesCache && Date.now() - this.ratesCache.at < 600_000) return this.ratesCache.rates;
    const [gc, pc] = await Promise.all([readGlobalConfig(this.conn, this.A.globalConfig), readPlatform(this.conn, new PublicKey(this.platformConfig))]);
    if (!gc || !pc) throw new Error("GlobalConfig or PlatformConfig not found");
    const n = FEES.platformFeeSplit;
    const holdersPpm = (pc.feeRate * n.holdersNumerator) / n.holdersDenominator;
    const rates: FeeRates = {
      raydiumProtocolPpm: gc.tradeFeeRate,
      platformFeePpm: pc.feeRate,
      creatorFeePpm: pc.creatorFeeRate,
      holdersPpm,
      platformSharePpm: pc.feeRate - holdersPpm,
      totalPpm: gc.tradeFeeRate + pc.feeRate + pc.creatorFeeRate,
      totalTargetPpm: FEES.rates.totalTargetPpm,
    };
    this.ratesCache = { at: Date.now(), rates };
    return rates;
  }

  async solUsd() {
    try {
      return await solUsd(this.cfg.priceSource);
    } catch {
      return null;
    }
  }

  async tokenMetadata(uri: string): Promise<TokenMetadata | null> {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      const r = await fetch(uri, { signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      return (await r.json()) as TokenMetadata;
    } catch {
      return null;
    }
  }

  async buybackPlan(coin: CoinRef, capBps: number): Promise<BuybackPlan | null> {
    const rates = await this.liveRates();
    if (!coin.graduated) {
      const pool = await this.launchPool(coin.poolId);
      if (!pool || pool.status !== 0) return null;
      const s = curveStateOf(pool);
      return { venue: "CURVE", maxChunk: (b) => maxBuyWithinImpact(s, b, capBps, rates), expectedOut: (a) => quoteBuy(s, a, rates).amountOut };
    }
    if (!coin.cpmmPoolId) return null;
    const acc = await this.conn.getAccountInfo(new PublicKey(coin.cpmmPoolId), "confirmed");
    if (!acc) return null;
    const st = await fetchCpmmState(this.conn, decodeCpmmPool(new PublicKey(coin.cpmmPoolId), acc.data), new PublicKey(coin.mint));
    return { venue: "CPMM", maxChunk: (b) => maxCpmmBuyWithinImpact(st, b, capBps), expectedOut: (a) => quoteCpmmBuy(st, a).amountOut };
  }

  /** Buyback wallet pays SOL; bought tokens go straight to the distributor's token account (DECISIONS D-017). */
  async prepareBuyback(coin: CoinRef, amount: bigint, minOut: bigint): Promise<Prepared> {
    const payer = this.key("buyback");
    const distributor = new PublicKey(this.wallets.distributor);
    const mint = new PublicKey(coin.mint);
    if (!coin.graduated) {
      const pool = await this.launchPool(coin.poolId);
      if (!pool) throw new Error("pool not found");
      const keys = launchPoolKeys(this.A.launchLabProgram, pool);
      const ixs = curveBuyInstructions(payer.publicKey, keys, amount, minOut, this.fees());
      return this.keep(payer, redirectBaseTo(ixs, payer.publicKey, distributor, mint, keys.mintProgramA));
    }
    const acc = await this.conn.getAccountInfo(new PublicKey(coin.cpmmPoolId!), "confirmed");
    if (!acc) throw new Error("CPMM pool not found");
    const pool = decodeCpmmPool(new PublicKey(coin.cpmmPoolId!), acc.data);
    const jup = await this.jupiterBuyback(coin, pool, amount, minOut).catch(() => null);
    if (jup) return jup;
    const ixs = cpmmBuyInstructions({ owner: payer.publicKey, cpmmProgram: new PublicKey(this.raydium.cpmmProgram), cpmmAuth: new PublicKey(this.raydium.cpmmAuth), pool, coinMint: mint, amountIn: amount, minOut, fees: this.fees() });
    const program = pool.mintA.equals(mint) ? pool.mintProgramA : pool.mintProgramB;
    return this.keep(payer, redirectBaseTo(ixs, payer.publicKey, distributor, mint, program));
  }

  /**
   * SPEC §3.1: after graduation, use Jupiter when its route returns at least 0.2% more than the CPMM pool
   * and stays inside the impact cap. Off unless JUPITER_BUYBACKS=1. Tokens go to the distributor's
   * existing token account; if it doesn't exist yet, the CPMM path is used.
   */
  private async jupiterBuyback(coin: CoinRef, pool: ReturnType<typeof decodeCpmmPool>, amount: bigint, minOut: bigint): Promise<Prepared | null> {
    if (process.env.JUPITER_BUYBACKS !== "1") return null;
    const mint = new PublicKey(coin.mint);
    const distAta = ata(new PublicKey(this.wallets.distributor), mint);
    if (!(await this.conn.getAccountInfo(distAta, "confirmed"))) return null;
    const capBps = FEES.buyback.maxImpactBps;
    const base = process.env.JUPITER_API_URL ?? "https://lite-api.jup.ag/swap/v1";
    const q = (await (await fetch(`${base}/quote?inputMint=${NATIVE_MINT.toBase58()}&outputMint=${coin.mint}&amount=${amount}&slippageBps=${capBps}`)).json()) as { outAmount?: string; otherAmountThreshold?: string; priceImpactPct?: string };
    if (!q.outAmount || !q.otherAmountThreshold) return null;
    const cpmmOut = quoteCpmmBuy(await fetchCpmmState(this.conn, pool, mint), amount).amountOut;
    const out = BigInt(q.outAmount);
    if (out * 1000n < cpmmOut * 1002n || BigInt(q.otherAmountThreshold) < minOut) return null;
    if (Number(q.priceImpactPct ?? "1") * 10_000 > capBps) return null;
    const payer = this.key("buyback");
    const r = (await (
      await fetch(`${base}/swap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quoteResponse: q, userPublicKey: payer.publicKey.toBase58(), destinationTokenAccount: distAta.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }),
      })
    ).json()) as { swapTransaction?: string };
    if (!r.swapTransaction) return null;
    const p = await prepareBuilt(this.conn, VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, "base64")), [payer]);
    this.prepared.set(p.signature, p);
    return { signature: p.signature, lastValidBlockHeight: p.lastValidBlockHeight, venue: "JUPITER" };
  }

  async existingTokenAccounts(mint: string, wallets: string[]) {
    const m = new PublicKey(mint);
    const atas = wallets.map((w) => ata(new PublicKey(w), m));
    const out = new Set<string>();
    for (let i = 0; i < atas.length; i += 100) {
      const infos = await this.conn.getMultipleAccountsInfo(atas.slice(i, i + 100), "confirmed");
      infos.forEach((info, j) => {
        if (info && info.owner.equals(TOKEN_PROGRAM_ID)) out.add(wallets[i + j]!);
      });
    }
    return out;
  }

  prepareTransfers(mint: string, items: { wallet: string; amount: bigint }[]) {
    const d = this.key("distributor");
    return this.keep(d, payoutInstructions(d.publicKey, new PublicKey(mint), items.map((i) => ({ wallet: new PublicKey(i.wallet), amount: i.amount })), this.fees()));
  }

  async tokenBalance(owner: string, mint: string) {
    try {
      const r = await this.conn.getTokenAccountBalance(ata(new PublicKey(owner), new PublicKey(mint)), "confirmed");
      return BigInt(r.value.amount);
    } catch {
      return 0n;
    }
  }

  async solBalance(owner: string) {
    return BigInt(await this.conn.getBalance(new PublicKey(owner), "confirmed"));
  }

  async platformVaultBalance() {
    try {
      const r = await this.conn.getTokenAccountBalance(platformFeeVault(this.A.launchLabProgram, new PublicKey(this.platformConfig)), "confirmed");
      return BigInt(r.value.amount);
    } catch {
      return 0n;
    }
  }

  prepareVaultClaim() {
    const c = this.key("claim");
    return this.keep(c, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.cfg.priorityMicroLamports }), ...claimPlatformVaultInstructions(this.A.launchLabProgram, new PublicKey(this.platformConfig), c.publicKey)]);
  }

  prepareClaimTransfers(outs: { to: string; lamports: bigint }[]) {
    const c = this.key("claim");
    return this.keep(c, [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.cfg.priorityMicroLamports }),
      ...outs.filter((o) => o.lamports > 0n).map((o) => SystemProgram.transfer({ fromPubkey: c.publicKey, toPubkey: new PublicKey(o.to), lamports: o.lamports })),
    ]);
  }

  /** Fee Key NFTs: balance-1, 0-decimal tokens in the lock NFT wallet whose locked position points at the pool. */
  async findFeeKey(cpmmPoolId: string) {
    const owner = new PublicKey(this.wallets.lockNft);
    const accs = await this.conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, "confirmed");
    for (const a of accs.value) {
      const info = a.account.data.parsed?.info as { mint: string; tokenAmount: { amount: string; decimals: number } } | undefined;
      if (!info || info.tokenAmount.amount !== "1" || info.tokenAmount.decimals !== 0) continue;
      const pos = await this.conn.getAccountInfo(lockedPositionAddress(new PublicKey(this.raydium.lockProgram), new PublicKey(info.mint)), "confirmed");
      if (pos && decodeLockedCpPosition(pos.data).poolId.toBase58() === cpmmPoolId) return info.mint;
    }
    return null;
  }

  async harvestableLp(feeKeyMint: string) {
    const pos = await this.conn.getAccountInfo(lockedPositionAddress(new PublicKey(this.raydium.lockProgram), new PublicKey(feeKeyMint)), "confirmed");
    // unclaimed_lp_amount is only refreshed on collect; treat any locked position as harvestable and let the tx decide
    return pos ? decodeLockedCpPosition(pos.data).lockedLpAmount : 0n;
  }

  async prepareHarvest(coin: CoinRef, feeKeyMint: string) {
    const owner = this.key("claim");
    if (owner.publicKey.toBase58() !== this.wallets.lockNft) throw new Error("the Fee Key owner key is not loaded (PLATFORM_LOCK_NFT_WALLET must be the platform fee wallet)");
    const acc = await this.conn.getAccountInfo(new PublicKey(coin.cpmmPoolId!), "confirmed");
    if (!acc) throw new Error("CPMM pool not found");
    const pool = decodeCpmmPool(new PublicKey(coin.cpmmPoolId!), acc.data);
    return this.keep(owner, [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.cfg.priorityMicroLamports }),
      ...harvestInstructions({ lockProgram: new PublicKey(this.raydium.lockProgram), lockAuth: new PublicKey(this.raydium.lockCpmmAuth), cpmmProgram: new PublicKey(this.raydium.cpmmProgram), cpmmAuth: new PublicKey(this.raydium.cpmmAuth), nftOwner: owner.publicKey, nftMint: new PublicKey(feeKeyMint), pool }),
    ]);
  }

  /** Unwrap harvested wSOL, send the buyback share to the buyback wallet and the coin tokens to the distributor. */
  async prepareHarvestSettle(mint: string, lamportsToBuyback: bigint, tokensToDistributor: bigint) {
    const owner = this.key("claim");
    const m = new PublicKey(mint);
    const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.cfg.priorityMicroLamports })];
    const wsol = ata(owner.publicKey, NATIVE_MINT);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, wsol, owner.publicKey, NATIVE_MINT), createCloseAccountInstruction(wsol, owner.publicKey, owner.publicKey));
    if (lamportsToBuyback > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: new PublicKey(this.wallets.buyback), lamports: lamportsToBuyback }));
    if (tokensToDistributor > 0n) {
      const dist = ata(new PublicKey(this.wallets.distributor), m);
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, dist, new PublicKey(this.wallets.distributor), m), createTransferInstruction(ata(owner.publicKey, m), dist, owner.publicKey, tokensToDistributor));
    }
    return this.keep(owner, ixs);
  }

  async broadcast(p: Prepared) {
    const full = this.prepared.get(p.signature);
    if (!full) throw new Error("prepared transaction not in memory; check its status instead of resending");
    await broadcast(this.conn, full);
  }

  wait(signature: string, lastValidBlockHeight: number) {
    return waitForLanding(this.conn, signature, lastValidBlockHeight);
  }

  check(signature: string, lastValidBlockHeight: number | null) {
    return lastValidBlockHeight == null ? statusOf(this.conn, signature) : checkPrevious(this.conn, signature, lastValidBlockHeight);
  }

  async txEffects(signature: string): Promise<TxEffects | null> {
    const tx = await this.conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx || tx.meta?.err) return null;
    return { tokenDeltas: tokenBalanceChanges(tx), slot: tx.slot, blockTime: tx.blockTime ?? null };
  }
}

/**
 * Replace the payer's base-token ATA with the distributor's in a buy, and create
 * the distributor's ATA (idempotent) instead of the payer's.
 */
function redirectBaseTo(ixs: TransactionInstruction[], payer: PublicKey, distributor: PublicKey, mint: PublicKey, program: PublicKey): TransactionInstruction[] {
  const from = ata(payer, mint, program);
  const to = ata(distributor, mint, program);
  return ixs.map((ix) => {
    const isPayerAtaCreate = ix.programId.toBase58() === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" && ix.keys[1]?.pubkey.equals(from);
    if (isPayerAtaCreate) return createAssociatedTokenAccountIdempotentInstruction(payer, to, distributor, mint, program);
    return new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: ix.keys.map((k) => (k.pubkey.equals(from) ? { ...k, pubkey: to } : k)) });
  });
}

export const DEFAULT_SUPPLY = CURVE.supplyBaseUnits;
