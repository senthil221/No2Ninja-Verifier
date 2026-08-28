-- AlterTable
ALTER TABLE "List" ADD COLUMN     "autoRetryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextAutoRetryAt" TIMESTAMP(3),
ADD COLUMN     "retryable" BOOLEAN NOT NULL DEFAULT false;

