/**
 * Routes that build transactions for the user's wallet to sign (launch, trade,
 * claim creator fees) and the metadata upload. Live mode only; the API never
 * signs for users. Launch reserves the ticker for two minutes (LaunchIntent).
 */
import {
  BRAND,
  LAUNCH_LIMITS,
  SOL_DECIMALS,
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
import { UploadError, cleanImage, gatewayUrl, pinFile, pinJson, type PinataConfig } from "../ipfs";
import type { OnChain } from "../onchain";

const b64 = (tx: { serialize(): Uint8Array }) => Buffer.from(tx.serialize()).toString("base64");
const bad = (reply: FastifyReply, message: string, status = 400) => reply.code(status).send({ error: "bad_request", message });
const big = (v: unknown): bigint | null => (typeof v === "string" && /^\d{1,30}$/.test(v) ? BigInt(v) : null);
const slip = (v: unknown, def: number) => {
  const n = Number(v ?? def);
  return Number.isInteger(n) && n >= 0 && n <= 5000 ? n : def;
};

function cleanLink(v: unknown, host: RegExp | null): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  let s = v.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return null;
    if (host && !host.test(u.hostname)) return null;
    return u.toString().slice(0, 200);
  } catch {
    return null;
  }
}

export interface ActionDeps {
  db: PrismaClient;
  chain: OnChain;
  pinata: PinataConfig | null;
  siteUrl: string;
}

export async function registerActions(app: FastifyInstance, d: ActionDeps): Promise<void> {
  app.post("/launch/metadata", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req, reply) => {
    if (!d.pinata) return bad(reply, "Uploads aren't configured on this server.", 503);
    const fields: Record<string, string> = {};
    let image: { data: Buffer; mime: string } | null = null;
    try {
      for await (const part of req.parts({ limits: { fileSize: LAUNCH_LIMITS.imageMaxBytes, files: 1, fields: 10 } })) {
        if (part.type === "file") {
          const data = await part.toBuffer();
          if (part.file.truncated) throw new UploadError("That image is over 4 MB. Choose a smaller one.", 413);
          image = { data, mime: part.mimetype };
        } else fields[part.fieldname] = String(part.value ?? "");
      }
    } catch (e) {
      if (e instanceof UploadError) return bad(reply, e.message, e.status);
      return bad(reply, "That upload couldn't be read.");
    }
    const ticker = normalizeTicker(fields.ticker ?? "");
    const err = validateName(fields.name ?? "") ?? validateTicker(ticker) ?? validateDescription(fields.description ?? "");
    if (err) return bad(reply, err);
    if (!image) return bad(reply, "Add an image for your coin.");
    const taken = (await d.db.coin.findUnique({ where: { tickerSlot: tickerKey(ticker) } })) || (await d.db.launchIntent.findFirst({ where: { tickerKey: tickerKey(ticker), expiresAt: { gt: new Date() } } }));
    if (taken) return bad(reply, duplicateTickerMessage(ticker), 409);
    try {
      const img = await cleanImage(image.data, image.mime);
      const imageCid = await pinFile(d.pinata, img.data, `${ticker.toLowerCase()}.${img.ext}`, img.mime);
      const meta = {
        name: fields.name!.trim(),
        symbol: ticker,
        description: (fields.description ?? "").trim(),
        image: gatewayUrl(d.pinata, imageCid),
        showName: true,
        createdOn: d.siteUrl,
        platform: BRAND.name,
        twitter: cleanLink(fields.x, /(^|\.)(x|twitter)\.com$/i) ?? undefined,
        telegram: cleanLink(fields.telegram, /(^|\.)(t\.me|telegram\.me)$/i) ?? undefined,
        website: cleanLink(fields.website, null) ?? undefined,
      };
      const metaCid = await pinJson(d.pinata, meta, `${ticker.toLowerCase()}.json`);
      return { uri: gatewayUrl(d.pinata, metaCid), image: meta.image };
    } catch (e) {
      if (e instanceof UploadError) return bad(reply, e.message, e.status);
      req.log.error({ err: e }, "metadata upload failed");
      return bad(reply, "Upload failed. Try again in a minute.", 502);
    }
  });

  app.post<{ Body: { creator?: string; name?: string; ticker?: string; uri?: string; firstBuyLamports?: string; slippageBps?: number } }>(
    "/launch/tx",
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.creator || !looksLikeAddress(b.creator)) return bad(reply, "Connect a wallet first.");
      const ticker = normalizeTicker(b.ticker ?? "");
      const err = validateName(b.name ?? "") ?? validateTicker(ticker);
      if (err) return bad(reply, err);
      if (!b.uri || !b.uri.startsWith("https://") || b.uri.length > 200) return bad(reply, "Upload the image and details first.");
      const first = b.firstBuyLamports ? big(b.firstBuyLamports) : 0n;
      if (first == null) return bad(reply, "Enter a number, like 0.5.");
      const key = tickerKey(ticker);
      if ((await d.db.coin.findUnique({ where: { tickerSlot: key } })) || (await d.db.launchIntent.findFirst({ where: { tickerKey: key, expiresAt: { gt: new Date() }, creator: { not: b.creator } } }))) {
        return bad(reply, duplicateTickerMessage(ticker), 409);
      }
      if (first > 0n) {
        const sol = await d.chain.walletSol(b.creator);
        if (sol < first + 30_000_000n) return bad(reply, `You have ${(Number(sol) / 10 ** SOL_DECIMALS).toFixed(2)} SOL. Lower the first buy.`);
      }
      try {
        const r = await d.chain.launchTx({ creator: b.creator, name: b.name!.trim(), symbol: ticker, uri: b.uri, firstBuyLamports: first, slippageBps: slip(b.slippageBps, 100) });
        await d.db.launchIntent.create({ data: { mint: r.mint, tickerKey: key, creator: b.creator, metadataUri: b.uri, expiresAt: new Date(Date.now() + 120_000) } });
        const out: LaunchTxDTO = { tx: b64(r.tx), mint: r.mint, poolId: r.poolId.toBase58(), expectedOut: r.expectedTokens.toString(), minOut: r.minTokens.toString() };
        return out;
      } catch (e) {
        req.log.error({ err: e }, "launch tx build failed");
        return bad(reply, (e as Error).message.includes("1232") ? "The launch transaction is too large. Shorten the name or links." : "Couldn't build the launch transaction. Try again.", 500);
      }
    },
  );

  app.get<{ Params: { mint: string }; Querystring: { side?: string; amount?: string; slippageBps?: string } }>("/coins/:mint/quote", async (req, reply) => {
    const coin = await d.db.coin.findUnique({ where: { mint: req.params.mint } });
    if (!coin || coin.hidden) return reply.code(404).send({ error: "not_found", message: "This coin isn't on Backflow." });
    const side = req.query.side === "sell" ? "sell" : "buy";
    const amount = big(req.query.amount);
    if (!amount || amount <= 0n) return bad(reply, "Enter an amount above zero.");
    const q = await d.chain.quote(coin.poolId, side, amount, slip(req.query.slippageBps, 100));
    return q ?? reply.code(409).send({ error: "not_on_curve", message: "This coin trades on Raydium now." });
  });

  app.post<{ Body: { owner?: string; mint?: string; side?: string; amount?: string; slippageBps?: number } }>("/trade/tx", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const b = req.body ?? {};
    if (!b.owner || !looksLikeAddress(b.owner)) return bad(reply, "Connect a wallet first.");
    const coin = b.mint ? await d.db.coin.findUnique({ where: { mint: b.mint } }) : null;
    if (!coin || coin.hidden) return reply.code(404).send({ error: "not_found", message: "This coin isn't on Backflow." });
    const amount = big(b.amount);
    if (!amount || amount <= 0n) return bad(reply, "Enter an amount above zero.");
    try {
      const r = await d.chain.tradeTx(b.owner, coin.poolId, b.side === "sell" ? "sell" : "buy", amount, slip(b.slippageBps, 100));
      const out: BuiltTxDTO = { tx: b64(r.tx), expectedOut: r.expectedOut.toString(), minOut: r.minOut.toString() };
      return out;
    } catch (e) {
      return bad(reply, (e as Error).message, 409);
    }
  });

  app.post<{ Body: { creator?: string } }>("/creator/claim-tx", async (req, reply) => {
    const creator = req.body?.creator;
    if (!creator || !looksLikeAddress(creator)) return bad(reply, "Connect a wallet first.");
    const claimable = await d.chain.creatorClaimable(creator);
    if (!claimable) return bad(reply, "There are no creator fees to claim yet.");
    const tx = await d.chain.claimCreatorTx(creator);
    return { tx: b64(tx), expectedOut: claimable.toString(), minOut: "0" } satisfies BuiltTxDTO;
  });
}
