/** Admin actions (CLI only; there is no admin page or API). Uses the workers' test database. */
import { admin, getPrisma } from "@backflow/db";
import { beforeEach, describe, expect, it } from "vitest";

const db = getPrisma();
const ME = "cli:ops@test";
const MINT = "CoinMint1111111111111111111111111111111back";
const MINT2 = "CoinMint2222222222222222222222222222222back";

async function truncate() {
  const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`);
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

const coin = (mint: string, ticker: string, extra: object = {}) =>
  db.coin.create({ data: { mint, poolId: "pool-" + mint, platformConfig: "P", name: ticker, ticker, tickerKey: ticker.toLowerCase(), creator: "C", supply: 1n, graduationTargetLamports: 1n, ...extra } });

beforeEach(async () => {
  await truncate();
  await coin(MINT, "MOCHI", { tickerSlot: "mochi" });
});

describe("admin actions", () => {
  it("hides and unhides a coin, with a moderation flag and an audit row each", async () => {
    await admin.setHidden(db, MINT, true, "spam", ME);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).hidden).toBe(true);
    await admin.setHidden(db, MINT, false, null, ME);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).hidden).toBe(false);
    expect(await db.moderationFlag.count({ where: { coinMint: MINT, by: ME } })).toBe(2);
    expect((await admin.auditLog(db)).map((l) => l.message)).toEqual(["unhid coin", "hid coin"]);
    await expect(admin.setHidden(db, "nope", true, null, ME)).rejects.toMatchObject({ code: "not_found" });
  });

  it("refresh re-reads a coin's holders and a logo that never loaded, with an audit row (D-055)", async () => {
    await db.coin.update({ where: { mint: MINT }, data: { metadataUri: "https://rebuy.fun/api/media/x.json", metadataStatus: "failed", metadataAttempts: 5, needsHolderSync: false } });
    expect(await admin.refreshCoin(db, MINT, ME)).toEqual({ metadata: true });
    const c = await db.coin.findUniqueOrThrow({ where: { mint: MINT } });
    expect(c.needsHolderSync).toBe(true);
    expect(c.metadataStatus).toBe("pending");
    expect(c.metadataAttempts).toBe(0);
    expect((await admin.auditLog(db))[0]!.message).toBe("refreshed coin");
    await expect(admin.refreshCoin(db, "nope", ME)).rejects.toMatchObject({ code: "not_found" });
  });

  it("won't unhide a duplicate-ticker coin while another coin owns the ticker", async () => {
    await coin(MINT2, "MOCHI", { hidden: true, hiddenReason: "duplicate ticker $MOCHI" });
    await expect(admin.setHidden(db, MINT2, false, null, ME)).rejects.toMatchObject({ code: "ticker_taken" });
  });

  it("pauses and resumes globally or per coin", async () => {
    await admin.setPaused(db, "payouts", "global", true, ME);
    expect((await db.setting.findUniqueOrThrow({ where: { key: "payouts_paused" } })).value).toBe(true);
    await admin.setPaused(db, "buybacks", MINT, true, ME);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybacksPaused).toBe(true);
    await admin.setPaused(db, "buybacks", MINT, false, ME);
    expect((await db.coin.findUniqueOrThrow({ where: { mint: MINT } })).buybacksPaused).toBe(false);
    await expect(admin.setPaused(db, "buybacks", MINT2, true, ME)).rejects.toMatchObject({ code: "not_found" });
    expect(await db.jobLog.count({ where: { job: "admin", key: ME } })).toBe(3);
  });

  it("only approves claims that are held, once", async () => {
    const held = await db.vaultClaim.create({ data: { status: "CONFIRMED", stage: "held", claimedLamports: 10n, expectedLamports: 9n, mismatchPpm: 111_111 } });
    const done = await db.vaultClaim.create({ data: { status: "CONFIRMED", stage: "done" } });
    await admin.approveHeldClaim(db, held.id, ME);
    expect((await db.vaultClaim.findUniqueOrThrow({ where: { id: held.id } })).stage).toBe("transfer");
    await expect(admin.approveHeldClaim(db, held.id, ME)).rejects.toMatchObject({ code: "conflict" });
    await expect(admin.approveHeldClaim(db, done.id, ME)).rejects.toMatchObject({ code: "conflict" });
    expect(await db.jobLog.count({ where: { message: "approved held vault claim" } })).toBe(1);
  });

  it("only re-queues failed harvests", async () => {
    const failed = await db.harvest.create({ data: { coinMint: MINT, status: "FAILED" } });
    const ok = await db.harvest.create({ data: { coinMint: MINT, status: "CONFIRMED" } });
    await admin.retryHarvest(db, failed.id, ME);
    expect((await db.harvest.findUniqueOrThrow({ where: { id: failed.id } })).createdAt.getTime()).toBe(0);
    await expect(admin.retryHarvest(db, ok.id, ME)).rejects.toMatchObject({ code: "conflict" });
  });

  it("adds and removes exclusions and validates addresses", async () => {
    await admin.addExclusion(db, "XMkJY2gvwdxLR1UYxkFLNSzPqM8DfDwaEUYmqtwuJa3D", "global", "manual", "team wallet", ME);
    expect(await admin.listExcluded(db)).toHaveLength(1);
    expect(await admin.removeExclusion(db, "XMkJY2gvwdxLR1UYxkFLNSzPqM8DfDwaEUYmqtwuJa3D", "global", ME)).toBe(1);
    await expect(admin.addExclusion(db, "not an address", "global", "manual", null, ME)).rejects.toMatchObject({ code: "bad_request" });
  });

  it("counts distinct reporters per coin and lists reported coins first", async () => {
    await coin(MINT2, "PEBBLE", { tickerSlot: "pebble" });
    await db.moderationFlag.createMany({
      data: [
        { coinMint: MINT2, reason: "scam", action: "report", by: "r:a" },
        { coinMint: MINT2, reason: "scam", action: "report", by: "r:a" },
        { coinMint: MINT2, reason: "x", action: "report", by: "r:b" },
      ],
    });
    const coins = await admin.listCoins(db);
    expect(coins[0]).toMatchObject({ mint: MINT2, reports: 2 });
    expect(await admin.listCoins(db, { reportedOnly: true })).toHaveLength(1);
  });

  it("resolves an indexer dead letter once", async () => {
    await db.indexerDeadLetter.create({ data: { stream: "platform:P", signature: "sig", error: "boom", attempts: 5 } });
    expect((await admin.adminOverview(db, "P")).deadLetters).toBe(1);
    await admin.resolveDeadLetter(db, "platform:P", "sig", ME);
    expect(await admin.listDeadLetters(db)).toHaveLength(0);
    await expect(admin.resolveDeadLetter(db, "platform:P", "sig", ME)).rejects.toMatchObject({ code: "not_found" });
  });
});
