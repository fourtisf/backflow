/**
 * Parse LaunchLab activity out of a confirmed transaction: trades (TradeEvent,
 * exact fees), pool creations (PoolCreateEvent + initialize accounts),
 * migrations (migrate_to_cpswap accounts) and token balance changes.
 *
 * Event layouts from the LaunchLab IDL (raydium-io/raydium-idl, 2026-05).
 * Events are emitted with Anchor's #[event_cpi] (self-CPI whose data is
 * EVENT_IX_TAG ‖ discriminator ‖ borsh body); "Program data:" logs are also
 * scanned in case a program version uses emit!.
 */
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { getPdaLaunchpadPoolId } from "@raydium-io/raydium-sdk-v2";

const EVENT_IX_TAG = Buffer.from("e445a52e51cb9a1d", "hex");
const disc = (s: string) => createHash("sha256").update(s).digest().subarray(0, 8);

export const DISC = {
  tradeEvent: Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
  poolCreateEvent: Buffer.from([151, 215, 226, 9, 118, 161, 115, 174]),
  initialize: disc("global:initialize"),
  initializeV2: disc("global:initialize_v2"),
  initializeToken2022: disc("global:initialize_with_token_2022"),
  buyExactIn: disc("global:buy_exact_in"),
  buyExactOut: disc("global:buy_exact_out"),
  sellExactIn: disc("global:sell_exact_in"),
  sellExactOut: disc("global:sell_exact_out"),
  migrateToCpswap: disc("global:migrate_to_cpswap"),
  migrateToAmm: disc("global:migrate_to_amm"),
} as const;

export interface TradeEventData {
  poolState: string;
  totalBaseSell: bigint;
  virtualBase: bigint;
  virtualQuote: bigint;
  realBaseBefore: bigint;
  realQuoteBefore: bigint;
  realBaseAfter: bigint;
  realQuoteAfter: bigint;
  amountIn: bigint;
  amountOut: bigint;
  protocolFee: bigint;
  platformFee: bigint;
  creatorFee: bigint;
  shareFee: bigint;
  direction: "buy" | "sell";
  poolStatus: number;
  exactIn: boolean;
}

export function decodeTradeEvent(body: Buffer): TradeEventData {
  if (body.length < 139) throw new Error(`TradeEvent body too short (${body.length})`);
  const u = (o: number) => body.readBigUInt64LE(o);
  return {
    poolState: new PublicKey(body.subarray(0, 32)).toBase58(),
    totalBaseSell: u(32),
    virtualBase: u(40),
    virtualQuote: u(48),
    realBaseBefore: u(56),
    realQuoteBefore: u(64),
    realBaseAfter: u(72),
    realQuoteAfter: u(80),
    amountIn: u(88),
    amountOut: u(96),
    protocolFee: u(104),
    platformFee: u(112),
    creatorFee: u(120),
    shareFee: u(128),
    direction: body[136] === 0 ? "buy" : "sell",
    poolStatus: body[137]!,
    exactIn: body[138] === 1,
  };
}

export interface PoolCreateEventData {
  poolState: string;
  creator: string;
  config: string;
  decimals: number;
  name: string;
  symbol: string;
  uri: string;
  curveType: number;
  supply: bigint;
  totalBaseSell: bigint;
  totalQuoteFundRaising: bigint;
  migrateType: number;
}

export function decodePoolCreateEvent(body: Buffer): PoolCreateEventData {
  let o = 0;
  const pk = () => {
    const v = new PublicKey(body.subarray(o, o + 32)).toBase58();
    o += 32;
    return v;
  };
  const u8 = () => body[o++]!;
  const u64 = () => {
    const v = body.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const str = () => {
    const n = body.readUInt32LE(o);
    o += 4;
    const v = body.subarray(o, o + n).toString("utf8");
    o += n;
    return v;
  };
  const poolState = pk();
  const creator = pk();
  const config = pk();
  const decimals = u8();
  const name = str();
  const symbol = str();
  const uri = str();
  const curveType = u8();
  const supply = u64();
  const totalBaseSell = curveType === 0 ? u64() : 0n;
  const totalQuoteFundRaising = u64();
  const migrateType = u8();
  return { poolState, creator, config, decimals, name, symbol, uri, curveType, supply, totalBaseSell, totalQuoteFundRaising, migrateType };
}

export interface ParsedTrade extends TradeEventData {
  /** Order of the event inside the transaction. */
  eventIndex: number;
  /** Signer of the buy/sell instruction (the trader). */
  trader: string | null;
}

export interface ParsedCreate {
  pool: string;
  mint: string;
  creator: string;
  globalConfig: string;
  platformConfig: string;
  baseVault: string;
  quoteVault: string;
  /** "token2022" when created with initialize_with_token_2022 (payouts can't serve those; buybacks stay off). */
  tokenProgram: "spl" | "token2022";
  event: PoolCreateEventData | null;
}

export interface ParsedMigration {
  pool: string;
  mint: string;
  cpmmPool: string;
  platformConfig: string;
}

export interface BalanceChange {
  mint: string;
  owner: string;
  /** Signed change in base units. */
  delta: bigint;
  /** Owner's total balance of `mint` after the transaction (across its token accounts touched here). */
  post: bigint;
  /** True when the owner is a PDA (off-curve): a program-owned account, never a wallet. */
  programOwned: boolean;
}

export interface ParsedLaunchLabTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  failed: boolean;
  trades: ParsedTrade[];
  creates: ParsedCreate[];
  migrations: ParsedMigration[];
  balanceChanges: BalanceChange[];
  /** Malformed LaunchLab data that was skipped (layout drift); the indexer alerts on these. */
  warnings: string[];
}

/** Raw `getTransaction` responses only (parsed-JSON transactions have a different instruction shape). */
type AnyTx = VersionedTransactionResponse;

interface FlatIx {
  programId: string;
  accounts: string[];
  data: Buffer;
}

function accountKeys(tx: AnyTx): string[] {
  const msg = tx.transaction.message as unknown as {
    getAccountKeys?: (o: { accountKeysFromLookups?: { writable: PublicKey[]; readonly: PublicKey[] } | null }) => { staticAccountKeys: PublicKey[]; accountKeysFromLookups?: { writable: PublicKey[]; readonly: PublicKey[] } };
    accountKeys?: Array<PublicKey | { pubkey: PublicKey }>;
  };
  if (msg.getAccountKeys) {
    const lookups = tx.meta?.loadedAddresses ? { writable: tx.meta.loadedAddresses.writable, readonly: tx.meta.loadedAddresses.readonly } : null;
    const k = msg.getAccountKeys({ accountKeysFromLookups: lookups });
    return [...k.staticAccountKeys, ...(k.accountKeysFromLookups?.writable ?? []), ...(k.accountKeysFromLookups?.readonly ?? [])].map((p) => p.toBase58());
  }
  return (msg.accountKeys ?? []).map((k) => ("pubkey" in k ? k.pubkey : k).toBase58());
}

/** Top-level and inner instructions in execution order. */
function flatten(tx: AnyTx, keys: string[]): FlatIx[] {
  const msg = tx.transaction.message as unknown as {
    compiledInstructions?: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }[];
    instructions?: Array<{ programIdIndex?: number; accounts?: number[]; data?: string; programId?: PublicKey }>;
  };
  const top: FlatIx[] = (msg.compiledInstructions ?? []).map((ix) => ({
    programId: keys[ix.programIdIndex]!,
    accounts: ix.accountKeyIndexes.map((i) => keys[i]!),
    data: Buffer.from(ix.data),
  }));
  if (!msg.compiledInstructions && msg.instructions) {
    for (const ix of msg.instructions) {
      if (ix.programIdIndex != null && ix.data != null) top.push({ programId: keys[ix.programIdIndex]!, accounts: (ix.accounts ?? []).map((i) => keys[i]!), data: Buffer.from(bs58.decode(ix.data)) });
    }
  }
  const inner = new Map<number, FlatIx[]>();
  for (const group of tx.meta?.innerInstructions ?? []) {
    inner.set(
      group.index,
      (group.instructions as Array<{ programIdIndex?: number; accounts?: number[]; data?: string }>)
        .filter((ix) => ix.programIdIndex != null && ix.data != null)
        .map((ix) => ({ programId: keys[ix.programIdIndex!]!, accounts: (ix.accounts ?? []).map((i) => keys[i]!), data: Buffer.from(bs58.decode(ix.data!)) })),
    );
  }
  const out: FlatIx[] = [];
  top.forEach((ix, i) => {
    out.push(ix);
    out.push(...(inner.get(i) ?? []));
  });
  return out;
}

const startsWith = (b: Buffer, p: Buffer) => b.length >= p.length && b.subarray(0, p.length).equals(p);

function isOnCurve(addr: string): boolean {
  try {
    return PublicKey.isOnCurve(new PublicKey(addr).toBytes());
  } catch {
    return false;
  }
}

/** Aggregate pre/post token balances per (mint, owner). */
export function tokenBalanceChanges(tx: AnyTx): BalanceChange[] {
  const pre = new Map<string, bigint>();
  const post = new Map<string, bigint>();
  const key = (mint: string, owner: string) => `${mint}|${owner}`;
  for (const b of tx.meta?.preTokenBalances ?? []) {
    if (!b.owner) continue;
    const k = key(b.mint, b.owner);
    pre.set(k, (pre.get(k) ?? 0n) + BigInt(b.uiTokenAmount.amount));
  }
  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (!b.owner) continue;
    const k = key(b.mint, b.owner);
    post.set(k, (post.get(k) ?? 0n) + BigInt(b.uiTokenAmount.amount));
  }
  const out: BalanceChange[] = [];
  for (const k of new Set([...pre.keys(), ...post.keys()])) {
    const [mint, owner] = k.split("|") as [string, string];
    const delta = (post.get(k) ?? 0n) - (pre.get(k) ?? 0n);
    if (delta !== 0n) out.push({ mint, owner, delta, post: post.get(k) ?? 0n, programOwned: !isOnCurve(owner) });
  }
  return out;
}

export function parseLaunchLabTx(tx: AnyTx, signature: string, launchLabProgram: string): ParsedLaunchLabTx {
  const res: ParsedLaunchLabTx = {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    failed: !!tx.meta?.err,
    trades: [],
    creates: [],
    migrations: [],
    balanceChanges: [],
    warnings: [],
  };
  if (res.failed) return res;
  const keys = accountKeys(tx);
  const ixs = flatten(tx, keys).filter((ix) => ix.programId === launchLabProgram);

  const tradeIxs: { pool: string; trader: string }[] = [];
  const events: { kind: "trade"; data: TradeEventData }[] = [];
  const createEvents: PoolCreateEventData[] = [];

  for (const ix of ixs) {
    const d = ix.data;
    if (startsWith(d, EVENT_IX_TAG)) {
      const body = d.subarray(16);
      const ed = d.subarray(8, 16);
      // Only LaunchLab's own self-CPI events are trusted: the program checks its event-authority PDA signed,
      // so no other program can produce one. "Program data:" log lines are never read (any program can write them).
      try {
        if (ed.equals(DISC.tradeEvent)) events.push({ kind: "trade", data: decodeTradeEvent(body) });
        else if (ed.equals(DISC.poolCreateEvent)) createEvents.push(decodePoolCreateEvent(body));
      } catch (e) {
        res.warnings.push(`skipped malformed LaunchLab event: ${(e as Error).message}`);
      }
      continue;
    }
    if ([DISC.buyExactIn, DISC.buyExactOut, DISC.sellExactIn, DISC.sellExactOut].some((p) => startsWith(d, p))) {
      tradeIxs.push({ trader: ix.accounts[0]!, pool: ix.accounts[4]! });
    } else if ([DISC.initializeV2, DISC.initialize, DISC.initializeToken2022].some((p) => startsWith(d, p))) {
      // initialize_v2 accounts: payer, creator, global_config, platform_config, authority, pool_state, base_mint, quote_mint, base_vault, quote_vault, ...
      res.creates.push({
        pool: ix.accounts[5]!,
        mint: ix.accounts[6]!,
        creator: ix.accounts[1]!,
        globalConfig: ix.accounts[2]!,
        platformConfig: ix.accounts[3]!,
        baseVault: ix.accounts[8]!,
        quoteVault: ix.accounts[9]!,
        tokenProgram: startsWith(d, DISC.initializeToken2022) ? "token2022" : "spl",
        event: null,
      });
    } else if (startsWith(d, DISC.migrateToCpswap)) {
      // migrate_to_cpswap accounts: payer, base_mint (1), quote_mint (2), platform_config (3), cpswap_program, cpswap_pool (5), …
      // pool_state is index 17 in the IDL (18 is global_config). Derive it from the mints instead of trusting an index.
      const mint = ix.accounts[1]!;
      const quote = ix.accounts[2]!;
      let pool: string;
      try {
        pool = getPdaLaunchpadPoolId(new PublicKey(launchLabProgram), new PublicKey(mint), new PublicKey(quote)).publicKey.toBase58();
      } catch {
        res.warnings.push("skipped migration with invalid mint accounts");
        continue;
      }
      if (ix.accounts[17] && ix.accounts[17] !== pool) res.warnings.push(`migrate_to_cpswap pool_state index differs from the derived pool ${pool}`);
      res.migrations.push({ mint, platformConfig: ix.accounts[3]!, cpmmPool: ix.accounts[5]!, pool });
    }
  }

  events.forEach((e, i) => {
    const ixInfo = tradeIxs[i];
    res.trades.push({ ...e.data, eventIndex: i, trader: ixInfo && ixInfo.pool === e.data.poolState ? ixInfo.trader : null });
  });
  for (const ce of createEvents) {
    const c = res.creates.find((x) => x.pool === ce.poolState);
    if (c) c.event = ce;
  }
  res.balanceChanges = tokenBalanceChanges(tx);
  return res;
}
