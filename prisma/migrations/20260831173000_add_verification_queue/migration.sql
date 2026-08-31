-- "pending" still means awaiting user approval. "queued" means approval was
-- given and the list is waiting for the one global verification slot.
ALTER TYPE "ListStatus" ADD VALUE 'queued';

ALTER TABLE "List" ADD COLUMN "queuedAt" TIMESTAMP(3);

CREATE INDEX "List_status_queuedAt_idx" ON "List"("status", "queuedAt");
