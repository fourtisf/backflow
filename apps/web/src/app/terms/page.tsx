import { BRAND, COPY } from "@backflow/core";

export const metadata = { title: "Terms" };

/** Draft terms for owner review before mainnet. Not legal advice. */
export default function TermsPage() {
  const b = BRAND.name;
  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Terms of use</h1>
        <p>Draft. Read these before you launch or trade a coin on {b}.</p>
      </div>
      <div className="prose">
        <h2>What {b} is</h2>
        <p>
          {b} is a website for launching and trading coins on Raydium LaunchLab, a Solana program run by Raydium. {b} does not hold your funds. You sign every launch and trade in
          your own wallet.
        </p>
        <h2>Risks</h2>
        <ul>
          <li>{b} has not been audited. Software can have bugs that lose money.</li>
          <li>Coins launched here are speculative. Most go to zero. Only use money you can afford to lose.</li>
          <li>Anyone can launch a coin. A coin being listed is not an endorsement.</li>
          <li>Solana transactions are final. A mistaken transaction can&apos;t be reversed.</li>
        </ul>
        <h2>Fees and rewards</h2>
        <p>
          Every trade on the bonding curve pays {COPY.total}. {COPY.holders} of trade volume is used to buy the coin back and is paid to eligible holders; the rest goes to the
          platform, the creator and Raydium. Rewards are not guaranteed. They depend on trading volume, prices and the rules on the How it works page, including forfeiture when
          you sell before a payout and a minimum payout size.
        </p>
        <h2>Rules may change</h2>
        <p>We may change fees, thresholds, payout timing and these terms. Changes apply from the time they are posted.</p>
        <h2>Your responsibilities</h2>
        <p>You are responsible for the coins you launch, the content you upload, and following the laws that apply to you. We may hide coins or content from the site.</p>
      </div>
    </div>
  );
}
