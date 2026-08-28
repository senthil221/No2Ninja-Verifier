-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'member');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'member';

-- AlterTable
ALTER TABLE "List" ADD COLUMN     "approvedById" TEXT;

-- AlterTable
ALTER TABLE "CreditLedger" ADD COLUMN     "userId" TEXT;

-- CreateIndex
CREATE INDEX "CreditLedger_userId_idx" ON "CreditLedger"("userId");

-- AddForeignKey
ALTER TABLE "List" ADD CONSTRAINT "List_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The account that already exists was created before roles did. It is the
-- one that ran setup, so it is the admin; without this it would default to
-- member and nobody could see cross-user spend.
UPDATE "User" SET "role" = 'admin'
WHERE "id" = (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1);
