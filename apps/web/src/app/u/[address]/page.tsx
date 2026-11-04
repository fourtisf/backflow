import { ProfilePage } from "@/components/ProfilePage";

export const metadata = { title: "Profile" };

export default function Page({ params }: { params: { address: string } }) {
  return <ProfilePage key={params.address} address={decodeURIComponent(params.address)} />;
}
