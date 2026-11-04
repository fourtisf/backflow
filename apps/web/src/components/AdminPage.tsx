"use client";

import { short, sol } from "@backflow/core";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL, ApiError } from "@/lib/api";
import { NO_SIGN_MESSAGE, signNonce } from "@/lib/auth";
import { apiPost } from "@/lib/tx";
import { toast, useUi } from "@/lib/store";
import { useWalletAddress } from "./Wallet";

type Json = Record<string, unknown>;
interface Session {
  wallet: string;
  token: string;
  expiresAt: number;
}

/**
 * Admin sign-in (audit M5): a signed, single-use nonce is exchanged for a 30-minute session token that the
 * server can revoke. The token lives in memory only (not sessionStorage), so a reload means signing in again.
 */
function useAdminAuth() {
  const addr = useWalletAddress();
  const wallet = useWallet();
  const [session, setSession] = useState<Session | null>(null);
  const ref = useRef<Session | null>(null);
  ref.current = session;
  useEffect(() => {
    if (ref.current && ref.current.wallet !== addr) setSession(null);
  }, [addr]);
  useEffect(() => {
    if (!session) return;
    const t = setTimeout(() => setSession(null), Math.max(0, session.expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, [session]);
  const signIn = useCallback(async (): Promise<Session | null> => {
    if (!addr || !wallet.signMessage) {
      toast(NO_SIGN_MESSAGE, true);
      return null;
    }
    try {
      const signed = await signNonce(wallet, "admin");
      const r = await apiPost<{ token: string; wallet: string; expiresAt: string }>("/admin/session", signed);
      const s = { wallet: r.wallet, token: r.token, expiresAt: Date.parse(r.expiresAt) };
      setSession(s);
      return s;
    } catch (e) {
      toast(e instanceof ApiError && e.status === 401 ? "That wallet isn't on the admin list, or the sign-in expired." : (e as Error).message, true);
      return null;
    }
  }, [addr, wallet]);
  const signOut = useCallback(async () => {
    const s = ref.current;
    setSession(null);
    if (s) await call(s.token, "POST", "/admin/logout").catch(() => {});
  }, []);
  return { addr, session, signIn, signOut, expire: () => setSession(null) };
}

async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(API_URL + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, "Can't reach the Backflow API.");
  }
  const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!r.ok) throw new ApiError(r.status, j.message ?? `Request failed (${r.status})`, j.error);
  return j as T;
}

export function AdminPage() {
  const openWallet = useUi((s) => s.openWalletModal);
  const { addr, session, signIn, signOut, expire } = useAdminAuth();
  const header = session?.token ?? null;
  const [overview, setOverview] = useState<Json | null>(null);
  const [coins, setCoins] = useState<Json[]>([]);
  const [excluded, setExcluded] = useState<Json[]>([]);
  const [claims, setClaims] = useState<Json[]>([]);
  const [failed, setFailed] = useState<Json | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exAddr, setExAddr] = useState("");
  const [exScope, setExScope] = useState("");

  const load = useCallback(async () => {
    if (!header) return;
    try {
      const [o, c, e, r, f] = await Promise.all([
        call<Json>(header, "GET", "/admin/overview"),
        call<Json[]>(header, "GET", "/admin/coins"),
        call<Json[]>(header, "GET", "/admin/excluded"),
        call<Json[]>(header, "GET", "/admin/reconcile"),
        call<Json>(header, "GET", "/admin/failed"),
      ]);
      setOverview(o);
      setCoins(c);
      setExcluded(e);
      setClaims(r);
      setFailed(f);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) expire();
      else setError((e as Error).message);
    }
  }, [header]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (method: string, path: string, body?: unknown, done?: string) => {
    if (!header) return;
    const run = (token: string) => call<{ note?: string }>(token, method, path, body);
    try {
      let r: { note?: string };
      try {
        r = await run(header);
      } catch (e) {
        // Resuming money movement and approving held claims need a sign-in from the last 5 minutes.
        if (!(e instanceof ApiError && e.code === "fresh_sign_in_required")) throw e;
        toast("Sign in again to confirm this action.");
        const fresh = await signIn();
        if (!fresh) return;
        r = await run(fresh.token);
      }
      toast(r.note ?? done ?? "Saved.");
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && e.code !== "fresh_sign_in_required") expire();
      toast((e as Error).message, true);
    }
  };

  const head = (
    <div className="page-head">
      <h1>Admin</h1>
      <p>Moderation, pause switches, hot wallets, reconciliation and failed jobs.</p>
    </div>
  );
  if (!addr)
    return (
      <div className="wrap">
        {head}
        <div className="panel gate">
          <h2>Connect an admin wallet</h2>
          <p>Only wallets on the admin list can use this page.</p>
          <button className="btn btn-primary btn-lg" onClick={openWallet}>
            Connect wallet
          </button>
        </div>
      </div>
    );
  if (!header)
    return (
      <div className="wrap">
        {head}
        <div className="panel gate">
          <h2>Sign in with {short(addr)}</h2>
          <p>Sign a message to prove you own this wallet. It costs nothing and sends nothing on chain.</p>
          <button className="btn btn-primary btn-lg" onClick={() => void signIn()}>
            Sign in
          </button>
        </div>
      </div>
    );

  const settings = (overview?.settings ?? {}) as Record<string, unknown>;
  const balances = (overview?.balances ?? {}) as Record<string, string | null>;
  const indexer = (overview?.indexer ?? {}) as { lagSlots?: number | null };
  const failedCounts = (overview?.failed ?? {}) as Record<string, number>;
  const paused = (k: string) => settings[k] === true;

  return (
    <div className="wrap" style={{ paddingBottom: 80 }}>
      {head}
      {error && (
        <div className="note warn" style={{ marginBottom: 16 }}>
          <span>{error}</span>
        </div>
      )}
      <div className="admin-grid">
        {(["buyback", "distributor", "claim", "treasury"] as const).map((w) => (
          <div className="panel" key={w}>
            <div className="k">{w === "claim" ? "Platform fee wallet" : w[0]!.toUpperCase() + w.slice(1)} SOL</div>
            <div className="v num">{balances[w] != null ? sol(balances[w]!) : "–"}</div>
          </div>
        ))}
        <div className="panel">
          <div className="k">Indexer lag</div>
          <div className="v num">{indexer.lagSlots == null ? "–" : `${indexer.lagSlots} slots`}</div>
        </div>
        <div className="panel">
          <div className="k">Buyback budgets</div>
          <div className="v num">{overview ? `${sol(String(overview.buybackBudgets))} SOL` : "–"}</div>
        </div>
        <div className="panel">
          <div className="k">Unclaimed platform fees</div>
          <div className="v num">{overview ? `${sol(String(overview.unclaimedPlatformFees))} SOL` : "–"}</div>
        </div>
        <div className="panel">
          <div className="k">Failed in 24h</div>
          <div className="v num">{Object.values(failedCounts).reduce((a, b) => a + b, 0)}</div>
        </div>
      </div>

      <div className="sec-title">
        <h2>Switches</h2>
        <button className="btn btn-ghost btn-sm" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
      <div className="panel panel-pad admin-row">
        {(["buybacks", "payouts"] as const).map((k) => {
          const on = paused(`${k}_paused`);
          return (
            <span key={k} className="admin-row" style={{ flex: "none" }}>
              <b style={{ textTransform: "capitalize" }}>{k}</b>
              <span className={`pill ${on ? "on" : "off"}`}>{on ? "Paused" : "Running"}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => void act("POST", "/admin/pause", { kind: k, paused: !on }, on ? `Resumed ${k}.` : `Paused ${k}.`)}>
                {on ? "Resume" : "Pause"}
              </button>
            </span>
          );
        })}
      </div>

      <div className="sec-title">
        <h2>Coins</h2>
      </div>
      <div className="panel scroll-x">
        <table className="tbl">
          <thead>
            <tr>
              <th>Coin</th>
              <th className="hide-m">Status</th>
              <th className="r hide-m">Budget</th>
              <th>Visibility</th>
              <th className="r">Actions</th>
            </tr>
          </thead>
          <tbody>
            {coins.map((c) => (
              <tr key={String(c.mint)}>
                <td>
                  <b>${String(c.ticker)}</b> <span className="muted num">{short(String(c.mint))}</span>
                  {!c.launchedViaUs && <span className="tag dim" style={{ marginLeft: 6 }}>Other frontend</span>}
                  {Number(c.reports) > 0 && <span className="pill on" style={{ marginLeft: 6 }}>{String(c.reports)} reports</span>}
                </td>
                <td className="hide-m">{String(c.status).toLowerCase()}</td>
                <td className="r num hide-m">{sol(String(c.buybackBudget))} SOL</td>
                <td>{c.hidden ? <span className="pill on">Hidden{c.hiddenReason ? `: ${String(c.hiddenReason)}` : ""}</span> : <span className="pill off">Visible</span>}</td>
                <td className="r">
                  <span className="admin-row" style={{ justifyContent: "flex-end" }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        const reason = c.hidden ? "" : window.prompt("Reason for hiding this coin?") ?? "";
                        void act("POST", `/admin/coins/${String(c.mint)}/hide`, { hidden: !c.hidden, reason });
                      }}
                    >
                      {c.hidden ? "Unhide" : "Hide"}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => void act("POST", "/admin/pause", { kind: "buybacks", scope: c.mint, paused: !c.buybacksPaused })}>
                      {c.buybacksPaused ? "Resume buybacks" : "Pause buybacks"}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => void act("POST", "/admin/pause", { kind: "payouts", scope: c.mint, paused: !c.payoutsPaused })}>
                      {c.payoutsPaused ? "Resume payouts" : "Pause payouts"}
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {!coins.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No coins yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="sec-title">
        <h2>Excluded accounts</h2>
      </div>
      <div className="panel panel-pad">
        <div className="admin-row">
          <input aria-label="Address to exclude" placeholder="Wallet address" value={exAddr} onChange={(e) => setExAddr(e.target.value.trim())} />
          <input aria-label="Coin mint (empty = all coins)" placeholder="Coin mint, or empty for all coins" value={exScope} onChange={(e) => setExScope(e.target.value.trim())} />
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              void act("POST", "/admin/excluded", { address: exAddr, scope: exScope || "global", reason: "manual" }, "Excluded.");
              setExAddr("");
            }}
          >
            Exclude
          </button>
        </div>
        <table className="tbl" style={{ marginTop: 12 }}>
          <tbody>
            {excluded.map((x) => (
              <tr key={`${String(x.address)}|${String(x.scope)}`}>
                <td className="num">{short(String(x.address))}</td>
                <td className="muted">{x.scope === "global" ? "All coins" : short(String(x.scope))}</td>
                <td className="muted hide-m">{String(x.reason)}</td>
                <td className="r">
                  <button className="btn btn-ghost btn-sm" onClick={() => void act("DELETE", `/admin/excluded?address=${encodeURIComponent(String(x.address))}&scope=${encodeURIComponent(String(x.scope))}`, undefined, "Removed.")}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sec-title">
        <h2>Reconciliation</h2>
      </div>
      <div className="panel scroll-x">
        <table className="tbl">
          <thead>
            <tr>
              <th>Claim</th>
              <th className="r">Claimed</th>
              <th className="r">Accrued</th>
              <th className="r">Mismatch</th>
              <th>Stage</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {claims.map((c) => (
              <tr key={String(c.id)}>
                <td className="num muted">{new Date(String(c.createdAt)).toLocaleString()}</td>
                <td className="r num">{sol(String(c.claimedLamports))}</td>
                <td className="r num">{sol(String(c.expectedLamports))}</td>
                <td className="r num">{c.mismatchPpm == null ? "–" : `${(Number(c.mismatchPpm) / 10_000).toFixed(2)}%`}</td>
                <td>{String(c.stage)}</td>
                <td className="r">
                  {c.stage === "held" && (
                    <button className="btn btn-ghost btn-sm" onClick={() => void act("POST", "/admin/retry", { kind: "claim", id: c.id })}>
                      Approve and transfer
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!claims.length && (
              <tr>
                <td colSpan={6} className="muted">
                  No vault claims yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="sec-title">
        <h2>Failed jobs and alerts</h2>
      </div>
      <div className="panel scroll-x">
        <table className="tbl">
          <tbody>
            {((failed?.logs ?? []) as Json[]).slice(0, 40).map((l) => (
              <tr key={String(l.id)}>
                <td className="num muted">{new Date(String(l.createdAt)).toLocaleString()}</td>
                <td>{String(l.job)}</td>
                <td>{String(l.level)}</td>
                <td>{String(l.message)}</td>
              </tr>
            ))}
            {!((failed?.logs ?? []) as Json[]).length && (
              <tr>
                <td className="muted">Nothing has failed.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
