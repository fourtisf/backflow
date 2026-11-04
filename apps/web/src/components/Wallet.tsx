"use client";

import { BRAND, short, solFixed } from "@backflow/core";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useRef, useState } from "react";
import { useSolBalance } from "@/lib/hooks";
import { toast, useUi } from "@/lib/store";
import { Icon } from "./Icon";

/** Wallets we list even when not installed: install pages on desktop, in-app browser deep links on phones. */
const SUGGESTED: { name: string; url: string; open: (page: string, origin: string) => string }[] = [
  { name: "Phantom", url: "https://phantom.com/download", open: (p, o) => `https://phantom.app/ul/browse/${encodeURIComponent(p)}?ref=${encodeURIComponent(o)}` },
  { name: "Solflare", url: "https://solflare.com/download", open: (p, o) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(p)}?ref=${encodeURIComponent(o)}` },
  { name: "Backpack", url: "https://backpack.app/downloads", open: (p, o) => `https://backpack.app/ul/v1/browse/${encodeURIComponent(p)}?ref=${encodeURIComponent(o)}` },
];

const isPhone = () => typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export function useWalletAddress(): string | null {
  const { publicKey } = useWallet();
  return publicKey ? publicKey.toBase58() : null;
}

export function SolBalance() {
  const { lamports } = useSolBalance();
  return (
    <div className="sol-bal num">
      Balance <b>{lamports == null ? "–" : solFixed(lamports, 2)}</b> SOL
    </div>
  );
}

export function WalletButton() {
  const { publicKey, disconnect, connecting, wallet } = useWallet();
  const open = useUi((s) => s.openWalletModal);
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const { lamports } = useSolBalance();

  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (!publicKey) {
    return (
      <button className="btn btn-ghost wallet-btn" onClick={open} disabled={connecting}>
        {connecting ? (
          <span>Connecting…</span>
        ) : (
          <>
            <span className="lbl-long">Connect wallet</span>
            <span className="lbl-short">Connect</span>
          </>
        )}
      </button>
    );
  }
  const addr = publicKey.toBase58();
  return (
    <div className="wallet-wrap" ref={wrap}>
      <button className="btn btn-ghost wallet-btn" aria-label={`Connected wallet ${short(addr)}`} aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((m) => !m)}>
        <span className="dot" />
        <span className="num">{short(addr)}</span>
      </button>
      {menu && (
        <div className="menu" role="menu">
          <div className="menu-h">
            {wallet?.adapter.name ?? "Wallet"}
            <b className="num">{lamports == null ? "–" : solFixed(lamports, 2)} SOL</b>
          </div>
          <a role="menuitem" href={`/u/${addr}`} onClick={() => setMenu(false)}>
            <Icon name="wallet" />
            Your profile
          </a>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false);
              navigator.clipboard?.writeText(addr).then(
                () => toast("Wallet address copied."),
                () => toast(`Wallet address: ${short(addr)}`),
              );
            }}
          >
            <Icon name="copy" />
            Copy address
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false);
              void disconnect();
            }}
          >
            <Icon name="out" />
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

export function WalletModal() {
  const { wallets, select, connected } = useWallet();
  const show = useUi((s) => s.walletModal);
  const close = useUi((s) => s.closeWalletModal);
  const first = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (connected && show) close();
  }, [connected, show, close]);

  useEffect(() => {
    if (!show) return;
    first.current?.focus();
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key !== "Tab" || !dialog.current) return;
      // keep focus inside the dialog
      const f = [...dialog.current.querySelectorAll<HTMLElement>("button, a[href]")].filter((el) => !el.hasAttribute("disabled"));
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [show, close]);

  if (!show) return null;

  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  const names = new Set(installed.map((w) => w.adapter.name as string));
  const missing = SUGGESTED.filter((s) => !names.has(s.name));

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="panel modal" role="dialog" aria-modal="true" aria-labelledby="wm-title" ref={dialog}>
        <div className="modal-h">
          <h3 id="wm-title">Connect a wallet</h3>
          <button className="x" onClick={close} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="wlist">
          {installed.map((w, i) => (
            <button
              key={w.adapter.name}
              ref={i === 0 ? first : undefined}
              className="witem"
              onClick={() => {
                select(w.adapter.name as WalletName);
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={w.adapter.icon} alt="" />
              {w.adapter.name}
              <span className="st on">Detected</span>
            </button>
          ))}
          {missing.map((s, i) => {
            const phone = isPhone();
            const href = phone ? s.open(location.href, location.origin) : s.url;
            return (
              <a key={s.name} className="witem" href={href} target={phone ? undefined : "_blank"} rel="noreferrer" ref={installed.length === 0 && i === 0 ? (first as never) : undefined}>
                <span className="wi-ph">
                  <Icon name="wallet" size={16} />
                </span>
                {s.name}
                <span className="st">{phone ? "Open in app" : "Install"}</span>
              </a>
            );
          })}
        </div>
        <p className="fine">{BRAND.name} never holds your funds. You sign every launch and trade in your own wallet.</p>
      </div>
    </div>
  );
}
