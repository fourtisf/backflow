/**
 * Encryption for pre-ground vanity mint keys at rest (AES-256-GCM, key from VANITY_KEY, 32 bytes hex).
 * The key never lives in the database; losing it only loses unused vanity keys.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("VANITY_KEY must be 32 bytes of hex (64 characters).");
  return Buffer.from(hex, "hex");
}

export function encryptSecret(secret: Uint8Array, hexKey = process.env.VANITY_KEY): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(hexKey), iv);
  const enc = Buffer.concat([c.update(secret), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decryptSecret(blob: string, hexKey = process.env.VANITY_KEY): Uint8Array {
  const [iv, tag, enc] = blob.split(".");
  if (!iv || !tag || !enc) throw new Error("bad encrypted secret");
  const d = createDecipheriv("aes-256-gcm", key(hexKey), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return new Uint8Array(Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]));
}
