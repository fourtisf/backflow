import Link from "next/link";

export default function NotFound() {
  return (
    <div className="wrap">
      <div className="panel gate" style={{ margin: "60px 0" }}>
        <h2>This page doesn&apos;t exist</h2>
        <p>Check the link, or go back to the coin list.</p>
        <Link className="btn btn-primary" href="/">
          Go to coins
        </Link>
      </div>
    </div>
  );
}
