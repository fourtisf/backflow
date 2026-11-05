/**
 * Routes that build transactions for the user's wallet to sign (launch, trade,
 * claim creator fees) and the metadata upload. Live mode only; the API never
 * signs for users.
 *
 * Launch flow (audit M1, M2, L3):
 *   1. POST /auth/nonce {wallet, purpose: "launch"}, the wallet signs, then
 *      POST /launch/session {wallet, nonce, signature} -> a 15-minute launch token.
 *   2. POST /launch/metadata (x-launch-token): image + details are pinned, and the
 *      metadata URI is recorded as a MetadataPin for that wallet and ticker.
 *   3. POST /launch/tx (x-launch-token): only for a URI this wallet pinned for this
 *      ticker, only with enough SOL for the launch, and the ticker is reserved for
 *      two minutes (LaunchIntent) under an advisory lock, one reservation per wallet.
 */
import {
  BRAND,
  LAUNCH_LIMITS,
  LINK_HOSTS,
  SOL_DECIMALS,
  cleanLink,
  duplicateTickerMessage,
  looksLikeAddress,
  normalizeTicker,
  tickerKey,
  validateDescription,
  validateName,
  validateTicker,
  type BuiltTxDTO,
  type LaunchTxDTO,
} from "@backflow/core";
import type { PrismaClient } from "@backflow/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { decryptSecret } from "@backflow/chain";
import { Keypair } from "@solana/web3.js";
import { AuthError, SIGNED_BODY_SCHEMA, createLaunchSession, launchSessionWallet, verifySigned, type AuthDeps } from "../auth";
import { UploadError, cleanImage, gatewayUrl, pinFile, pinJson, storeLocal, type LocalMediaConfig, type PinataConfig } from "../ipfs";
import type { OnChain } from "../onchain";

const b64 = (tx: { serialize(): Uint8Array }) => Buffer.from(tx.serialize()).toString("base64");
const bad = (reply: FastifyReply, message: string, status = 400) => reply.code(status).send({ error: "bad_request", message });
const big = (v: unknown): bigint | null => (typeof v === "string" && /^\d{1,30}$/.test(v) ? BigInt(v) : null);
const slip = (v: unknown, def: number) => {
  const n = Number(v ?? def);
  return Number.isInteger(n) && n >= 0 && n <= 5000 ? n : def;
};

/** How long /launch/tx holds a ticker for the wallet that asked. */
export const LAUNCH_HOLD_MS = 120_000;
/**
 * SOL a launch needs besides the first buy: rent for the pool state, two vaults, the mint and its
 * metadata account, the creator's token account, and network fees. An estimate with headroom.
 */
export const LAUNCH_COST_LAMPORTS = 30_000_000n;
/** Metadata uploads per wallet per hour (on top of the per-IP limit). */
export const UPLOADS_PER_WALLET_PER_HOUR = 10;

const NEED_SESSION = "Sign the launch message in your wallet first.";
const sol2 = (l: bigint) => (Number(l) / 10 ** SOL_DECIMALS).toFixed(2);

/** SPEC §4 (optional): take one pre-ground vanity mint key (e.g. "…buy"), if enabled and any are left. */
async function claimVanity(db: PrismaClient): Promise<Keypair | undefined> {
  if (process.env.VANITY_ENABLED !== "1") return undefined;
  const rows = await db.$queryRaw<{ pubkey: string; secretEnc: string }[]>`
    UPDATE "VanityMint" SET "usedAt" = now()
    WHERE pubkey = (SELECT pubkey FROM "VanityMint" WHERE "usedAt" IS NULL ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING pubkey, "secretEnc"`;
  const row = rows[0];
  if (!row) return undefined;
  const kp = Keypair.fromSecretKey(decryptSecret(row.secretEnc));
  return kp.publicKey.toBase58() === row.pubkey ? kp : undefined;
}

/** Fixed, plain messages for chain and builder errors; the details go to the log only (audit L2). */
export function tradeErrorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  if (/moving to Raydium/i.test(m)) return "This coin is moving to Raydium. Try again in a minute.";
  if (/pool not found/i.test(m)) return "This coin's pool couldn't be read. Try again in a minute.";
  if (/byte limit|too large|1232/i.test(m)) return "The transaction is too large. Try a different amount.";
  return "Couldn't build the transaction. Try again in a minute.";
}

export interface ActionDeps {
  db: PrismaClient;
  chain: OnChain;
  pinata: PinataConfig | null;
  /** Images and metadata on this server instead of IPFS (D-048). Used when `pinata` is null. */
  localMedia?: LocalMediaConfig | null;
  siteUrl: string;
  auth: AuthDeps;
}

const LAUNCH_TX_SCHEMA = {
  body: {
    type: "object",
    properties: {
      creator: { type: "string", maxLength: 64 },
      name: { type: "string", maxLength: 64 },
      ticker: { type: "string", maxLength: 32 },
      uri: { type: "string", maxLength: 200 },
      firstBuyLamports: { type: "string", maxLength: 30 },
      slippageBps: { type: "integer", minimum: 0, maximum: 5000 },
    },
  },
} as const;

const TRADE_TX_SCHEMA = {
  body: {
    type: "object",
    properties: {
      owner: { type: "string", maxLength: 64 },
      mint: { type: "string", maxLength: 64 },
      side: { type: "string", maxLength: 8 },
      amount: { type: "string", maxLength: 30 },
      slippageBps: { type: "integer", minimum: 0, maximum: 5000 },
    },
  },
} as const;

const CLAIM_TX_SCHEMA = {
  body: {
    type: "object",
    properties: { creator: { type: "string", maxLength: 64 }, kind: { type: "string", maxLength: 16 }, mint: { type: "string", maxLength: 64 } },
  },
} as const;

export async function registerActions(app: FastifyInstance, d: ActionDeps): Promise<void> {
  /** Exchange a signed "launch" message for a launch token (kept in memory by the web, 15 minutes). */
  app.post<{ Body: { wallet?: string; nonce?: string; signature?: string } }>(
    "/launch/session",
    { schema: SIGNED_BODY_SCHEMA, config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (req, reply) => {
      try {
        const wallet = await verifySigned(d.auth, req.body, "launch");
        return await createLaunchSession(d.auth, wallet);
      } catch (e) {
        if (e instanceof AuthError) return reply.code(e.status).send({ error: e.code, message: e.message });
        throw e;
      }
    },
  );

  app.post("/launch/metadata", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req, reply) => {
    const pinata = d.pinata;
    const local = pinata ? null : (d.localMedia ?? null);
    if (!pinata && !local) return bad(reply, "Uploads aren't configured on this server.", 503);
    // Check the launch token before reading the body, so anonymous uploads never reach the image decoder.
    const wallet = await launchSessionWallet(d.auth, req);
    if (!wallet) return reply.code(401).send({ error: "launch_session_required", message: NEED_SESSION });
    const recent = await d.db.metadataPin.count({ where: { creator: wallet, createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
    if (recent >= UPLOADS_PER_WALLET_PER_HOUR) return bad(reply, "That's a lot of uploads from one wallet. Try again in an hour.", 429);
    const fields: Record<string, string> = {};
    let image: { data: Buffer; mime: string } | null = null;
    try {
      for await (const part of req.parts({ limits: { fileSize: LAUNCH_LIMITS.imageMaxBytes, files: 1, fields: 10, fieldSize: 1024 } })) {
        if (part.type === "file") {
          const data = await part.toBuffer();
          if (part.file.truncated) throw new UploadError("That image is over 4 MB. Choose a smaller one.", 413);
          image = { data, mime: part.mimetype };
        } else fields[part.fieldname] = String(part.value ?? "").slice(0, 1024);
      }
    } catch (e) {
      if (e instanceof UploadError) return bad(reply, e.message, e.status);
      return bad(reply, "That upload couldn't be read.");
    }
    const ticker = normalizeTicker(fields.ticker ?? "");
    const err = validateName(fields.name ?? "") ?? validateTicker(ticker) ?? validateDescription(fields.description ?? "");
    if (err) return bad(reply, err);
    if (!image) return bad(reply, "Add an image for your coin.");
    const key = tickerKey(ticker);
    const taken = (await d.db.coin.findUnique({ where: { tickerSlot: key } })) || (await d.db.launchIntent.findFirst({ where: { tickerKey: key, expiresAt: { gt: new Date() }, creator: { not: wallet } } }));
    if (taken) return bad(reply, duplicateTickerMessage(ticker), 409);
    try {
      const img = await cleanImage(image.data, image.mime);
      const imageUrl = pinata ? gatewayUrl(pinata, await pinFile(pinata, img.data, `${ticker.toLowerCase()}.${img.ext}`, img.mime)) : await storeLocal(local!, img.data, img.ext);
      const meta = {
        name: fields.name!.trim(),
        symbol: ticker,
        description: (fields.description ?? "").trim(),
        image: imageUrl,
        showName: true,
        createdOn: d.siteUrl,
        platform: BRAND.name,
        twitter: cleanLink(fields.x, LINK_HOSTS.x) ?? undefined,
        telegram: cleanLink(fields.telegram, LINK_HOSTS.telegram) ?? undefined,
        website: cleanLink(fields.website, null) ?? undefined,
      };
      const uri = pinata ? gatewayUrl(pinata, await pinJson(pinata, meta, `${ticker.toLowerCase()}.json`)) : await storeLocal(local!, Buffer.from(JSON.stringify(meta)), "json");
      // Bind the URI to this wallet and ticker: /launch/tx accepts only URIs pinned here (L3).
      await d.db.metadataPin.upsert({ where: { uri }, create: { uri, creator: wallet, tickerKey: key }, update: { creator: wallet, tickerKey: key, createdAt: new Date() } });
      return { uri, image: meta.image };
    } catch (e) {
      if (e instanceof UploadError) return bad(reply, e.message, e.status);
      req.log.error({ err: e }, "metadata upload failed");
      return bad(reply, "Upload failed. Try again in a minute.", 502);
    }
  });

  app.post<{ Body: { creator?: string; name?: string; ticker?: string; uri?: string; firstBuyLamports?: string; slippageBps?: number } }>(
    "/launch/tx",
    { schema: LAUNCH_TX_SCHEMA, config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.creator || !looksLikeAddress(b.creator)) return bad(reply, "Connect a wallet first.");
      const session = await launchSessionWallet(d.auth, req);
      if (!session || session !== b.creator) return reply.code(401).send({ error: "launch_session_required", message: NEED_SESSION });
      const ticker = normalizeTicker(b.ticker ?? "");
      const err = validateName(b.name ?? "") ?? validateTicker(ticker);
      if (err) return bad(reply, err);
      const key = tickerKey(ticker);
      const pin = b.uri ? await d.db.metadataPin.findUnique({ where: { uri: b.uri } }) : null;
      if (!pin || pin.creator !== b.creator || pin.tickerKey !== key) return bad(reply, "Upload the image and details first.");
      const first = b.firstBuyLamports ? big(b.firstBuyLamports) : 0n;
      if (first == null) return bad(reply, "Enter a number, like 0.5.");
      const now = new Date();
      if ((await d.db.coin.findUnique({ where: { tickerSlot: key } })) || (await d.db.launchIntent.findFirst({ where: { tickerKey: key, expiresAt: { gt: now }, creator: { not: b.creator } } }))) {
        return bad(reply, duplicateTickerMessage(ticker), 409);
      }
      // Fail closed: no balance check, no reservation.
      let balance: bigint;
      try {
        balance = await d.chain.walletSol(b.creator);
      } catch (e) {
        req.log.warn({ err: e }, "balance check failed");
        return bad(reply, "Couldn't check your SOL balance. Try again in a minute.", 503);
      }
      if (balance < first + LAUNCH_COST_LAMPORTS) {
        return bad(reply, first > 0n ? `You have ${sol2(balance)} SOL. Lower the first buy.` : `You need about ${sol2(LAUNCH_COST_LAMPORTS)} SOL to pay for the launch accounts and network fees. You have ${sol2(balance)} SOL.`);
      }
      let built: Awaited<ReturnType<OnChain["launchTx"]>>;
      try {
        built = await d.chain.launchTx({ creator: b.creator, name: b.name!.trim(), symbol: ticker, uri: pin.uri, firstBuyLamports: first, slippageBps: slip(b.slippageBps, 100) }, await claimVanity(d.db));
      } catch (e) {
        req.log.error({ err: e }, "launch tx build failed");
        return bad(reply, /1232|byte limit/.test((e as Error).message) ? "The launch transaction is too large. Shorten the name or links." : "Couldn't build the launch transaction. Try again.", 502);
      }
      // Check-then-insert, serialized per ticker, so two wallets can't both reserve it.
      const reserved = await d.db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
          const t = new Date();
          if (await tx.coin.findUnique({ where: { tickerSlot: key } })) return false;
          if (await tx.launchIntent.findFirst({ where: { tickerKey: key, expiresAt: { gt: t }, creator: { not: b.creator } } })) return false;
          // one active reservation per wallet: older ones stop holding a ticker (rows stay for the indexer until purged)
          await tx.launchIntent.updateMany({ where: { creator: b.creator, expiresAt: { gt: t } }, data: { expiresAt: t } });
          await tx.launchIntent.deleteMany({ where: { expiresAt: { lt: new Date(t.getTime() - 3_600_000) } } });
          await tx.launchIntent.create({ data: { mint: built.mint, tickerKey: key, creator: b.creator!, metadataUri: pin.uri, expiresAt: new Date(t.getTime() + LAUNCH_HOLD_MS) } });
          return true;
        },
        { timeout: 10_000 },
      );
      if (!reserved) return bad(reply, duplicateTickerMessage(ticker), 409);
      const out: LaunchTxDTO = { tx: b64(built.tx), mint: built.mint, poolId: built.poolId.toBase58(), expectedOut: built.expectedTokens.toString(), minOut: built.minTokens.toString() };
      return out;
    },
  );

  app.get<{ Params: { mint: string }; Querystring: { side?: string; amount?: string; slippageBps?: string } }>("/coins/:mint/quote", async (req, reply) => {
    if (!looksLikeAddress(req.params.mint)) return reply.code(404).send({ error: "not_found", message: `This coin isn't on ${BRAND.name}.` });
    const coin = await d.db.coin.findUnique({ where: { mint: req.params.mint } });
    if (!coin || coin.hidden) return reply.code(404).send({ error: "not_found", message: `This coin isn't on ${BRAND.name}.` });
    const side = req.query.side === "sell" ? "sell" : "buy";
    const amount = big(req.query.amount);
    if (!amount || amount <= 0n) return bad(reply, "Enter an amount above zero.");
    try {
      const q = await d.chain.quote(coin, side, amount, slip(req.query.slippageBps, 100));
      return q ?? reply.code(409).send({ error: "unavailable", message: "This coin is moving to Raydium. Try again in a minute." });
    } catch (e) {
      req.log.warn({ err: e }, "quote failed");
      return reply.code(502).send({ error: "unavailable", message: "Couldn't get a price from the Solana network. Try again in a minute." });
    }
  });

  app.post<{ Body: { owner?: string; mint?: string; side?: string; amount?: string; slippageBps?: number } }>("/trade/tx", { schema: TRADE_TX_SCHEMA, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const b = req.body ?? {};
    if (!b.owner || !looksLikeAddress(b.owner)) return bad(reply, "Connect a wallet first.");
    const coin = b.mint && looksLikeAddress(b.mint) ? await d.db.coin.findUnique({ where: { mint: b.mint } }) : null;
    if (!coin || coin.hidden) return reply.code(404).send({ error: "not_found", message: `This coin isn't on ${BRAND.name}.` });
    const amount = big(b.amount);
    if (!amount || amount <= 0n) return bad(reply, "Enter an amount above zero.");
    try {
      const r = await d.chain.tradeTx(b.owner, coin, b.side === "sell" ? "sell" : "buy", amount, slip(b.slippageBps, 100));
      const out: BuiltTxDTO = { tx: b64(r.tx), expectedOut: r.expectedOut.toString(), minOut: r.minOut.toString() };
      return out;
    } catch (e) {
      req.log.warn({ err: e }, "trade tx build failed");
      return bad(reply, tradeErrorMessage(e), 409);
    }
  });

  /**
   * Creator fees. kind "launchlab" (default) empties the creator's LaunchLab vault (all their coins, before
   * graduation). kind "cpmm" collects the creator fees of one graduated coin's Raydium pool.
   */
  app.post<{ Body: { creator?: string; kind?: string; mint?: string } }>("/creator/claim-tx", { schema: CLAIM_TX_SCHEMA, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const creator = req.body?.creator;
    if (!creator || !looksLikeAddress(creator)) return bad(reply, "Connect a wallet first.");
    try {
      if (req.body?.kind === "cpmm") {
        const mint = req.body.mint;
        const coin = mint && looksLikeAddress(mint) ? await d.db.coin.findUnique({ where: { mint } }) : null;
        if (!coin?.cpmmPoolId) return bad(reply, "This coin hasn't moved to Raydium yet.");
        const fees = await d.chain.cpmmCreatorFees(creator, coin.cpmmPoolId, coin.mint);
        if (!fees) return bad(reply, "Only the coin's creator can claim these fees.", 403);
        if (fees.sol === 0n && fees.tokens === 0n) return bad(reply, "There are no creator fees to claim yet.");
        const tx = await d.chain.claimCpmmCreatorTx(creator, coin.cpmmPoolId);
        return { tx: b64(tx), expectedOut: fees.sol.toString(), minOut: "0" } satisfies BuiltTxDTO;
      }
      const claimable = await d.chain.creatorClaimable(creator);
      if (!claimable) return bad(reply, "There are no creator fees to claim yet.");
      const tx = await d.chain.claimCreatorTx(creator);
      return { tx: b64(tx), expectedOut: claimable.toString(), minOut: "0" } satisfies BuiltTxDTO;
    } catch (e) {
      req.log.warn({ err: e }, "claim tx build failed");
      return bad(reply, "Couldn't build the claim transaction. Try again in a minute.", 502);
    }
  });
}
