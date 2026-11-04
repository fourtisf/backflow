import { BRAND } from "@backflow/core";

export const metadata = { title: "Privacy" };

/** Draft privacy notice for owner and legal review before mainnet. */
export default function PrivacyPage() {
  const b = BRAND.name;
  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Privacy</h1>
        <p>Draft. What {b} stores and why.</p>
      </div>
      <div className="prose">
        <h2>No accounts</h2>
        <p>{b} has no sign-up. You connect a Solana wallet; we see its public address, as everyone on the blockchain can.</p>
        <h2>What we store</h2>
        <ul>
          <li>Public blockchain data about {b} coins: trades, balances, buybacks and payouts. This is already public on Solana.</li>
          <li>Images and details you upload when you launch a coin. They are published to IPFS and can&apos;t be deleted from it.</li>
          <li>Reports you send about a coin, with your wallet address if you are connected, or your IP address if not.</li>
          <li>If you turn on Telegram payout alerts: your Telegram chat id, linked to your wallet address. Send /stop to the bot to remove it.</li>
          <li>Server logs (IP address, time, page) for security and rate limiting, kept for up to 30 days.</li>
        </ul>
        <h2>What stays in your browser</h2>
        <p>Your watchlist and slippage setting are saved in your browser only. We never see them.</p>
        <h2>What we don&apos;t do</h2>
        <p>We don&apos;t sell data, run ad trackers, or ask for your keys. We will never ask for your seed phrase.</p>
      </div>
    </div>
  );
}
