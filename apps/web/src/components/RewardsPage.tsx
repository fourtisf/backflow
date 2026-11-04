"use client";

import { BRAND, CURVE, int, mergeWalletRewards, short, sol, tokens, usd, type BuybackDTO, type CreatorCoin, type WalletCoinRewards, type WalletRewardsDTO } from "@backflow/core";
import Link from "next/link";
import { explorerTx, useExplorerLinks } from "@/lib/tx";
import { useCreatorClaim } from "@/lib/claims";
import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState, type ReactNode } from "react";
import { apiGet } from "@/lib/api";
import { catalogEntry, useSavedWallets, type SavedWallet } from "@/lib/wallets";
import { NO_SIGN_MESSAGE, signNonce } from "@/lib/auth";
import { apiPost } from "@/lib/tx";
import { RewardHistory } from "./ProofPages";
import { useLive, useRewards, useUi, toast } from "@/lib/store";
import { Ago, Avatar, PayoutCountdown, tokensCompact } from "./ui";
import { WalletLogo, useSwitchWallet, useWalletAddress } from "./Wallet";

const UNIT = 10 ** CURVE.decimals;
const valueUsd = (amount: string, price: number | null) => (price == null ? null : (Number(BigInt(amount)) / UNIT) * price);

function Ledger() {
  const links = useExplorerLinks();
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
            <td className="r num hide-m">
              <Link href={`/buyback/${e.id}`} style={{ color: "var(--peri)" }}>
                {int(e.holderCount)} holders
              </Link>
            </td>
            <td className="r hide-m">
              {e.signature && links ? (
                <a className="num" href={explorerTx(e.signature)} target="_blank" rel="noreferrer">
                  {short(e.signature)}
                </a>
              ) : (
                <span className="num muted">{e.signature ? short(e.signature) : e.status}</span>
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

function Creator({ coins, claimable }: { coins: CreatorCoin[]; claimable: string | null }) {
  const { claim, busy } = useCreatorClaim();
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
  const total = claimable != null ? BigInt(claimable) : null;
  return (
    <>
      <table className="tbl">
        <thead>
          <tr>
            <th>Coin</th>
            <th className="r hide-m">Earned on the curve</th>
            <th className="r">Raydium pool fees</th>
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
              <td className="r">
                {c.cpmmClaimable ? (
                  <span className="btn-row" style={{ justifyContent: "flex-end" }}>
                    <span className="num">{sol(c.cpmmClaimable.sol)} SOL</span>
                    <button className="btn btn-ghost btn-sm" disabled={!!busy || BigInt(c.cpmmClaimable.sol) <= 0n} onClick={() => void claim("cpmm", c.mint)}>
                      {busy === `cpmm:${c.mint}` ? "Confirm…" : "Claim"}
                    </button>
                  </span>
                ) : (
                  <span className="muted">{c.status === "curve" ? "After graduation" : "–"}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="launch-foot">
        <span className="cost">
          Bonding curve fees claimable now <b className="num" style={{ color: "var(--rose)" }}>{total == null ? "–" : `${sol(total)} SOL`}</b>. Raydium keeps one creator vault for all your coins, so one claim takes it all.
        </span>
        <button className="btn btn-ghost" disabled={!!busy || total == null || total <= 0n} onClick={() => void claim("launchlab")}>
          {busy === "launchlab" ? "Confirm in your wallet…" : "Claim creator fees"}
        </button>
      </div>
    </>
  );
}

/** Opt-in payout messages on Telegram: sign once with the wallet, then open the bot. */
function TelegramAlerts() {
  const isLive = useLive((s) => s.stats?.mode === "live");
  const { publicKey, signMessage } = useWallet();
  const [busy, setBusy] = useState(false);
  if (!isLive || !publicKey) return null;
  const link = async () => {
    if (!signMessage) {
      toast(NO_SIGN_MESSAGE, true);
      return;
    }
    setBusy(true);
    try {
      // single-use, server-issued nonce (audit L9)
      const r = await apiPost<{ url: string }>("/telegram/link", await signNonce({ publicKey, signMessage }, "telegram"));
      window.open(r.url, "_blank", "noopener");
    } catch (e) {
      toast((e as Error).message || "Couldn't link Telegram.", true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="note info" style={{ alignItems: "center", marginTop: 16 }}>
      <span style={{ flex: 1 }}>Get a Telegram message whenever a payout lands in your wallet.</span>
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void link()}>
        {busy ? "Sign in your wallet…" : "Turn on Telegram alerts"}
      </button>
    </div>
  );
}

const coinsValue = (coins: WalletCoinRewards[], key: "pending" | "received") => {
  let v = 0;
  for (const c of coins) {
    const x = valueUsd(c[key], c.priceUsd);
    if (x == null) return null;
    v += x;
  }
  return v;
};

/** Rewards of saved wallets other than the connected one, read-only (no signature needed to look). */
function useOtherRewards(addresses: string[]) {
  const [data, setData] = useState<Record<string, WalletRewardsDTO | { error: string }>>({});
  const key = addresses.join(",");
  useEffect(() => {
    let stop = false;
    for (const a of addresses) {
      apiGet<WalletRewardsDTO>(`/wallet/${a}/rewards`).then(
        (d) => !stop && setData((m) => ({ ...m, [a]: d })),
        (e) => !stop && setData((m) => ({ ...m, [a]: { error: (e as Error).message } })),
      );
    }
    return () => {
      stop = true;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return data;
}

function WalletPicker({ wallets, active, view, setView }: { wallets: SavedWallet[]; active: string; view: string; setView: (v: string) => void }) {
  const chip = (id: string, body: ReactNode, label: string) => (
    <button key={id} role="tab" aria-selected={view === id} aria-label={label} className={"wpick" + (view === id ? " on" : "")} onClick={() => setView(id)}>
      {body}
    </button>
  );
  return (
    <div className="wpicker" role="tablist" aria-label="Which wallets to show">
      {chip("all", <>All wallets <span className="num">{wallets.length}</span></>, `All ${wallets.length} wallets`)}
      {wallets.map((w) =>
        chip(
          w.address,
          <>
            <WalletLogo name={w.name} size={18} />
            <span className="num">{short(w.address)}</span>
            {w.address === active && <span className="tag on">Connected</span>}
          </>,
          `${catalogEntry(w.name)?.name ?? w.name} ${short(w.address)}${w.address === active ? ", connected" : ""}`,
        ),
      )}
    </div>
  );
}

function ByWallet({ wallets, data }: { wallets: SavedWallet[]; data: Record<string, WalletRewardsDTO | { error: string } | null> }) {
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Wallet</th>
          <th className="r">Coins held</th>
          <th className="r">Waiting for payout</th>
          <th className="r">Paid so far</th>
        </tr>
      </thead>
      <tbody>
        {wallets.map((w) => {
          const d = data[w.address];
          const coins = d && "coins" in d ? d.coins : null;
          const show = (v: number | null) => (v == null ? "–" : usd(v));
          return (
            <tr key={w.address}>
              <td>
                <span className="btn-row" style={{ gap: 10, flexWrap: "nowrap" }}>
                  <WalletLogo name={w.name} size={22} />
                  <span>
                    {catalogEntry(w.name)?.name ?? w.name} <span className="num dim">{short(w.address)}</span>
                  </span>
                </span>
              </td>
              <td className="r num">{coins ? coins.filter((c) => BigInt(c.balance) > 0n).length : d && "error" in d ? "–" : "…"}</td>
              <td className="r num">{coins ? show(coinsValue(coins, "pending")) : "…"}</td>
              <td className="r num">{coins ? show(coinsValue(coins, "received")) : "…"}</td>
            </tr>
          );
        })}
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
  return <ConnectedRewards addr={addr} head={head} ledger={ledger} data={data} error={error} loading={loading} />;
}

function ConnectedRewards({ addr, head, ledger, data, error, loading }: { addr: string; head: ReactNode; ledger: ReactNode; data: WalletRewardsDTO | null; error: string | null; loading: boolean }) {
  const saved = useSavedWallets((s) => s.list);
  const switchTo = useSwitchWallet();
  const [view, setView] = useState<string>(addr);
  useEffect(() => setView(addr), [addr]);
  const wallets = [...saved.filter((w) => w.address === addr), ...saved.filter((w) => w.address !== addr)];
  const others = useOtherRewards(wallets.filter((w) => w.address !== addr).map((w) => w.address));
  const all: Record<string, WalletRewardsDTO | { error: string } | null> = { ...others, [addr]: data };
  const picker = wallets.length > 1 ? <WalletPicker wallets={wallets} active={addr} view={view} setView={setView} /> : null;

  if (view === "all") {
    const lists = wallets.map((w) => all[w.address]).filter((d): d is WalletRewardsDTO => !!d && "coins" in d);
    const merged = mergeWalletRewards(lists.map((d) => d.coins));
    return (
      <div className="wrap">
        {head}
        {picker}
        <Summary coins={merged} />
        <div className="note info" style={{ marginTop: 16 }}>
          <span>
            Totals for {wallets.length} wallets saved on this device{lists.length < wallets.length ? " (still loading some)" : ""}. Claims and Telegram alerts use the connected wallet.
          </span>
        </div>
        <div className="sec-title">
          <h2>By wallet</h2>
        </div>
        <div className="panel scroll-x">
          <ByWallet wallets={wallets} data={all} />
        </div>
        <div className="sec-title">
          <h2>By coin, all wallets</h2>
        </div>
        <div className="panel scroll-x">
          <ByCoin coins={merged} />
        </div>
        {ledger}
      </div>
    );
  }

  if (view !== addr) {
    const w = wallets.find((x) => x.address === view);
    const d = others[view];
    return (
      <div className="wrap">
        {head}
        {picker}
        {d && "coins" in d ? (
          <>
            <Summary coins={d.coins} />
            <div className="note info" style={{ marginTop: 16, alignItems: "center" }}>
              <span style={{ flex: 1 }}>You&apos;re looking at {short(view)}. Switch to it to claim creator fees or turn on alerts for it.</span>
              {w && (
                <button className="btn btn-ghost btn-sm" onClick={() => void switchTo(w)}>
                  Switch to this wallet
                </button>
              )}
            </div>
            <div className="sec-title">
              <h2>By coin</h2>
            </div>
            <div className="panel scroll-x">
              <ByCoin coins={d.coins} />
            </div>
            <div className="sec-title">
              <h2>History</h2>
            </div>
            <div className="panel scroll-x">
              <RewardHistory wallet={view} />
            </div>
          </>
        ) : (
          <div className="panel loading-rows">{d && "error" in d ? `– ${d.error}` : "Loading rewards…"}</div>
        )}
        {ledger}
      </div>
    );
  }

  return (
    <div className="wrap">
      {head}
      {picker}
      {data ? (
        <>
          <Summary coins={data.coins} />
          <div className="sec-title">
            <h2>By coin</h2>
          </div>
          <div className="panel scroll-x">
            <ByCoin coins={data.coins} />
          </div>
          <TelegramAlerts />
          <div className="sec-title">
            <h2>History</h2>
          </div>
          <div className="panel scroll-x">
            <RewardHistory wallet={addr} />
          </div>
          <div className="sec-title">
            <h2>Your launches</h2>
          </div>
          <div className="panel scroll-x">
            <Creator coins={data.creatorCoins} claimable={data.creatorClaimableLamports} />
          </div>
        </>
      ) : (
        <div className="panel loading-rows">{error ? `– ${error}` : loading ? "Loading your rewards…" : "–"}</div>
      )}
      {ledger}
    </div>
  );
}
