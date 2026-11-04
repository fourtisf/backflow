"use client";

import { BRAND, short, solFixed } from "@backflow/core";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useWallet, type Wallet } from "@solana/wallet-adapter-react";
import { useEffect, useRef, useState } from "react";
import { useSolBalance } from "@/lib/hooks";
import { toast, useUi } from "@/lib/store";
import { WALLETS, catalogEntry, isPhone, useSavedWallets, walletIcon, type SavedWallet } from "@/lib/wallets";
import { Icon } from "./Icon";

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

/** A wallet's logo, or a plain wallet glyph when we don't know it. Decorative: the name is always next to it. */
export function WalletLogo({ name, icon, size = 30 }: { name: string | null | undefined; icon?: string | null; size?: number }) {
  const src = walletIcon(name, icon);
  const r = Math.round(size * 0.3);
  if (!src)
    return (
      <span className="wi-ph" style={{ width: size, height: size, borderRadius: r }} aria-hidden="true">
        <Icon name="wallet" size={Math.round(size * 0.55)} />
      </span>
    );
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="wlogo" src={src} alt="" width={size} height={size} style={{ borderRadius: r }} />;
}

const sameWallet = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && (a === b || (!!catalogEntry(a) && catalogEntry(a) === catalogEntry(b)));
const usable = (w: Wallet) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable;

/** Remembers every wallet that connects on this device, including account switches inside a wallet app. */
export function WalletSync() {
  const { publicKey, wallet } = useWallet();
  const load = useSavedWallets((s) => s.load);
  const add = useSavedWallets((s) => s.add);
  useEffect(() => load(), [load]);
  useEffect(() => {
    if (publicKey && wallet) add(publicKey.toBase58(), wallet.adapter.name);
  }, [publicKey, wallet, add]);
  return null;
}

/** Connect through a wallet app: disconnect the current one first when it's a different app. */
function useConnectVia() {
  const { wallet, select, disconnect, connected } = useWallet();
  return async (target: Wallet) => {
    if (connected && wallet && !sameWallet(wallet.adapter.name, target.adapter.name)) await disconnect().catch(() => {});
    select(target.adapter.name as WalletName); // autoConnect connects once it's selected
  };
}

/** Switch the active wallet to a saved one. */
export function useSwitchWallet() {
  const { wallet, wallets, publicKey } = useWallet();
  const connectVia = useConnectVia();
  return async (w: SavedWallet): Promise<boolean> => {
    if (publicKey?.toBase58() === w.address) return true;
    if (wallet && publicKey && sameWallet(wallet.adapter.name, w.name)) {
      toast(`Switch to ${short(w.address)} inside ${catalogEntry(w.name)?.name ?? w.name}. ${BRAND.name} follows the account selected there.`);
      return false;
    }
    const target = wallets.find((x) => sameWallet(x.adapter.name, w.name) && usable(x));
    if (!target) {
      toast(`${catalogEntry(w.name)?.name ?? w.name} isn't available in this browser.`, true);
      return false;
    }
    await connectVia(target);
    return true;
  };
}

export function WalletButton() {
  const { publicKey, disconnect, connecting, wallet } = useWallet();
  const open = useUi((s) => s.openWalletModal);
  const openAdd = useUi((s) => s.openAddWallet);
  const saved = useSavedWallets((s) => s.list);
  const remove = useSavedWallets((s) => s.remove);
  const switchTo = useSwitchWallet();
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
  const name = wallet?.adapter.name ?? "Wallet";
  const display = catalogEntry(name)?.name ?? name;
  const others = saved.filter((w) => w.address !== addr);
  return (
    <div className="wallet-wrap" ref={wrap}>
      <button className="btn btn-ghost wallet-btn" aria-label={`Connected with ${display}: ${short(addr)}`} aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((m) => !m)}>
        <WalletLogo name={name} icon={wallet?.adapter.icon} size={20} />
        <span className="num">{short(addr)}</span>
      </button>
      {menu && (
        <div className="menu wmenu" role="menu">
          <div className="menu-h wm-active">
            <WalletLogo name={name} icon={wallet?.adapter.icon} size={34} />
            <span>
              <span className="wm-title">
                {display} <span className="tag on">Active</span>
              </span>
              <b className="num">{short(addr)}</b>
              <span className="num">{lamports == null ? "–" : solFixed(lamports, 2)} SOL</span>
            </span>
          </div>
          {others.length > 0 && <div className="menu-sec">Your other wallets</div>}
          {others.map((w) => (
            <div className="wm-row" key={w.address}>
              <button
                role="menuitem"
                onClick={() => {
                  void switchTo(w).then((ok) => ok && setMenu(false));
                }}
              >
                <WalletLogo name={w.name} size={22} />
                <span className="wm-name">
                  {catalogEntry(w.name)?.name ?? w.name}
                  <span className="num">{short(w.address)}</span>
                </span>
                <span className="st">Switch</span>
              </button>
              <button className="wm-rm" aria-label={`Remove ${short(w.address)} from your wallets`} onClick={() => remove(w.address)}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false);
              openAdd();
            }}
          >
            <Icon name="plus" />
            Add another wallet
          </button>
          <div className="menu-sep" />
          <a role="menuitem" href={`/u/${addr}`} onClick={() => setMenu(false)}>
            <Icon name="user" />
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
  const { wallets, wallet, connected, publicKey } = useWallet();
  const show = useUi((s) => s.walletModal);
  const mode = useUi((s) => s.walletModalMode);
  const close = useUi((s) => s.closeWalletModal);
  const saved = useSavedWallets((s) => s.list);
  const switchTo = useSwitchWallet();
  const connectVia = useConnectVia();
  const dialog = useRef<HTMLDivElement>(null);
  const startAddr = useRef<string | null>(null);

  // close once a (new) wallet is connected
  useEffect(() => {
    if (show) startAddr.current = publicKey?.toBase58() ?? null;
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (show && connected && publicKey && publicKey.toBase58() !== startAddr.current) close();
  }, [connected, publicKey, show, close]);

  useEffect(() => {
    if (!show) return;
    const prev = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>("button.witem, a.witem")?.focus();
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

  const installed = wallets.filter(usable);
  // installed wallets in catalog order first, then any other installed wallet, then the rest of the catalog
  const known = WALLETS.map((c) => ({ c, w: installed.find((w) => catalogEntry(w.adapter.name) === c) }));
  const unknown = installed.filter((w) => !catalogEntry(w.adapter.name));
  const phone = isPhone();
  const current = publicKey?.toBase58();
  const pick = (w: Wallet) => {
    if (mode === "add" && connected && wallet && sameWallet(wallet.adapter.name, w.adapter.name)) {
      toast(`You're already connected with ${catalogEntry(w.adapter.name)?.name ?? w.adapter.name}. Switch the account inside the app, or pick another wallet.`);
      return;
    }
    void connectVia(w);
  };
  const quick = mode === "connect" ? saved.filter((s) => s.address !== current) : [];

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="panel modal" role="dialog" aria-modal="true" aria-labelledby="wm-title" ref={dialog}>
        <div className="modal-h">
          <h3 id="wm-title">{mode === "add" ? "Add another wallet" : "Connect a wallet"}</h3>
          <button className="x" onClick={close} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="wlist">
          {quick.length > 0 && <div className="wl-sec">Your wallets</div>}
          {quick.map((s) => (
            <button key={s.address} className="witem" onClick={() => void switchTo(s)}>
              <WalletLogo name={s.name} />
              <span className="wi-name">
                {catalogEntry(s.name)?.name ?? s.name}
                <span className="num">{short(s.address)}</span>
              </span>
              <span className="st">Connect</span>
            </button>
          ))}
          {quick.length > 0 && <div className="wl-sec">All wallets</div>}
          {known
            .filter((k) => k.w)
            .map(({ c, w }) => (
              <button key={c.key} className="witem" onClick={() => pick(w!)}>
                <WalletLogo name={c.name} icon={w!.adapter.icon} />
                <span className="wi-name">{c.name}</span>
                <span className="st on">{connected && wallet && sameWallet(wallet.adapter.name, w!.adapter.name) ? "Connected" : w!.readyState === WalletReadyState.Installed ? "Detected" : "Web wallet"}</span>
              </button>
            ))}
          {unknown.map((w) => (
            <button key={w.adapter.name} className="witem" onClick={() => pick(w)}>
              <WalletLogo name={w.adapter.name} icon={w.adapter.icon} />
              <span className="wi-name">{w.adapter.name}</span>
              <span className="st on">{w.readyState === WalletReadyState.Installed ? "Detected" : "Web wallet"}</span>
            </button>
          ))}
          {known
            .filter((k) => !k.w)
            .map(({ c }) => {
              const viaApp = phone && !!c.open;
              const href = viaApp ? c.open!(location.href, location.origin) : c.download;
              return (
                <a key={c.key} className="witem" href={href} target={viaApp ? undefined : "_blank"} rel="noreferrer">
                  <WalletLogo name={c.name} />
                  <span className="wi-name">{c.name}</span>
                  <span className="st">{viaApp ? "Open in app" : "Install"}</span>
                </a>
              );
            })}
        </div>
        <p className="fine">
          {mode === "add"
            ? `Each wallet you connect is remembered on this device, so you can switch between them from the wallet menu. ${BRAND.name} never holds your funds.`
            : `${BRAND.name} never holds your funds. You sign every launch and trade in your own wallet.`}
        </p>
      </div>
    </div>
  );
}
