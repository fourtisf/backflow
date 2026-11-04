import { looksLikeAddress } from "@backflow/core";
import { notFound } from "next/navigation";
import { ProfilePage } from "@/components/ProfilePage";
import { decodeParam } from "@/lib/params";

export const metadata = { title: "Profile" };

export default function Page({ params }: { params: { address: string } }) {
  const address = decodeParam(params.address);
  if (!address || !looksLikeAddress(address)) notFound();
  return <ProfilePage key={address} address={address} />;
}
