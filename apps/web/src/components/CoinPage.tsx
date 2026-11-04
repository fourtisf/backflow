"use client";

import {
  BRAND,
  BUYBACK,
  COPY,
  CURVE,
  SOL_DECIMALS,
  estimateBuy,
  estimateSell,
  int,
  minBig,
  parseUnits,
  ppmPct,
  progress,
  short,
  sol,
  solFixed,
  solWhole,
  supplyText,
  tokens,
  usd,
  type BuybackDTO,
  type CandleDTO,
  type CandleTf,
  type CoinDetail,
  type HolderDTO,
  type TradeDTO,
  type WalletCoinRewards,
} from "@backflow/core";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/api";
import { useSolBalance } from "@/lib/hooks";
import { onLive, toast, useLive, useRewards, useUi } from "@/lib/store";
import { CandleChart } from "./CandleChart";
import { Icon } from "./Icon";
import { Ago, Change, CoinAvatar, Mcap, PayoutCountdown, Ring, vaultRatio } from "./ui";
import { useWalletAddress } from "./Wallet";

const TH = BUYBACK.thresholdLamports;
const TF_MS: Record<CandleTf, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000 };
const DEC = CURVE.decimals;

function useHolding(mint: string): WalletCoinRewards | null {
  const data = useRewards((s) => s.data);
  return data?.coins.find((c) => c.mint === mint) ?? null;
}

/* --------------------------------- trade ---------------------------------- */

function priceScaled(priceLamports: string | null): bigint {
  if (!priceLamports) return 0n;
  const [w = "0", f = ""] = priceLamports.split(".");
  return parseUnits(`${w}.${f.slice(0, 9)}`, 9) ?? 0n;
}

function TradePanel({ coin, priceLamports }: { coin: CoinDetail; priceLamports: string | null }) {
  const addr = useWalletAddress();
  const openWallet = useUi((s) => s.openWalletModal);
  const holding = useHolding(coin.mint);
  const { lamports: solBal } = useSolBalance();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("");
  const [err, setErr] = useState("");
  const inp = useRef<HTMLInputElement>(null);
  const isBuy = side === "buy";
  const bal = holding ? BigInt(holding.balance) : 0n;
  const pending = holding ? BigInt(holding.pending) : 0n;
  const price = priceScaled(priceLamports);

  useEffect(() => {
    setAmt("");
    setErr("");
  }, [side]);

  const parsed = parseUnits(amt, isBuy ? SOL_DECIMALS : DEC);
  let out = "–";
  let fee = "–";
  if (parsed && parsed > 0n && price > 0n) {
    if (isBuy) {
      const e = estimateBuy(parsed, price, DEC);
      out = `${tokens(e.tokensOut)} $${coin.ticker}`;
      fee = `${sol(e.fees.total)} SOL`;
    } else {
      const e = estimateSell(parsed, price, DEC);
      out = `${sol(e.out)} SOL`;
      fee = `${sol(e.fees.total)} SOL`;
    }
  }

  const presets: [string, string][] = isBuy
    ? [["0.1", "0.1"], ["0.5", "0.5"], ["1", "1"], ["5", "5"]]
    : [["25", "25%"], ["50", "50%"], ["75", "75%"], ["100", "Max"]];

  const preset = (v: string) => {
    setErr("");
    if (isBuy) setAmt(v);
    else {
      const units = (bal * BigInt(v)) / 100n;
      const whole = units / 10n ** BigInt(DEC);
      setAmt(bal > 0n ? whole.toString() : "");
    }
    inp.current?.focus();
  };

  const submit = () => {
    if (!addr) {
      openWallet();
      return;
    }
    if (!parsed || parsed <= 0n) {
      setErr("Enter an amount above zero.");
      inp.current?.focus();
      return;
    }
    if (isBuy) {
      if (solBal != null && parsed > solBal) {
        setErr(`You have ${solFixed(solBal, 2)} SOL. Lower the amount or top up your wallet.`);
        inp.current?.focus();
        return;
      }
    } else {
      if (bal <= 0n) {
        setErr(`You don't hold any $${coin.ticker}.`);
        return;
      }
      if (parsed > bal) {
        setErr(`You hold ${tokens(bal)} $${coin.ticker}. Lower the amount.`);
        inp.current?.focus();
        return;
      }
    }
    toast("Trading isn't live yet in this build. Nothing was sent.");
  };

  return (
    <div className="panel trade">
      <div className="seg" role="tablist" aria-label="Buy or sell">
        <button className={"buy" + (isBuy ? " on" : "")} role="tab" aria-selected={isBuy} onClick={() => setSide("buy")}>
          Buy
        </button>
        <button className={"sell" + (!isBuy ? " on" : "")} role="tab" aria-selected={!isBuy} onClick={() => setSide("sell")}>
          Sell
        </button>
      </div>
      <div className="field">
        <label htmlFor="amt">
          <span>{isBuy ? "You pay" : "You sell"}</span>
          <span className="num">
            Balance {addr ? (isBuy ? (solBal == null ? "–" : `${solFixed(solBal, 2)} SOL`) : `${tokens(bal)} $${coin.ticker}`) : "–"}
          </span>
        </label>
        <div className="amt">
          <input
            id="amt"
            ref={inp}
            inputMode="decimal"
            placeholder="0.00"
            autoComplete="off"
            value={amt}
            onChange={(e) => {
              setAmt(e.target.value);
              setErr("");
            }}
            onKeyDown={(e) => e.key === "Enter" && addr && submit()}
          />
          <span className="unit">{isBuy ? "SOL" : "$" + coin.ticker}</span>
        </div>
        <div className="presets">
          {presets.map(([v, l]) => (
            <button key={l} onClick={() => preset(v)}>
              {l}
            </button>
          ))}
        </div>
        <div className="err" role="alert">
          {err}
        </div>
      </div>
      <div className="est">
        <div className="l">
          <span>You receive about</span>
          <b className="num">{out}</b>
        </div>
        <details className="fees">
          <summary>
            <span>
              Fee {COPY.total}
              <span className="chev">▾</span>
            </span>
            <b className="num">{fee}</b>
          </summary>
          <div className="rows">
            <div>
              <span className="sw c-hold" />
              Buys ${coin.ticker} for holders<b className="num">{COPY.holders}</b>
            </div>
            <div>
              <span className="sw c-plat" />
              Platform<b className="num">{COPY.platform}</b>
            </div>
            <div>
              <span className="sw c-crea" />
              Creator<b className="num">{COPY.creator}</b>
            </div>
            <div>
              <span className="sw c-ray" />
              Raydium<b className="num">{COPY.raydium}</b>
            </div>
          </div>
        </details>
      </div>
      {!isBuy && pending > 0n && (
        <div className="note warn">
          <Icon name="warn" />
          <span>
            Selling now forfeits your{" "}
            <b className="num">
              {tokens(pending)} ${coin.ticker}
            </b>{" "}
            waiting for the next payout. It goes back to the other holders.
          </span>
        </div>
      )}
      {addr ? (
        <button className={`btn btn-lg btn-block ${isBuy ? "btn-primary" : "btn-sell"}`} onClick={submit}>
          {isBuy ? "Buy" : "Sell"} ${coin.ticker}
        </button>
      ) : (
        <button className="btn btn-lg btn-block btn-primary" onClick={openWallet}>
          Connect wallet to {isBuy ? "buy" : "sell"}
        </button>
      )}
    </div>
  );
}

/* ------------------------------ right rail -------------------------------- */

function SharePanel({ coin, budget }: { coin: CoinDetail; budget: string }) {
  const addr = useWalletAddress();
  const openWallet = useUi((s) => s.openWalletModal);
  const h = useHolding(coin.mint);
  const shown = solFixed(minBig(BigInt(budget), TH), 2);
  const core = (
    <div className="share-core">
      <Ring mint={coin.mint} value={vaultRatio({ buybackBudgetLamports: budget }, TH)} size={92} stroke={9}>
        <span className="num" style={{ fontWeight: 600, fontSize: 15 }}>
          {shown}
        </span>
      </Ring>
      <p>
        Vault has{" "}
        <b className="num">
          {shown} of {solFixed(TH, 2)} SOL
        </b>
        . When it fills, the bot buys ${coin.ticker} and splits it across every holder by how much they hold.
      </p>
    </div>
  );
  if (!addr) {
    return (
      <div className="panel share">
        <h3>Your buyback share</h3>
        {core}
        <button className="btn btn-ghost btn-block" onClick={openWallet}>
          Connect wallet to see your share
        </button>
      </div>
    );
  }
  if (!h || BigInt(h.balance) <= 0n) {
    return (
      <div className="panel share">
        <h3>Your buyback share</h3>
        {core}
        <div className="note info" style={{ marginTop: 0 }}>
          <Icon name="info" />
          <span>You don&apos;t hold ${coin.ticker} yet. Buy any amount and you start earning from the next buyback.</span>
        </div>
      </div>
    );
  }
  return (
    <div className="panel share">
      <h3>Your buyback share</h3>
      {core}
      <div className="kv">
        <div>
          <span>You hold</span>
          <b className="num">
            {tokens(h.balance)} ${coin.ticker}
          </b>
        </div>
        <div>
          <span>Your share</span>
          <b className="num">{(h.sharePpm / 1e4).toFixed(2)}%</b>
        </div>
        <div>
          <span>Waiting for payout</span>
          <b className="num" style={{ color: "var(--current)" }}>
            +{tokens(h.pending)}
          </b>
        </div>
        <div>
          <span>Paid to you so far</span>
          <b className="num">{tokens(h.received)}</b>
        </div>
        <div>
          <span>Next payout</span>
          <b className="num">
            <PayoutCountdown />
          </b>
        </div>
      </div>
    </div>
  );
}

function CurvePanel({ coin, curveLamports, graduated }: { coin: CoinDetail; curveLamports: string; graduated: boolean }) {
  if (graduated) {
    return (
      <div className="panel curve">
        <h3>Graduated to Raydium</h3>
        <p>This coin filled its bonding curve and moved to a Raydium pool. The liquidity is locked forever. Fees from the pool keep funding buybacks for holders.</p>
        <div className="kv">
          <div>
            <span>Pool trade fee</span>
            <b className="num">{coin.poolFeePpm != null ? ppmPct(coin.poolFeePpm) : <>–<span className="dash-reason">not confirmed yet</span></>}</b>
          </div>
        </div>
      </div>
    );
  }
  const p = progress(curveLamports, coin.graduationTargetLamports) * 100;
  const grad = solWhole(BigInt(coin.graduationTargetLamports));
  return (
    <div className="panel curve">
      <h3>Bonding curve</h3>
      <div className="cbar">
        <i style={{ width: p.toFixed(1) + "%" }} />
      </div>
      <div className="meta num">
        <span>
          {(Number(BigInt(curveLamports) / 100_000_000n) / 10).toFixed(1)} of {grad} SOL
        </span>
        <span>{p.toFixed(0)}% to Raydium</span>
      </div>
      <p>At {grad} SOL the coin moves to a Raydium pool and its liquidity is locked forever. Buybacks keep running before and after.</p>
    </div>
  );
}

/* --------------------------------- tabs ----------------------------------- */

type CoinTab = "trades" | "buys" | "holders";

function TradesTable({ trades, ticker, me }: { trades: TradeDTO[]; ticker: string; me: string | null }) {
  if (!trades.length) return <div className="empty"><b>No trades yet</b>Trades show up here as they land.</div>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Side</th>
          <th>Wallet</th>
          <th className="r">SOL</th>
          <th className="r hide-m">${ticker}</th>
          <th className="r">Time</th>
        </tr>
      </thead>
      <tbody>
        {trades.slice(0, 14).map((t) => {
          const mine = me != null && t.wallet === me;
          return (
            <tr key={t.signature} className={mine ? "me" : undefined}>
              <td>
                <span className={`side ${t.side === "buy" ? "b" : "s"}`}>{t.side === "buy" ? "Buy" : "Sell"}</span>
              </td>
              <td className="num">{mine ? "You" : short(t.wallet)}</td>
              <td className="r num">{sol(t.quoteLamports)}</td>
              <td className="r num hide-m">{tokens(t.tokenAmount)}</td>
              <td className="r muted num">
                <Ago at={t.blockTime} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function explorerTx(sig: string): string {
  const cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "devnet";
  return `https://solscan.io/tx/${sig}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`}`;
}

export function BuybacksTable({ rows, ticker }: { rows: BuybackDTO[]; ticker: string }) {
  if (!rows.length) return <div className="empty"><b>No buybacks yet</b>The first one fires when the vault reaches {solWhole(TH)} SOL.</div>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Buyback</th>
          <th className="r">Spent</th>
          <th className="r">Bought</th>
          <th className="r hide-m">Split across</th>
          <th className="r">Time</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 14).map((b) => (
          <tr key={b.id}>
            <td>{b.signature ? <a className="num" href={explorerTx(b.signature)} target="_blank" rel="noreferrer">{short(b.signature)}</a> : <span className="muted">{b.status}</span>}</td>
            <td className="r num">{sol(b.solSpentLamports)} SOL</td>
            <td className="r num">
              {tokens(b.tokensBought)} ${ticker}
            </td>
            <td className="r num hide-m">{int(b.holderCount)} holders</td>
            <td className="r muted num">
              <Ago at={b.createdAt} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HoldersTable({ holders, me, holding }: { holders: HolderDTO[]; me: string | null; holding: WalletCoinRewards | null }) {
  const supply = CURVE.supplyBaseUnits;
  const rows = [...holders];
  if (me && holding && BigInt(holding.balance) > 0n && !rows.some((r) => r.wallet === me)) {
    rows.push({ wallet: me, label: null, balance: holding.balance, supplyPpm: Number((BigInt(holding.balance) * 1_000_000n) / supply), excluded: false });
  }
  const excluded = rows.filter((r) => r.excluded);
  const earning = rows.filter((r) => !r.excluded).sort((a, b) => b.supplyPpm - a.supplyPpm);
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Holder</th>
          <th>Rewards</th>
          <th className="r">Supply</th>
        </tr>
      </thead>
      <tbody>
        {[...excluded, ...earning].map((h) => {
          const mine = me != null && h.wallet === me;
          return (
            <tr key={h.wallet} className={mine ? "me" : undefined}>
              <td className="num">{h.label ?? (mine ? "You" : short(h.wallet))}</td>
              <td>{h.excluded ? <span className="tag dim">No rewards</span> : <span className="tag">Earning</span>}</td>
              <td className="r num">{(h.supplyPpm / 1e4).toFixed(2)}%</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ---------------------------------- page ---------------------------------- */

export function CoinPage({ mint }: { mint: string }) {
  const detail = useApi<CoinDetail>(`/coins/${mint}`);
  const live = useLive((s) => s.coins[mint]);
  const bbCount = useLive((s) => s.buybackCounts[mint]);
  const upsert = useLive((s) => s.upsertCoins);
  const me = useWalletAddress();
  const holding = useHolding(mint);
  const [tf, setTf] = useState<CandleTf>("1m");
  const [tab, setTab] = useState<CoinTab>("trades");
  const candlesQ = useApi<{ candles: CandleDTO[] }>(detail.data ? `/coins/${mint}/candles?tf=${tf}` : null);
  const tradesQ = useApi<{ trades: TradeDTO[] }>(detail.data ? `/coins/${mint}/trades` : null);
  const buysQ = useApi<{ buybacks: BuybackDTO[] }>(detail.data ? `/coins/${mint}/buybacks` : null);
  const holdersQ = useApi<{ holders: HolderDTO[] }>(detail.data && tab === "holders" ? `/coins/${mint}/holders` : null);
  const [priceLamports, setPriceLamports] = useState<string | null>(null);

  useEffect(() => {
    if (detail.data) {
      upsert([detail.data]);
      setPriceLamports(detail.data.priceLamports);
    }
  }, [detail.data, upsert]);

  // Live updates for this coin: price → candles, trades, buybacks.
  const { setData: setCandles } = candlesQ;
  const { setData: setTrades } = tradesQ;
  const { setData: setBuys } = buysQ;
  useEffect(() => {
    const step = TF_MS[tf];
    return onLive((e) => {
      if (e.type === "price" && e.mint === mint) {
        if (e.priceLamports) setPriceLamports(e.priceLamports);
        const v = e.mcapUsd;
        if (v == null) return;
        setCandles((prev) => {
          if (!prev || !prev.candles.length) return prev;
          const cs = prev.candles.slice();
          const last = cs[cs.length - 1]!;
          const open = Math.floor(e.t / step) * step;
          if (open > last.t) cs.push({ t: open, o: last.c, h: Math.max(last.c, v), l: Math.min(last.c, v), c: v, buyback: false });
          else cs[cs.length - 1] = { ...last, c: v, h: Math.max(last.h, v), l: Math.min(last.l, v) };
          return { candles: cs.slice(-400) };
        });
      }
      if (e.type === "trade" && e.mint === mint) {
        setTrades((prev) => (prev ? { trades: [e.trade, ...prev.trades].slice(0, 60) } : prev));
      }
      if (e.type === "buyback" && e.buyback.coinMint === mint) {
        setBuys((prev) => (prev ? { buybacks: [e.buyback, ...prev.buybacks.filter((b) => b.id !== e.buyback.id)].slice(0, 60) } : prev));
        setCandles((prev) => {
          if (!prev || !prev.candles.length) return prev;
          const cs = prev.candles.slice();
          cs[cs.length - 1] = { ...cs[cs.length - 1]!, buyback: true };
          return { candles: cs };
        });
      }
    });
  }, [mint, tf, setCandles, setTrades, setBuys]);

  const coin = detail.data;
  const merged = useMemo(() => (coin ? { ...coin, ...(live ?? {}) } : null), [coin, live]);

  if (detail.error && !coin) {
    return (
      <div className="wrap">
        <div className="panel gate" style={{ margin: "60px 0" }}>
          {detail.error.status === 404 ? (
            <>
              <h2>This coin isn&apos;t on {BRAND.name}</h2>
              <p>Check the link, or find it on the coin list.</p>
            </>
          ) : (
            <>
              <h2>This coin can&apos;t load right now</h2>
              <p>{detail.error.message}</p>
            </>
          )}
          <Link className="btn btn-primary" href="/">
            Go to coins
          </Link>
        </div>
      </div>
    );
  }
  if (!coin || !merged) {
    return (
      <div className="wrap">
        <Link className="crumb" href="/">
          <Icon name="back" size={16} />
          All coins
        </Link>
        <div className="panel loading-rows">Loading coin…</div>
      </div>
    );
  }

  const graduated = merged.status !== "curve";
  return (
    <div className="wrap">
      <Link className="crumb" href="/">
        <Icon name="back" size={16} />
        All coins
      </Link>
      <div className="panel coin-hero">
        <CoinAvatar coin={coin} size={76} />
        <div style={{ minWidth: 0 }}>
          <h1>{coin.name}</h1>
          <div className="coin-meta">
            <span>${coin.ticker}</span>
            <button
              className="ca num"
              aria-label="Copy contract address"
              onClick={() =>
                navigator.clipboard?.writeText(coin.mint).then(
                  () => toast("Contract address copied."),
                  () => toast("Contract address: " + short(coin.mint)),
                )
              }
            >
              {short(coin.mint)} <Icon name="copy" />
            </button>
            {coin.x && (
              <a className="soc" href={coin.x} target="_blank" rel="noreferrer nofollow" aria-label="X">
                <Icon name="x" />
              </a>
            )}
            {coin.telegram && (
              <a className="soc" href={coin.telegram} target="_blank" rel="noreferrer nofollow" aria-label="Telegram">
                <Icon name="tg" />
              </a>
            )}
            {coin.website && (
              <a className="soc" href={coin.website} target="_blank" rel="noreferrer nofollow" aria-label="Website">
                <Icon name="web" />
              </a>
            )}
            {graduated ? (
              <span className="tag">
                <Icon name="lock" size={12} />
                LP locked on Raydium
              </span>
            ) : (
              <span className="tag peri">On bonding curve</span>
            )}
          </div>
        </div>
        <div className="coin-price">
          <Mcap as="div" className="v num" value={merged.mcapUsd} />
          <div className="c num">
            <Change value={merged.change24hPct} /> <span className="muted">market cap, 24h</span>
          </div>
        </div>
      </div>
      <div className="coin-grid">
        <div className="main-col" style={{ minWidth: 0 }}>
          <div className="panel chart-panel">
            <div className="stats">
              <div>
                <div className="k">Volume, 24h</div>
                <div className="v num">{usd(merged.vol24hUsd)}</div>
              </div>
              <div>
                <div className="k">Paid to holders</div>
                <div className="v num">{sol(merged.paidToHoldersLamports)} SOL</div>
              </div>
              <div>
                <div className="k">Buybacks</div>
                <div className="v num">{int(bbCount ?? coin.buybackCount)}</div>
              </div>
              <div>
                <div className="k">Holders</div>
                <div className="v num">{int(merged.holderCount)}</div>
              </div>
            </div>
            <CandleChart
              candles={candlesQ.data?.candles ?? []}
              label={`Market cap chart for ${coin.ticker}`}
              empty={candlesQ.error ? <span>– {candlesQ.error.message}</span> : !candlesQ.data ? <span>Loading chart…</span> : candlesQ.data.candles.length ? null : <span>No trades yet</span>}
              controls={
                <div className="seg sm" role="tablist" aria-label="Candle size">
                  {(["1m", "5m", "15m"] as CandleTf[]).map((k) => (
                    <button key={k} role="tab" className={tf === k ? "on" : ""} aria-selected={tf === k} onClick={() => setTf(k)}>
                      {k}
                    </button>
                  ))}
                </div>
              }
            />
            <div className="chart-legend">
              <span>
                <i></i>Buyback for holders
              </span>
            </div>
          </div>
          <div className="panel tabs-panel">
            <div className="tabs-bar">
              <div className="seg" role="tablist" aria-label="Coin activity">
                {(
                  [
                    ["trades", "Trades"],
                    ["buys", "Buybacks"],
                    ["holders", "Holders"],
                  ] as [CoinTab, string][]
                ).map(([k, l]) => (
                  <button key={k} role="tab" className={tab === k ? "on" : ""} aria-selected={tab === k} onClick={() => setTab(k)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <div className="scroll-x">
              {tab === "trades" && (tradesQ.data ? <TradesTable trades={tradesQ.data.trades} ticker={coin.ticker} me={me} /> : <div className="loading-rows">{tradesQ.error ? `– ${tradesQ.error.message}` : "Loading trades…"}</div>)}
              {tab === "buys" && (buysQ.data ? <BuybacksTable rows={buysQ.data.buybacks} ticker={coin.ticker} /> : <div className="loading-rows">{buysQ.error ? `– ${buysQ.error.message}` : "Loading buybacks…"}</div>)}
              {tab === "holders" && (holdersQ.data ? <HoldersTable holders={holdersQ.data.holders} me={me} holding={holding} /> : <div className="loading-rows">{holdersQ.error ? `– ${holdersQ.error.message}` : "Loading holders…"}</div>)}
            </div>
          </div>
        </div>
        <aside className="rail">
          <TradePanel coin={coin} priceLamports={priceLamports} />
          <SharePanel coin={coin} budget={merged.buybackBudgetLamports} />
          <CurvePanel coin={coin} curveLamports={merged.curveQuoteLamports} graduated={graduated} />
          <div className="panel about">
            <h3>About</h3>
            <p>{coin.description || "No description."}</p>
            <div className="kv" style={{ marginTop: 14 }}>
              <div>
                <span>Created by</span>
                <b className="num">{short(coin.creator)}</b>
              </div>
              <div>
                <span>Launched</span>
                <b>
                  <Ago at={coin.createdAt} />
                </b>
              </div>
              <div>
                <span>Supply</span>
                <b className="num">{supplyText()}</b>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

