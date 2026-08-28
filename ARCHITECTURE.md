# Architecture and decisions

Why this system is shaped the way it is. Most of the non-obvious choices
exist because something specific went wrong; those reasons are recorded here
so they are not undone by someone who only sees the code.

## The problem

Verify prospect lists across two providers with very different economics:

- **Mail Tester Ninja (MTN)** — flat-rate, effectively free per check, but
  **no bulk endpoint** and rate limited (57 requests / 10s on the Ultimate
  plan). One HTTP call per address.
- **No2Bounce (N2B)** — **one credit per address**, real bulk
  API, better at the cases MTN cannot resolve.

So: run everything through the free provider, and pay only for what it
could not answer.

## Pipeline

```
Upload → Pre-flight → [cache] → MTN pass → N2B pass → Export
                         ↑            ↑          ↑
                    free, no API   free      1 credit/address
```

Statuses: `pending` → `running_mtn` → `running_n2b` → `completed`. Plus
`failed` (something broke) and `stopped` (halted by hand). Both keep results
and can resume.

**One deliberate stopping point.** Nothing runs until Start is pressed; the
pre-flight summary before it is where the spend is authorised, and the
person who presses it is who the credits are attributed to. After that the
two passes run through without another prompt.

**What counts as valid.** No2Bounce answers `Deliverable`,
`CatchAll`/`AcceptAll`, `Invalid`, `Bounce` or `Spam`, alone or combined
(`Deliverable/AcceptAll`). Only a plain `Deliverable` becomes valid. The
disqualifiers are matched *before* the word "deliverable" is honoured, since
"UnDeliverable" contains it and a spam trap is deliverable in the literal
sense -- the ordering in `mapN2bStatus` is the rule, not an optimisation.

**What the paid pass is asked to answer.** Only the results the cheap pass
could not resolve: `Catch-All`, and `SPAM Block` / `Timeout` / `MX Error` /
`Limited` once MTN's own retries are spent. `Accepted` settles valid;
`Rejected` and `No MX` settle invalid. The last two are the important half
of the rule -- the server refused the address, or the domain has no mail
exchanger at all, and buying a second opinion on either is a credit spent
to hear the same answer.

## The cost model, which drives most decisions

Every design choice below exists to avoid paying N2B for an answer already
obtainable for free.

| Layer | Saves |
|---|---|
| Within-file dedup | duplicate addresses in one upload |
| `EmailCache` -- No2Bounce verdicts only | re-paying for an address already bought |
| `DomainCache` (per domain) | see below |
| Domain probing within a batch | one paid check answers for a whole domain |

**Reuse is priced per provider.** Mail Tester Ninja is flat-rate, so caching
its verdicts saves nothing while risking a stale one -- people change roles
and mailboxes close, and a months-old "Accepted" becomes a bounce that costs
sender reputation. Its results are re-verified every time by default
(`MTN_CACHE_TTL_DAYS=0`). No2Bounce costs a credit per address, so its
verdicts are reused for 90 days. The same split applies to domain facts:
no-MX (from the free provider) follows the MTN setting, confirmed catch-all
(paid) does not.

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
| Account looks broken | `Disabled Key` | **fatal**: stop the list, escalate nothing, auto-retry |
| Provider unreachable | DNS, TLS, 429 | stop the list, auto-retry; row returns to pending |

A bad key once caused every row of a list to be escalated — a 20k list would
have burned 20k credits learning nothing. Both classes stop the list instead
of escalating a single row while the problem is unresolved.

"Fatal" guarantees only that one thing, not that the list gives up: in
practice, MTN's "Disabled Key" has turned out to be intermittent on their
side rather than an actually-revoked key — a person retrying the identical
key by hand routinely fixes it. Since MTN calls are free, retrying that
automatically costs nothing; see auto-retry below for what bounds it if a
key is genuinely dead.

### Auto-retry: self-healing for what a person would just retry anyway

A list stopped by a transient-looking failure retries itself on a backoff
schedule (1 min, doubling, capped at 30 min, `LIST_AUTO_RETRY_MAX_ATTEMPTS`
attempts by default) instead of sitting there until someone notices and
clicks Retry. What counts as retryable (`lib/retry-policy.ts`) is narrow on
purpose:

- a bare network failure with no HTTP status (`fetch failed` — DNS, refused
  connection, timeout)
- a provider 5xx or 429
- MTN's `fatal`-classified account errors (see above)

A request the provider actively rejected with some other 4xx (a malformed
body, an unrecognised field) is **not** retried automatically: the request
was wrong, and an identical retry produces an identical rejection. That
needs a code or config fix, not patience.

No alert fires while a retryable failure is still within its budget — a
blip that clears on its own should not page anyone. One fires only once the
budget is exhausted, at which point it genuinely does need a person.
`markFailed` owns this decision for every failure path in the pipeline, the
same way it owns the terminal-state alerting described above, so a future
failure path cannot introduce silent, unbounded retrying by accident.

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
