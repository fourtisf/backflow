"use client";

import { short, sol, tokens, type ProfileDTO } from "@backflow/core";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { toast } from "@/lib/store";
import { RewardHistory } from "./ProofPages";
import { Avatar, Change, CoinAvatar, CurveCell, Mcap } from "./ui";
import { useWalletAddress } from "./Wallet";

export function ProfilePage({ address }: { address: string }) {
  const { data, error } = useApi<ProfileDTO>(`/wallet/${address}/profile`);
  const me = useWalletAddress();
  const head = (
    <div className="page-head">
      <h1 className="num">{me === address ? "Your profile" : short(address)}</h1>
      <p>
        Coins launched and rewards earned by this wallet.{" "}
        <button
          className="ca num"
          onClick={() =>
            navigator.clipboard?.writeText(address).then(
              () => toast("Address copied."),
              () => toast(address),
            )
          }
        >
          {short(address)} copy
        </button>
      </p>
    </div>
  );
  if (!data) return <div className="wrap">{head}<div className="panel loading-rows">{error ? `– ${error.message}` : "Loading…"}</div></div>;
  const holding = data.rewards.coins.filter((c) => BigInt(c.balance) > 0n || BigInt(c.received) > 0n);
  return (
    <div className="wrap" style={{ paddingBottom: 80 }}>
      {head}
      <div className="sec-title">
        <h2>Launched</h2>
      </div>
      <div className="panel list">
        {data.created.length ? (
          data.created.map((c) => (
            <Link key={c.mint} className="row" href={`/coin/${c.mint}`} style={{ gridTemplateColumns: "minmax(0,1fr) 110px 90px 1.2fr 110px" }}>
              <span className="coin">
                <CoinAvatar coin={c} size={36} />
                <span style={{ minWidth: 0 }}>
                  <span className="nm" style={{ display: "block" }}>
                    {c.name}
                  </span>
                  <span className="tk">${c.ticker}</span>
                </span>
              </span>
              <Mcap className="r num" value={c.mcapUsd} />
              <span className="r hide-m">
                <Change value={c.change24hPct} />
              </span>
              <span className="hide-m">
                <CurveCell coin={c} />
              </span>
              <span className="r num">{sol(c.paidToHoldersLamports)} SOL</span>
            </Link>
          ))
        ) : (
          <div className="empty">
            <b>No launches</b>This wallet hasn&apos;t launched a coin on Backflow.
          </div>
        )}
      </div>
      <div className="sec-title">
        <h2>Holding and earning</h2>
      </div>
      <div className="panel scroll-x">
        {holding.length ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>Coin</th>
                <th className="r">Holds</th>
                <th className="r hide-m">Share</th>
                <th className="r">Paid so far</th>
              </tr>
            </thead>
            <tbody>
              {holding.map((c) => (
                <tr key={c.mint}>
                  <td>
                    <Link className="coin-cell" href={`/coin/${c.mint}`}>
                      <Avatar seed={c.avatarSeed} imageUri={c.imageUri} size={26} />
                      <b>${c.ticker}</b>
                    </Link>
                  </td>
                  <td className="r num">{tokens(c.balance)}</td>
                  <td className="r num hide-m">{(c.sharePpm / 1e4).toFixed(2)}%</td>
                  <td className="r num">{tokens(c.received)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            <b>Nothing yet</b>This wallet doesn&apos;t hold any Backflow coins.
          </div>
        )}
      </div>
      <div className="sec-title">
        <h2>History</h2>
      </div>
      <div className="panel scroll-x">
        <RewardHistory wallet={address} />
      </div>
    </div>
  );
}
