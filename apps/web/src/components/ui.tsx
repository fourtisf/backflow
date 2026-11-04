"use client";

import {
  FEE_SEGMENTS,
  UI,
  ago,
  mmss,
  pct,
  progress,
  tokens,
  usd,
  type BuybackDTO,
  type CoinRow,
} from "@backflow/core";
import { useEffect, useRef, useState } from "react";
import { art } from "@/lib/art";
import { useNow, usePayoutCountdown } from "@/lib/hooks";
import { onLive } from "@/lib/store";
import { Icon } from "./Icon";

/* --------------------------------- avatar --------------------------------- */

export function Avatar({ seed, imageUri, size, round }: { seed: number; imageUri?: string | null; size: number; round?: boolean }) {
  const style = { width: size, height: size, ...(round ? { borderRadius: "50%" } : null) };
  if (imageUri) {
    return (
      <span className="av" style={style}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUri} alt="" />
      </span>
    );
  }
  return <span className="av" style={style} dangerouslySetInnerHTML={{ __html: art(seed) }} />;
}

export function CoinAvatar({ coin, size, round }: { coin: Pick<CoinRow, "avatarSeed" | "imageUri">; size: number; round?: boolean }) {
  return <Avatar seed={coin.avatarSeed} imageUri={coin.imageUri} size={size} round={round} />;
}

/* ---------------------------------- ring ---------------------------------- */

const CIRC = 2 * Math.PI * 44;

/** Vault ring. Pulses when a buyback lands for `mint`. */
export function Ring({ mint, value, size, stroke, children, title }: { mint?: string; value: number; size: number; stroke: number; children?: React.ReactNode; title?: string }) {
  const [fired, setFired] = useState(false);
  useEffect(() => {
    if (!mint) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onLive((e) => {
      if (e.type === "buyback" && e.buyback.coinMint === mint) {
        setFired(false);
        requestAnimationFrame(() => setFired(true));
        clearTimeout(t);
        t = setTimeout(() => setFired(false), 1000);
      }
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [mint]);
  const v = Math.max(0, Math.min(1, value));
  return (
    <span className={"ringbox" + (fired ? " fired" : "")} style={{ width: size, height: size }} title={title}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <circle cx="50" cy="50" r="44" className="ring-track" strokeWidth={stroke} />
        <circle
          cx="50"
          cy="50"
          r="44"
          className="ring-fill"
          strokeWidth={stroke}
          strokeDasharray={CIRC.toFixed(2)}
          strokeDashoffset={(CIRC * (1 - v)).toFixed(2)}
          transform="rotate(-90 50 50)"
        />
      </svg>
      {children != null && <span className="ring-c">{children}</span>}
    </span>
  );
}

/* --------------------------------- spark ---------------------------------- */

export function Spark({ data, w, h }: { data: number[]; w: number; h: number }) {
  if (!data || data.length < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of data) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const rg = hi - lo || hi * 0.01 || 1;
  const d = "M" + data.map((v, i) => ((i / (data.length - 1)) * w).toFixed(1) + " " + (h - 3 - ((v - lo) / rg) * (h - 8)).toFixed(1)).join("L");
  const up = data[data.length - 1]! >= data[0]!;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${d}L${w} ${h}L0 ${h}Z`} fill={`url(#${up ? "gUp" : "gDn"})`} />
      <path d={d} fill="none" stroke={up ? "#3DDC97" : "#FF5C7A"} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------- fee split --------------------------------- */

export function FeeBar() {
  const label = "Fee split: " + FEE_SEGMENTS.map((s) => `${s.label.toLowerCase()} ${s.pct}`).join(", ");
  return (
    <div className="fbar" role="img" aria-label={label}>
      {FEE_SEGMENTS.map((s) => (
        <span key={s.key} className={`c-${s.key}`} style={{ flex: Number(s.ppm) }} />
      ))}
    </div>
  );
}

export function FeeLegend() {
  return (
    <div className="flegend">
      {FEE_SEGMENTS.map((s) => (
        <div key={s.key}>
          <span className={`sw c-${s.key}`} />
          {s.label} <b className="num">{s.pct}</b>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------- market data bits ----------------------------- */

/** Market cap that flashes green/red on moves above the configured threshold. */
export function Mcap({ value, as: Tag = "span", className, id }: { value: number | null; as?: "span" | "b" | "div"; className?: string; id?: string }) {
  const ref = useRef<HTMLElement | null>(null);
  const prev = useRef<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || value == null) return;
    const p = prev.current;
    if (p == null) {
      prev.current = value;
      return;
    }
    if (p > 0 && Math.abs(value - p) / p > UI.priceMoveFlashPpm / 1e6) {
      el.classList.remove("fu", "fd");
      void el.offsetWidth;
      el.classList.add(value >= p ? "fu" : "fd");
      prev.current = value;
    }
  }, [value]);
  return (
    <Tag ref={ref as never} className={className} id={id}>
      {usd(value)}
    </Tag>
  );
}

export function Change({ value, style }: { value: number | null; style?: React.CSSProperties }) {
  return (
    <span className={`num ${value != null && value < 0 ? "down" : "up"}`} style={style}>
      {pct(value)}
    </span>
  );
}

export function Ago({ at }: { at: string | number }) {
  const now = useNow(5000);
  const t = typeof at === "number" ? at : Date.parse(at);
  return <>{ago(t, Math.max(now, t))}</>;
}

export function PayoutCountdown() {
  const s = usePayoutCountdown();
  return <>{s == null ? "–" : mmss(s)}</>;
}

export function CurveCell({ coin }: { coin: CoinRow }) {
  if (coin.status !== "curve") {
    return (
      <span className="tag">
        <Icon name="lock" size={12} />
        On Raydium
      </span>
    );
  }
  const p = progress(coin.curveQuoteLamports, coin.graduationTargetLamports) * 100;
  return (
    <div className="curve-cell">
      <div className="cbar">
        <i style={{ width: p.toFixed(1) + "%" }} />
      </div>
      <span className="num">{p.toFixed(0)}% to Raydium</span>
    </div>
  );
}

export function vaultRatio(coin: Pick<CoinRow, "buybackBudgetLamports">, thresholdLamports: bigint): number {
  return progress(coin.buybackBudgetLamports, thresholdLamports);
}

export function TickerItem({ e, isNew }: { e: BuybackDTO; isNew?: boolean }) {
  return (
    <a className={"tk-item" + (isNew ? " new" : "")} href={`/coin/${e.coinMint}`}>
      <Avatar seed={e.avatarSeed} imageUri={e.imageUri} size={22} round />
      <b>${e.ticker}</b>
      <span className="g num">+{tokensCompact(e.tokensBought)}</span>
      <span>to {e.holderCount.toLocaleString("en-US")} holders</span>
      <span className="num" style={{ color: "var(--mist-2)" }}>
        <Ago at={e.createdAt} />
      </span>
    </a>
  );
}

/** Token base units (string) → compact number ("18.40M"), using the coin decimals from config. */
export function tokensCompact(v: string | bigint): string {
  return tokens(v);
}

/** A dash plus a short reason, for missing data (SPEC §5). */
export function Dash({ reason }: { reason?: string | null }) {
  return (
    <>
      –{reason ? <span className="dash-reason">{reason}</span> : null}
    </>
  );
}
