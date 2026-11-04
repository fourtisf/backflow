/** Regression tests for the chain-layer audit findings. */
import { CURVE, RATES, curveInit, newCurve } from "@backflow/core";
import { getPdaLaunchpadPoolId, getPdaPlatformAllowConfig, getPdaPlatformCurveRule } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { DISC, buildLaunchTx, checkPrevious, parseLaunchLabTx, payoutInstructions, statusOf, waitForLanding } from "../src";

const SOL = 1_000_000_000n;
const init = curveInit({ supply: CURVE.supplyBaseUnits, totalSell: CURVE.sellOnCurveBaseUnits, totalFundRaising: CURVE.graduationTargetLamports, totalLocked: 0n, migrateFee: 0n });

function tradeBody(pool: PublicKey, len = 139): Buffer {
  const b = Buffer.alloc(len);
  pool.toBuffer().copy(b, 0);
  if (len >= 120) b.writeBigUInt64LE(6_750_000n * 1000n, 112); // a huge platform fee
  return b;
}

function txWith(opts: { program: PublicKey; keys: PublicKey[]; ixs: { programIdIndex: number; accountKeyIndexes: number[]; data: Buffer }[]; inner?: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[]; logs?: string[] }) {
  return {
    slot: 1,
    blockTime: 1_800_000_000,
    meta: { err: null, logMessages: opts.logs ?? [], loadedAddresses: { writable: [], readonly: [] }, innerInstructions: opts.inner ?? [], preTokenBalances: [], postTokenBalances: [] },
    transaction: { message: { compiledInstructions: opts.ixs, getAccountKeys: () => ({ staticAccountKeys: opts.keys, accountKeysFromLookups: { writable: [], readonly: [] } }) } },
  };
}

describe("events: only LaunchLab's own self-CPI events count (C1)", () => {
  it("ignores a forged TradeEvent written to the logs by another program", () => {
    const launchLab = Keypair.generate().publicKey;
    const attacker = Keypair.generate().publicKey;
    const pool = Keypair.generate().publicKey;
    const forged = Buffer.concat([DISC.tradeEvent, tradeBody(pool)]).toString("base64");
    const tx = txWith({
      program: launchLab,
      keys: [Keypair.generate().publicKey, attacker],
      ixs: [{ programIdIndex: 1, accountKeyIndexes: [0], data: Buffer.from([1]) }],
      logs: [`Program ${attacker.toBase58()} invoke [1]`, `Program data: ${forged}`, `Program ${attacker.toBase58()} success`],
    });
    expect(parseLaunchLabTx(tx as never, "sig", launchLab.toBase58()).trades).toEqual([]);
  });

  it("skips a malformed event instead of throwing (no stuck stream)", () => {
    const launchLab = Keypair.generate().publicKey;
    const short = Buffer.concat([Buffer.from("e445a52e51cb9a1d", "hex"), DISC.tradeEvent, tradeBody(Keypair.generate().publicKey, 40)]);
    const tx = txWith({
      program: launchLab,
      keys: [Keypair.generate().publicKey, launchLab],
      ixs: [{ programIdIndex: 1, accountKeyIndexes: [0], data: Buffer.concat([DISC.buyExactIn, Buffer.alloc(24)]) }],
      inner: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [], data: bs58.encode(short) }] }],
    });
    const r = parseLaunchLabTx(tx as never, "sig", launchLab.toBase58());
    expect(r.trades).toEqual([]);
    expect(r.warnings[0]).toMatch(/malformed/);
  });
});

describe("events: migrations resolve the pool from the mints (H1)", () => {
  it("derives pool_state instead of reading account index 18 (global_config)", () => {
    const launchLab = new PublicKey("DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6");
    const mint = Keypair.generate().publicKey;
    const pool = getPdaLaunchpadPoolId(launchLab, mint, NATIVE_MINT).publicKey;
    const cpmmPool = Keypair.generate().publicKey;
    const platform = Keypair.generate().publicKey;
    const accounts = Array.from({ length: 20 }, () => Keypair.generate().publicKey);
    accounts[1] = mint;
    accounts[2] = NATIVE_MINT;
    accounts[3] = platform;
    accounts[5] = cpmmPool;
    accounts[17] = pool;
    const keys = [launchLab, ...accounts];
    const tx = txWith({ program: launchLab, keys, ixs: [{ programIdIndex: 0, accountKeyIndexes: accounts.map((_, i) => i + 1), data: Buffer.concat([DISC.migrateToCpswap, Buffer.alloc(8)]) }] });
    const r = parseLaunchLabTx(tx as never, "sig", launchLab.toBase58());
    expect(r.migrations).toEqual([{ mint: mint.toBase58(), platformConfig: platform.toBase58(), cpmmPool: cpmmPool.toBase58(), pool: pool.toBase58() }]);
    expect(r.warnings).toEqual([]);
  });
});

describe("send: a processed error isn't final, and expiry is judged on finalized height (M1, M4)", () => {
  const conn = (status: object | null, finalized: number) =>
    ({
      getSignatureStatuses: async () => ({ value: [status] }),
      getBlockHeight: async (c: string) => (c === "finalized" ? finalized : finalized + 40),
    }) as unknown as Connection;

  it("treats an error seen only at 'processed' as pending", async () => {
    expect(await statusOf(conn({ err: { InstructionError: [0, "x"] }, confirmationStatus: "processed" }, 0), "s")).toBe("pending");
    expect(await statusOf(conn({ err: { InstructionError: [0, "x"] }, confirmationStatus: "confirmed" }, 0), "s")).toBe("failed");
    expect(await statusOf(conn({ err: null, confirmationStatus: "finalized" }, 0), "s")).toBe("confirmed");
  });

  it("only calls a transaction dropped once the finalized height is past its blockhash with a margin", async () => {
    expect(await checkPrevious(conn(null, 1010), "s", 1000)).toBe("pending"); // within the margin
    expect(await checkPrevious(conn(null, 1021), "s", 1000)).toBe("dropped");
    expect(await waitForLanding(conn(null, 1021), "s", 1000, 5_000)).toBe("dropped");
  });
});

describe("tx: payouts are visible to the mint stream, launches pass optional accounts (C1, H4)", () => {
  it("payout transfers are TransferChecked and list the mint", () => {
    const d = Keypair.generate().publicKey;
    const m = Keypair.generate().publicKey;
    const ixs = payoutInstructions(d, m, [{ wallet: Keypair.generate().publicKey, amount: 5n }], {}, 6);
    const t = ixs.find((i) => i.programId.equals(TOKEN_PROGRAM_ID))!;
    expect(t.data[0]).toBe(12); // TransferChecked
    expect(t.data[9]).toBe(6); // decimals
    expect(t.keys.some((k) => k.pubkey.equals(m))).toBe(true);
  });

  it("initialize_v2 gets the platform curve rule and allow-config accounts when required", () => {
    const programId = new PublicKey("DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6");
    const globalConfig = Keypair.generate().publicKey;
    const platformId = Keypair.generate().publicKey;
    const base = {
      programId,
      globalConfig,
      platformId,
      creator: Keypair.generate().publicKey,
      mint: Keypair.generate().publicKey,
      name: "Mochi",
      symbol: "MOCHI",
      uri: "ipfs://x",
      decimals: 6,
      supply: CURVE.supplyBaseUnits,
      totalSell: CURVE.sellOnCurveBaseUnits,
      totalFundRaising: CURVE.graduationTargetLamports,
      initialCurve: newCurve(init, CURVE.sellOnCurveBaseUnits),
      rates: RATES,
      firstBuyLamports: 0n,
      slippageBps: 100,
      blockhash: PublicKey.default.toBase58(),
    };
    const keysOf = (r: ReturnType<typeof buildLaunchTx>) => r.tx.message.staticAccountKeys.map((k) => k.toBase58());
    const plain = keysOf(buildLaunchTx(base));
    const rule = getPdaPlatformCurveRule(programId, platformId, globalConfig).publicKey.toBase58();
    const allow = getPdaPlatformAllowConfig(programId, platformId, globalConfig).publicKey.toBase58();
    expect(plain).not.toContain(rule);
    const strict = keysOf(buildLaunchTx({ ...base, restrictCurveParam: true, requiresPlatformAuth: true }));
    expect(strict).toContain(rule);
    expect(strict).toContain(allow);
    void SOL;
  });
});

describe("vault: vanity mint keys are encrypted at rest", () => {
  it("round-trips a keypair and rejects a wrong key or tampered data", async () => {
    const { encryptSecret, decryptSecret } = await import("../src/vault");
    const k1 = "11".repeat(32);
    const k2 = "22".repeat(32);
    const kp = Keypair.generate();
    const enc = encryptSecret(kp.secretKey, k1);
    expect(enc).not.toContain(bs58.encode(kp.secretKey));
    expect(Buffer.from(decryptSecret(enc, k1)).equals(Buffer.from(kp.secretKey))).toBe(true);
    expect(() => decryptSecret(enc, k2)).toThrow();
    const tampered = enc.slice(0, -4) + (enc.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => decryptSecret(tampered, k1)).toThrow();
    expect(() => encryptSecret(kp.secretKey, "short")).toThrow(/VANITY_KEY/);
  });
});
