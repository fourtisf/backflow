/**
 * Token image + metadata upload (SPEC §4 step 2): validate type, size and
 * dimensions, re-encode to strip EXIF, pin to IPFS through Pinata.
 */
import { LAUNCH_LIMITS } from "@backflow/core";
import sharp from "sharp";

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const FORMATS: Record<string, "png" | "jpeg" | "gif" | "webp"> = { png: "png", jpeg: "jpeg", jpg: "jpeg", gif: "gif", webp: "webp" };

/** Validate and clean an uploaded image. Returns the re-encoded bytes (no EXIF/GPS metadata). */
export async function cleanImage(buf: Buffer, mimetype: string): Promise<{ data: Buffer; mime: string; ext: string; width: number; height: number }> {
  if (!LAUNCH_LIMITS.imageTypes.includes(mimetype)) throw new UploadError("Use a PNG, JPG, GIF or WebP image.");
  if (buf.length > LAUNCH_LIMITS.imageMaxBytes) throw new UploadError("That image is over 4 MB. Choose a smaller one.", 413);
  let meta: sharp.Metadata;
  try {
    meta = await sharp(buf, { animated: true }).metadata();
  } catch {
    throw new UploadError("That file isn't a readable image.");
  }
  const fmt = FORMATS[meta.format ?? ""];
  if (!fmt) throw new UploadError("Use a PNG, JPG, GIF or WebP image.");
  const width = meta.width ?? 0;
  const height = meta.pageHeight ?? meta.height ?? 0;
  if (width < 32 || height < 32) throw new UploadError("The image is too small. Use at least 32 × 32 pixels.");
  if (width > 4096 || height > 4096) throw new UploadError("The image is too large. Use at most 4096 × 4096 pixels.");
  const animated = fmt === "gif" || fmt === "webp";
  // sharp drops EXIF/XMP/ICC metadata unless withMetadata() is called; rotate() applies the EXIF orientation first.
  const data = await sharp(buf, { animated }).rotate().toFormat(fmt).toBuffer();
  return { data, mime: fmt === "jpeg" ? "image/jpeg" : `image/${fmt}`, ext: fmt === "jpeg" ? "jpg" : fmt, width, height };
}

export interface PinataConfig {
  jwt: string;
  gateway: string;
}

async function pinata<T>(cfg: PinataConfig, path: string, body: string | FormData, json: boolean): Promise<T> {
  const r = await fetch(`https://api.pinata.cloud${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.jwt}`, ...(json ? { "content-type": "application/json" } : {}) },
    body,
  });
  if (!r.ok) throw new UploadError(`IPFS upload failed (${r.status}). Try again in a minute.`, 502);
  return (await r.json()) as T;
}

export async function pinFile(cfg: PinataConfig, data: Buffer, name: string, mime: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)], { type: mime }), name);
  form.append("pinataMetadata", JSON.stringify({ name }));
  const r = await pinata<{ IpfsHash: string }>(cfg, "/pinning/pinFileToIPFS", form, false);
  return r.IpfsHash;
}

export async function pinJson(cfg: PinataConfig, content: unknown, name: string): Promise<string> {
  const r = await pinata<{ IpfsHash: string }>(cfg, "/pinning/pinJSONToIPFS", JSON.stringify({ pinataContent: content, pinataMetadata: { name } }), true);
  return r.IpfsHash;
}

export const gatewayUrl = (cfg: PinataConfig, cid: string) => `${cfg.gateway.replace(/\/?$/, "/")}${cid}`;
