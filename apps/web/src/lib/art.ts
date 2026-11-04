/**
 * Procedural coin avatars ("critters"), ported from prototype/backflow.html.
 * Used when a coin has no image. Output depends only on the numeric seed, so
 * it is safe to inject as markup.
 */

function mulberry(seed: number) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const BG = [["#1B2A5C", "#3550B8"], ["#123A48", "#1E8A86"], ["#3A1E56", "#7C45B0"], ["#4C1C36", "#B04276"], ["#173A2C", "#2E9563"], ["#2A2352", "#5B4BC8"], ["#12324D", "#2A86C2"], ["#3B2A1A", "#B06A35"]] as const;
const BODY = ["#45E3D3", "#8F9CFF", "#FF8DB3", "#FFD36E", "#A6E86F", "#FFA86B", "#C9B9FF", "#7FD8FF", "#FF7B7B"] as const;

const cache = new Map<number, string>();

export function art(seedIn: number): string {
  const seed = seedIn >>> 0;
  const hit = cache.get(seed);
  if (hit) return hit;
  const r = mulberry(seed);
  const p = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)] as T;
  const bg = p(BG);
  const body = p(BODY);
  let other: string = p(BODY);
  if (other === body) other = BODY[(BODY.indexOf(body) + 3) % BODY.length]!;
  const shape = Math.floor(r() * 4), eyes = Math.floor(r() * 5), mouth = Math.floor(r() * 4), acc = Math.floor(r() * 6), blush = r() > 0.45;
  const ink = "#0A1124";
  const gid = "g" + seed.toString(36);
  let s = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><radialGradient id="${gid}" cx="30%" cy="20%" r="95%"><stop offset="0" stop-color="${bg[1]}"/><stop offset="1" stop-color="${bg[0]}"/></radialGradient></defs><rect width="100" height="100" fill="url(#${gid})"/>`;
  s += `<ellipse cx="50" cy="91" rx="26" ry="4.5" fill="#000" opacity=".22"/>`;
  if (acc === 1) s += `<path d="M50 30V15" stroke="${ink}" stroke-width="3" stroke-linecap="round"/><circle cx="50" cy="13" r="5.5" fill="${other}"/>`;
  if (acc === 4) s += `<path d="M30 36 25 18l15 11ZM70 36l5-18-15 11Z" fill="${other}"/>`;
  if (acc === 2) s += `<path d="M50 30c0-7 2-11 6-14" stroke="#2E9563" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M56 16c6-5 13-4 15 0-5 4-11 5-15 0Z" fill="#A6E86F"/><path d="M52 22c-6-5-12-4-14 0 5 4 10 5 14 0Z" fill="#7BD455"/>`;
  const bodies = [
    `<circle cx="50" cy="58" r="29" fill="${body}"/>`,
    `<rect x="21" y="30" width="58" height="58" rx="22" fill="${body}"/>`,
    `<path d="M50 27c19 0 31 12 31 31S70 88 50 88 19 78 19 60s12-33 31-33Z" fill="${body}"/>`,
    `<path d="M22 88V56a28 28 0 0 1 56 0v32l-9.3-6-9.3 6-9.4-6-9.3 6-9.4-6Z" fill="${body}"/>`,
  ];
  s += bodies[shape];
  s += `<ellipse cx="38" cy="42" rx="9" ry="5" fill="#fff" opacity=".22" transform="rotate(-25 38 42)"/>`;
  const ey = 55;
  if (eyes === 0) s += `<circle cx="40" cy="${ey}" r="4.6" fill="${ink}"/><circle cx="60" cy="${ey}" r="4.6" fill="${ink}"/><circle cx="41.5" cy="${ey - 1.6}" r="1.4" fill="#fff"/><circle cx="61.5" cy="${ey - 1.6}" r="1.4" fill="#fff"/>`;
  if (eyes === 1) s += `<circle cx="39" cy="${ey}" r="8.5" fill="#fff"/><circle cx="61" cy="${ey}" r="8.5" fill="#fff"/><circle cx="41" cy="${ey + 1}" r="4.4" fill="${ink}"/><circle cx="63" cy="${ey + 1}" r="4.4" fill="${ink}"/><circle cx="42.4" cy="${ey - 0.6}" r="1.4" fill="#fff"/><circle cx="64.4" cy="${ey - 0.6}" r="1.4" fill="#fff"/>`;
  if (eyes === 2) s += `<path d="M34 ${ey}q6 5 12 0M54 ${ey}q6 5 12 0" stroke="${ink}" stroke-width="3.2" fill="none" stroke-linecap="round"/>`;
  if (eyes === 3) s += `<path d="M27 ${ey - 7}h46v4c0 5-4 9-9 9h-6c-3 0-5-3-6-5h-4c-1 2-3 5-6 5h-6c-5 0-9-4-9-9Z" fill="${ink}"/><path d="M33 ${ey - 4}l6 0" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".7"/>`;
  if (eyes === 4) s += `<circle cx="50" cy="${ey - 1}" r="12" fill="#fff"/><circle cx="52" cy="${ey}" r="6" fill="${ink}"/><circle cx="54" cy="${ey - 2}" r="2" fill="#fff"/>`;
  if (blush && eyes !== 3) s += `<ellipse cx="30" cy="66" rx="5" ry="3" fill="#FF6F9C" opacity=".45"/><ellipse cx="70" cy="66" rx="5" ry="3" fill="#FF6F9C" opacity=".45"/>`;
  const my = 70;
  if (mouth === 0) s += `<path d="M42 ${my - 2}q8 8 16 0" stroke="${ink}" stroke-width="3.2" fill="none" stroke-linecap="round"/>`;
  if (mouth === 1) s += `<ellipse cx="50" cy="${my}" rx="4.5" ry="5.5" fill="${ink}"/><ellipse cx="50" cy="${my + 2.5}" rx="3" ry="2" fill="#FF6F9C"/>`;
  if (mouth === 2) s += `<path d="M43 ${my}h14" stroke="${ink}" stroke-width="3.2" stroke-linecap="round"/>`;
  if (mouth === 3) s += `<path d="M40 ${my - 3}q10 11 20 0Z" fill="${ink}"/><rect x="47" y="${my - 3}" width="6" height="4" rx="1" fill="#fff"/>`;
  if (acc === 3) s += `<path d="M27 37a23 15 0 0 1 46 0Z" fill="${other}"/><path d="M50 37h30" stroke="${other}" stroke-width="5" stroke-linecap="round"/><circle cx="50" cy="22.5" r="3" fill="${ink}" opacity=".35"/>`;
  if (acc === 5) s += `<path d="M34 34 37 19l7 9 6-12 6 12 7-9 3 15Z" fill="#FFD36E" stroke="${ink}" stroke-width="1.4" stroke-linejoin="round"/>`;
  s += `</svg>`;
  cache.set(seed, s);
  return s;
}
