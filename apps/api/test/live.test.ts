import { CURVE, signInMessage, type SignInPurpose } from "@backflow/core";
import { getPrisma } from "@backflow/db";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import nacl from "tweetnacl";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import type { AuthDeps } from "../src/auth";
import { UploadError, cleanImage } from "../src/ipfs";
import { LiveProvider } from "../src/live/provider";
import { MockProvider } from "../src/mock/provider";
import type { OnChain } from "../src/onchain";

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

describe("transparency", () => {
  async function seedDistribution() {
    const bb = await db.buyback.create({
      data: { coinMint: MINT, round: 1, chunk: 0, idempotencyKey: `${MINT}:1:0`, status: "CONFIRMED", venue: "CURVE", signature: "BBsig", solSpent: 1_000_000_000n, tokensBought: 1_000n, windowStart: new Date("2026-11-04T10:00:00Z"), windowEnd: new Date("2026-11-04T11:00:00Z"), confirmedAt: new Date("2026-11-04T11:00:00Z"), credited: true, carriedIn: 10n, dustCarried: 1n },
    });
    await db.rewardCredit.createMany({ data: [ { buybackId: bb.id, coinMint: MINT, wallet: ALICE, weight: "7200000", amount: 757n }, { buybackId: bb.id, coinMint: MINT, wallet: BOB, weight: "2400000", amount: 252n } ] });
    const payout = await db.payout.create({ data: { round: 1, coinMint: MINT, idempotencyKey: `${MINT}:1`, status: "CONFIRMED", completedAt: new Date("2026-11-04T11:05:00Z") } });
    await db.payoutItem.create({ data: { payoutId: payout.id, wallet: ALICE, amount: 757n, status: "CONFIRMED", signature: "PAYsig" } });
    await db.forfeiture.create({ data: { payoutId: payout.id, coinMint: MINT, wallet: BOB, amount: 252n, createdAt: new Date("2026-11-04T11:05:00Z") } });
    return bb;
  }

  it("lists a wallet's credits, payouts and forfeitures newest first", async () => {
    await seedDistribution();
    const a = await live().walletHistory(ALICE, 50);
    expect(a.map((i) => i.kind)).toEqual(["payout", "credit"]);
    expect(a[0]).toMatchObject({ amount: "757", signature: "PAYsig", ticker: "MOCHI" });
    const b = await live().walletHistory(BOB, 50);
    expect(b.map((i) => i.kind)).toEqual(["forfeit", "credit"]);
  });

  it("serves a checkable distribution: credits + dust = bought + carried in", async () => {
    const bb = await seedDistribution();
    const d = (await live().buybackDetail(bb.id))!;
    expect(BigInt(d.creditedTotal) + BigInt(d.dustCarried)).toBe(BigInt(d.tokensBought) + BigInt(d.carriedIn));
    expect(d.creditCount).toBe(2);
    const app = await buildApp({ provider: live() });
    const csv = await app.inject({ method: "GET", url: `/buybacks/${bb.id}/credits?format=csv` });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toBe("wallet,weight,amount");
    expect(csv.body).toContain(`${ALICE},7200000,757`);
    expect((await app.inject({ method: "GET", url: "/buybacks/nope" })).statusCode).toBe(404);
    await app.close();
  });

  it("aggregates platform stats", async () => {
    await seedDistribution();
    const s = await live().platformStats();
    expect(s).toMatchObject({ coins: 1, buybacks: 1, payoutTransfers: 1, forfeitures: 1, paidToHoldersLamports: "3000000000" });
    expect(s.topCoins[0]!.ticker).toBe("MOCHI");
  });
});

const AUTH: AuthDeps = { db, domain: "backflow.test", cluster: "devnet" };
type App = Awaited<ReturnType<typeof buildApp>>;

/** Ask for a nonce, sign the message like a wallet would, return the body the API expects. */
async function signed(app: App, kp: nacl.SignKeyPair, purpose: SignInPurpose, domain = AUTH.domain) {
  const wallet = bs58.encode(kp.publicKey);
  const n = (await app.inject({ method: "POST", url: "/auth/nonce", payload: { wallet, purpose } })).json() as { nonce: string; issuedAt: string; domain: string; cluster: string };
  const msg = signInMessage({ purpose, wallet, nonce: n.nonce, issuedAt: n.issuedAt, domain, cluster: n.cluster });
  return { wallet, nonce: n.nonce, signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)) };
}

describe("launch flow", () => {
  const kp = nacl.sign.keyPair();
  const creator = bs58.encode(kp.publicKey);
  const other = nacl.sign.keyPair();
  const URI = "https://gateway.pinata.cloud/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  let balance = 1_000_000_000n;
  let balanceFails = false;
  const chain = {
    walletSol: async () => {
      if (balanceFails) throw new Error("rpc down");
      return balance;
    },
    launchTx: async () => ({ tx: { serialize: () => new Uint8Array([1, 2, 3]) }, mint: Keypair.generate().publicKey.toBase58(), poolId: PublicKey.default, expectedTokens: 0n, minTokens: 0n }),
    lookupTable: () => "ok",
    close: () => {},
  } as unknown as OnChain;
  let app: App;
  beforeEach(async () => {
    balance = 1_000_000_000n;
    balanceFails = false;
    app = await buildApp({ provider: new MockProvider({ tickMs: 0 }), auth: AUTH, actions: { db, chain, pinata: { jwt: "test", gateway: "https://gateway.pinata.cloud/ipfs/" }, siteUrl: "https://backflow.test", auth: AUTH } });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });
  const session = async (k = kp) => ((await app.inject({ method: "POST", url: "/launch/session", payload: await signed(app, k, "launch") })).json() as { token: string }).token;
  const launch = (token: string | null, body: Record<string, unknown>) => app.inject({ method: "POST", url: "/launch/tx", headers: token ? { "x-launch-token": token } : {}, payload: { creator, name: "Newt", ticker: "NEWT", uri: URI, ...body } });

  it("needs a launch session, a pinned URI for the same ticker, and enough SOL", async () => {
    expect((await launch(null, {})).statusCode).toBe(401);
    const token = await session();
    expect((await launch(token, {})).json().message).toMatch(/Upload the image/);
    await db.metadataPin.create({ data: { uri: URI, creator, tickerKey: "newt" } });
    expect((await launch(token, { ticker: "OTHER" })).json().message).toMatch(/Upload the image/);
    balance = 1_000_000n;
    expect((await launch(token, {})).json().message).toMatch(/You need about 0.03 SOL/);
    balanceFails = true;
    expect((await launch(token, {})).statusCode).toBe(503);
    balanceFails = false;
    balance = 1_000_000_000n;
    const ok = await launch(token, { firstBuyLamports: "500000000" });
    expect(ok.statusCode).toBe(200);
    expect(await db.launchIntent.count({ where: { creator, expiresAt: { gt: new Date() } } })).toBe(1);
    // a token for another wallet doesn't work for this creator
    const otherToken = await session(other);
    expect((await launch(otherToken, {})).statusCode).toBe(401);
  });

  it("keeps one active reservation per wallet and refuses a ticker another wallet holds", async () => {
    const token = await session();
    await db.metadataPin.create({ data: { uri: URI, creator, tickerKey: "newt" } });
    expect((await launch(token, {})).statusCode).toBe(200);
    expect((await launch(token, {})).statusCode).toBe(200);
    expect(await db.launchIntent.count({ where: { creator, expiresAt: { gt: new Date() } } })).toBe(1);
    const oWallet = bs58.encode(other.publicKey);
    const oUri = URI.replace("QmYw", "QmZw");
    await db.metadataPin.create({ data: { uri: oUri, creator: oWallet, tickerKey: "newt" } });
    const r = await app.inject({ method: "POST", url: "/launch/tx", headers: { "x-launch-token": await session(other) }, payload: { creator: oWallet, name: "Newt", ticker: "NEWT", uri: oUri } });
    expect(r.statusCode).toBe(409);
  });

  it("lets only one of two wallets reserve the same ticker at the same time", async () => {
    const kps = [nacl.sign.keyPair(), nacl.sign.keyPair(), nacl.sign.keyPair()];
    const reqs = await Promise.all(
      kps.map(async (k, i) => {
        const w = bs58.encode(k.publicKey);
        const uri = `${URI.slice(0, -1)}${"abc"[i]}`;
        await db.metadataPin.create({ data: { uri, creator: w, tickerKey: "race" } });
        return { w, uri, token: await session(k) };
      }),
    );
    const res = await Promise.all(reqs.map((r) => app.inject({ method: "POST", url: "/launch/tx", headers: { "x-launch-token": r.token }, payload: { creator: r.w, name: "Race", ticker: "RACE", uri: r.uri } })));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect(await db.launchIntent.count({ where: { tickerKey: "race" } })).toBe(1);
  });

  it("pins metadata only with a launch session and records it for the wallet and ticker", async () => {
    // random pixels: a ~1 MB file, well over the 64 KB JSON body limit, must still upload
    const side = 600;
    const noise = randomBytes(side * side * 3);
    const png = await sharp(noise, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer();
    expect(png.length).toBeGreaterThan(200_000);
    const form = () => {
      const boundary = "----bf";
      const parts = [
        ["name", "Newt"],
        ["ticker", "newt"],
        ["description", "A small newt"],
        ["x", "javascript:alert(1)"],
      ].map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
      const head = Buffer.from(parts.join("") + `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`);
      return { payload: Buffer.concat([head, png, Buffer.from(`\r\n--${boundary}--\r\n`)]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
    };
    const pinned: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      pinned.push(init?.body);
      return new Response(JSON.stringify({ IpfsHash: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" }), { status: 200 });
    });
    const anon = await app.inject({ method: "POST", url: "/launch/metadata", ...form() });
    expect(anon.statusCode).toBe(401);
    expect(pinned).toHaveLength(0);
    const token = await session();
    const f = form();
    const r = await app.inject({ method: "POST", url: "/launch/metadata", payload: f.payload, headers: { ...f.headers, "x-launch-token": token } });
    expect(r.statusCode).toBe(200);
    expect(await db.metadataPin.findUnique({ where: { uri: r.json().uri } })).toMatchObject({ creator, tickerKey: "newt" });
    // the javascript: link was dropped before pinning
    expect(String(pinned[1])).not.toContain("javascript");
  });

  it("stores the image and metadata on this server when there is no Pinata (D-048)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rebuy-media-"));
    const local = await buildApp({ provider: new MockProvider({ tickMs: 0 }), auth: AUTH, actions: { db, chain, pinata: null, localMedia: { dir, baseUrl: "https://rebuy.fun/api/media" }, siteUrl: "https://rebuy.fun", auth: AUTH }, media: { dir } });
    try {
      const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#45E3D3" } }).png().toBuffer();
      const boundary = "----bf";
      const head = Buffer.from(
        [["name", "Newt"], ["ticker", "newt"], ["description", "A small newt"]].map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join("") +
          `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
      );
      const token = ((await local.inject({ method: "POST", url: "/launch/session", payload: await signed(local, kp, "launch") })).json() as { token: string }).token;
      const r = await local.inject({ method: "POST", url: "/launch/metadata", payload: Buffer.concat([head, png, Buffer.from(`\r\n--${boundary}--\r\n`)]), headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "x-launch-token": token } });
      expect(r.statusCode).toBe(200);
      const { uri, image } = r.json() as { uri: string; image: string };
      expect(uri).toMatch(/^https:\/\/rebuy\.fun\/api\/media\/[0-9a-f]{64}\.json$/);
      expect(image).toMatch(/^https:\/\/rebuy\.fun\/api\/media\/[0-9a-f]{64}\.png$/);
      expect(await db.metadataPin.findUnique({ where: { uri } })).toMatchObject({ creator, tickerKey: "newt" });
      // both files are served back, the JSON points at the image, and names are content hashes
      const meta = await local.inject({ method: "GET", url: `/media/${uri.split("/").pop()}` });
      expect(meta.statusCode).toBe(200);
      expect(meta.headers["content-type"]).toBe("application/json");
      expect(meta.headers["cache-control"]).toContain("immutable");
      expect(meta.json()).toMatchObject({ name: "Newt", symbol: "NEWT", image });
      const file = image.split("/").pop()!;
      const img = await local.inject({ method: "GET", url: `/media/${file}` });
      expect(img.statusCode).toBe(200);
      expect(img.headers["content-type"]).toBe("image/png");
      expect(createHash("sha256").update(img.rawPayload).digest("hex")).toBe(file.slice(0, 64));
      // nothing outside the store can be read
      for (const bad of ["..%2F..%2Fetc%2Fpasswd", "x.png", `${"a".repeat(64)}.svg`, `${"a".repeat(64)}.png`]) expect((await local.inject({ method: "GET", url: `/media/${bad}` })).statusCode).toBe(404);
    } finally {
      await local.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reports and status", () => {
  it("stores one report per reporter per coin and ignores an unsigned wallet", async () => {
    const app = await buildApp({ provider: live() });
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: "POST", url: `/coins/${MINT}/report`, payload: { reason: "looks like a scam", wallet: ALICE } });
      expect(r.statusCode).toBe(200);
    }
    const rows = await db.moderationFlag.findMany({ where: { coinMint: MINT, action: "report" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.by).toMatch(/^r:[0-9a-f]{24}$/);
    expect(rows[0]!.by).not.toContain(ALICE);
    await app.close();
  });

  it("shows only ok/down per component on the public status", async () => {
    const app = await buildApp({ provider: live(), extras: { db, chain: null, publish: null, mode: "live", platformConfig: "P", auth: AUTH } });
    const s = (await app.inject({ method: "GET", url: "/status" })).json() as Record<string, unknown>;
    expect(s.database).toBe("ok");
    expect(Object.values(s.workers as Record<string, unknown>).every((w) => w === "ok" || w === "down")).toBe(true);
    expect(JSON.stringify(s)).not.toContain("note");
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

  it("sniffs the real type: SVG or TIFF bytes sent as image/png never reach the decoder", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64"/></svg>');
    await expect(cleanImage(svg, "image/png")).rejects.toThrow(/readable image/);
    const tiff = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#000" } }).tiff().toBuffer();
    await expect(cleanImage(tiff, "image/jpeg")).rejects.toThrow(/readable image/);
  });

  const gif = async (frames: number, side: number) => {
    const imgs = await Promise.all(Array.from({ length: frames }, (_, i) => sharp({ create: { width: side, height: side, channels: 3, background: { r: (i * 37) % 256, g: (i * 91) % 256, b: (i * 53) % 256 } } }).png().toBuffer()));
    return sharp(imgs, { join: { animated: true } }).gif().toBuffer();
  };

  it("accepts small animations and refuses too many frames or too many pixels in total", async () => {
    const ok = await cleanImage(await gif(3, 64), "image/gif");
    expect(ok.mime).toBe("image/gif");
    expect((await sharp(ok.data, { animated: true }).metadata()).pages).toBe(3);
    await expect(cleanImage(await gif(61, 64), "image/gif")).rejects.toThrow(/too many frames/);
    // each frame is within 4096 px, but 7 × 2000 × 2000 = 28 M pixels in total
    await expect(cleanImage(await gif(7, 2000), "image/gif")).rejects.toThrow(/too large/);
  });

  it("mock mode refuses on-chain actions with plain copy", async () => {
    const app = await buildApp({ provider: new MockProvider({ tickMs: 0 }) });
    const r = await app.inject({ method: "POST", url: "/trade/tx", payload: {} });
    expect(r.statusCode).toBe(501);
    expect(r.json().message).toMatch(/simulated data/);
    await app.close();
  });
});
