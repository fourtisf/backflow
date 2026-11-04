/** Deterministic helpers ported from prototype/backflow.html. */

export type Rng = () => number;

export function mulberry(seed: number): Rng {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58(rnd: Rng, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += B58[Math.floor(rnd() * 58)];
  return s;
}

export class Dice {
  constructor(readonly rnd: Rng) {}
  r(a: number, b: number): number {
    return a + (b - a) * this.rnd();
  }
  ri(a: number, b: number): number {
    return Math.floor(this.r(a, b + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.rnd() * arr.length)] as T;
  }
  addr(n = 44): string {
    return b58(this.rnd, n);
  }
  /** A 64-byte signature in base58 is ~88 chars. */
  sig(): string {
    return b58(this.rnd, 88);
  }
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
