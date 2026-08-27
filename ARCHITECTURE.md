# Architecture and decisions

Why this system is shaped the way it is. Most of the non-obvious choices
exist because something specific went wrong; those reasons are recorded here
so they are not undone by someone who only sees the code.

## The problem

Verify prospect lists across two providers with very different economics:

- **Mail Tester Ninja (MTN)** — flat-rate, effectively free per check, but
  **no bulk endpoint** and rate limited (57 requests / 10s on the Ultimate
  plan). One HTTP call per address.
- **NeverBounce / no2bounce (N2B)** — **one credit per address**, real bulk
  API, better at the cases MTN cannot resolve.

So: run everything through the free provider, and pay only for what it
could not answer.

## Pipeline

```
Upload → Pre-flight → [cache] → MTN pass → Review gate → N2B pass → Export
                         ↑                      ↑
                    free, no API          human decides spend
```

Statuses: `pending` → `running_mtn` → `needs_approval` → `running_n2b` →
`completed`. Plus `failed` (something broke) and `stopped` (halted by hand).
Both keep results and can resume.

**Two deliberate stopping points.** Nothing runs until Start is pressed, and
nothing is *charged* until the review gate is approved. Credits are the only
irreversible thing here, so spending them is never automatic.

## The cost model, which drives most decisions

Every design choice below exists to avoid paying N2B for an answer already
obtainable for free.

| Layer | Saves |
|---|---|
| Within-file dedup | duplicate addresses in one upload |
| `EmailCache` (global, per address) | anything verified in any previous list |
| `DomainCache` (per domain) | see below |
| Domain probing within a batch | one paid check answers for a whole domain |

**Domain-level facts.** Some answers belong to the mail server, not the
mailbox: a domain with no MX cannot deliver to *any* address, and a
catch-all accepts *every* address. Learning these once and reusing them is
the difference between paying per address and paying per domain. A run once
spent 29 credits establishing a single fact about one domain — that is the
failure this prevents.

Only N2B's own `catchall` flag is treated as settled. MTN's catch-all
result is recorded as a hint but never used to skip a paid check: letting
the cheap provider decide what the expensive one would have said is how
results quietly become wrong.

**Escalation policy** (`MTN_ESCALATION_POLICY`):
- `all_except_valid` (default) — anything not confirmed deliverable gets a
  second opinion. MTN's "Rejected" can be a false negative, and for lead gen
  a wrongly discarded prospect costs more than a credit.
- `unresolved` — trust MTN's invalid verdicts; escalate only what it could
  not answer. Cheaper.

## Non-obvious decisions

### Rate limiting is *pacing*, not a window

A window limiter permits the whole allowance to fire at once. That is legal
by the per-window total and still reads as a burst to the provider — it
earned a 429. Requests are paced one per interval, derived from the plan's
own rate with a safety factor (57/10s → one every ~202ms → ~49/10s).

Concurrency (default 8) exists only to absorb latency: SMTP probes take
~880ms median with outliers past 7s, so serial execution ran the pipeline at
a *tenth* of the allowance. Paced starts plus concurrency gets the rate
without the spike.

A 429 pauses the whole worker for `Retry-After` and requeues without
consuming a retry. It must never be read as "provider unreachable", which
stops the entire list.

### Failures never escalate to the paid provider

Three distinct failure classes, deliberately separated, because conflating
them costs money:

| Class | Example | Handling |
|---|---|---|
| Address is unresolvable | `Catch-All` | escalate — this is the point |
| Account is broken | `Disabled Key` | **fatal**: stop the list, escalate nothing |
| Provider unreachable | DNS, TLS, 429 | retry / stop; row returns to pending |

A bad key once caused every row of a list to be escalated — a 20k list would
have burned 20k credits learning nothing. Account-level and transport
failures now stop the list instead.

### Classification keys on `code`, not `message`

MTN documents `ok` / `ko` / `mb` (valid / invalid / unverifiable). Matching
on the message string alone meant unfamiliar wording was categorised by
guesswork, and the docs' casing (`No Mx`) does not match the API's
(`No MX`) — which silently escalated dead domains. The code decides; the
message only refines the `mb` case.

### Sessions are database rows

Not a signed cookie, so signing out actually revokes access. Middleware runs
on the edge where Prisma cannot, so it only checks that a cookie *exists*;
`requireUser()` verifies it for real on every page, API routes return 401,
and **every server action asserts the session itself** — actions are POST
endpoints that no page guard covers.

### Every terminal transition goes through one function

`markFailed` / `markNeedsApproval` / `markCompleted`. Alerts fire from
there, so a future call site cannot add a transition and forget to alert.
The same principle applies in the UI: every action runs through one helper
that resumes polling, because forgetting that is what once left the page
frozen while work ran invisibly in the background.

## Testing

| Command | What it covers |
|---|---|
| `npm test` | Unit. Classification, escalation policy, report parsing, password hashing, rate-limit handling. No network. |
| `npm run test:live` | **Contract tests against the real providers.** |
| `npm run smoke` | Full pipeline end to end, then cleans up after itself. |

**Why contract tests exist.** Every serious bug in this integration came
from writing code against documentation and shipping it unverified: a
rejected `hashkey` field, a poll response not wrapped in `data`, a verdict
column (`finalScoreValue`) that no header match could find. Unit tests
cannot catch that — the thing being asserted is what the provider actually
does. Run them after any provider change, and if an integration starts
behaving oddly.

`npm run smoke` is the pre-deploy gate. "Containers started" is not the same
as "the pipeline works"; several releases here were both.

## Operations

- **Deploy**: `git pull && docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --build`. Migrations run automatically via the one-shot `migrate` service.
- **Health**: `GET /api/health` — unauthenticated, reports dependency status only, 503 when degraded.
- **Alerts**: `ALERT_WEBHOOK_URL` receives `list_failed`, `needs_decision`, `list_completed` as JSON with a direct link.
- **Backups**: `./scripts/backup.sh` (`--verify` restores into a scratch database to prove the dump is usable). Not scheduled by default. Exports cover the lists; they do **not** cover `EmailCache` and `DomainCache`, which are the expensive things to rebuild.

## Known gaps

- Single worker process. Fine at this volume; the limiter is per-worker, so running two would double the request rate and need moving to a shared limiter first.
- Strict FIFO queue — a large list blocks a small one until it finishes. Deliberate: prioritisation happens by choosing when to press Start.
- No role-address (`info@`, `sales@`) or disposable-domain flagging. These verify as valid but are poor cold-email targets.
- No bounce feedback loop. Real bounce data from the sending tool would beat any verifier's verdict and is the highest-value addition left.
