-- DropForeignKey
ALTER TABLE "ListRow" DROP CONSTRAINT "ListRow_listId_fkey";

-- DropForeignKey
ALTER TABLE "N2bBatch" DROP CONSTRAINT "N2bBatch_listId_fkey";

-- DropForeignKey
ALTER TABLE "CreditLedger" DROP CONSTRAINT "CreditLedger_listId_fkey";

-- AlterTable
ALTER TABLE "CreditLedger" ADD COLUMN     "listName" TEXT NOT NULL DEFAULT '',
ALTER COLUMN "listId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "ListRow" ADD CONSTRAINT "ListRow_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "N2bBatch" ADD CONSTRAINT "N2bBatch_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List"("id") ON DELETE SET NULL ON UPDATE CASCADE;

