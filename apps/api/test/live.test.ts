import { CURVE } from "@backflow/core";
import { getPrisma } from "@backflow/db";
import bs58 from "bs58";
import sharp from "sharp";
import nacl from "tweetnacl";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { UploadError, cleanImage } from "../src/ipfs";
import { LiveProvider } from "../src/live/provider";
import { MockProvider } from "../src/mock/provider";
import { adminMessage, registerAdmin, verifyAdmin } from "../src/routes/admin";

const db = getPrisma();
const MINT = "CoinMint1111111111111111111111111111111back";
const ALICE = "A1ice111111111111111111111111111111111111111";
const BOB = "Bob11111111111111111111111111111111111111111";
const DIST = "Distributor111111111111111111111111111111111";

beforeEach(async () => {
  const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`);
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await db.coin.create({
    data: {
      mint: MINT,
      poolId: "Poo11111111111111111111111111111111111111111",
      platformConfig: "P",
      name: "Mochi",
      ticker: "MOCHI",
      tickerKey: "mochi",
      tickerSlot: "mochi",
      creator: ALICE,
      supply: CURVE.supplyBaseUnits,
      graduationTargetLamports: CURVE.graduationTargetLamports,
      realBase: 100_000_000_000_000n,
      mcapUsd: 50_000,
      vol24hUsd: 1234,
      paidToHoldersLamports: 3_000_000_000n,
    },
  });
  await db.holderState.createMany({
    data: [
      { coinMint: MINT, wallet: ALICE, balance: 60_000_000_000_000n, receivedTotal: 5n },
      { coinMint: MINT, wallet: BOB, balance: 20_000_000_000_000n },
      { coinMint: MINT, wallet: DIST, balance: 20_000_000_000_000n },
    ],
  });
  await db.pending.create({ data: { coinMint: MINT, wallet: ALICE, amount: 777n } });
});
afterAll(async () => {
  await db.$disconnect();
});

const live = () => new LiveProvider({ db, chain: null, sub: null, platformWallets: [{ address: DIST, label: "Distributor" }] });

describe("live provider", () => {
  it("lists visible coins and hides moderated ones", async () => {
    const p = live();
    expect((await p.listCoins("trending", "")).map((c) => c.ticker)).toEqual(["MOCHI"]);
    await db.coin.update({ where: { mint: MINT }, data: { hidden: true } });
    expect(await p.listCoins("trending", "")).toEqual([]);
    expect(await p.getCoin(MINT)).toBeNull();
  });

  it("tags the curve vault and excluded wallets in holders", async () => {
    const h = (await live().holders(MINT))!;
    expect(h[0]).toMatchObject({ label: "Bonding curve vault", excluded: true });
    expect(h.find((x) => x.wallet === DIST)).toMatchObject({ excluded: true, label: "Distributor" });
    expect(h.find((x) => x.wallet === ALICE)).toMatchObject({ excluded: false });
  });

  it("computes the wallet's share of eligible supply (excluded wallets don't count)", async () => {
    const r = await live().walletRewards(ALICE);
    expect(r.coins[0]).toMatchObject({ ticker: "MOCHI", pending: "777", received: "5", sharePpm: 750_000 });
    expect(r.creatorCoins.map((c) => c.ticker)).toEqual(["MOCHI"]);
  });

  it("checks tickers against coins and live launch reservations", async () => {
    const p = live();
    expect((await p.tickerAvailable("mochi")).available).toBe(false);
    expect((await p.tickerAvailable("NEWT")).available).toBe(true);
    await db.launchIntent.create({ data: { mint: "M2", tickerKey: "newt", creator: BOB, metadataUri: "https://x", expiresAt: new Date(Date.now() + 60_000) } });
    expect((await p.tickerAvailable("NEWT")).available).toBe(false);
  });

  it("reports live mode and total paid", async () => {
    const s = await live().stats();
    expect(s.mode).toBe("live");
    expect(s.totalPaidLamports).toBe("3000000000");
  });
});

describe("admin auth", () => {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const sign = (ts: number, w = wallet) => `${w}.${ts}.${bs58.encode(nacl.sign.detached(new TextEncoder().encode(adminMessage(w, ts)), kp.secretKey))}`;

  it("accepts a fresh signature from an allowlisted wallet", () => {
    expect(verifyAdmin(sign(Date.now()), new Set([wallet]))).toBe(wallet);
  });
  it("rejects expired, forged and non-allowlisted headers", () => {
    expect(verifyAdmin(sign(Date.now() - 16 * 60_000), new Set([wallet]))).toBeNull();
    expect(verifyAdmin(sign(Date.now()), new Set())).toBeNull();
    const other = bs58.encode(nacl.sign.keyPair().publicKey);
    expect(verifyAdmin(sign(Date.now(), other), new Set([other]))).toBeNull();
    expect(verifyAdmin(undefined, new Set([wallet]))).toBeNull();
  });

  it("guards admin routes and audits writes", async () => {
    const app = await buildApp({ provider: new MockProvider({ tickMs: 0 }) });
    await registerAdmin(app, { db, chain: null, admins: new Set([wallet]), wallets: { buyback: "", distributor: DIST, claim: "", treasury: "" }, platformConfig: "P" });
    expect((await app.inject({ method: "GET", url: "/admin/overview" })).statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/admin/pause", headers: { "x-admin-auth": sign(Date.now()) }, payload: { kind: "buybacks", paused: true } });
    expect(ok.statusCode).toBe(200);
    expect((await db.setting.findUnique({ where: { key: "buybacks_paused" } }))?.value).toBe(true);
    expect(await db.jobLog.count({ where: { job: "admin" } })).toBe(1);
    const hide = await app.inject({ method: "POST", url: `/admin/coins/${MINT}/hide`, headers: { "x-admin-auth": sign(Date.now()) }, payload: { hidden: true, reason: "spam" } });
    expect(hide.statusCode).toBe(200);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).hidden).toBe(true);
    await app.close();
  });
});

describe("uploads", () => {
  it("re-encodes images and strips EXIF metadata", async () => {
    const withExif = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#45E3D3" } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: "secret", Artist: "gps-leak" } } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const out = await cleanImage(withExif, "image/jpeg");
    expect((await sharp(out.data).metadata()).exif).toBeUndefined();
    expect(out.mime).toBe("image/jpeg");
  });

  it("rejects wrong types, tiny images and files that aren't images", async () => {
    const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer();
    await expect(cleanImage(tiny, "image/png")).rejects.toBeInstanceOf(UploadError);
    await expect(cleanImage(Buffer.from("hello"), "image/png")).rejects.toThrow(/readable image/);
    await expect(cleanImage(tiny, "image/svg+xml")).rejects.toThrow(/PNG, JPG/);
  });

  it("mock mode refuses on-chain actions with plain copy", async () => {
    const app = await buildApp({ provider: new MockProvider({ tickMs: 0 }) });
    const r = await app.inject({ method: "POST", url: "/trade/tx", payload: {} });
    expect(r.statusCode).toBe(501);
    expect(r.json().message).toMatch(/simulated data/);
    await app.close();
  });
});
