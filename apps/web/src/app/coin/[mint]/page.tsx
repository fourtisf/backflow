import { BRAND, COPY, type CoinDetail } from "@backflow/core";
import type { Metadata } from "next";
import { CoinPage } from "@/components/CoinPage";

const INTERNAL_API = process.env.API_INTERNAL_URL || process.env.API_URL || "http://localhost:4000";

export async function generateMetadata({ params }: { params: { mint: string } }): Promise<Metadata> {
  try {
    const r = await fetch(`${INTERNAL_API}/coins/${encodeURIComponent(params.mint)}`, { next: { revalidate: 60 } });
    if (!r.ok) return { title: "Coin" };
    const c = (await r.json()) as CoinDetail;
    const description = `$${c.ticker} on ${BRAND.name}: ${COPY.holders} of every trade buys it back and pays it to holders.`;
    return { title: `${c.name} ($${c.ticker})`, description, openGraph: { title: `${c.name} ($${c.ticker})`, description }, twitter: { card: "summary_large_image" } };
  } catch {
    return { title: "Coin" };
  }
}

export default function Page({ params, searchParams }: { params: { mint: string }; searchParams: { new?: string } }) {
  return <CoinPage key={params.mint} mint={decodeURIComponent(params.mint)} fresh={searchParams.new === "1"} />;
}
