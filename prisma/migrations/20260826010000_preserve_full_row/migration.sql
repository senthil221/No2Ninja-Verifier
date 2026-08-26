-- AlterTable
ALTER TABLE "List" ADD COLUMN     "columnHeaders" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ListRow" ADD COLUMN     "rawRow" JSONB NOT NULL DEFAULT '{}';

