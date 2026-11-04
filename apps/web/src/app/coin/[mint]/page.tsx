import { BRAND, COPY, looksLikeAddress, type CoinDetail } from "@backflow/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CoinPage } from "@/components/CoinPage";
import { decodeParam } from "@/lib/params";

/** Only a base58 address can be a coin; anything else (../, %-junk) is a 404 before any fetch (audit L4). */
const mintOf = (raw: string): string | null => {
  const m = decodeParam(raw);
  return m && looksLikeAddress(m) ? m : null;
};

const INTERNAL_API = process.env.API_INTERNAL_URL || process.env.API_URL || "http://localhost:4000";

export async function generateMetadata({ params }: { params: { mint: string } }): Promise<Metadata> {
  const mint = mintOf(params.mint);
  if (!mint) return { title: "Coin" };
  try {
    const r = await fetch(`${INTERNAL_API}/coins/${encodeURIComponent(mint)}`, { next: { revalidate: 60 } });
    if (!r.ok) return { title: "Coin" };
    const c = (await r.json()) as CoinDetail;
    const description = `$${c.ticker} on ${BRAND.name}: ${COPY.holders} of every trade buys it back and pays it to holders.`;
    return { title: `${c.name} ($${c.ticker})`, description, openGraph: { title: `${c.name} ($${c.ticker})`, description }, twitter: { card: "summary_large_image" } };
  } catch {
    return { title: "Coin" };
  }
}

export default function Page({ params, searchParams }: { params: { mint: string }; searchParams: { new?: string } }) {
  const mint = mintOf(params.mint);
  if (!mint) notFound();
  return <CoinPage key={mint} mint={mint} fresh={searchParams.new === "1"} />;
}
