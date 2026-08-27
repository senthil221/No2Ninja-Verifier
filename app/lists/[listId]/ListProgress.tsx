"use client";

import { useEffect, useState } from "react";
import { approveList, retryFailedList, finishListWithoutN2b } from "@/app/actions";

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
  pendingN2b: number;
  pendingN2bReasons: { reason: string; count: number }[];
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
  const [retrying, setRetrying] = useState(false);
  const [finishing, setFinishing] = useState(false);

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
        <div className="review-panel">
          <div className="review-head">
            <span className="eyebrow">Step 2 of 2 — your decision</span>
            <h3>Mail Tester Ninja finished. Continue to NeverBounce?</h3>
          </div>

          <div className="review-split">
            <div>
              <div className="review-label">Already resolved — no further cost</div>
              <div className="review-figure num">{data.resolved}</div>
              <div className="meta">
                of {data.totalRows} rows, via cache and Mail Tester Ninja
              </div>
            </div>
            <div>
              <div className="review-label">Would cost NeverBounce credits</div>
              <div className="review-figure num accent">{data.pendingN2b}</div>
              <div className="meta">
                {data.pendingN2b === 1 ? "credit" : "credits"} to resolve the rest
              </div>
            </div>
          </div>

          {data.pendingN2bReasons.length > 0 && (
            <table className="reason-table">
              <thead>
                <tr>
                  <th>Why it's unresolved</th>
                  <th style={{ textAlign: "right" }}>Rows</th>
                </tr>
              </thead>
              <tbody>
                {data.pendingN2bReasons.map((r) => (
                  <tr key={r.reason}>
                    <td>{r.reason}</td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {r.count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="review-actions">
            <button
              disabled={approving || finishing}
              onClick={async () => {
                setApproving(true);
                await approveList(listId);
                setApproving(false);
              }}
            >
              {approving
                ? "Submitting…"
                : `Verify ${data.pendingN2b} with NeverBounce`}
            </button>
            <button
              className="btn-quiet"
              disabled={approving || finishing}
              onClick={async () => {
                setFinishing(true);
                await finishListWithoutN2b(listId);
                setFinishing(false);
              }}
            >
              {finishing ? "Finishing…" : "Finish without NeverBounce"}
            </button>
          </div>
          <div className="meta" style={{ marginTop: 8 }}>
            Finishing keeps every result found so far and spends nothing. Unresolved rows are
            marked <code>risky</code> (catch-all domains) or <code>unknown</code>, and the list
            becomes exportable.
          </div>
        </div>
      )}

      {data.status === "failed" && (
        <div className="error-banner" style={{ marginTop: 20 }}>
          This list stopped before finishing.
          {data.lastError && <div className="meta" style={{ marginTop: 4 }}>{data.lastError}</div>}
          <div className="meta" style={{ marginTop: 8 }}>
            Results already verified are kept — retrying resumes from where it stopped and
            re-checks nothing you've already paid for.
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              disabled={retrying || finishing}
              onClick={async () => {
                setRetrying(true);
                await retryFailedList(listId);
                setRetrying(false);
              }}
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
            <button
              className="btn-quiet"
              disabled={retrying || finishing}
              onClick={async () => {
                setFinishing(true);
                await finishListWithoutN2b(listId);
                setFinishing(false);
              }}
            >
              {finishing ? "Finishing…" : "Finish without NeverBounce"}
            </button>
          </div>
        </div>
      )}

      {(data.status === "completed" || data.status === "failed") && (
        <a href={`/api/lists/${listId}/export`} style={{ display: "inline-block", marginTop: 12 }}>
          <button>
            {data.status === "completed" ? "Download results CSV" : "Download partial results"}
          </button>
        </a>
      )}
    </div>
  );
}
