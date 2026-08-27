-- AlterEnum
ALTER TYPE "ListStatus" ADD VALUE 'stopped';

-- CreateTable
CREATE TABLE "DomainCache" (
    "domain" TEXT NOT NULL,
    "isCatchAll" BOOLEAN,
    "hasNoMx" BOOLEAN,
    "catchAllSource" TEXT,
    "observations" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainCache_pkey" PRIMARY KEY ("domain")
);

