"use client";

import { useEffect, useState } from "react";
import { approveList } from "@/app/actions";

interface StatusPayload {
  status: string;
  lastError: string | null;
  totalRows: number;
  resolved: number;
  stageCounts: Record<string, number>;
  byFinalStatus: Record<string, number>;
  bySource: Record<string, number>;
  n2bCreditsSpent: number;
  n2bBatches: { id: string; status: string; emailCount: number }[];
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "needs_approval"]);
const STATUS_COLOR_VAR: Record<string, string> = {
  valid: "--valid",
  invalid: "--invalid",
  risky: "--risky",
  unknown: "--unknown",
};
const STATUS_ORDER = ["valid", "invalid", "risky", "unknown"];

export default function ListProgress({ listId }: { listId: string }) {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      const res = await fetch(`/api/lists/${listId}/status`, { cache: "no-store" });
      if (!res.ok || cancelled) return;
      const json: StatusPayload = await res.json();
      if (cancelled) return;
      setData(json);
      if (!TERMINAL_STATUSES.has(json.status)) {
        timer = setTimeout(poll, 3000);
      }
    }
    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [listId]);

  if (!data) return <p className="empty-state">Loading progress…</p>;

  const pct = data.totalRows > 0 ? Math.round((data.resolved / data.totalRows) * 100) : 0;
  const orderedStatuses = STATUS_ORDER.filter((s) => data.byFinalStatus[s]);

  return (
    <div>
      <div className="legend">
        {orderedStatuses.map((status) => (
          <div className="legend-item" key={status}>
            <span
              className="legend-dot"
              style={{ background: `var(${STATUS_COLOR_VAR[status]})` }}
            />
            <span className="num">{data.byFinalStatus[status]}</span> {status}
          </div>
        ))}
      </div>

      <div className="progress-track">
        {orderedStatuses.map((status) => (
          <span
            key={status}
            style={{
              width: `${(data.byFinalStatus[status]! / data.totalRows) * 100}%`,
              background: `var(${STATUS_COLOR_VAR[status]})`,
            }}
          />
        ))}
      </div>
      <p className="meta">
        <span className="num">{data.resolved}</span> / <span className="num">{data.totalRows}</span> resolved
        (<span className="num">{pct}</span>%)
      </p>

      <div className="stat-row">
        <div className="stat">
          <span className="value num">{data.bySource.cache ?? 0}</span>
          <span className="label">From cache</span>
        </div>
        <div className="stat">
          <span className="value num">{data.bySource.mtn ?? 0}</span>
          <span className="label">From MTN</span>
        </div>
        <div className="stat">
          <span className="value num">{data.bySource.n2b ?? 0}</span>
          <span className="label">From N2B</span>
        </div>
        <div className="stat">
          <span className="value num">{data.n2bCreditsSpent}</span>
          <span className="label">N2B credits</span>
        </div>
      </div>

      {data.status === "needs_approval" && (
        <div className="warning" style={{ marginTop: 20 }}>
          This list's Pass 2 (NeverBounce) batch would exceed the configured single-list credit
          cap (<span className="num">{data.stageCounts.needs_n2b ?? 0}</span> rows pending).
          Approve to proceed.
          <div style={{ marginTop: 10 }}>
            <button
              disabled={approving}
              onClick={async () => {
                setApproving(true);
                await approveList(listId);
                setApproving(false);
              }}
            >
              {approving ? "Submitting…" : "Approve N2B submission"}
            </button>
          </div>
        </div>
      )}

      {data.status === "failed" && (
        <div className="error-banner" style={{ marginTop: 20 }}>
          This list failed and won't retry automatically.
          {data.lastError && <div className="meta" style={{ marginTop: 4 }}>{data.lastError}</div>}
        </div>
      )}

      {data.status === "completed" && (
        <a href={`/api/lists/${listId}/export`} style={{ display: "inline-block", marginTop: 20 }}>
          <button>Download results CSV</button>
        </a>
      )}
    </div>
  );
}
