"use client";

import { useApi } from "@/lib/api";

/** Public status: ok or down per component only; details stay on the server (`pnpm admin overview`). */
interface Status {
  status: "ok" | "degraded";
  api: string;
  mode: string;
  time: string;
  database?: "ok" | "down";
  indexerLagSeconds?: number | null;
  lookupTable?: "ok" | "degraded";
  workers: Record<string, "ok" | "down">;
}

const lag = (s: number) => (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);

export function StatusPage() {
  const { data, error, reload } = useApi<Status>("/status");
  const ok = (b: boolean, bad = "Down") => <span className={`pill ${b ? "off" : "on"}`}>{b ? "Operational" : bad}</span>;
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
            {data?.lookupTable && (
              <tr>
                <td>Transaction builder</td>
                <td className="r">{ok(data.lookupTable === "ok", "Degraded")}</td>
              </tr>
            )}
            {data && data.indexerLagSeconds !== undefined && (
              <tr>
                <td>Indexer lag</td>
                <td className="r num">{data.indexerLagSeconds == null ? "–" : lag(data.indexerLagSeconds)}</td>
              </tr>
            )}
            {data &&
              Object.entries(data.workers ?? {}).map(([name, w]) => (
                <tr key={name}>
                  <td style={{ textTransform: "capitalize" }}>{name} worker</td>
                  <td className="r">{ok(w === "ok")}</td>
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
