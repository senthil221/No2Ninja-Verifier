-- Older releases allowed several lists to run together. Keep the list that
-- is demonstrably making progress (or an N2B list already in its paid pass)
-- and place every other active list into the FIFO queue before adding the
-- invariant. This makes the migration safe on an already-busy production DB.
BEGIN;

LOCK TABLE "List" IN SHARE ROW EXCLUSIVE MODE;

WITH ranked_active AS (
  SELECT
    l.id,
    row_number() OVER (
      ORDER BY
        CASE WHEN l.status = 'running_n2b' THEN 0 ELSE 1 END,
        COALESCE(
          (SELECT max(r."mtnCheckedAt") FROM "ListRow" r WHERE r."listId" = l.id),
          TIMESTAMP '1970-01-01'
        ) DESC,
        l."createdAt" ASC,
        l.id ASC
    ) AS position
  FROM "List" l
  WHERE l.status IN ('running_mtn', 'running_n2b')
)
UPDATE "List" l
SET status = 'queued', "queuedAt" = CURRENT_TIMESTAMP
FROM ranked_active ranked
WHERE l.id = ranked.id AND ranked.position > 1;

-- A database constraint, not just an application check, protects against
-- simultaneous Start/Retry requests racing in different server processes.
CREATE UNIQUE INDEX "List_one_active_verification_idx"
ON "List" ((1))
WHERE status IN ('running_mtn', 'running_n2b');

COMMIT;
