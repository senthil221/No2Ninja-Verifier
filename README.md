# Waterfall Verifier

Orchestrates prospect list email verification as a two-stage waterfall:

1. **Pass 1 — Mail Tester Ninja** (cheap, single-call, rate-limited): every row is checked here first.
2. **Pass 2 — NeverBounce (no2bounce)** (bulk, pricier): only rows MTN couldn't confidently resolve are re-checked, in one bulk submission per list.

A global `EmailCache` means any address already verified in a past list — for any client — is never re-paid for again, as long as the cached result is within the configured freshness window.

## Stack

Next.js (App Router) + Prisma/Postgres for the app, Redis + BullMQ for the rate-limited MTN queue and the NeverBounce polling queue, run as a separate worker process. Docker Compose ties it together.

## Setup

```bash
cp .env.example .env
# then fill in MTN_API_KEY and N2B_API_TOKEN in .env
docker compose up --build
```

This starts Postgres, Redis, runs Prisma migrations (one-shot `migrate` service), then starts the app and the background worker. By default nothing is published to a host port except what you add yourself — see the two deployment options below.

### Option A: standalone, direct port access

Add a `docker-compose.override.yml` (Compose loads it automatically) with:

```yaml
services:
  app:
    ports:
      - "3000:3000"
```

Then `docker compose up --build -d` and reach the app at `http://<host>:3000`. Fine for local/dev use; put something in front of it (reverse proxy + auth) before relying on it for real client data.

### Option B: routing through an existing Traefik instance

If you already run Traefik in front of another app on the same host (e.g. a Hostinger/n8n-style setup where Traefik does TLS termination via the Docker provider), route this app through it instead of exposing a port directly:

```bash
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up --build -d
```

Set these in `.env` first: `DOMAIN_NAME` (the domain Traefik already has certs for), `VERIFIER_SUBDOMAIN` (defaults to `verifier`), `TRAEFIK_NETWORK` (the external Docker network Traefik's containers are on — find it with `docker network ls`), and `TLS_CERTRESOLVER` (the certresolver name from that Traefik instance's own compose file). This overlay only adds a network + Traefik labels to the `app` service — it never touches the existing Traefik container or any other app already running behind it.

### Local development (no Docker)

```bash
npm install
# point DATABASE_URL / REDIS_URL in .env at local instances
npx prisma migrate deploy
npm run dev        # Next.js app
npm run worker      # in a second terminal — BullMQ worker
```

## How a list moves through the pipeline

`pending → running_mtn → running_n2b → completed` (or `needs_approval` if Pass 2 would exceed the configured per-list credit cap, or `failed` on an unrecoverable error).

- MTN's `Timeout` / `Mx Error` / `SPAM Block` results are treated as transient and retried on MTN itself (`MTN_MAX_RETRIES`) before falling through to Pass 2 — this avoids spending a NeverBounce credit on something that just needed a retry.
- MTN's `Catch-All` result is ambiguous; `CATCH_ALL_HANDLING` controls whether it's accepted as-is or escalated to NeverBounce (default: escalate).
- Before a Pass 2 batch is submitted, if it would exceed `N2B_SINGLE_LIST_CREDIT_CAP`, the list pauses at `needs_approval` and must be approved manually from the list's page in the UI.

## Known gaps / things to verify before relying on this in production

- **No authentication yet.** The `User` model exists in the schema but there's no login flow. Put this behind your own reverse proxy / VPN (the same way you likely already gate n8n) before exposing it beyond localhost.
- **NeverBounce small-list (≤20K) completion response shape is unconfirmed.** The public API docs page doesn't show a literal example of the per-email result payload for inline (non-signed-URL) responses, or the exact CSV column headers in the signed-URL file for large batches. `lib/n2b.ts` (`poll` and `fetchSignedUrlResults`) parses defensively against several likely field names, but this is the one integration point that should be checked against a real test batch — if it doesn't match, that's the only file that needs adjusting.
- No CSV column-mapping UI yet — the uploader auto-detects a column named (or containing) "email", or falls back to the first column.
