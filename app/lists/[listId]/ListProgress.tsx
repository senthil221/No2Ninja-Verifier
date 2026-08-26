"use client";

import { useEffect, useState } from "react";
import { approveList } from "@/app/actions";

interface StatusPayload {
  status: string;
  totalRows: number;
  resolved: number;
  stageCounts: Record<string, number>;
  byFinalStatus: Record<string, number>;
  bySource: Record<string, number>;
  n2bCreditsSpent: number;
  n2bBatches: { id: string; status: string; emailCount: number }[];
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "needs_approval"]);
const STATUS_COLORS: Record<string, string> = {
  valid: "var(--valid)",
  invalid: "var(--invalid)",
  risky: "var(--risky)",
  unknown: "var(--unknown)",
};

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

  if (!data) return <p className="meta">Loading progress…</p>;

  const pct = data.totalRows > 0 ? Math.round((data.resolved / data.totalRows) * 100) : 0;

  return (
    <div>
      <div className="progress-bar">
        {Object.entries(data.byFinalStatus).map(([status, count]) => (
          <span
            key={status}
            style={{
              width: `${(count / data.totalRows) * 100}%`,
              background: STATUS_COLORS[status] ?? "var(--unknown)",
            }}
          />
        ))}
      </div>
      <div className="meta">
        {data.resolved} / {data.totalRows} resolved ({pct}%)
      </div>

      <div className="stat-grid">
        {Object.entries(data.byFinalStatus).map(([status, count]) => (
          <div className="stat" key={status}>
            <div className="value">{count}</div>
            <div className="label">{status}</div>
          </div>
        ))}
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="value">{data.bySource.cache ?? 0}</div>
          <div className="label">from cache</div>
        </div>
        <div className="stat">
          <div className="value">{data.bySource.mtn ?? 0}</div>
          <div className="label">from MTN</div>
        </div>
        <div className="stat">
          <div className="value">{data.bySource.n2b ?? 0}</div>
          <div className="label">from N2B</div>
        </div>
        <div className="stat">
          <div className="value">{data.n2bCreditsSpent}</div>
          <div className="label">N2B credits</div>
        </div>
      </div>

      {data.status === "needs_approval" && (
        <div className="warning">
          This list's Pass 2 (NeverBounce) batch would exceed the configured single-list credit
          cap ({data.stageCounts.needs_n2b ?? 0} rows pending). Approve to proceed.
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

      {data.status === "completed" && (
        <a href={`/api/lists/${listId}/export`}>
          <button>Download results CSV</button>
        </a>
      )}
    </div>
  );
}
