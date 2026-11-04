import { CoinPage } from "@/components/CoinPage";

export default function Page({ params }: { params: { mint: string } }) {
  return <CoinPage key={params.mint} mint={decodeURIComponent(params.mint)} />;
}
