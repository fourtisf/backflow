/**
 * The chain operations workers need, behind one interface so job logic can be
 * tested against a fake. RealChain implements it with @backflow/chain.
 */
import { CURVE, FEES, fetchableMetadataUri, type FeeRates } from "@backflow/core";
import { checkJupiterInstructions, tokenAmountOf, type JupSwapInstructions } from "./jupiter";
import { fetchJsonLimited } from "./safe-fetch";

/** Most the buyback wallet may lose beyond the swap amount in a Jupiter buyback (network + priority fees, temporary rent). */
const JUPITER_FEE_CAP = 10_000_000n;

/** Gateway used to fetch ipfs:// metadata and to rewrite image links. */
export const ipfsGateway = () => process.env.PINATA_GATEWAY || "https://gateway.pinata.cloud/ipfs/";
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
  loadLuts,
  prepare,
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
  jupiterGateway,
} from "@backflow/chain";
import { maxBuyWithinImpact, maxCpmmBuyWithinImpact, quoteBuy, quoteCpmmBuy, RAYDIUM } from "@backflow/core";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createTransferInstruction } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, type Connection, type Keypair } from "@solana/web3.js";

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
  /** True when the transaction landed but failed (fee still paid). */
  failed: boolean;
  /** Network fee in lamports (paid by the fee payer). */
  fee: bigint;
  tokenDeltas: BalanceChange[];
  /** Lamport change per account key (pre → post). */
  lamportDeltas: Record<string, bigint>;
  slot: number;
  blockTime: number | null;
}

/** Real token holdings of a coin, aggregated per owner wallet. Program-owned (off-curve) owners are flagged. */
export interface ChainHolding {
  owner: string;
  amount: bigint;
  programOwned: boolean;
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
  /** Raw metadata JSON (untrusted: callers run it through cleanMetadata). Null when it can't be fetched within the limits. */
  tokenMetadata(uri: string): Promise<unknown | null>;
  /** Every token account of the mint, aggregated by owner (getProgramAccounts). Null when the RPC call fails. */
  holderBalances(mint: string): Promise<{ slot: number; holdings: ChainHolding[] } | null>;
  /** Block time of a slot, for transactions whose blockTime was missing. */
  blockTime(slot: number): Promise<number | null>;
  buybackPlan(coin: CoinRef, capBps: number): Promise<BuybackPlan | null>;
  prepareBuyback(coin: CoinRef, amount: bigint, minOut: bigint): Promise<Prepared>;
  existingTokenAccounts(mint: string, wallets: string[]): Promise<Set<string>>;
  prepareTransfers(mint: string, items: { wallet: string; amount: bigint }[], decimals: number): Promise<Prepared>;
  tokenBalance(owner: string, mint: string): Promise<bigint>;
  solBalance(owner: string): Promise<bigint>;
  platformVaultBalance(): Promise<bigint>;
  prepareVaultClaim(): Promise<Prepared>;
  prepareClaimTransfers(outs: { to: string; lamports: bigint }[]): Promise<Prepared>;
  findFeeKey(cpmmPoolId: string): Promise<string | null>;
  harvestableLp(feeKeyMint: string): Promise<bigint>;
  prepareHarvest(coin: CoinRef, feeKeyMint: string): Promise<Prepared>;
  prepareHarvestSettle(mint: string, lamportsToBuyback: bigint, tokensToDistributor: bigint, lamportsToTreasury: bigint): Promise<Prepared>;
  broadcast(p: Prepared): Promise<void>;
  wait(signature: string, lastValidBlockHeight: number): Promise<LandedStatus>;
  check(signature: string, lastValidBlockHeight: number | null): Promise<LandedStatus>;
  /** Effects of a landed transaction; null while the RPC can't return it yet (callers retry, never settle as zero). */
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
    // Public keys come from *_PUBKEY env vars, so each worker only needs (and only gets) its own secret key
    // file (per-process env files, DEPLOY.md). The key file is the fallback for local development.
    const pub = (keyEnv: string, pubEnv: string) => {
      const v = process.env[pubEnv];
      if (v && !v.startsWith("REPLACE")) return new PublicKey(v).toBase58();
      try {
        return loadKeypair(keyEnv).publicKey.toBase58();
      } catch {
        return "";
      }
    };
    const claim = pub("PLATFORM_FEE_WALLET_KEYPAIR_PATH", "PLATFORM_FEE_PUBKEY");
    this.wallets = {
      buyback: pub("BUYBACK_WALLET_KEYPAIR_PATH", "BUYBACK_PUBKEY"),
      distributor: pub("DISTRIBUTOR_WALLET_KEYPAIR_PATH", "DISTRIBUTOR_PUBKEY"),
      claim,
      treasury: process.env.TREASURY_PUBKEY && !process.env.TREASURY_PUBKEY.startsWith("REPLACE") ? process.env.TREASURY_PUBKEY : "",
      lockNft: process.env.PLATFORM_LOCK_NFT_WALLET || claim,
    };
  }

  private key(which: "buyback" | "distributor" | "claim"): Keypair {
    const env = { buyback: "BUYBACK_WALLET_KEYPAIR_PATH", distributor: "DISTRIBUTOR_WALLET_KEYPAIR_PATH", claim: "PLATFORM_FEE_WALLET_KEYPAIR_PATH" }[which];
    const expected = { buyback: this.wallets.buyback, distributor: this.wallets.distributor, claim: this.wallets.claim }[which];
    if (!this.keys[which]) {
      const k = loadKeypair(env);
      if (expected && k.publicKey.toBase58() !== expected) throw new Error(`${env} does not match the configured ${which} public key`);
      this.keys[which] = k;
    }
    return this.keys[which]!;
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

  /**
   * The RPC returns newest first, 1000 per page. Page back with `before` until the cursor (`until`) is
   * reached, then hand back the OLDEST `max` so the caller's cursor never jumps over a gap.
   */
  async signaturesSince(address: string, until: string | null, max: number) {
    return collectSignatures(async (before) => {
      const page = await this.conn.getSignaturesForAddress(new PublicKey(address), { before, until: until ?? undefined, limit: 1000 }, "confirmed");
      return page.map((s) => ({ signature: s.signature, slot: s.slot, failed: !!s.err, blockTime: s.blockTime ?? null }));
    }, max);
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

  async tokenMetadata(uri: string): Promise<unknown | null> {
    const url = fetchableMetadataUri(uri, ipfsGateway());
    if (!url) return null;
    try {
      return await fetchJsonLimited(url);
    } catch {
      return null;
    }
  }

  async holderBalances(mint: string): Promise<{ slot: number; holdings: ChainHolding[] } | null> {
    try {
      const { context, value: accs } = await this.conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
        withContext: true,
        commitment: "confirmed",
        filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }],
        dataSlice: { offset: 32, length: 40 }, // owner (32) + amount (8)
      });
      const by = new Map<string, bigint>();
      for (const a of accs) {
        const d = a.account.data;
        const owner = new PublicKey(d.subarray(0, 32)).toBase58();
        by.set(owner, (by.get(owner) ?? 0n) + d.readBigUInt64LE(32));
      }
      return { slot: context.slot, holdings: [...by].map(([owner, amount]) => ({ owner, amount, programOwned: !PublicKey.isOnCurve(new PublicKey(owner).toBytes()) })) };
    } catch {
      return null;
    }
  }

  async blockTime(slot: number) {
    try {
      return await this.conn.getBlockTime(slot);
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
      // Cap at what completes the curve (as the SDK does), so the program takes exactly what we record as spent.
      const maxChunk = (b: bigint) => {
        const x = maxBuyWithinImpact(s, b, capBps, rates);
        return x > 0n ? quoteBuy(s, x, rates).amountIn : 0n;
      };
      return { venue: "CURVE", maxChunk, expectedOut: (a) => quoteBuy(s, a, rates).amountOut };
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
    const jup = jupiterGateway();
    const base = process.env.JUPITER_API_URL || `${jup.base}/swap/v1`;
    const get = async (url: string, init?: RequestInit) =>
      (await fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...jup.headers }, signal: AbortSignal.timeout(10_000) })).json();
    const q = (await get(`${base}/quote?inputMint=${NATIVE_MINT.toBase58()}&outputMint=${coin.mint}&amount=${amount}&slippageBps=${capBps}`)) as { outAmount?: string; otherAmountThreshold?: string; priceImpactPct?: string; inAmount?: string };
    if (!q.outAmount || !q.otherAmountThreshold || q.inAmount !== amount.toString()) return null;
    const cpmmOut = quoteCpmmBuy(await fetchCpmmState(this.conn, pool, mint), amount).amountOut;
    const out = BigInt(q.outAmount);
    if (out * 1000n < cpmmOut * 1002n || BigInt(q.otherAmountThreshold) < minOut) return null;
    if (Number(q.priceImpactPct ?? "1") * 10_000 > capBps) return null;
    const payer = this.key("buyback");
    const r = (await get(`${base}/swap-instructions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteResponse: q, userPublicKey: payer.publicKey.toBase58(), destinationTokenAccount: distAta.toBase58(), wrapAndUnwrapSol: true }),
    })) as JupSwapInstructions;
    // Allowlisted instructions only, compiled by us with our payer, blockhash and compute budget.
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.cfg.priorityMicroLamports }), ...checkJupiterInstructions(r, payer.publicKey, distAta)];
    const luts = await loadLuts(this.conn, r.addressLookupTableAddresses ?? []);
    const p = await prepare(this.conn, payer, ixs, [], luts);
    // Balance effects: the buyback wallet loses at most amount + a fee cap, and the distributor gains at least minOut.
    const [solBefore, tokBefore] = await Promise.all([this.conn.getBalance(payer.publicKey, "confirmed"), this.tokenBalance(this.wallets.distributor, coin.mint)]);
    const sim = await this.conn.simulateTransaction(p.tx, { sigVerify: false, commitment: "confirmed", accounts: { encoding: "base64", addresses: [payer.publicKey.toBase58(), distAta.toBase58()] } });
    const [payerAcc, distAcc] = sim.value.accounts ?? [];
    if (sim.value.err || !payerAcc || !distAcc) throw new Error("jupiter: simulation failed");
    const solSpent = BigInt(solBefore) - BigInt(payerAcc.lamports);
    const tokGained = tokenAmountOf(Buffer.from(distAcc.data[0] ?? "", "base64")) - tokBefore;
    if (solSpent > amount + JUPITER_FEE_CAP || tokGained < minOut) throw new Error(`jupiter: balance check failed (sol ${solSpent}, tokens ${tokGained})`);
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

  prepareTransfers(mint: string, items: { wallet: string; amount: bigint }[], decimals: number) {
    const d = this.key("distributor");
    return this.keep(d, payoutInstructions(d.publicKey, new PublicKey(mint), items.map((i) => ({ wallet: new PublicKey(i.wallet), amount: i.amount })), this.fees(), decimals));
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
      ...outs.filter((o) => o.lamports > 0n && o.to !== c.publicKey.toBase58()).map((o) => SystemProgram.transfer({ fromPubkey: c.publicKey, toPubkey: new PublicKey(o.to), lamports: o.lamports })),
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

  /** Unwrap harvested wSOL; send the buyback share to the buyback wallet, the platform share to the treasury and the coin tokens to the distributor. */
  async prepareHarvestSettle(mint: string, lamportsToBuyback: bigint, tokensToDistributor: bigint, lamportsToTreasury: bigint) {
    const owner = this.key("claim");
    const m = new PublicKey(mint);
    const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.cfg.priorityMicroLamports })];
    const wsol = ata(owner.publicKey, NATIVE_MINT);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, wsol, owner.publicKey, NATIVE_MINT), createCloseAccountInstruction(wsol, owner.publicKey, owner.publicKey));
    // With one server wallet (D-045) the buyback share and the coin tokens already sit where they belong.
    const self = owner.publicKey.toBase58();
    if (lamportsToBuyback > 0n && this.wallets.buyback !== self) ixs.push(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: new PublicKey(this.wallets.buyback), lamports: lamportsToBuyback }));
    if (lamportsToTreasury > 0n && !this.wallets.treasury) throw new Error("TREASURY_PUBKEY is not set: the platform share of a harvest has nowhere to go");
    if (lamportsToTreasury > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: new PublicKey(this.wallets.treasury), lamports: lamportsToTreasury }));
    if (tokensToDistributor > 0n && this.wallets.distributor !== self) {
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
    if (!tx || !tx.meta) return null; // not visible on this node yet
    const keys = [
      ...tx.transaction.message.staticAccountKeys.map((k) => k.toBase58()),
      ...(tx.meta.loadedAddresses?.writable ?? []).map((k) => k.toBase58()),
      ...(tx.meta.loadedAddresses?.readonly ?? []).map((k) => k.toBase58()),
    ];
    const lamportDeltas: Record<string, bigint> = {};
    keys.forEach((k, i) => {
      const d = BigInt(tx.meta!.postBalances[i] ?? 0) - BigInt(tx.meta!.preBalances[i] ?? 0);
      if (d !== 0n) lamportDeltas[k] = (lamportDeltas[k] ?? 0n) + d;
    });
    const failed = !!tx.meta.err;
    return { failed, fee: BigInt(tx.meta.fee), tokenDeltas: failed ? [] : tokenBalanceChanges(tx), lamportDeltas, slot: tx.slot, blockTime: tx.blockTime ?? null };
  }
}

export type SigInfo = { signature: string; slot: number; failed: boolean; blockTime: number | null };

/**
 * getSignaturesForAddress pages newest → oldest. Keep paging (with `before`) until a short page says
 * the cursor was reached, then return the OLDEST `max`, oldest first, so a backlog larger than one
 * page is worked through in order instead of skipped.
 */
export async function collectSignatures(page: (before: string | undefined) => Promise<SigInfo[]>, max: number, pageSize = 1000): Promise<SigInfo[]> {
  const out: SigInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const p = await page(before);
    out.push(...p);
    if (p.length < pageSize) break;
    before = p[p.length - 1]!.signature;
  }
  return out.reverse().slice(0, max);
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
