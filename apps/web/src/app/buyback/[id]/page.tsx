import { BuybackProof } from "@/components/ProofPages";

export const metadata = { title: "Buyback proof" };

export default function Page({ params }: { params: { id: string } }) {
  return <BuybackProof id={decodeURIComponent(params.id)} />;
}
