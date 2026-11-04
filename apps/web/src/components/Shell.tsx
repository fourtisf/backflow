"use client";

import { BRAND, CURVE, UI, short, tokens, usd, type LiveEvent } from "@backflow/core";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { onLive, toast, useLive, useRewards, useToasts } from "@/lib/store";
import { Icon } from "./Icon";
import { TickerItem } from "./ui";
import { SolBalance, WalletButton, WalletModal, useWalletAddress } from "./Wallet";

const NAV = [
  { href: "/", key: "board", label: "Coins" },
  { href: "/launch", key: "launch", label: "Launch" },
  { href: "/rewards", key: "rewards", label: "Rewards" },
  { href: "/how", key: "how", label: "How it works" },
];

function navKey(path: string): string {
  if (path === "/" || path.startsWith("/coin/")) return "board";
  return path.split("/")[1] ?? "";
}

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M26.5 11.5A11.5 11.5 0 1 0 27.5 18" stroke="url(#gFlow)" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M28.6 5.8 27 12.4l-6.6-1.4" stroke="#45E3D3" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="16" r="3.6" fill="#45E3D3" />
    </svg>
  );
}

function LiveStrip() {
  const ledger = useLive((s) => s.ledger);
  const mode = useLive((s) => s.stats?.mode);
  const apiError = useLive((s) => s.apiError);
  const [fresh, setFresh] = useState<string | null>(null);
  useEffect(
    () =>
      onLive((e) => {
        if (e.type === "buyback") setFresh(e.buyback.id);
      }),
    [],
  );
  return (
    <div className="ticker" aria-label="Live buybacks">
      <div className="wrap">
        <span className="tk-label">
          <i></i>Live
        </span>
        {mode === "mock" && <span className="tag dim tk-mode">Simulated data</span>}
        <div className="track">
          {apiError && !ledger.length ? (
            <span className="tk-item">
              <span style={{ paddingLeft: 8 }}>– {apiError}</span>
            </span>
          ) : (
            ledger.slice(0, UI.liveStripMax).map((e) => <TickerItem key={e.id} e={e} isNew={e.id === fresh} />)
          )}
        </div>
      </div>
    </div>
  );
}

export function Header() {
  const path = usePathname() ?? "/";
  const addr = useWalletAddress();
  const active = navKey(path);
  return (
    <header className="top">
      <div className="wrap top-in">
        <Link className="brand" href="/" aria-label={`${BRAND.name} home`}>
          <Logo />
          {BRAND.name}
        </Link>
        <nav className="main" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.key} href={n.href} className={active === n.key ? "on" : undefined} aria-current={active === n.key ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className={"top-right" + (addr ? " has-wallet" : "")}>
          {addr && <SolBalance />}
          <WalletButton />
        </div>
      </div>
      <LiveStrip />
    </header>
  );
}

export function Footer() {
  const mode = useLive((s) => s.stats?.mode);
  return (
    <footer>
      <div className="wrap">
        <span>
          {BRAND.name} is not audited. Runs on Raydium LaunchLab.{mode === "mock" ? " This build shows simulated data." : ""}
        </span>
        <span>
          Coins are speculative and can go to zero, and the rules may change. <Link href="/terms">Terms</Link>
        </span>
      </div>
    </footer>
  );
}

export function Toasts() {
  const items = useToasts((s) => s.items);
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={"toast" + (t.bad ? " bad" : "") + (t.leaving ? " out" : "")}>
          <span className="ti">
            <Icon name={t.bad ? "warn" : "check"} />
          </span>
          <div>{t.body}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Keeps the connected wallet's rewards fresh and shows the buyback and payout
 * toasts from SPEC §8.
 */
function RewardsWatcher() {
  const addr = useWalletAddress();
  const load = useRewards((s) => s.load);
  const clear = useRewards((s) => s.clear);
  const prevAddr = useRef<string | null>(null);

  useEffect(() => {
    if (addr && addr !== prevAddr.current) {
      void load(addr).then(() => {
        const d = useRewards.getState().data;
        const n = d?.coins.filter((c) => BigInt(c.balance) > 0n).length ?? 0;
        if (d) toast(`Wallet connected. You hold ${n} ${n === 1 ? "coin" : "coins"} that ${n === 1 ? "earns" : "earn"} buybacks.`);
      });
    }
    if (!addr && prevAddr.current) clear();
    prevAddr.current = addr;
  }, [addr, load, clear]);

  useEffect(() => {
    if (!addr) return;
    let reloadT: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(reloadT);
      reloadT = setTimeout(() => void load(addr), 400);
    };
    const off = onLive((e: LiveEvent) => {
      const data = useRewards.getState().data;
      if (!data) return;
      if (e.type === "buyback") {
        const held = data.coins.find((c) => c.mint === e.buyback.coinMint && BigInt(c.balance) > 0n);
        if (!held) return;
        const mine = (BigInt(e.buyback.tokensBought) * BigInt(held.sharePpm)) / 1_000_000n;
        if (mine > 0n) {
          toast(
            <>
              Buyback on <b>${held.ticker}</b>. <b className="num">+{tokens(mine)}</b> added to your next payout.
            </>,
          );
        }
        reload();
      }
      if (e.type === "payout" && e.wallets.includes(addr)) {
        const paid = data.coins.filter((c) => BigInt(c.pending) > 0n);
        const usdTotal = paid.reduce((s, c) => s + (Number(BigInt(c.pending)) / 10 ** CURVE.decimals) * (c.priceUsd ?? 0), 0);
        if (paid.length) {
          toast(
            <>
              Payout landed: <b className="num">{usd(usdTotal)}</b> in {paid.map((c) => "$" + c.ticker).join(", ")} sent to your wallet.
            </>,
          );
        }
        reload();
      }
    });
    return () => {
      off();
      clearTimeout(reloadT);
    };
  }, [addr, load]);
  return null;
}

export function ShellExtras() {
  return (
    <>
      <Toasts />
      <WalletModal />
      <RewardsWatcher />
    </>
  );
}

export { short };
