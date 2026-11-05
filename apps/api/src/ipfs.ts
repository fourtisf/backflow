/**
 * Token image + metadata upload (SPEC §4 step 2): validate type, size and
 * dimensions, re-encode to strip EXIF, pin to IPFS through Pinata.
 *
 * Hardening (audit M2): the file type is sniffed from its first bytes (PNG,
 * JPEG, GIF, WebP only) before any decoder sees it; animated images are
 * capped by frame count and by total pixels across all frames; decoding has
 * a pixel limit and a 5 s timeout; and only one image is processed at a time
 * (sharp.concurrency(1) plus a queue), so uploads can't starve the API.
 */
import { LAUNCH_LIMITS } from "@backflow/core";
import sharp from "sharp";

sharp.concurrency(1);

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type Fmt = "png" | "jpeg" | "gif" | "webp";

export const IMAGE_LIMITS = {
  minSide: 32,
  maxSide: 4096,
  maxFrames: 60,
  /** width × frame height × frames */
  maxTotalPixels: 25_000_000,
  timeoutSeconds: 5,
  /** Uploads waiting for the image queue before new ones are turned away. */
  maxQueued: 8,
} as const;

/** Identify an image by its magic bytes. Anything else (SVG, TIFF, HEIF, …) never reaches libvips. */
export function sniffImage(b: Buffer): Fmt | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")) return "gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/* one image at a time */
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  if (waiting >= IMAGE_LIMITS.maxQueued) return Promise.reject(new UploadError("Uploads are busy right now. Try again in a minute.", 503));
  waiting++;
  const run = queue.then(job, job);
  queue = run.catch(() => {}).finally(() => waiting--);
  return run;
}

/** Validate and clean an uploaded image. Returns the re-encoded bytes (no EXIF/GPS metadata). */
export function cleanImage(buf: Buffer, mimetype: string): Promise<{ data: Buffer; mime: string; ext: string; width: number; height: number }> {
  if (!LAUNCH_LIMITS.imageTypes.includes(mimetype)) return Promise.reject(new UploadError("Use a PNG, JPG, GIF or WebP image."));
  if (buf.length > LAUNCH_LIMITS.imageMaxBytes) return Promise.reject(new UploadError("That image is over 4 MB. Choose a smaller one.", 413));
  const fmt = sniffImage(buf);
  if (!fmt) return Promise.reject(new UploadError("That file isn't a readable image. Use a PNG, JPG, GIF or WebP image."));
  return enqueue(() => processImage(buf, fmt));
}

async function processImage(buf: Buffer, fmt: Fmt) {
  const animated = fmt === "gif" || fmt === "webp";
  const input = { animated, limitInputPixels: IMAGE_LIMITS.maxTotalPixels };
  let meta: sharp.Metadata;
  try {
    // headers only (no pixel decoding), so the caps below can answer with a clear message
    meta = await sharp(buf, { animated, limitInputPixels: false }).metadata();
  } catch {
    throw new UploadError("That file isn't a readable image.");
  }
  if (meta.format !== fmt) throw new UploadError("That file isn't a readable image.");
  const width = meta.width ?? 0;
  const pages = Math.max(1, meta.pages ?? 1);
  const height = meta.pageHeight ?? meta.height ?? 0;
  if (width < IMAGE_LIMITS.minSide || height < IMAGE_LIMITS.minSide) throw new UploadError("The image is too small. Use at least 32 × 32 pixels.");
  if (width > IMAGE_LIMITS.maxSide || height > IMAGE_LIMITS.maxSide) throw new UploadError("The image is too large. Use at most 4096 × 4096 pixels.");
  if (pages > IMAGE_LIMITS.maxFrames) throw new UploadError("That animation has too many frames. Use 60 frames or fewer.");
  if (width * height * pages > IMAGE_LIMITS.maxTotalPixels) throw new UploadError("That animation is too large. Use fewer frames or a smaller size.");
  let data: Buffer;
  try {
    // sharp drops EXIF/XMP/ICC metadata unless withMetadata() is called; rotate() applies the EXIF orientation first.
    data = await sharp(buf, input).timeout({ seconds: IMAGE_LIMITS.timeoutSeconds }).rotate().toFormat(fmt).toBuffer();
  } catch {
    throw new UploadError("That image took too long to process. Use a smaller one.");
  }
  return { data, mime: fmt === "jpeg" ? "image/jpeg" : `image/${fmt}`, ext: fmt === "jpeg" ? "jpg" : fmt, width, height };
}

export interface PinataConfig {
  jwt: string;
  gateway: string;
}

async function pinata<T>(cfg: PinataConfig, path: string, body: string | FormData, json: boolean): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30_000);
  try {
    const r = await fetch(`https://api.pinata.cloud${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.jwt}`, ...(json ? { "content-type": "application/json" } : {}) },
      body,
      signal: ac.signal,
    });
    if (!r.ok) throw new UploadError(`IPFS upload failed (${r.status}). Try again in a minute.`, 502);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
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

/* ------------------------- storage on this server (D-048) ------------------------- */

/**
 * Coin images and metadata kept on this server instead of IPFS, chosen by the owner. Files are named by the
 * SHA-256 of their bytes, so a name always means the same content and can be cached forever; they're served
 * at `${baseUrl}/<sha256>.<ext>` by GET /media/:file. The directory must be backed up: the on-chain metadata
 * links can't be changed later.
 */
export interface LocalMediaConfig {
  dir: string;
  /** Public base, e.g. https://rebuy.fun/api/media */
  baseUrl: string;
}

export const MEDIA_FILE = /^[0-9a-f]{64}\.(png|jpg|gif|webp|json)$/;
export const MEDIA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", json: "application/json" };

export async function storeLocal(cfg: LocalMediaConfig, data: Buffer, ext: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { mkdir, writeFile, rename } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const name = `${createHash("sha256").update(data).digest("hex")}.${ext}`;
  if (!MEDIA_FILE.test(name)) throw new UploadError("That file type can't be stored.");
  await mkdir(cfg.dir, { recursive: true });
  const tmp = join(cfg.dir, `.${name}.${process.pid}.tmp`);
  await writeFile(tmp, data, { mode: 0o644 });
  await rename(tmp, join(cfg.dir, name)); // atomic: a reader never sees half a file
  return `${cfg.baseUrl.replace(/\/+$/, "")}/${name}`;
}
