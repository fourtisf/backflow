"use client";

import { int, short, sol, tokens, type BuybackDetailDTO, type CreditRow, type PlatformStatsDTO, type RewardHistoryItem } from "@backflow/core";
import Link from "next/link";
import { API_URL, useApi } from "@/lib/api";
import { explorerTx, useExplorerLinks } from "@/lib/tx";
import { Ago, Avatar, CoinAvatar, Mcap, Spark } from "./ui";
import { useWalletAddress } from "./Wallet";

/* ------------------------------ buyback proof ------------------------------ */

export function BuybackProof({ id }: { id: string }) {
  const d = useApi<BuybackDetailDTO>(`/buybacks/${encodeURIComponent(id)}`);
  const c = useApi<{ credits: CreditRow[] }>(d.data ? `/buybacks/${encodeURIComponent(id)}/credits` : null);
  const links = useExplorerLinks();
  const me = useWalletAddress();
  if (d.error) {
    return (
      <div className="wrap">
        <div className="panel gate" style={{ margin: "60px 0" }}>
          <h2>{d.error.status === 404 ? "This buyback isn't on Backflow" : "This buyback can't load right now"}</h2>
          <p>{d.error.status === 404 ? "Check the link, or open one from the buyback ledger." : d.error.message}</p>
          <Link className="btn btn-primary" href="/rewards">
            Go to the ledger
          </Link>
        </div>
      </div>
    );
  }
  const b = d.data;
  if (!b) return <div className="wrap"><div className="panel loading-rows" style={{ margin: "60px 0" }}>Loading buyback…</div></div>;
  const total = BigInt(b.tokensBought) + BigInt(b.carriedIn);
  const credits = c.data?.credits ?? [];
  const download = (fmt: "csv" | "json") => `${API_URL}/buybacks/${encodeURIComponent(id)}/credits${fmt === "csv" ? "?format=csv" : ""}`;
  return (
    <div className="wrap" style={{ paddingBottom: 80 }}>
      <div className="page-head">
        <h1>
          Buyback of ${b.ticker}
        </h1>
        <p>
          Every holder&apos;s share of this buyback, with the numbers you need to check it yourself.
        </p>
      </div>
      <div className="rw-sum">
        <div className="panel">
          <div className="k">Spent</div>
          <div className="v num">{sol(b.solSpentLamports)} SOL</div>
          <div className="s">via {b.venue === "curve" ? "the bonding curve" : b.venue === "jupiter" ? "Jupiter" : "the Raydium pool"}</div>
        </div>
        <div className="panel">
          <div className="k">Bought</div>
          <div className="v num">{tokens(b.tokensBought)}</div>
          <div className="s">${b.ticker}, plus {tokens(b.carriedIn)} carried in</div>
        </div>
        <div className="panel">
          <div className="k">Split across</div>
          <div className="v num">{int(b.creditCount)}</div>
          <div className="s">holders, by time-weighted balance</div>
        </div>
        <div className="panel">
          <div className="k">Carried to next</div>
          <div className="v num">{tokens(b.dustCarried)}</div>
          <div className="s">rounding dust</div>
        </div>
      </div>

      <div className="sec-title">
        <h2>How to check it</h2>
      </div>
      <div className="panel panel-pad prose" style={{ maxWidth: "none", paddingBottom: 22 }}>
        <p>
          The window ran from <b>{new Date(b.windowStart).toLocaleString()}</b> to <b>{new Date(b.windowEnd).toLocaleString()}</b>. Each wallet&apos;s weight is its balance × seconds held in that window (pools and platform wallets are left out). Each wallet gets{" "}
          <b>floor(total × weight ÷ sum of weights)</b>, where total = bought + carried in = <b className="num">{tokens(total)}</b>. What rounding leaves over is carried to the next buyback.
        </p>
        <p style={{ marginTop: 10 }}>
          Check: credited <b className="num">{tokens(b.creditedTotal)}</b> + carried to next <b className="num">{tokens(b.dustCarried)}</b> = <b className="num">{tokens(BigInt(b.creditedTotal) + BigInt(b.dustCarried))}</b>.{" "}
          {b.signature && links ? (
            <a href={explorerTx(b.signature)} target="_blank" rel="noreferrer" style={{ color: "var(--peri)" }}>
              Buyback transaction
            </a>
          ) : null}
        </p>
        <div className="admin-row" style={{ marginTop: 14 }}>
          <a className="btn btn-ghost btn-sm" href={download("csv")}>
            Download CSV
          </a>
          <a className="btn btn-ghost btn-sm" href={download("json")} target="_blank" rel="noreferrer">
            Open JSON
          </a>
        </div>
      </div>

      <div className="sec-title">
        <h2>Credits</h2>
      </div>
      <div className="panel scroll-x">
        <table className="tbl">
          <thead>
            <tr>
              <th>Wallet</th>
              <th className="r hide-m">Weight</th>
              <th className="r">Credited</th>
            </tr>
          </thead>
          <tbody>
            {credits.slice(0, 200).map((r) => (
              <tr key={r.wallet} className={r.wallet === me ? "me" : undefined}>
                <td className="num">
                  {r.wallet === me ? (
                    "You"
                  ) : (
                    <Link href={`/u/${r.wallet}`} style={{ color: "var(--foam)" }}>
                      {short(r.wallet)}
                    </Link>
                  )}
                </td>
                <td className="r num hide-m">{r.weight}</td>
                <td className="r num">
                  {tokens(r.amount)} ${b.ticker}
                </td>
              </tr>
            ))}
            {!credits.length && (
              <tr>
                <td colSpan={3} className="muted">
                  {c.loading ? "Loading credits…" : b.credited ? "Nobody was eligible; everything carried to the next buyback." : "Credits are being calculated."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {credits.length > 200 && <div className="loading-rows">Showing the top 200 of {credits.length}. Download the CSV for all of them.</div>}
      </div>
    </div>
  );
}

/* ------------------------------ platform stats ----------------------------- */

export function PlatformStats() {
  const { data, error } = useApi<PlatformStatsDTO>("/stats/platform");
  const head = (
    <div className="page-head">
      <h1>Backflow in numbers</h1>
      <p>Everything here is read from the chain and our ledger, and updates as trades land.</p>
    </div>
  );
  if (!data) return <div className="wrap">{head}<div className="panel loading-rows">{error ? `– ${error.message}` : "Loading…"}</div></div>;
  const tiles: [string, string, string][] = [
    ["Paid back to holders", `${sol(data.paidToHoldersLamports)} SOL`, `${int(data.buybacks)} buybacks`],
    ["Trading volume", `${sol(data.volumeLamports)} SOL`, `${int(data.trades)} trades`],
    ["Coins launched", int(data.coins), `${int(data.graduated)} on Raydium`],
    ["Payout transfers", int(data.payoutTransfers), `${int(data.forfeitures)} forfeitures`],
  ];
  return (
    <div className="wrap" style={{ paddingBottom: 80 }}>
      {head}
      <div className="rw-sum">
        {tiles.map(([k, v, s]) => (
          <div className="panel" key={k}>
            <div className="k">{k}</div>
            <div className="v num">{v}</div>
            <div className="s">{s}</div>
          </div>
        ))}
      </div>
      <div className="sec-title">
        <h2>Most paid to holders</h2>
      </div>
      <div className="panel list">
        {data.topCoins.map((c) => (
          <Link key={c.mint} className="row" href={`/coin/${c.mint}`} style={{ gridTemplateColumns: "minmax(0,1fr) 104px 120px 120px" }}>
            <span className="coin">
              <CoinAvatar coin={c} size={36} />
              <span style={{ minWidth: 0 }}>
                <span className="nm" style={{ display: "block" }}>
                  {c.name}
                </span>
                <span className="tk">${c.ticker}</span>
              </span>
            </span>
            <span className="rsp hide-m">
              <Spark data={c.spark} w={104} h={30} />
            </span>
            <Mcap className="r num hide-m" value={c.mcapUsd} />
            <span className="r num">{sol(c.paidToHoldersLamports)} SOL</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------ reward history ----------------------------- */

const KIND: Record<RewardHistoryItem["kind"], string> = { credit: "Credited from buyback", payout: "Paid to wallet", forfeit: "Forfeited (sold before payout)" };

export function RewardHistory({ wallet }: { wallet: string }) {
  const { data, error } = useApi<{ items: RewardHistoryItem[] }>(`/wallet/${wallet}/history?limit=50`);
  const links = useExplorerLinks();
  if (!data) return <div className="loading-rows">{error ? `– ${error.message}` : "Loading history…"}</div>;
  if (!data.items.length) return <div className="empty"><b>Nothing yet</b>Credits, payouts and forfeitures show up here.</div>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>What</th>
          <th>Coin</th>
          <th className="r">Amount</th>
          <th className="r hide-m">Proof</th>
          <th className="r">When</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((i, n) => (
          <tr key={`${i.kind}-${i.at}-${n}`}>
            <td style={i.kind === "forfeit" ? { color: "var(--down)" } : i.kind === "payout" ? { color: "var(--current)" } : undefined}>{KIND[i.kind]}</td>
            <td>
              <Link className="coin-cell" href={`/coin/${i.coinMint}`}>
                <b>${i.ticker}</b>
              </Link>
            </td>
            <td className="r num">
              {i.kind === "forfeit" ? "−" : "+"}
              {tokens(i.amount)}
            </td>
            <td className="r hide-m">
              {i.buybackId ? (
                <Link href={`/buyback/${i.buybackId}`} style={{ color: "var(--peri)" }}>
                  Split
                </Link>
              ) : i.signature && links ? (
                <a href={explorerTx(i.signature)} target="_blank" rel="noreferrer" style={{ color: "var(--peri)" }}>
                  Tx
                </a>
              ) : (
                <span className="muted">–</span>
              )}
            </td>
            <td className="r muted num">
              <Ago at={i.at} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export { Avatar };
