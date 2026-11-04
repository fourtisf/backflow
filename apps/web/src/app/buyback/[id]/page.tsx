import { notFound } from "next/navigation";
import { BuybackProof } from "@/components/ProofPages";
import { decodeParam } from "@/lib/params";

export const metadata = { title: "Buyback proof" };

export default function Page({ params }: { params: { id: string } }) {
  const id = decodeParam(params.id);
  if (!id) notFound();
  return <BuybackProof id={id} />;
}
