"use client";

import { useApi } from "@/lib/api";
import { Ago } from "./ui";

interface Status {
  api: string;
  mode: string;
  time: string;
  database?: string;
  indexerLagSlots?: number | null;
  workers: Record<string, { healthy: boolean; lastOkAt: string | null; note: string | null }>;
}

export function StatusPage() {
  const { data, error, reload } = useApi<Status>("/status");
  const ok = (b: boolean) => <span className={`pill ${b ? "off" : "on"}`}>{b ? "Operational" : "Down"}</span>;
  return (
    <div className="wrap" style={{ paddingBottom: 80 }}>
      <div className="page-head">
        <h1>Status</h1>
        <p>Live health of the Backflow services. Buybacks and payouts keep their own records and pick up where they stopped after an outage.</p>
      </div>
      <div className="panel scroll-x">
        <table className="tbl">
          <tbody>
            <tr>
              <td>API</td>
              <td className="r">{error ? ok(false) : data ? ok(true) : "…"}</td>
            </tr>
            {data?.database && (
              <tr>
                <td>Database</td>
                <td className="r">{ok(data.database === "ok")}</td>
              </tr>
            )}
            {data && data.indexerLagSlots !== undefined && (
              <tr>
                <td>Indexer lag</td>
                <td className="r num">{data.indexerLagSlots == null ? "–" : `${data.indexerLagSlots} slots`}</td>
              </tr>
            )}
            {data &&
              Object.entries(data.workers).map(([name, w]) => (
                <tr key={name}>
                  <td style={{ textTransform: "capitalize" }}>
                    {name} worker
                    {w.note ? <span className="dash-reason">{w.note}</span> : null}
                  </td>
                  <td className="r">
                    {ok(w.healthy)}{" "}
                    {w.lastOkAt ? (
                      <span className="muted num">
                        <Ago at={w.lastOkAt} />
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <button className="btn btn-ghost btn-sm" style={{ marginTop: 14 }} onClick={reload}>
        Refresh
      </button>
    </div>
  );
}
