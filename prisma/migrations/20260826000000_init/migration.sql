-- CreateEnum
CREATE TYPE "ListStatus" AS ENUM ('pending', 'running_mtn', 'running_n2b', 'needs_approval', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "RowStage" AS ENUM ('pending', 'cache_hit', 'mtn_done', 'needs_n2b', 'n2b_done');

-- CreateEnum
CREATE TYPE "FinalStatus" AS ENUM ('valid', 'invalid', 'risky', 'unknown');

-- CreateEnum
CREATE TYPE "ResultSource" AS ENUM ('cache', 'mtn', 'n2b');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('mtn', 'n2b');

-- CreateEnum
CREATE TYPE "N2bBatchStatus" AS ENUM ('submitted', 'polling', 'completed', 'failed');

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "List" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceFileName" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "status" "ListStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "List_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListRow" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "rawEmail" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "stage" "RowStage" NOT NULL DEFAULT 'pending',
    "mtnStatus" TEXT,
    "mtnMessage" TEXT,
    "mtnAttempts" INTEGER NOT NULL DEFAULT 0,
    "mtnCheckedAt" TIMESTAMP(3),
    "n2bStatus" TEXT,
    "n2bCheckedAt" TIMESTAMP(3),
    "finalStatus" "FinalStatus",
    "finalSource" "ResultSource",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailCache" (
    "normalizedEmail" TEXT NOT NULL,
    "lastMtnResult" TEXT,
    "lastMtnCheckedAt" TIMESTAMP(3),
    "lastN2bResult" TEXT,
    "lastN2bCheckedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailCache_pkey" PRIMARY KEY ("normalizedEmail")
);

-- CreateTable
CREATE TABLE "N2bBatch" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "trackingId" TEXT NOT NULL,
    "hashkey" TEXT,
    "status" "N2bBatchStatus" NOT NULL DEFAULT 'submitted',
    "emailCount" INTEGER NOT NULL,
    "resultUrl" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "N2bBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "List_clientId_idx" ON "List"("clientId");

-- CreateIndex
CREATE INDEX "ListRow_listId_idx" ON "ListRow"("listId");

-- CreateIndex
CREATE INDEX "ListRow_normalizedEmail_idx" ON "ListRow"("normalizedEmail");

-- CreateIndex
CREATE INDEX "ListRow_listId_stage_idx" ON "ListRow"("listId", "stage");

-- CreateIndex
CREATE INDEX "N2bBatch_listId_idx" ON "N2bBatch"("listId");

-- CreateIndex
CREATE INDEX "N2bBatch_trackingId_idx" ON "N2bBatch"("trackingId");

-- CreateIndex
CREATE INDEX "CreditLedger_listId_idx" ON "CreditLedger"("listId");

-- AddForeignKey
ALTER TABLE "List" ADD CONSTRAINT "List_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListRow" ADD CONSTRAINT "ListRow_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "N2bBatch" ADD CONSTRAINT "N2bBatch_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

