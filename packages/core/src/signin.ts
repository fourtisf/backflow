/**
 * Signed-message sign-in (launch, Telegram link). There is no admin sign-in on
 * the web: admin tasks run as CLI commands on the server (`pnpm admin`). The API issues a
 * single-use nonce (POST /auth/nonce), the wallet signs the text below, and the
 * API rebuilds the same text from its own domain, cluster and the stored nonce
 * before checking the signature. A signature is therefore bound to one site,
 * one cluster, one purpose and one request, and cannot be replayed.
 */

import { BRAND } from "./brand";

export type SignInPurpose = "launch" | "telegram";

export const SIGN_IN_PURPOSES: readonly SignInPurpose[] = ["launch", "telegram"];

/** How long a nonce may be signed and used after it was issued. */
export const SIGN_IN_NONCE_TTL_MS = 5 * 60_000;

export interface SignInFields {
  purpose: SignInPurpose;
  /** Base58 wallet address that signs. */
  wallet: string;
  /** Server nonce from POST /auth/nonce. */
  nonce: string;
  /** ISO time the server issued the nonce (returned with it). */
  issuedAt: string;
  /** Host of the site the user is on, e.g. "backflow.example". */
  domain: string;
  /** "devnet" or "mainnet-beta". */
  cluster: string;
}

const STATEMENT: Record<SignInPurpose, string> = {
  launch: `Confirm that you want to launch a coin on ${BRAND.name}.`,
  telegram: `Link ${BRAND.name} payout alerts to your Telegram chat.`,
};

/**
 * The exact text a wallet signs: plain and human readable, with the site first so people can spot a
 * lookalike. It deliberately does NOT start with "<domain> wants you to sign in with your Solana
 * account:": wallets such as Phantom parse that line as Sign In With Solana and refuse messages whose
 * other lines don't follow that standard exactly, so the launch signature never happened (D-054).
 */
export function signInMessage(f: SignInFields): string {
  return [
    `${BRAND.name} · ${f.domain}`,
    STATEMENT[f.purpose],
    "This costs nothing and sends nothing on chain.",
    "",
    `Wallet: ${f.wallet}`,
    `Purpose: ${f.purpose}`,
    `Domain: ${f.domain}`,
    `Cluster: ${f.cluster}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
  ].join("\n");
}

/** What POST /auth/nonce returns. */
export interface SignInNonceDTO {
  nonce: string;
  purpose: SignInPurpose;
  domain: string;
  cluster: string;
  issuedAt: string;
  expiresAt: string;
}
