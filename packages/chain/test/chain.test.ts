import {
  CURVE,
  RATES,
  curveInit,
  newCurve,
  quoteBuy,
  quoteSell,
  batches,
  type CurveState,
} from "@backflow/core";
import { Curve, LaunchpadPool } from "@raydium-io/raydium-sdk-v2";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DISC, decodeLaunchPool, decodeTradeEvent, parseLaunchLabTx, payoutInstructions, maxTransfersPerTx, txSize, MAX_TX_BYTES, buildLaunchTx, compile } from "../src";

const SOL = 1_000_000_000n;
const init = curveInit({ supply: CURVE.supplyBaseUnits, totalSell: CURVE.sellOnCurveBaseUnits, totalFundRaising: CURVE.graduationTargetLamports, totalLocked: 0n, migrateFee: 0n });
const bnOf = (v: bigint) => new BN(v.toString());

function sdkPool(s: CurveState) {
  return {
    virtualA: bnOf(s.virtualBase),
    virtualB: bnOf(s.virtualQuote),
    realA: bnOf(s.realBase),
    realB: bnOf(s.realQuote),
    totalSellA: bnOf(s.totalSellBase),
    totalFundRaisingB: bnOf(CURVE.graduationTargetLamports),
  };
}

describe("core curve math matches the Raydium SDK exactly", () => {
  it("init params", () => {
    const sdk = Curve.getCurve(0).getInitParam({ supply: bnOf(CURVE.supplyBaseUnits), totalFundRaising: bnOf(CURVE.graduationTargetLamports), totalSell: bnOf(CURVE.sellOnCurveBaseUnits), totalLockedAmount: new BN(0), migrateFee: new BN(0) });
    expect(sdk.a.toString()).toBe(init.virtualBase.toString());
    expect(sdk.b.toString()).toBe(init.virtualQuote.toString());
  });

  it("buyExactIn and sellExactIn for random states and sizes", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: CURVE.sellOnCurveBaseUnits - 1n }), fc.bigInt({ min: 1n, max: 100n * SOL }), fc.bigInt({ min: 1n, max: 10n ** 14n }), (realA, buyIn, sellIn) => {
        // realB consistent with realA: what it costs to buy realA from a fresh curve
        const fresh = newCurve(init, CURVE.sellOnCurveBaseUnits);
        const realB = realA === 0n ? 0n : ((fresh.virtualQuote * realA) / (fresh.virtualBase - realA)) + 1n;
        const s: CurveState = { ...fresh, realBase: realA, realQuote: realB };
        const common = { protocolFeeRate: bnOf(RATES.raydiumProtocolPpm), platformFeeRate: bnOf(RATES.platformFeePpm), creatorFeeRate: bnOf(RATES.creatorFeePpm), shareFeeRate: new BN(0), curveType: 0, transferFeeConfigA: undefined, slot: 0 };
        const sdkBuy = Curve.buyExactIn({ poolInfo: sdkPool(s) as never, amountB: bnOf(buyIn), ...common });
        const ours = quoteBuy(s, buyIn);
        const sdkSell = Curve.sellExactIn({ poolInfo: sdkPool(s) as never, amountA: bnOf(sellIn), ...common });
        const oursSell = quoteSell(s, sellIn);
        return (
          sdkBuy.amountA.amount.toString() === ours.amountOut.toString() &&
          sdkBuy.amountB.toString() === ours.amountIn.toString() &&
          sdkBuy.splitFee.platformFee.toString() === ours.fees.platform.toString() &&
          sdkBuy.splitFee.protocolFee.toString() === ours.fees.protocol.toString() &&
          sdkBuy.splitFee.creatorFee.toString() === ours.fees.creator.toString() &&
          sdkSell.amountB.toString() === oursSell.amountOut.toString() &&
          sdkSell.splitFee.platformFee.toString() === oursSell.fees.platform.toString()
        );
      }),
      { numRuns: 300 },
    );
  });
});

describe("event and pool decoding", () => {
  function tradeBody(pool: PublicKey, over: Partial<Record<string, bigint>> = {}, dir = 0): Buffer {
    const b = Buffer.alloc(139);
    pool.toBuffer().copy(b, 0);
    const vals = [CURVE.sellOnCurveBaseUnits, init.virtualBase, init.virtualQuote, 0n, 0n, 1000n, 2000n, SOL, 1000n, 2_500_000n, 6_750_000n, 1_750_000n, 0n];
    const names = ["totalBaseSell", "virtualBase", "virtualQuote", "realBaseBefore", "realQuoteBefore", "realBaseAfter", "realQuoteAfter", "amountIn", "amountOut", "protocolFee", "platformFee", "creatorFee", "shareFee"];
    names.forEach((n, i) => b.writeBigUInt64LE(over[n] ?? vals[i]!, 32 + i * 8));
    b[136] = dir;
    b[137] = 0;
    b[138] = 1;
    return b;
  }

  it("decodes a TradeEvent body", () => {
    const pool = Keypair.generate().publicKey;
    const e = decodeTradeEvent(tradeBody(pool));
    expect(e.poolState).toBe(pool.toBase58());
    expect(e.platformFee).toBe(6_750_000n);
    expect(e.direction).toBe("buy");
    expect(e.exactIn).toBe(true);
  });

  it("parses a transaction with an event CPI, the trader, and token balance changes", () => {
    const program = Keypair.generate().publicKey;
    const trader = Keypair.generate().publicKey;
    const pool = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const keys = [trader, program, pool, mint];
    const buyIxData = Buffer.concat([DISC.buyExactIn, Buffer.alloc(24)]);
    const eventData = Buffer.concat([Buffer.from("e445a52e51cb9a1d", "hex"), DISC.tradeEvent, tradeBody(pool)]);
    const tx = {
      slot: 123,
      blockTime: 1_800_000_000,
      meta: {
        err: null,
        logMessages: [],
        loadedAddresses: { writable: [], readonly: [] },
        innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [], data: bs58.encode(eventData) }] }],
        preTokenBalances: [{ accountIndex: 3, mint: mint.toBase58(), owner: trader.toBase58(), uiTokenAmount: { amount: "0" } }],
        postTokenBalances: [{ accountIndex: 3, mint: mint.toBase58(), owner: trader.toBase58(), uiTokenAmount: { amount: "1000" } }],
      },
      transaction: {
        message: {
          compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0, 1, 1, 1, 2], data: buyIxData }],
          getAccountKeys: () => ({ staticAccountKeys: keys, accountKeysFromLookups: { writable: [], readonly: [] } }),
        },
      },
    };
    const r = parseLaunchLabTx(tx as never, "sig", program.toBase58());
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.trader).toBe(trader.toBase58());
    expect(r.trades[0]!.platformFee).toBe(6_750_000n);
    expect(r.balanceChanges).toEqual([{ mint: mint.toBase58(), owner: trader.toBase58(), delta: 1000n, post: 1000n, programOwned: false }]);
  });

  it("round-trips a LaunchLab pool account through the SDK layout", () => {
    const id = Keypair.generate().publicKey;
    const pk = () => Keypair.generate().publicKey;
    const data = Buffer.alloc(LaunchpadPool.span);
    LaunchpadPool.encode(
      {
        epoch: new BN(1), bump: 255, status: 0, mintDecimalsA: 6, mintDecimalsB: 9, migrateType: 1,
        supply: bnOf(CURVE.supplyBaseUnits), totalSellA: bnOf(CURVE.sellOnCurveBaseUnits), virtualA: bnOf(init.virtualBase), virtualB: bnOf(init.virtualQuote),
        realA: new BN(5), realB: new BN(7), totalFundRaisingB: bnOf(CURVE.graduationTargetLamports), protocolFee: new BN(0), platformFee: new BN(0), migrateFee: new BN(0),
        vestingSchedule: { totalLockedAmount: new BN(0), cliffPeriod: new BN(0), unlockPeriod: new BN(0), startTime: new BN(0), totalAllocatedShare: new BN(0) },
        configId: pk(), platformId: pk(), mintA: pk(), mintB: pk(), vaultA: pk(), vaultB: pk(), creator: pk(), mintProgramFlag: 0, cpmmCreatorFeeOn: 0, platformVestingShare: new BN(0),
      } as never,
      data,
    );
    const p = decodeLaunchPool(id, data);
    expect(p.status).toBe(0);
    expect(p.realA).toBe(5n);
    expect(p.virtualB).toBe(init.virtualQuote);
  });
});

describe("transaction sizes (payout batching load test)", () => {
  it("fits at least 15 SPL transfers per transaction", () => {
    expect(maxTransfersPerTx()).toBeGreaterThanOrEqual(15);
  });

  it("5,000 recipients pack into transactions that all fit", () => {
    const per = maxTransfersPerTx();
    const d = Keypair.generate().publicKey;
    const m = Keypair.generate().publicKey;
    const recipients = Array.from({ length: 5_000 }, (_, i) => ({ wallet: Keypair.generate().publicKey, amount: BigInt(i + 1) }));
    const groups = batches(recipients, per);
    expect(groups.length).toBe(Math.ceil(5_000 / per));
    for (const g of groups) expect(txSize(d, payoutInstructions(d, m, g, { priorityMicroLamports: 1 }))).toBeLessThanOrEqual(MAX_TX_BYTES);
  });

  it("launch + first buy compiles into a single transaction", () => {
    const creator = Keypair.generate().publicKey;
    const mint = Keypair.generate();
    const r = buildLaunchTx({
      programId: Keypair.generate().publicKey,
      globalConfig: Keypair.generate().publicKey,
      platformId: Keypair.generate().publicKey,
      creator,
      mint: mint.publicKey,
      name: "Thirty two characters long name!",
      symbol: "TENCHARSXX",
      uri: "https://gateway.pinata.cloud/ipfs/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
      decimals: 6,
      supply: CURVE.supplyBaseUnits,
      totalSell: CURVE.sellOnCurveBaseUnits,
      totalFundRaising: CURVE.graduationTargetLamports,
      initialCurve: newCurve(init, CURVE.sellOnCurveBaseUnits),
      rates: RATES,
      firstBuyLamports: SOL,
      slippageBps: 100,
      blockhash: PublicKey.default.toBase58(),
      fees: { priorityMicroLamports: 10_000 },
    });
    expect(r.tx).toBeInstanceOf(VersionedTransaction);
    expect(r.tx.serialize().length).toBeLessThanOrEqual(MAX_TX_BYTES);
    expect(r.minTokens).toBeLessThan(r.expectedTokens);
  });

  it("refuses transactions over the size limit", () => {
    const d = Keypair.generate().publicKey;
    const m = Keypair.generate().publicKey;
    const many = Array.from({ length: 60 }, () => ({ wallet: Keypair.generate().publicKey, amount: 1n }));
    expect(() => compile(d, payoutInstructions(d, m, many), PublicKey.default.toBase58())).toThrow(/over the 1232-byte limit/);
  });
});
