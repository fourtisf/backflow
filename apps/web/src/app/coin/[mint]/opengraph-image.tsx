import { BRAND, COPY, looksLikeAddress, type CoinDetail } from "@backflow/core";
import { ImageResponse } from "next/og";

/** Share card for a coin (X, Telegram, Discord previews). Data comes from the API at request time. */
export const runtime = "nodejs";
export const alt = "Coin on Backflow";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INTERNAL_API = process.env.API_INTERNAL_URL || process.env.API_URL || "http://localhost:4000";

async function coin(mint: string): Promise<CoinDetail | null> {
  if (!looksLikeAddress(mint)) return null;
  try {
    const r = await fetch(`${INTERNAL_API}/coins/${encodeURIComponent(mint)}`, { next: { revalidate: 60 } });
    return r.ok ? ((await r.json()) as CoinDetail) : null;
  } catch {
    return null;
  }
}

const usd = (n: number | null) => (n == null ? "–" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);

export default async function Image({ params }: { params: { mint: string } }) {
  const c = await coin(params.mint);
  const paid = c ? (Number(BigInt(c.paidToHoldersLamports)) / 1e9).toFixed(2) : "0";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: "linear-gradient(135deg,#0B1236 0%,#050817 60%,#06231F 100%)", color: "#EEF1FF", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 30, color: "#45E3D3", fontWeight: 700 }}>{BRAND.name}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 76, fontWeight: 700, letterSpacing: -2 }}>{c ? c.name : "A coin that pays its holders"}</div>
          <div style={{ fontSize: 36, color: "#8D97C2" }}>{c ? `$${c.ticker}` : ""}</div>
        </div>
        <div style={{ display: "flex", gap: 56, fontSize: 30 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ color: "#8D97C2", fontSize: 24 }}>Paid back to holders</span>
            <span style={{ color: "#45E3D3", fontSize: 48, fontWeight: 700 }}>{paid} SOL</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ color: "#8D97C2", fontSize: 24 }}>Market cap</span>
            <span style={{ fontSize: 48, fontWeight: 700 }}>{c ? usd(c.mcapUsd) : "–"}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", color: "#8D97C2", fontSize: 24 }}>{COPY.holders} of every trade buys it back for holders</div>
        </div>
      </div>
    ),
    size,
  );
}
