"use client";

import { BRAND, CURVE, int, short, sol, tokens, usd, type BuybackDTO, type CreatorCoin, type WalletCoinRewards } from "@backflow/core";
import Link from "next/link";
import { useLive, useRewards, useUi, toast } from "@/lib/store";
import { Ago, Avatar, PayoutCountdown, tokensCompact } from "./ui";
import { useWalletAddress } from "./Wallet";

const UNIT = 10 ** CURVE.decimals;
const valueUsd = (amount: string, price: number | null) => (price == null ? null : (Number(BigInt(amount)) / UNIT) * price);

function explorerTx(sig: string): string {
  const cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "devnet";
  return `https://solscan.io/tx/${sig}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`}`;
}

function Ledger() {
  const ledger = useLive((s) => s.ledger);
  const loaded = useLive((s) => s.ledgerLoaded);
  const apiError = useLive((s) => s.apiError);
  if (!ledger.length) {
    return <div className="loading-rows">{apiError ? `– ${apiError}` : loaded ? "No buybacks yet." : "Loading buybacks…"}</div>;
  }
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Coin</th>
          <th className="r">Spent</th>
          <th className="r">Bought</th>
          <th className="r hide-m">Split across</th>
          <th className="r hide-m">Transaction</th>
          <th className="r">Time</th>
        </tr>
      </thead>
      <tbody>
        {ledger.slice(0, 20).map((e: BuybackDTO) => (
          <tr key={e.id}>
            <td>
              <Link className="coin-cell" href={`/coin/${e.coinMint}`}>
                <Avatar seed={e.avatarSeed} imageUri={e.imageUri} size={26} />
                <b>${e.ticker}</b>
              </Link>
            </td>
            <td className="r num">{sol(e.solSpentLamports)} SOL</td>
            <td className="r num">{tokensCompact(e.tokensBought)}</td>
            <td className="r num hide-m">{int(e.holderCount)} holders</td>
            <td className="r hide-m">
              {e.signature ? (
                <a className="num" href={explorerTx(e.signature)} target="_blank" rel="noreferrer">
                  {short(e.signature)}
                </a>
              ) : (
                <span className="muted">{e.status}</span>
              )}
            </td>
            <td className="r muted num">
              <Ago at={e.createdAt} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Summary({ coins }: { coins: WalletCoinRewards[] }) {
  let val = 0;
  let pend = 0;
  let recv = 0;
  let n = 0;
  let priced = true;
  for (const c of coins) {
    if (c.priceUsd == null) priced = false;
    if (BigInt(c.balance) > 0n) n++;
    val += valueUsd(c.balance, c.priceUsd) ?? 0;
    pend += valueUsd(c.pending, c.priceUsd) ?? 0;
    recv += valueUsd(c.received, c.priceUsd) ?? 0;
  }
  const show = (v: number) => (priced ? usd(v) : "–");
  return (
    <div className="rw-sum">
      <div className="panel">
        <div className="k">Paid to you so far</div>
        <div className="v num" style={{ color: "var(--current)" }}>
          {show(recv)}
        </div>
        <div className="s">At today&apos;s prices</div>
      </div>
      <div className="panel">
        <div className="k">Waiting for payout</div>
        <div className="v num">{show(pend)}</div>
        <div className="s">
          Lands in{" "}
          <span className="num">
            <PayoutCountdown />
          </span>
        </div>
      </div>
      <div className="panel">
        <div className="k">Holdings value</div>
        <div className="v num">{show(val)}</div>
        <div className="s">
          Across {n} {n === 1 ? "coin" : "coins"}
        </div>
      </div>
      <div className="panel">
        <div className="k">Coins earning</div>
        <div className="v num">{n}</div>
        <div className="s">Sell one and its pending is forfeited</div>
      </div>
    </div>
  );
}

function ByCoin({ coins }: { coins: WalletCoinRewards[] }) {
  const rows = coins.filter((c) => BigInt(c.balance) > 0n || BigInt(c.pending) > 0n || BigInt(c.received) > 0n);
  if (!rows.length) {
    return (
      <div className="empty">
        <b>No coins yet</b>Buy any {BRAND.name} coin to start earning from its buybacks.{" "}
        <Link href="/" style={{ color: "var(--current)" }}>
          Browse coins
        </Link>
      </div>
    );
  }
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Coin</th>
          <th className="r">You hold</th>
          <th className="r hide-m">Share</th>
          <th className="r">Waiting</th>
          <th className="r hide-m">Paid so far</th>
          <th className="r hide-m">Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.mint}>
            <td>
              <Link className="coin-cell" href={`/coin/${c.mint}`}>
                <Avatar seed={c.avatarSeed} imageUri={c.imageUri} size={28} />
                <b>${c.ticker}</b>
              </Link>
            </td>
            <td className="r num">{tokens(c.balance)}</td>
            <td className="r num hide-m">{(c.sharePpm / 1e4).toFixed(2)}%</td>
            <td className="r num" style={{ color: "var(--current)" }}>
              +{tokens(c.pending)}
            </td>
            <td className="r num hide-m">{tokens(c.received)}</td>
            <td className="r num hide-m">{usd(valueUsd(c.balance, c.priceUsd))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Creator({ coins }: { coins: CreatorCoin[] }) {
  if (!coins.length) {
    return (
      <div className="empty">
        <b>No launches yet</b>Coins you launch show up here with the creator fees you can claim.{" "}
        <Link href="/launch" style={{ color: "var(--current)" }}>
          Launch a coin
        </Link>
      </div>
    );
  }
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Coin</th>
          <th className="r hide-m">Earned</th>
          <th className="r">Claimable</th>
          <th className="r">
            <span className="sr">Claim</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {coins.map((c) => (
          <tr key={c.mint}>
            <td>
              <Link className="coin-cell" href={`/coin/${c.mint}`}>
                <Avatar seed={c.avatarSeed} imageUri={c.imageUri} size={28} />
                <b>${c.ticker}</b>
              </Link>
            </td>
            <td className="r num hide-m">{sol(c.earnedLamports)} SOL</td>
            <td className="r num" style={{ color: "var(--rose)" }}>
              {sol(c.claimableLamports)} SOL
            </td>
            <td className="r">
              <button
                className="btn btn-ghost creator-claim"
                disabled={BigInt(c.claimableLamports) <= 0n}
                onClick={() => toast("Claiming creator fees isn't live yet in this build. Nothing was sent.")}
              >
                Claim creator fees
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RewardsPage() {
  const addr = useWalletAddress();
  const openWallet = useUi((s) => s.openWalletModal);
  const { data, error, loading } = useRewards();
  const head = (
    <div className="page-head">
      <h1>Your rewards</h1>
      <p>Coins bought back for you, across every {BRAND.name} coin you hold.</p>
    </div>
  );
  const ledger = (
    <>
      <div className="sec-title">
        <h2>All buybacks</h2>
        <span className="live">
          <i></i>Live
        </span>
      </div>
      <div className="panel scroll-x">
        <Ledger />
      </div>
      <div style={{ height: 70 }} />
    </>
  );
  if (!addr) {
    return (
      <div className="wrap">
        {head}
        <div className="panel gate">
          <h2>Connect a wallet to see what you&apos;ve earned</h2>
          <p>Hold any {BRAND.name} coin and you get a share of every buyback, paid in that coin.</p>
          <button className="btn btn-primary btn-lg" onClick={openWallet}>
            Connect wallet
          </button>
        </div>
        {ledger}
      </div>
    );
  }
  return (
    <div className="wrap">
      {head}
      {data ? (
        <>
          <Summary coins={data.coins} />
          <div className="sec-title">
            <h2>By coin</h2>
          </div>
          <div className="panel scroll-x">
            <ByCoin coins={data.coins} />
          </div>
          <div className="sec-title">
            <h2>Your launches</h2>
          </div>
          <div className="panel scroll-x">
            <Creator coins={data.creatorCoins} />
          </div>
        </>
      ) : (
        <div className="panel loading-rows">{error ? `– ${error}` : loading ? "Loading your rewards…" : "–"}</div>
      )}
      {ledger}
    </div>
  );
}
