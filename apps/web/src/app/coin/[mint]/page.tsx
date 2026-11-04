import { CoinPage } from "@/components/CoinPage";

export default function Page({ params, searchParams }: { params: { mint: string }; searchParams: { new?: string } }) {
  return <CoinPage key={params.mint} mint={decodeURIComponent(params.mint)} fresh={searchParams.new === "1"} />;
}
