# Waterfall Verifier

Orchestrates prospect list email verification as a two-stage waterfall:

1. **Pass 1 — Mail Tester Ninja** (cheap, single-call, rate-limited): every row is checked here first.
2. **Pass 2 — No2Bounce** (bulk, pricier): only rows MTN couldn't confidently resolve are re-checked, in one bulk submission per list. It follows the first pass automatically — there is no approval step in between.

A global `EmailCache` means any address already verified in a past list — for any client — is never re-paid for again, as long as the cached result is within the configured freshness window.

## Stack

Next.js (App Router) + Prisma/Postgres for the app, Redis + BullMQ for the rate-limited MTN queue and the No2Bounce polling queue, run as a separate worker process. Docker Compose ties it together.

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

`pending → running_mtn → running_n2b → completed` (or `failed` on an unrecoverable error, or `stopped` if halted by hand). Pressing Start is the only checkpoint: from there the list runs both passes unattended.

- Exactly five MTN results reach Pass 2: `Catch-All`, `SPAM Block`, `Timeout`, `Mx Error` and `Limited`. `Accepted` settles as valid; `Rejected` and `No MX` settle as invalid — the address was refused, or the domain has nowhere to deliver, so a paid second opinion buys nothing.
- `Timeout` / `Mx Error` / `SPAM Block` are retried on MTN itself first (`MTN_MAX_RETRIES`), so a blip doesn't cost a credit.
- `CATCH_ALL_HANDLING` controls whether `Catch-All` is accepted as risky or escalated (default: escalate).
- `Limited` never settles as valid even when MTN pairs it with an `ok` code: a limited answer is the server declining to finish the check, not a confirmation.
- When the list finishes, one export merges both passes: **Valid only** is the send list, whichever engine established each address.
- Only a confirmed mailbox counts as valid. No2Bounce answers `Deliverable`, `CatchAll`/`AcceptAll`, `Invalid`, `Bounce` or `Spam` — only a plain `Deliverable` maps to valid. An accept-all deliverable is the domain accepting every address, and a spam trap is deliverable in the literal sense; both are risky, so neither reaches the send list.

## Known gaps / things to verify before relying on this in production

- **No authentication yet.** The `User` model exists in the schema but there's no login flow. Put this behind your own reverse proxy / VPN (the same way you likely already gate n8n) before exposing it beyond localhost.
- **No2Bounce small-list (≤20K) completion response shape is unconfirmed.** The public API docs page doesn't show a literal example of the per-email result payload for inline (non-signed-URL) responses, or the exact CSV column headers in the signed-URL file for large batches. `lib/n2b.ts` (`poll` and `fetchSignedUrlResults`) parses defensively against several likely field names, but this is the one integration point that should be checked against a real test batch — if it doesn't match, that's the only file that needs adjusting.
- No CSV column-mapping UI yet — the uploader auto-detects a column named (or containing) "email", or falls back to the first column.
