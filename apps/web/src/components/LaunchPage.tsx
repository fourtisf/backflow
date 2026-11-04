"use client";

import {
  COPY,
  LAUNCH_LIMITS,
  RATES,
  SOL_DECIMALS,
  normalizeTicker,
  parseUnits,
  solFixed,
  usd,
  validateName,
  validateTicker,
  type TickerAvailability,
} from "@backflow/core";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiGet } from "@/lib/api";
import { NO_SIGN_MESSAGE, signNonce } from "@/lib/auth";
import { apiPost, apiUpload, signAndSend, useFeeCopy } from "@/lib/tx";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useRouter } from "next/navigation";
import type { LaunchTxDTO } from "@backflow/core";
import { hashSeed } from "@/lib/art";
import { useSolBalance } from "@/lib/hooks";
import { toast, useLive, useUi } from "@/lib/store";
import { Icon } from "./Icon";
import { Avatar, Ring } from "./ui";
import { useWalletAddress } from "./Wallet";

interface Draft {
  name: string;
  ticker: string;
  desc: string;
  img: string | null;
  x: string;
  tg: string;
  web: string;
  first: string;
}
const EMPTY: Draft = { name: "", ticker: "", desc: "", img: null, x: "", tg: "", web: "", first: "" };
const TICKER_HINT = "Letters and numbers only.";

/** Slider position (0–100) → volume in USD, as in the prototype. */
function volumeAt(pos: number): number {
  return Math.round((10000 * Math.pow(10, (pos / 100) * 2.7)) / 1000) * 1000;
}

export function LaunchPage() {
  const addr = useWalletAddress();
  const openWallet = useUi((s) => s.openWalletModal);
  const { lamports: solBal } = useSolBalance();
  const [d, setD] = useState<Draft>(EMPTY);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [tickerErr, setTickerErr] = useState<string | null>(null);
  const [firstErr, setFirstErr] = useState<string | null>(null);
  const [avail, setAvail] = useState<TickerAvailability | null>(null);
  const [vol, setVol] = useState(45);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const isLive = useLive((s) => s.stats?.mode === "live");
  const wallet = useWallet();
  const { connection } = useConnection();
  const router = useRouter();
  const fee = useFeeCopy();
  // Launch token from a signed "launch" message (15 minutes). Memory only, never stored in the browser.
  const launchSession = useRef<{ wallet: string; token: string; expiresAt: number } | null>(null);

  const launchToken = async (): Promise<string> => {
    const s = launchSession.current;
    if (s && s.wallet === addr && s.expiresAt - Date.now() > 60_000) return s.token;
    setBusy("Sign the message in your wallet…");
    const signed = await signNonce(wallet, "launch");
    const r = await apiPost<{ token: string; expiresAt: string }>("/launch/session", signed);
    launchSession.current = { wallet: signed.wallet, token: r.token, expiresAt: Date.parse(r.expiresAt) };
    return r.token;
  };

  const set = (k: keyof Draft, v: string | null) => setD((p) => ({ ...p, [k]: v }));

  // Ticker uniqueness, checked against the API as you type.
  useEffect(() => {
    setAvail(null);
    if (!d.ticker) return;
    const ac = new AbortController();
    const t = setTimeout(() => {
      apiGet<TickerAvailability>(`/tickers/${encodeURIComponent(d.ticker)}/available`, ac.signal)
        .then(setAvail)
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [d.ticker]);

  const dup = avail && !avail.available && avail.ticker === d.ticker ? avail.reason : null;
  const pvSeed = hashSeed((d.name || "backflow") + (d.ticker || ""));
  const volume = volumeAt(vol);

  const onImage = (f: File | undefined) => {
    if (!f) return;
    if (!LAUNCH_LIMITS.imageTypes.includes(f.type)) {
      toast("Use a PNG, JPG, GIF or WebP image.", true);
      return;
    }
    if (f.size > LAUNCH_LIMITS.imageMaxBytes) {
      toast("That image is over 4 MB. Choose a smaller one.", true);
      return;
    }
    setFile(f);
    const rd = new FileReader();
    rd.onload = () => set("img", String(rd.result));
    rd.readAsDataURL(f);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addr) {
      openWallet();
      return;
    }
    let bad = false;
    const ne = validateName(d.name);
    setNameErr(ne);
    if (ne) bad = true;
    const te = validateTicker(d.ticker);
    setTickerErr(te);
    if (te || dup) bad = true;
    setFirstErr(null);
    let firstLamports = 0n;
    if (d.first.trim()) {
      const first = parseUnits(d.first, SOL_DECIMALS);
      if (first != null) firstLamports = first;
      if (first == null) {
        setFirstErr("Enter a number, like 0.5.");
        bad = true;
      } else if (solBal != null && first > solBal) {
        setFirstErr(`You have ${solFixed(solBal, 2)} SOL. Lower the first buy.`);
        bad = true;
      }
    }
    if (bad) {
      requestAnimationFrame(() => (form.current?.querySelector(".bad") as HTMLElement | null)?.focus());
      return;
    }
    if (!isLive) {
      toast("Launching isn't live yet in this build. Nothing was sent.");
      return;
    }
    if (!file) {
      toast("Add an image for your coin.", true);
      return;
    }
    if (!wallet.signMessage) {
      toast(NO_SIGN_MESSAGE, true);
      return;
    }
    try {
      const token = await launchToken();
      const auth = { "x-launch-token": token };
      setBusy("Uploading image…");
      const fd = new FormData();
      fd.append("name", d.name.trim());
      fd.append("ticker", d.ticker);
      fd.append("description", d.desc.trim());
      fd.append("x", d.x);
      fd.append("telegram", d.tg);
      fd.append("website", d.web);
      fd.append("image", file, file.name);
      const meta = await apiUpload<{ uri: string }>("/launch/metadata", fd, auth);
      setBusy("Confirm in your wallet…");
      const built = await apiPost<LaunchTxDTO>("/launch/tx", { creator: addr, name: d.name.trim(), ticker: d.ticker, uri: meta.uri, firstBuyLamports: firstLamports.toString(), slippageBps: 100 }, auth);
      await signAndSend(wallet, connection, built.tx);
      toast(
        <>
          <b>${d.ticker} is live.</b> You earn {fee.creator} of every trade.
        </>,
      );
      setD(EMPTY);
      setFile(null);
      router.push(`/coin/${built.mint}?new=1`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "launch_session_required") launchSession.current = null;
      toast((err as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  const tickerHint = tickerErr ?? dup ?? TICKER_HINT;
  const tickerBad = !!(tickerErr || dup);

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Launch a coin that pays its holders</h1>
        <p>Free to launch. Every trade of your coin pays {fee.creator} to you and buys your coin back for the people holding it.</p>
      </div>
      <div className="launch-grid">
        <form className="panel" ref={form} noValidate onSubmit={(e) => void submit(e)}>
          <div className="step">
            <div className="step-h">
              <span className="n">1</span>
              <h3>Name and image</h3>
            </div>
            <div className="drop">
              <Avatar seed={pvSeed} imageUri={d.img} size={96} localPreview />
              <div className="drop-txt">
                PNG, JPG, GIF or WebP, up to 4 MB. Square works best.
                <br />
                <label className="btn btn-ghost" style={{ cursor: "pointer" }}>
                  <Icon name="img" size={16} />
                  Upload image
                  <input type="file" accept={LAUNCH_LIMITS.imageTypes.join(",")} className="sr" onChange={(e) => onImage(e.target.files?.[0])} />
                </label>
              </div>
            </div>
            <div className="f-grid" style={{ marginTop: 18 }}>
              <div className="f">
                <label htmlFor="fName">
                  <span>Name</span>
                  <span className="num">
                    {d.name.length}/{LAUNCH_LIMITS.nameMax}
                  </span>
                </label>
                <input
                  id="fName"
                  maxLength={LAUNCH_LIMITS.nameMax}
                  placeholder="Mochi"
                  value={d.name}
                  className={nameErr ? "bad" : undefined}
                  onChange={(e) => {
                    set("name", e.target.value);
                    setNameErr(null);
                  }}
                />
                <span className={"hint" + (nameErr ? " bad" : "")}>{nameErr ?? ""}</span>
              </div>
              <div className="f">
                <label htmlFor="fTicker">
                  <span>Ticker</span>
                  <span className="num">
                    {d.ticker.length}/{LAUNCH_LIMITS.tickerMax}
                  </span>
                </label>
                <input
                  id="fTicker"
                  maxLength={LAUNCH_LIMITS.tickerMax}
                  placeholder="MOCHI"
                  value={d.ticker}
                  autoCapitalize="characters"
                  className={tickerBad ? "bad" : undefined}
                  onChange={(e) => {
                    set("ticker", normalizeTicker(e.target.value));
                    setTickerErr(null);
                  }}
                />
                <span className={"hint" + (tickerBad ? " bad" : "")}>{tickerHint}</span>
              </div>
              <div className="f full">
                <label htmlFor="fDesc">
                  <span>Description</span>
                  <span className="num">
                    {d.desc.length}/{LAUNCH_LIMITS.descriptionMax}
                  </span>
                </label>
                <textarea id="fDesc" maxLength={LAUNCH_LIMITS.descriptionMax} placeholder="What is it, in one or two lines?" value={d.desc} onChange={(e) => set("desc", e.target.value)} />
              </div>
            </div>
          </div>
          <div className="step">
            <div className="step-h">
              <span className="n">2</span>
              <h3>Links</h3>
              <span className="opt">Optional</span>
            </div>
            <div className="f-grid">
              <div className="f">
                <label htmlFor="fX">X</label>
                <input id="fX" placeholder="x.com/yourcoin" value={d.x} onChange={(e) => set("x", e.target.value)} />
              </div>
              <div className="f">
                <label htmlFor="fTg">Telegram</label>
                <input id="fTg" placeholder="t.me/yourcoin" value={d.tg} onChange={(e) => set("tg", e.target.value)} />
              </div>
              <div className="f full">
                <label htmlFor="fWeb">Website</label>
                <input id="fWeb" placeholder="yourcoin.xyz" value={d.web} onChange={(e) => set("web", e.target.value)} />
              </div>
            </div>
          </div>
          <div className="step">
            <div className="step-h">
              <span className="n">3</span>
              <h3>First buy</h3>
              <span className="opt">Optional</span>
            </div>
            <div className="f">
              <label htmlFor="fFirst">
                <span>Buy your own coin in the launch transaction</span>
                <span className="num">{addr && solBal != null ? `Balance ${solFixed(solBal, 2)} SOL` : ""}</span>
              </label>
              <div className="amt">
                <input
                  id="fFirst"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={d.first}
                  className={firstErr ? "bad" : undefined}
                  onChange={(e) => {
                    set("first", e.target.value);
                    setFirstErr(null);
                  }}
                />
                <span className="unit">SOL</span>
              </div>
              <span className={"hint" + (firstErr ? " bad" : "")}>{firstErr ?? "Lands in the same transaction as the launch, before anyone else can buy."}</span>
            </div>
          </div>
          <div className="launch-foot">
            <span className="cost">
              <b>No launch fee.</b> You pay Solana network fees and account rent (about 0.03 SOL).
            </span>
            <button className="btn btn-primary btn-lg" type="submit" disabled={!!busy}>
              {busy ?? (addr ? "Launch coin" : "Connect wallet to launch")}
            </button>
          </div>
        </form>
        <aside className="rail stick">
          <div className="panel preview">
            <h3>Preview</h3>
            <div className="sub">How your coin shows up on the list.</div>
            <div className="pv-card">
              <Avatar seed={pvSeed} imageUri={d.img} size={56} localPreview />
              <div style={{ minWidth: 0 }}>
                <div className="nm">{d.name || "Your coin"}</div>
                <div className="tk">${d.ticker || "TICKER"}</div>
              </div>
              <span style={{ marginLeft: "auto" }}>
                <Ring value={0} size={36} stroke={12} />
              </span>
            </div>
            <div className="pv-desc">{d.desc || <span style={{ color: "var(--mist-2)" }}>Your description shows here.</span>}</div>
          </div>
          <div className="panel calc">
            <h3>What you earn as creator</h3>
            <div className="sub">Drag to set your coin&apos;s total trading volume.</div>
            <input type="range" min={0} max={100} value={vol} aria-label="Trading volume" onChange={(e) => setVol(Number(e.target.value))} />
            <div className="vol">
              <span className="muted">Trading volume</span>
              <b className="num">{usd(volume)}</b>
            </div>
            <div className="earn">
              <div className="me">
                <span className="sw c-crea" />
                <span>You, at {COPY.creator}</span>
                <b className="num">{usd((volume * Number(RATES.creatorFeePpm)) / 1e6)}</b>
              </div>
              <div>
                <span className="sw c-hold" />
                <span>Bought back for holders, {COPY.holders}</span>
                <b className="num">{usd((volume * Number(RATES.holdersPpm)) / 1e6)}</b>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
