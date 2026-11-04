import type { FeeRates } from "@backflow/core";
import { FEES } from "@backflow/core";
import type { LandedStatus, LaunchPool, ParsedLaunchLabTx, BalanceChange } from "@backflow/chain";
import type { BuybackPlan, Chain, CoinRef, Prepared, TokenMetadata, TxEffects, Wallets } from "../src/chain";

let seq = 0;
const sig = (p: string) => `${p}${++seq}`.padEnd(64, "x");

/** In-memory chain for job tests. Every outcome is scriptable. */
export class FakeChain implements Chain {
  readonly wallets: Wallets = { buyback: "BuyBackWa11et11111111111111111111111111111", distributor: "Distributor111111111111111111111111111111111", claim: "C1aim111111111111111111111111111111111111111", treasury: "Treasury11111111111111111111111111111111111", lockNft: "C1aim111111111111111111111111111111111111111" };
  readonly platformConfig = "P1atform11111111111111111111111111111111111";
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

  async currentSlot() {
    return this.slot;
  }
  async signaturesSince(address: string, until: string | null) {
    const all = this.streams.get(address) ?? [];
    const i = until ? all.findIndex((s) => s.signature === until) : -1;
    return all.slice(i + 1);
  }
  async parsedTx(signature: string) {
    return this.txs.get(signature) ?? null;
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
  async tokenMetadata(): Promise<TokenMetadata | null> {
    return { description: "test coin", image: "https://img.example/x.png" };
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
    return this.prep("bb", { mint: c.mint, amount, minOut }, { slot: ++this.slot, blockTime: Math.floor(this.now().getTime() / 1000), tokenDeltas: [{ mint: c.mint, owner: this.wallets.distributor, delta: got, post: got, programOwned: false }] });
  }
  async existingTokenAccounts(_mint: string, wallets: string[]) {
    return new Set(wallets.filter((w) => !this.missingAtas.has(w)));
  }
  async prepareTransfers(mint: string, items: { wallet: string; amount: bigint }[]) {
    return this.prep("pay", { mint, items });
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
    return this.prep("claim", {}, { slot: ++this.slot, blockTime: null, tokenDeltas: [d] });
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
    return this.prep("harvest", c, {
      slot: ++this.slot,
      blockTime: null,
      tokenDeltas: [
        { mint: "So11111111111111111111111111111111111111112", owner: this.wallets.lockNft, delta: 300n, post: 300n, programOwned: false },
        { mint: c.mint, owner: this.wallets.lockNft, delta: 5000n, post: 5000n, programOwned: false },
      ],
    });
  }
  async prepareHarvestSettle(mint: string, lamports: bigint, tokens: bigint) {
    return this.prep("settle", { mint, lamports, tokens });
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
    return this.effects.get(signature) ?? null;
  }
}
