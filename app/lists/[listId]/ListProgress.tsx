"use client";

import { useCallback, useEffect, useState } from "react";
import {
  approveList,
  retryFailedList,
  finishListWithoutN2b,
  beginVerification,
} from "@/app/actions";

interface StatusPayload {
  status: string;
  lastError: string | null;
  totalRows: number;
  resolved: number;
  stageCounts: Record<string, number>;
  byFinalStatus: Record<string, number>;
  bySource: Record<string, number>;
  n2bCreditsSpent: number;
  throughput: { perSecond: number; etaSeconds: number | null };
  pendingN2b: number;
  pendingN2bReasons: { reason: string; count: number }[];
  preflight: {
    sourceRowCount: number;
    skippedInvalid: number;
    skippedDupes: number;
    knownFromCache: number;
    toVerify: number;
  };
  breakdown: {
    mtnMessage: string;
    stage: string;
    finalStatus: string | null;
    count: number;
    escalates: boolean;
  }[];
}

// Statuses where nothing moves without a person acting. Polling pauses here
// to avoid pointless requests, and every action resumes it -- forgetting
// that is what previously left the page frozen after "Start verification".
const AWAITING_ACTION = new Set(["pending", "needs_approval", "failed"]);
const FINISHED = new Set(["completed"]);

const STATUS_COLOR_VAR: Record<string, string> = {
  valid: "--valid",
  invalid: "--invalid",
  risky: "--risky",
  unknown: "--unknown",
};
const STATUS_ORDER = ["valid", "invalid", "risky", "unknown"];

const STATUS_MEANING: Record<string, string> = {
  valid: "Mailbox confirmed. Safe to send.",
  invalid: "Confirmed undeliverable. Remove before sending.",
  risky: "Catch-all domain — accepts anything, so delivery is unconfirmed.",
  unknown: "Could not be determined by either provider.",
};

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

const STEPS = [
  { key: "preflight", label: "Pre-flight" },
  { key: "mtn", label: "Mail Tester Ninja" },
  { key: "review", label: "Your review" },
  { key: "n2b", label: "NeverBounce" },
  { key: "done", label: "Done" },
];

function stepIndexFor(status: string): number {
  switch (status) {
    case "pending":
      return 0;
    case "running_mtn":
      return 1;
    case "needs_approval":
      return 2;
    case "running_n2b":
      return 3;
    case "completed":
      return 4;
    default:
      return 1;
  }
}

function Stepper({ status }: { status: string }) {
  const current = stepIndexFor(status);
  const failed = status === "failed";

  return (
    <ol className="stepper" aria-label="Verification pipeline">
      {STEPS.map((s, i) => {
        const state =
          failed && i === current ? "error" : i < current ? "done" : i === current ? "active" : "todo";
        return (
          <li key={s.key} className={`step step-${state}`}>
            <span className="step-dot" aria-hidden="true">
              {state === "done" ? "✓" : state === "error" ? "!" : i + 1}
            </span>
            <span className="step-label">{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ExportMenu({ listId, counts }: { listId: string; counts: Record<string, number> }) {
  const valid = counts.valid ?? 0;
  const risky = counts.risky ?? 0;
  const invalid = counts.invalid ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const options = [
    { filter: "valid", label: "Valid only", note: "ready to send", count: valid, primary: true },
    {
      filter: "sendable",
      label: "Valid + catch-all",
      note: "wider reach, unconfirmed",
      count: valid + risky,
    },
    { filter: "all", label: "Everything", note: "full results", count: total },
    { filter: "bad", label: "Invalid only", note: "for suppression", count: invalid },
  ];

  return (
    <div className="export-grid">
      {options.map((o) => (
        <a
          key={o.filter}
          className={`export-card${o.primary ? " export-card-primary" : ""}`}
          href={`/api/lists/${listId}/export?filter=${o.filter}`}
        >
          <span className="export-count num">{o.count}</span>
          <span className="export-label">{o.label}</span>
          <span className="export-note">{o.note}</span>
        </a>
      ))}
    </div>
  );
}

export default function ListProgress({ listId }: { listId: string }) {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Bumped after every action so the poll loop restarts immediately rather
  // than waiting for a manual refresh.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch(`/api/lists/${listId}/status`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const json: StatusPayload = await res.json();
        if (cancelled) return;
        setData(json);
        if (!AWAITING_ACTION.has(json.status) && !FINISHED.has(json.status)) {
          timer = setTimeout(poll, 2000);
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 5000);
      }
    }
    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [listId, tick]);

  // Every action runs through here so none can forget to resume polling.
  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(null);
      setTick((t) => t + 1);
    }
  }, []);

  if (!data) return <p className="empty-state">Loading…</p>;

  const p = data.preflight;
  const pct = data.totalRows > 0 ? Math.round((data.resolved / data.totalRows) * 100) : 0;
  const orderedStatuses = STATUS_ORDER.filter((s) => data.byFinalStatus[s]);
  const running = data.status === "running_mtn" || data.status === "running_n2b";

  return (
    <div>
      <Stepper status={data.status} />

      {/* ---------- Step 1: pre-flight ---------- */}
      {data.status === "pending" && (
        <div className="panel-action">
          <h3 className="panel-title">
            {p.toVerify} {p.toVerify === 1 ? "address" : "addresses"} ready to verify
          </h3>
          <table className="reason-table">
            <tbody>
              <tr>
                <td>Rows in file</td>
                <td className="num right">{p.sourceRowCount}</td>
              </tr>
              <tr className="muted-row">
                <td>Skipped — not a valid address</td>
                <td className="num right">{p.skippedInvalid}</td>
              </tr>
              <tr className="muted-row">
                <td>Skipped — duplicate</td>
                <td className="num right">{p.skippedDupes}</td>
              </tr>
              <tr>
                <td>
                  Already known from previous lists
                  <span className="row-note"> · free</span>
                </td>
                <td className="num right">{p.knownFromCache}</td>
              </tr>
              <tr>
                <td>
                  <strong>Will be checked by Mail Tester Ninja</strong>
                  <span className="row-note"> · free, unlimited plan</span>
                </td>
                <td className="num right">
                  <strong>{p.toVerify}</strong>
                </td>
              </tr>
            </tbody>
          </table>
          <div className="review-actions">
            <button
              disabled={busy !== null}
              onClick={() => run("start", () => beginVerification(listId))}
            >
              {busy === "start" ? "Starting…" : "Start verification"}
            </button>
          </div>
          <p className="meta">
            You&apos;ll get another checkpoint before anything is sent to NeverBounce.
          </p>
        </div>
      )}

      {/* ---------- Live progress ---------- */}
      {data.status !== "pending" && (
        <>
          <div className="progress-head">
            <span className="progress-count num">
              {data.resolved} / {data.totalRows}
            </span>
            <span className="meta">
              resolved ({pct}%){running && <span className="live-dot" aria-label="running" />}
            </span>
            {running && data.throughput.perSecond > 0 && (
              <span className="throughput">
                <span className="num">{data.throughput.perSecond}</span>/sec
                {data.throughput.etaSeconds !== null && (
                  <> · ~{formatEta(data.throughput.etaSeconds)} left</>
                )}
              </span>
            )}
          </div>

          <div className="progress-track">
            {orderedStatuses.map((s) => (
              <span
                key={s}
                style={{
                  width: `${(data.byFinalStatus[s]! / data.totalRows) * 100}%`,
                  background: `var(${STATUS_COLOR_VAR[s]})`,
                }}
              />
            ))}
          </div>

          <div className="result-cards">
            {STATUS_ORDER.map((s) => (
              <div key={s} className={`result-card result-${s}`}>
                <span className="result-count num">{data.byFinalStatus[s] ?? 0}</span>
                <span className="result-name">{s}</span>
                <span className="result-meaning">{STATUS_MEANING[s]}</span>
              </div>
            ))}
          </div>

          <div className="source-line">
            <span>
              <span className="num">{data.bySource.cache ?? 0}</span> from cache
            </span>
            <span>
              <span className="num">{data.bySource.mtn ?? 0}</span> from Ninja
            </span>
            <span>
              <span className="num">{data.bySource.n2b ?? 0}</span> from NeverBounce
            </span>
            <span>
              <span className="num">{data.n2bCreditsSpent}</span> credits used
            </span>
          </div>
        </>
      )}

      {/* ---------- Step 3: review gate ---------- */}
      {data.status === "needs_approval" && (
        <div className="panel-action panel-decision">
          <span className="eyebrow">Your decision</span>
          <h3 className="panel-title">Mail Tester Ninja finished. Continue to NeverBounce?</h3>

          <div className="review-split">
            <div>
              <div className="review-label">Resolved — no further cost</div>
              <div className="review-figure num">{data.resolved}</div>
              <div className="meta">of {data.totalRows} rows</div>
            </div>
            <div>
              <div className="review-label">Would cost credits</div>
              <div className="review-figure num accent">{data.pendingN2b}</div>
              <div className="meta">1 credit per address</div>
            </div>
          </div>

          {data.pendingN2bReasons.length > 0 && (
            <table className="reason-table">
              <thead>
                <tr>
                  <th>Why it&apos;s unresolved</th>
                  <th className="right">Rows</th>
                </tr>
              </thead>
              <tbody>
                {data.pendingN2bReasons.map((r) => (
                  <tr key={r.reason}>
                    <td>{r.reason}</td>
                    <td className="num right">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="review-actions">
            <button
              disabled={busy !== null}
              onClick={() => run("approve", () => approveList(listId))}
            >
              {busy === "approve" ? "Submitting…" : `Verify ${data.pendingN2b} with NeverBounce`}
            </button>
            <button
              className="btn-quiet"
              disabled={busy !== null}
              onClick={() => run("finish", () => finishListWithoutN2b(listId))}
            >
              {busy === "finish" ? "Finishing…" : "Finish without NeverBounce"}
            </button>
          </div>
          <p className="meta">
            Finishing keeps every result found so far and spends nothing. Unresolved rows are
            marked risky or unknown.
          </p>
        </div>
      )}

      {/* ---------- Failure ---------- */}
      {data.status === "failed" && (
        <div className="error-banner">
          <strong>This list stopped before finishing.</strong>
          {data.lastError && <div className="meta">{data.lastError}</div>}
          <div className="meta">
            Everything already verified is kept — retrying resumes where it stopped and re-checks
            nothing you&apos;ve paid for.
          </div>
          <div className="review-actions">
            <button
              disabled={busy !== null}
              onClick={() => run("retry", () => retryFailedList(listId))}
            >
              {busy === "retry" ? "Retrying…" : "Retry"}
            </button>
            <button
              className="btn-quiet"
              disabled={busy !== null}
              onClick={() => run("finish", () => finishListWithoutN2b(listId))}
            >
              {busy === "finish" ? "Finishing…" : "Finish without NeverBounce"}
            </button>
          </div>
        </div>
      )}

      {/* ---------- Export ---------- */}
      {(data.status === "completed" || data.status === "failed") && (
        <div className="section">
          <h3 className="section-title">Export</h3>
          <p className="meta section-sub">
            One file, both providers merged. Every row keeps your original columns plus its
            status and which engine resolved it.
          </p>
          <ExportMenu listId={listId} counts={data.byFinalStatus} />
        </div>
      )}

      {/* ---------- Full accounting ---------- */}
      {data.breakdown.length > 0 && (
        <div className="section">
          <h3 className="section-title">Every row accounted for</h3>
          <table className="reason-table">
            <thead>
              <tr>
                <th>Provider response</th>
                <th>Outcome</th>
                <th className="right">Rows</th>
              </tr>
            </thead>
            <tbody>
              {data.breakdown.map((b, i) => (
                <tr key={`${b.mtnMessage}-${b.stage}-${i}`}>
                  <td>{b.mtnMessage}</td>
                  <td>
                    {b.escalates ? (
                      <span className="dest-n2b">&rarr; NeverBounce</span>
                    ) : (
                      <span className={`pill pill-res-${b.finalStatus ?? "unknown"}`}>
                        {b.finalStatus ?? "pending"}
                      </span>
                    )}
                  </td>
                  <td className="num right">{b.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
