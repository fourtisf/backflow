"use client";

import { BUYBACK, int, minBig, sol, solFixed, type BoardTab, type CoinRow } from "@backflow/core";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/api";
import { useReducedMotion } from "@/lib/hooks";
import { useLive } from "@/lib/store";
import { FlowCanvas } from "./FlowCanvas";
import { Icon } from "./Icon";
import { Tabs } from "./Tabs";
import { useFeeCopy } from "@/lib/tx";
import { Ago, Avatar, Change, CoinAvatar, CurveCell, Dash, FeeBar, FeeLegend, Mcap, PayoutCountdown, Ring, Spark, tokensCompact, vaultRatio } from "./ui";

const TH = BUYBACK.thresholdLamports;
const TABS: [BoardTab, string][] = [
  ["trending", "Trending"],
  ["new", "New"],
  ["near", "Near graduation"],
  ["raydium", "On Raydium"],
];

function byVolume(coins: Record<string, CoinRow>): CoinRow[] {
  return Object.values(coins).sort((a, b) => (b.vol24hUsd ?? 0) - (a.vol24hUsd ?? 0));
}

function Hero() {
  const stats = useLive((s) => s.stats);
  const apiError = useLive((s) => s.apiError);
  const coins = useLive((s) => s.coins);
  const ledger = useLive((s) => s.ledger);
  const hc = useMemo(() => byVolume(coins)[0] ?? null, [coins]);
  const last = ledger[0];
  const vault = hc ? vaultRatio(hc, TH) : 0;
  const reduced = useReducedMotion();
  const fee = useFeeCopy();

  return (
    <section className="wrap hero">
      <div>
        <Link className="pill-live" href="/rewards">
          <i></i>
          <span>
            <b className="num">{stats ? `${sol(stats.totalPaidLamports)} SOL` : "–"}</b> paid back to holders
            {!stats && apiError ? <span className="dash-reason">{apiError}</span> : null}
          </span>
        </Link>
        <h1 className="display">Trade fees that flow back to holders.</h1>
        <p className="lead">
          Launch a coin on Solana. Every buy and sell pays <b>{fee.total}</b>, and <b>{fee.holders} of each trade</b> buys the coin back and pays it to the people holding it.
        </p>
        <div className="hero-cta">
          <Link className="btn btn-primary btn-lg" href="/launch">
            Launch a coin
          </Link>
          <button className="btn btn-ghost btn-lg" onClick={() => document.getElementById("coins")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" })}>
            Explore coins
          </button>
        </div>
        <div className="feesplit">
          <div className="feesplit-top">
            <span>Where each trade&apos;s fee goes</span>
            <b className="num">{fee.total}</b>
          </div>
          <FeeBar />
          <FeeLegend />
        </div>
      </div>
      <div className="hero-side">
        <div className="hero-visual">
          <FlowCanvas mint={hc?.mint ?? null} value={vault} />
          <div className="core">
            <div className="core-in">
              {hc ? (
                <Link className="coinchip" href={`/coin/${hc.mint}`}>
                  <CoinAvatar coin={hc} size={26} round />${hc.ticker}
                </Link>
              ) : (
                <span className="coinchip">–</span>
              )}
              <div className="core-num num">
                <span>{hc ? solFixed(minBig(BigInt(hc.buybackBudgetLamports), TH), 2) : "–"}</span>
                <small>/ {solFixed(TH, 2)} SOL</small>
              </div>
              <div className="core-cap">collected toward the next buyback</div>
            </div>
          </div>
        </div>
        <div className="float f1">
          <div className="k">Next payout to wallets</div>
          <div className="v num">
            <PayoutCountdown />
          </div>
        </div>
        <div className="float f2">
          {last ? (
            <>
              <Avatar seed={last.avatarSeed} imageUri={last.imageUri} size={36} />
              <div>
                <div>
                  <b className="num">
                    +{tokensCompact(last.tokensBought)} ${last.ticker}
                  </b>
                </div>
                <div className="t">
                  bought back for {int(last.holderCount)} holders,{" "}
                  <span className="num">
                    <Ago at={last.createdAt} />
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="t">No buybacks yet.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function FCard({ coin }: { coin: CoinRow }) {
  return (
    <Link className="panel fcard" href={`/coin/${coin.mint}`}>
      <div className="fc-top">
        <CoinAvatar coin={coin} size={46} />
        <div style={{ minWidth: 0 }}>
          <div className="nm">{coin.name}</div>
          <div className="tk">${coin.ticker}</div>
        </div>
        <Ring mint={coin.mint} value={vaultRatio(coin, TH)} size={34} stroke={12} />
      </div>
      <div className="fc-mid">
        <Mcap className="fc-mc num" value={coin.mcapUsd} />
        <Change value={coin.change24hPct} />
      </div>
      <div className="fc-spark">
        <Spark data={coin.spark} w={320} h={64} />
      </div>
      <div className="fc-foot">
        <span>Paid to holders</span>
        <b className="num">{sol(coin.paidToHoldersLamports)} SOL</b>
      </div>
    </Link>
  );
}

function Trending() {
  const coins = useLive((s) => s.coins);
  const feat = useMemo(() => byVolume(coins).slice(0, 3), [coins]);
  return (
    <section className="wrap sec" aria-label="Trending coins">
      <div className="sec-head">
        <div>
          <h2>Trending now</h2>
          <p>Most traded in the last 24 hours.</p>
        </div>
      </div>
      <div className="feat">
        {feat.length ? feat.map((c) => <FCard key={c.mint} coin={c} />) : <div className="panel loading-rows" style={{ gridColumn: "1/-1" }}>Loading coins…</div>}
      </div>
    </section>
  );
}

function Row({ mint }: { mint: string }) {
  const c = useLive((s) => s.coins[mint]);
  if (!c) return null;
  return (
    <Link className="row" href={`/coin/${c.mint}`}>
      <span className="coin">
        <CoinAvatar coin={c} size={42} />
        <span style={{ minWidth: 0 }}>
          <span className="nm" style={{ display: "block" }}>
            {c.name}
          </span>
          <span className="tk">
            ${c.ticker}{" "}
            <span style={{ color: "var(--mist-2)" }}>
              <Ago at={c.createdAt} />
            </span>
          </span>
        </span>
      </span>
      <span className="rsp hide-m">
        <Spark data={c.spark} w={104} h={30} />
      </span>
      <Mcap className="r num hide-m" value={c.mcapUsd} />
      <span className="r hide-m">
        <Change value={c.change24hPct} />
      </span>
      <span className="hide-m">
        <CurveCell coin={c} />
      </span>
      <span className="r num hide-m c-paid">{sol(c.paidToHoldersLamports)} SOL</span>
      <span className="mc-m num">
        <Mcap as="b" value={c.mcapUsd} />
        <Change value={c.change24hPct} style={{ fontSize: 12.5 }} />
      </span>
      <span className="r" title="Vault progress to the next buyback">
        <Ring mint={c.mint} value={vaultRatio(c, TH)} size={36} stroke={12} />
      </span>
    </Link>
  );
}

function BoardList() {
  const [tab, setTab] = useState<BoardTab>("trending");
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, loading } = useApi<{ coins: CoinRow[] }>(`/coins?tab=${tab}&q=${encodeURIComponent(dq)}`);
  const upsert = useLive((s) => s.upsertCoins);
  useEffect(() => {
    if (data) upsert(data.coins);
  }, [data, upsert]);

  let body: React.ReactNode;
  if (!data && error) {
    body = (
      <div className="empty">
        <b>Coins are unavailable</b>
        <Dash reason={error.message} />
      </div>
    );
  } else if (!data && loading) {
    body = <div className="loading-rows">Loading coins…</div>;
  } else if (data && !data.coins.length) {
    body = (
      <div className="empty">
        <b>No coins match</b>Try another name or ticker, or{" "}
        <Link href="/launch" style={{ color: "var(--current)" }}>
          launch this one yourself
        </Link>
        .
      </div>
    );
  } else if (data) {
    body = (
      <>
        <div className="row head" aria-hidden="true">
          <span>Coin</span>
          <span className="hide-m">Last 24h</span>
          <span className="r hide-m">Market cap</span>
          <span className="r hide-m">24h</span>
          <span className="hide-m">Bonding curve</span>
          <span className="r hide-m c-paid">Paid to holders</span>
          <span className="mc-m">Market cap</span>
          <span className="r">Next</span>
        </div>
        {data.coins.map((c) => (
          <Row key={c.mint} mint={c.mint} />
        ))}
      </>
    );
  }

  return (
    <section className="wrap board" id="coins" aria-label="All coins">
      <div className="board-head">
        <h2>All coins</h2>
        <Tabs items={TABS} value={tab} onChange={setTab} label="Filter coins" />
        <label className="search">
          <span className="sr">Search coins</span>
          <Icon name="search" />
          <input type="search" placeholder="Search name or ticker" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        </label>
      </div>
      <div className="panel list">{body}</div>
    </section>
  );
}

export function Board() {
  return (
    <>
      <Hero />
      <Trending />
      <BoardList />
    </>
  );
}
