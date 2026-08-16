-- AlterTable
ALTER TABLE "Badge" ADD COLUMN     "tier" TEXT NOT NULL DEFAULT 'BRONZE',
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'GROUP',
ADD COLUMN     "criteria" JSONB;

-- CreateTable
CREATE TABLE "StudentBadge" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "rm" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentBadge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudentBadge_groupId_idx" ON "StudentBadge"("groupId");

-- CreateIndex
CREATE INDEX "StudentBadge_rm_idx" ON "StudentBadge"("rm");

-- CreateIndex
CREATE UNIQUE INDEX "StudentBadge_rm_badgeId_key" ON "StudentBadge"("rm", "badgeId");

-- AddForeignKey
ALTER TABLE "StudentBadge" ADD CONSTRAINT "StudentBadge_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentBadge" ADD CONSTRAINT "StudentBadge_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "Badge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
