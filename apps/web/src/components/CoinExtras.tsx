"use client";

import type { CoinDetail, HolderRiskDTO } from "@backflow/core";
import { useEffect, useState } from "react";
import { useApi } from "@/lib/api";
import { useFavorites } from "@/lib/favorites";
import { toast } from "@/lib/store";
import { apiPost } from "@/lib/tx";

const pctOf = (ppm: number) => `${(ppm / 10_000).toFixed(ppm < 10_000 ? 2 : 1)}%`;

/** Holder concentration signals (trader safety). Thresholds are guidance, not verdicts. */
export function RiskPanel({ mint }: { mint: string }) {
  const { data } = useApi<HolderRiskDTO>(`/coins/${mint}/risk`);
  if (!data) return null;
  const rows: { label: string; value: string; warn: boolean; note: string }[] = [
    { label: "Creator holds", value: pctOf(data.creatorPpm), warn: data.creatorPpm > 100_000, note: "over 10% can be dumped at once" },
    { label: "Top 10 holders", value: pctOf(data.top10Ppm), warn: data.top10Ppm > 500_000, note: "over 50% is concentrated" },
    { label: "Bought in the first minute", value: `${pctOf(data.earlyPpm)} · ${data.earlyWallets} wallets`, warn: data.earlyPpm > 200_000, note: "early bundles still holding" },
  ];
  const warnings = rows.filter((r) => r.warn);
  return (
    <div className="panel about">
      <h3>Holder info</h3>
      <div className="kv" style={{ marginTop: 10 }}>
        {rows.map((r) => (
          <div key={r.label}>
            <span>{r.label}</span>
            <b className={`num ${r.warn ? "down" : ""}`}>{r.value}</b>
          </div>
        ))}
        <div>
          <span>Wallets earning</span>
          <b className="num">{data.holders.toLocaleString("en-US")}</b>
        </div>
      </div>
      {warnings.length > 0 && (
        <p style={{ color: "var(--warn)" }}>Heads up: {warnings.map((w) => w.note).join("; ")}.</p>
      )}
    </div>
  );
}

export function StarButton({ mint }: { mint: string }) {
  const { mints, toggle, init } = useFavorites();
  useEffect(() => init(), [init]);
  const on = mints.includes(mint);
  return (
    <button className="soc" aria-pressed={on} aria-label={on ? "Remove from watchlist" : "Add to watchlist"} title={on ? "Remove from watchlist" : "Add to watchlist"} onClick={() => toggle(mint)} style={on ? { color: "var(--warn)" } : undefined}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z" />
      </svg>
    </button>
  );
}

export function ShareButton({ coin }: { coin: Pick<CoinDetail, "mint" | "ticker" | "name" | "paidToHoldersLamports"> }) {
  const share = async () => {
    const url = `${location.origin}/coin/${coin.mint}`;
    const text = `$${coin.ticker} pays its holders on every trade.`;
    try {
      if (navigator.share) {
        await navigator.share({ title: coin.name, text, url });
        return;
      }
    } catch {
      return; // cancelled
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied.");
    } catch {
      window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, "_blank", "noopener");
    }
  };
  return (
    <button className="soc" aria-label="Share" title="Share" onClick={() => void share()}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14" />
      </svg>
    </button>
  );
}

const REASONS = ["Scam or rug", "Impersonates someone", "Offensive image or name", "Spam", "Other"];

export function ReportButton({ mint }: { mint: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(REASONS[0]!);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await apiPost(`/coins/${encodeURIComponent(mint)}/report`, { reason });
      toast("Thanks. A moderator will take a look.");
      setOpen(false);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={() => setOpen(true)}>
        Report this coin
      </button>
    );
  return (
    <div className="btn-row" style={{ marginTop: 12 }}>
      <label className="sr" htmlFor="report-reason">
        Reason
      </label>
      <select id="report-reason" value={reason} onChange={(e) => setReason(e.target.value)} className="btn btn-ghost btn-sm" style={{ flex: 1 }}>
        {REASONS.map((r) => (
          <option key={r}>{r}</option>
        ))}
      </select>
      <button className="btn btn-sell btn-sm" disabled={busy} onClick={() => void send()}>
        Send report
      </button>
    </div>
  );
}
