/**
 * Signed-message auth with single-use server nonces (audit M1, M5, L9).
 *
 *   1. POST /auth/nonce {wallet, purpose}  -> an AuthNonce row (5 minute TTL)
 *   2. the wallet signs signInMessage(...) from @backflow/core
 *   3. a route calls verifySigned(), which rebuilds the message from this
 *      server's own domain and cluster plus the stored nonce, checks the
 *      ed25519 signature, and consumes the nonce atomically.
 *
 * Launch sessions: a verified "launch" signature is exchanged for a random
 * token that is valid for 15 minutes. Only its sha256 is stored, as an
 * AuthNonce row with purpose "launch_session" (so it survives restarts and
 * works with more than one API process). The web keeps the token in memory
 * and sends it as `x-launch-token` with the upload, /launch/metadata and
 * /launch/tx. One active session per wallet: a new one replaces the old.
 */
import { SIGN_IN_NONCE_TTL_MS, SIGN_IN_PURPOSES, looksLikeAddress, signInMessage, type SignInNonceDTO, type SignInPurpose } from "@backflow/core";
import type { PrismaClient } from "@backflow/db";
import bs58 from "bs58";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import nacl from "tweetnacl";

export const LAUNCH_SESSION_TTL_MS = 15 * 60_000;
const LAUNCH_SESSION = "launch_session";

export interface AuthDeps {
  db: PrismaClient;
  /** Host shown in the signed message, e.g. "backflow.example" (AUTH_DOMAIN, or the host of PUBLIC_SITE_URL). */
  domain: string;
  /** "devnet" | "mainnet-beta" */
  cluster: string;
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 401,
  ) {
    super(message);
  }
}

export const sha256 = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

const EXPIRED = () => new AuthError("expired", "That sign-in request expired. Try again.");

let lastPurge = 0;
/** Delete nonces and sessions that expired more than an hour ago (at most once a minute). */
async function purge(db: PrismaClient, now: Date): Promise<void> {
  if (now.getTime() - lastPurge < 60_000) return;
  lastPurge = now.getTime();
  await db.authNonce.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 3_600_000) } } }).catch(() => {});
}

export async function issueNonce(d: AuthDeps, wallet: string, purpose: SignInPurpose, now = new Date()): Promise<SignInNonceDTO> {
  await purge(d.db, now);
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(now.getTime() + SIGN_IN_NONCE_TTL_MS);
  await d.db.authNonce.create({ data: { nonce, purpose, wallet, createdAt: now, expiresAt } });
  return { nonce, purpose, domain: d.domain, cluster: d.cluster, issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString() };
}

export interface SignedBody {
  wallet?: unknown;
  nonce?: unknown;
  signature?: unknown;
}

/**
 * Checks a signed nonce and consumes it. Returns the wallet, or throws AuthError.
 * The domain, cluster and purpose come from this server, never from the request.
 */
export async function verifySigned(d: AuthDeps, body: SignedBody | undefined, purpose: SignInPurpose, now = new Date()): Promise<string> {
  const wallet = body?.wallet;
  const nonce = body?.nonce;
  const signature = body?.signature;
  if (typeof wallet !== "string" || !looksLikeAddress(wallet) || typeof nonce !== "string" || nonce.length > 64 || typeof signature !== "string" || signature.length > 128) {
    throw new AuthError("bad_request", "Sign the message in your wallet first.", 400);
  }
  const row = await d.db.authNonce.findUnique({ where: { nonce } });
  if (!row || row.purpose !== purpose || (row.wallet && row.wallet !== wallet) || row.usedAt || row.expiresAt <= now) throw EXPIRED();
  const message = signInMessage({ purpose, wallet, nonce, issuedAt: row.createdAt.toISOString(), domain: d.domain, cluster: d.cluster });
  let ok = false;
  try {
    ok = nacl.sign.detached.verify(new TextEncoder().encode(message), bs58.decode(signature), bs58.decode(wallet));
  } catch {
    ok = false;
  }
  if (!ok) throw new AuthError("bad_signature", "That signature doesn't match the wallet.");
  // single use, even under concurrent requests: only one UPDATE can flip usedAt from null
  const used = await d.db.authNonce.updateMany({ where: { nonce, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
  if (used.count !== 1) throw EXPIRED();
  return wallet;
}

/** Exchange a verified launch signature for a 15-minute launch token. */
export async function createLaunchSession(d: AuthDeps, wallet: string, now = new Date()): Promise<{ token: string; expiresAt: string }> {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + LAUNCH_SESSION_TTL_MS);
  await d.db.$transaction([
    d.db.authNonce.deleteMany({ where: { purpose: LAUNCH_SESSION, wallet } }),
    d.db.authNonce.create({ data: { nonce: sha256(token), purpose: LAUNCH_SESSION, wallet, createdAt: now, expiresAt } }),
  ]);
  return { token, expiresAt: expiresAt.toISOString() };
}

/** The wallet a launch token belongs to, or null when it is missing, unknown or expired. */
export async function launchSessionWallet(d: AuthDeps, req: FastifyRequest, now = new Date()): Promise<string | null> {
  const token = req.headers["x-launch-token"];
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const row = await d.db.authNonce.findUnique({ where: { nonce: sha256(token) } });
  if (!row || row.purpose !== LAUNCH_SESSION || !row.wallet || row.usedAt || row.expiresAt <= now) return null;
  return row.wallet;
}

const NONCE_SCHEMA = {
  body: {
    type: "object",
    properties: { wallet: { type: "string", maxLength: 64 }, purpose: { type: "string", maxLength: 16 } },
  },
} as const;

export const SIGNED_BODY_SCHEMA = {
  body: {
    type: "object",
    properties: { wallet: { type: "string", maxLength: 64 }, nonce: { type: "string", maxLength: 64 }, signature: { type: "string", maxLength: 128 } },
  },
} as const;

export async function registerAuth(app: FastifyInstance, d: AuthDeps): Promise<void> {
  app.post<{ Body: { wallet?: string; purpose?: string } }>("/auth/nonce", { schema: NONCE_SCHEMA, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { wallet, purpose } = req.body ?? {};
    if (!wallet || !looksLikeAddress(wallet)) return reply.code(400).send({ error: "bad_request", message: "Connect a wallet first." });
    if (!(SIGN_IN_PURPOSES as readonly string[]).includes(purpose ?? "")) return reply.code(400).send({ error: "bad_request", message: "Unknown sign-in purpose." });
    return issueNonce(d, wallet, purpose as SignInPurpose);
  });
}
