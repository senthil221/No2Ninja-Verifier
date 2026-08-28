-- The review gate between the two passes is gone: once a run is started,
-- whatever Mail Tester Ninja cannot answer goes straight to No2Bounce.

-- Any list currently parked at the old gate would otherwise be stranded --
-- nothing produces that status any more, so nothing would ever move it on.
-- Park them as "stopped" instead, which the UI already offers a Resume for,
-- and resuming submits their unresolved rows exactly as before.
UPDATE "List"
SET "status" = 'stopped',
    "lastError" = 'Paused at the old review step, which has been removed. Resume to send the unresolved rows to No2Bounce.'
WHERE "status" = 'needs_approval';

-- Drop the now-unreachable enum value. Postgres cannot remove a value from
-- an enum in place, so the type is rebuilt.
ALTER TYPE "ListStatus" RENAME TO "ListStatus_old";
CREATE TYPE "ListStatus" AS ENUM ('pending', 'running_mtn', 'running_n2b', 'completed', 'failed', 'stopped');
ALTER TABLE "List" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "List" ALTER COLUMN "status" TYPE "ListStatus" USING ("status"::text::"ListStatus");
ALTER TABLE "List" ALTER COLUMN "status" SET DEFAULT 'pending';
DROP TYPE "ListStatus_old";

-- Spend is now authorised by starting the run rather than by approving at
-- the gate, so the column says what it means. Renaming keeps every existing
-- attribution intact.
ALTER TABLE "List" RENAME COLUMN "approvedById" TO "startedById";
ALTER TABLE "List" RENAME CONSTRAINT "List_approvedById_fkey" TO "List_startedById_fkey";
