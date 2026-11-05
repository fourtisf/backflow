import type { FeeRates } from "@backflow/core";
import { FEES } from "@backflow/core";
import type { LandedStatus, LaunchPool, ParsedLaunchLabTx, BalanceChange } from "@backflow/chain";
import type { BuybackPlan, Chain, ChainHolding, CoinRef, Prepared, TxEffects, Wallets } from "../src/chain";

let seq = 0;
const sig = (p: string) => `${p}${++seq}`.padEnd(64, "x");

/** In-memory chain for job tests. Every outcome is scriptable. */
export class FakeChain implements Chain {
  readonly wallets: Wallets = { buyback: "BuyBackWa11et11111111111111111111111111111", distributor: "Distributor111111111111111111111111111111111", claim: "C1aim111111111111111111111111111111111111111", treasury: "Treasury11111111111111111111111111111111111", lockNft: "C1aim111111111111111111111111111111111111111" };
  readonly platformConfig = "P1atform11111111111111111111111111111111111";
  readonly globalConfig = "G";
  readonly launchLabProgram = "LaunchLab1111111111111111111111111111111111";
  slot = 1000;
  streams = new Map<string, { signature: string; slot: number; failed: boolean; blockTime: number | null }[]>();
  txs = new Map<string, ParsedLaunchLabTx>();
  /** tokens per lamport for buyback quotes and fills */
  tokensPerLamport = 1000n;
  maxChunk = 10n ** 18n;
  sol = new Map<string, bigint>();
  tokens = new Map<string, bigint>();
  vault = 0n;
  /** outcome for the next waits, in order; default confirmed */
  outcomes: LandedStatus[] = [];
  /** statuses returned by check() per signature */
  statuses = new Map<string, LandedStatus>();
  failPrepare = false;
  effects = new Map<string, TxEffects>();
  sent: { kind: string; signature: string; detail: unknown }[] = [];
  missingAtas = new Set<string>();
  vaultClaimAmount: bigint | null = null;
  /** clock used for transaction block times */
  now: () => Date = () => new Date();
  /** token movements that happened on chain but that no mint-stream transaction shows (plain SPL Transfers): "mint|owner" → delta */
  invisible = new Map<string, bigint>();
  /** signatures the RPC can't return yet (getTransaction → null) */
  unavailable = new Set<string>();
  /** network fee reported for landed transactions */
  fee = 0n;
  /** effects that can't be read yet (txEffects → null) */
  unreadable = new Set<string>();
  metadata: unknown = { description: "test coin", image: "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", twitter: "https://x.com/mochi", website: "javascript:alert(1)" };

  async currentSlot() {
    return this.slot;
  }
  async signaturesSince(address: string, until: string | null, max: number) {
    const all = this.streams.get(address) ?? [];
    const i = until ? all.findIndex((s) => s.signature === until) : -1;
    return all.slice(i + 1).slice(0, max); // oldest first, oldest `max`
  }
  async parsedTx(signature: string) {
    if (this.unavailable.has(signature)) return null;
    return this.txs.get(signature) ?? null;
  }
  /** Chain truth: every streamed balance change plus invisible transfers. Sync slot = newest streamed slot. */
  async holderBalances(mint: string): Promise<{ slot: number; holdings: ChainHolding[] } | null> {
    const by = new Map<string, bigint>();
    let slot = 0;
    for (const tx of this.txs.values()) {
      slot = Math.max(slot, tx.slot);
      for (const c of tx.balanceChanges) if (c.mint === mint && !c.programOwned) by.set(c.owner, (by.get(c.owner) ?? 0n) + c.delta);
    }
    for (const [k, d] of this.invisible) {
      const [m, owner] = k.split("|") as [string, string];
      if (m === mint) by.set(owner, (by.get(owner) ?? 0n) + d);
    }
    return { slot, holdings: [...by].filter(([, a]) => a > 0n).map(([owner, amount]) => ({ owner, amount, programOwned: false })) };
  }
  async blockTime() {
    return null;
  }
  poolProblems = new Map<string, string>();
  async poolProblem(poolId: string): Promise<string | null> {
    return this.poolProblems.get(poolId) ?? null;
  }
  async launchPool(): Promise<LaunchPool | null> {
    return null;
  }
  async liveRates(): Promise<FeeRates> {
    return FEES.rates;
  }
  async solUsd() {
    return 150;
  }
  async tokenMetadata(): Promise<unknown | null> {
    return this.metadata;
  }
  async buybackPlan(_c: CoinRef): Promise<BuybackPlan | null> {
    return { venue: "CURVE", maxChunk: (b) => (b < this.maxChunk ? b : this.maxChunk), expectedOut: (a) => a * this.tokensPerLamport };
  }
  private prep(kind: string, detail: unknown, effects?: TxEffects): Prepared {
    if (this.failPrepare) throw new Error("simulation failed: custom program error 0x1771");
    const s = sig(kind);
    this.sent.push({ kind, signature: s, detail });
    if (effects) this.effects.set(s, effects);
    return { signature: s, lastValidBlockHeight: this.slot + 150 };
  }
  async prepareBuyback(c: CoinRef, amount: bigint, minOut: bigint) {
    const got = amount * this.tokensPerLamport;
    return this.prep("bb", { mint: c.mint, amount, minOut }, this.fx({ blockTime: Math.floor(this.now().getTime() / 1000), tokenDeltas: [{ mint: c.mint, owner: this.wallets.distributor, delta: got, post: got, programOwned: false }] }));
  }
  /** Effects of a landed transaction with the configured fee. */
  fx(p: Partial<TxEffects> & { tokenDeltas: BalanceChange[] }): TxEffects {
    return { failed: false, fee: this.fee, lamportDeltas: {}, slot: ++this.slot, blockTime: null, ...p };
  }
  async existingTokenAccounts(_mint: string, wallets: string[]) {
    return new Set(wallets.filter((w) => !this.missingAtas.has(w)));
  }
  async prepareTransfers(mint: string, items: { wallet: string; amount: bigint }[], decimals: number) {
    return this.prep("pay", { mint, items, decimals }, this.fx({ tokenDeltas: [] }));
  }
  async tokenBalance(owner: string, mint: string) {
    return this.tokens.get(`${owner}|${mint}`) ?? 10n ** 30n;
  }
  async solBalance(owner: string) {
    return this.sol.get(owner) ?? 100n * 10n ** 9n;
  }
  async platformVaultBalance() {
    return this.vault;
  }
  async prepareVaultClaim() {
    const amt = this.vaultClaimAmount ?? this.vault;
    const d: BalanceChange = { mint: "So11111111111111111111111111111111111111112", owner: "VaultAuthPDA", delta: -amt, post: 0n, programOwned: true };
    return this.prep("claim", {}, this.fx({ tokenDeltas: [d] }));
  }
  async prepareClaimTransfers(outs: { to: string; lamports: bigint }[]) {
    return this.prep("xfer", outs);
  }
  async findFeeKey() {
    return "FeeKey1111111111111111111111111111111111111";
  }
  async harvestableLp() {
    return 1n;
  }
  async prepareHarvest(c: CoinRef) {
    return this.prep("harvest", c, this.fx({
      tokenDeltas: [
        { mint: "So11111111111111111111111111111111111111112", owner: this.wallets.lockNft, delta: 300n, post: 300n, programOwned: false },
        { mint: c.mint, owner: this.wallets.lockNft, delta: 5000n, post: 5000n, programOwned: false },
      ],
    }));
  }
  async prepareHarvestSettle(mint: string, lamports: bigint, tokens: bigint, treasury: bigint) {
    return this.prep("settle", { mint, lamports, tokens, treasury }, this.fx({ tokenDeltas: [] }));
  }
  async broadcast() {}
  async wait(signature: string): Promise<LandedStatus> {
    const o = this.outcomes.shift() ?? "confirmed";
    this.statuses.set(signature, o);
    return o;
  }
  async check(signature: string) {
    return this.statuses.get(signature) ?? "dropped";
  }
  async txEffects(signature: string) {
    if (this.unreadable.has(signature)) return null;
    return this.effects.get(signature) ?? null;
  }
}
