"use client";

import { signInMessage, type SignInNonceDTO, type SignInPurpose } from "@backflow/core";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { apiPost } from "./tx";

export const NO_SIGN_MESSAGE = "This wallet can't sign messages. Use Phantom, Solflare or Backpack.";

export interface SignedNonce {
  wallet: string;
  nonce: string;
  signature: string;
}

/**
 * Signed-message sign-in (audit M1, M5, L9): the API issues a single-use nonce, the wallet signs a
 * readable message naming this site, the cluster and the purpose, and the API checks it once.
 * Throws plain-copy errors; a cancelled prompt says so.
 */
export async function signNonce(wallet: Pick<WalletContextState, "publicKey" | "signMessage">, purpose: SignInPurpose): Promise<SignedNonce> {
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  if (!wallet.signMessage) throw new Error(NO_SIGN_MESSAGE);
  const address = wallet.publicKey.toBase58();
  const n = await apiPost<SignInNonceDTO>("/auth/nonce", { wallet: address, purpose });
  const message = signInMessage({ purpose, wallet: address, nonce: n.nonce, issuedAt: n.issuedAt, domain: n.domain, cluster: n.cluster });
  let sig: Uint8Array;
  try {
    sig = await wallet.signMessage(new TextEncoder().encode(message));
  } catch {
    throw new Error("You cancelled the signature in your wallet. Nothing was sent.");
  }
  return { wallet: address, nonce: n.nonce, signature: bs58.encode(sig) };
}
