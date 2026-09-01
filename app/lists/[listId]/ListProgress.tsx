"use client";

import { useCallback, useEffect, useState } from "react";
import {
  retryFailedList,
  finishListWithoutN2b,
  beginVerification,
  stopVerification,
} from "@/app/actions";
import { shouldPollListStatus } from "@/lib/list-scheduler-policy";
import { verificationPhase, type VerificationAccounting } from "@/lib/progress-accounting";

interface StatusPayload {
  status: string;
  lastError: string | null;
  // Present only while a failure is self-healing: null once it isn't
  // retryable, or once the attempt budget is exhausted -- both mean a
  // person is the only way forward from here.
  autoRetry: { attempt: number; maxAttempts: number; nextAttemptAt: string } | null;
  totalRows: number;
  resolved: number;
  stageCounts: Record<string, number>;
  byFinalStatus: Record<string, number>;
  bySource: Record<string, number>;
  mtnAccounting: VerificationAccounting;
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
  queue: {
    position: number;
    activeList: { id: string; name: string; status: string } | null;
  } | null;
  breakdown: {
    mtnMessage: string;
    stage: string;
    finalStatus: string | null;
    count: number;
    escalates: boolean;
  }[];
}

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
  risky: "Catch-all domain. Accepts anything, so delivery is unconfirmed.",
  unknown: "Could not be determined by either provider.",
};

// Renders "in ~3 min" and counts down locally between polls, rather than
// showing a fixed timestamp that goes stale until the next fetch.
function AutoRetryCountdown({ at }: { at: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = Math.max(0, Math.round((new Date(at).getTime() - now) / 1000));
  return <>{remaining <= 0 ? "any moment now" : `in ~${formatEta(remaining)}`}</>;
}

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
  { key: "n2b", label: "No2Bounce" },
  { key: "done", label: "Done" },
];

function stepIndexFor(status: string, accounting: VerificationAccounting): number {
  return { preflight: 0, mtn: 1, n2b: 2, done: 3 }[
    verificationPhase(status, accounting)
  ];
}

function Stepper({ status, accounting }: { status: string; accounting: VerificationAccounting }) {
  const current = stepIndexFor(status, accounting);
  const failed = status === "failed" || status === "stopped";

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

function ExportMenu({
  listId,
  counts,
  bySource,
}: {
  listId: string;
  counts: Record<string, number>;
  bySource: Record<string, number>;
}) {
  const valid = counts.valid ?? 0;
  const risky = counts.risky ?? 0;
  const invalid = counts.invalid ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const options = [
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
    <>
      {/* The whole point of the run: every address either pass confirmed,
          in one file, whichever engine established it. */}
      <a className="export-primary" href={`/api/lists/${listId}/export?filter=valid`}>
        <span className="export-primary-count num">{valid}</span>
        <span className="export-primary-body">
          <span className="export-primary-label">Download valid addresses</span>
          <span className="export-primary-note">
            Both passes combined &mdash; <span className="num">{bySource.mtn ?? 0}</span> from
            Ninja, <span className="num">{bySource.n2b ?? 0}</span> from No2Bounce,{" "}
            <span className="num">{bySource.cache ?? 0}</span> from cache
          </span>
        </span>
      </a>

      <div className="export-grid">
        {options.map((o) => (
          <a
            key={o.filter}
            className="export-card"
            href={`/api/lists/${listId}/export?filter=${o.filter}`}
          >
            <span className="export-count num">{o.count}</span>
            <span className="export-label">{o.label}</span>
            <span className="export-note">{o.note}</span>
          </a>
        ))}
      </div>
    </>
  );
}

export default function ListProgress({ listId }: { listId: string }) {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
        if (shouldPollListStatus(json.status, Boolean(json.autoRetry))) {
          // A pending auto-retry can be minutes away; no need to hammer the
          // endpoint waiting for it the way active progress does.
          timer = setTimeout(poll, json.autoRetry ? 10_000 : 2000);
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
    setActionError(null);
    try {
      await action();
    } catch {
      setActionError("The action could not be completed. Refresh the page and try again.");
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
      <Stepper status={data.status} accounting={data.mtnAccounting} />

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
                <td>Skipped, not a valid address</td>
                <td className="num right">{p.skippedInvalid}</td>
              </tr>
              <tr className="muted-row">
                <td>Skipped, duplicate</td>
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
            Starting runs both passes without stopping: Mail Tester Ninja first, then only what
            it could not answer goes to No2Bounce at one credit each.
          </p>
        </div>
      )}

      {data.status === "queued" && (
        <div className="panel-action">
          <h3 className="panel-title">
            Queued for verification
            {data.queue && <span className="num"> · position {data.queue.position}</span>}
          </h3>
          <p className="meta">
            Only one list runs at a time, using the full safe provider allowance. This list starts
            automatically when the current list completes.
          </p>
          {data.queue?.activeList && (
            <p className="meta">
              Currently running: <strong>{data.queue.activeList.name}</strong>
            </p>
          )}
          <div className="review-actions">
            <button
              className="btn-quiet"
              disabled={busy !== null}
              onClick={() => run("stop", () => stopVerification(listId))}
            >
              {busy === "stop" ? "Removing…" : "Remove from queue"}
            </button>
          </div>
        </div>
      )}

      {/* ---------- Live progress ---------- */}
      {data.status !== "pending" && data.status !== "queued" && (
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

          <p className="mtn-accounting">
            <strong>MTN pass:</strong>{" "}
            <span className="num">{data.mtnAccounting.checkedByMtn}</span> checked live +{" "}
            <span className="num">{data.mtnAccounting.reusedFromCacheOrDomain}</span> reused from
            cache/domain
            {data.mtnAccounting.waitingForMtn > 0 ? (
              <>
                {" "}· <span className="num">{data.mtnAccounting.waitingForMtn}</span> waiting for MTN
              </>
            ) : (
              <>
                {" "}· <span className="num">{data.mtnAccounting.resolvedByMtn}</span> resolved by MTN
                {" "}· <span className="num">{data.mtnAccounting.escalatedToN2b}</span> escalated to
                No2Bounce
              </>
            )}
          </p>

          <div className="result-cards">
            {STATUS_ORDER.map((s) => (
              <div key={s} className={`result-card result-${s}`}>
                <span className="result-count num">{data.byFinalStatus[s] ?? 0}</span>
                <span className="result-name">{s}</span>
                <span className="result-meaning">{STATUS_MEANING[s]}</span>
              </div>
            ))}
          </div>

          {running && (
            <div className="running-actions">
              <button
                className="btn-quiet"
                disabled={busy !== null}
                onClick={() => run("stop", () => stopVerification(listId))}
              >
                {busy === "stop" ? "Stopping…" : "Stop verification"}
              </button>
              {actionError && (
                <p className="action-error" role="alert">
                  {actionError}
                </p>
              )}
            </div>
          )}

          <div className="source-line">
            <span>
              <span className="num">{data.mtnAccounting.reusedFromCacheOrDomain}</span> reused from
              cache/domain
            </span>
            <span>
              <span className="num">{data.mtnAccounting.checkedByMtn}</span> checked by Ninja
            </span>
            <span>
              <span className="num">{data.mtnAccounting.resolvedByMtn}</span> resolved by Ninja
            </span>
            <span>
              <span className="num">{data.mtnAccounting.escalatedToN2b}</span> escalated to No2Bounce
            </span>
            <span>
              <span className="num">{data.mtnAccounting.resolvedByN2b}</span> resolved by No2Bounce
            </span>
            <span>
              <span className="num">{data.n2bCreditsSpent}</span> credits used
            </span>
          </div>
        </>
      )}

      {/* ---------- What the paid pass is working through ---------- */}
      {data.status === "running_n2b" && data.pendingN2bReasons.length > 0 && (
        <div className="section">
          <h3 className="section-title">
            With No2Bounce: <span className="num">{data.pendingN2b}</span>
          </h3>
          <p className="meta section-sub">
            Everything Mail Tester Ninja could not answer, at one credit each. Rejected and
            no-MX addresses are settled already and cost nothing.
          </p>
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
        </div>
      )}

      {/* ---------- Stopped by hand ---------- */}
      {data.status === "stopped" && (
        <div className="panel-action">
          <h3 className="panel-title">Verification stopped</h3>
          <p className="meta">
            Nothing further is being checked or charged. Everything verified so far is kept.
            resuming continues from where it left off and re-checks nothing.
          </p>
          <div className="review-actions">
            <button
              disabled={busy !== null}
              onClick={() => run("retry", () => retryFailedList(listId))}
            >
              {busy === "retry" ? "Resuming…" : "Resume"}
            </button>
            <button
              className="btn-quiet"
              disabled={busy !== null}
              onClick={() => run("finish", () => finishListWithoutN2b(listId))}
            >
              {busy === "finish" ? "Finishing…" : "Finish with what we have"}
            </button>
          </div>
        </div>
      )}

      {/* ---------- Failure ---------- */}
      {data.status === "failed" && (
        <div className="error-banner">
          <strong>
            {data.autoRetry ? "This list hit a snag, retrying on its own." : "This list stopped before finishing."}
          </strong>
          {data.lastError && <div className="meta">{data.lastError}</div>}
          {data.autoRetry ? (
            <div className="meta">
              Attempt <span className="num">{data.autoRetry.attempt}</span> of{" "}
              <span className="num">{data.autoRetry.maxAttempts}</span> failed. Next try{" "}
              <AutoRetryCountdown at={data.autoRetry.nextAttemptAt} />. Nothing further is being
              checked or charged in the meantime, and nothing already verified is at risk.
            </div>
          ) : (
            <div className="meta">
              Everything already verified is kept. Retrying resumes where it stopped and
              re-checks nothing you&apos;ve paid for.
            </div>
          )}
          <div className="review-actions">
            <button
              disabled={busy !== null}
              onClick={() => run("retry", () => retryFailedList(listId))}
            >
              {busy === "retry" ? "Retrying…" : data.autoRetry ? "Retry now" : "Retry"}
            </button>
            <button
              className="btn-quiet"
              disabled={busy !== null}
              onClick={() => run("finish", () => finishListWithoutN2b(listId))}
            >
              {busy === "finish" ? "Finishing…" : "Finish without No2Bounce"}
            </button>
          </div>
        </div>
      )}

      {/* ---------- Export ---------- */}
      {(data.status === "completed" || data.status === "failed" || data.status === "stopped") && (
        <div className="section">
          <h3 className="section-title">Export</h3>
          <p className="meta section-sub">
            One file, both providers merged. Valid means a confirmed mailbox and nothing else
            &mdash; catch-all, spam, bounce and invalid are all left out of it. Every row keeps
            your original columns plus its status and which engine resolved it.
          </p>
          <ExportMenu listId={listId} counts={data.byFinalStatus} bySource={data.bySource} />
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
                      <span className="dest-n2b">&rarr; No2Bounce</span>
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
