-- CreateTable
CREATE TABLE "Mission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "badgeKey" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "criteria" JSONB NOT NULL,

    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionProgress" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "met" BOOLEAN NOT NULL DEFAULT false,
    "byRm" TEXT,
    "evidence" JSONB,
    "metAt" TIMESTAMP(3),

    CONSTRAINT "MissionProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Badge" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupBadge" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupBadge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XpLedger" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "rm" TEXT,
    "missionId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XpLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "grade" DOUBLE PRECISION NOT NULL,
    "submittedByRm" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupTeachingSettings" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "rankingOptOut" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "GroupTeachingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Mission_key_key" ON "Mission"("key");

-- CreateIndex
CREATE INDEX "MissionProgress_groupId_idx" ON "MissionProgress"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "MissionProgress_groupId_missionId_key" ON "MissionProgress"("groupId", "missionId");

-- CreateIndex
CREATE UNIQUE INDEX "Badge_key_key" ON "Badge"("key");

-- CreateIndex
CREATE INDEX "GroupBadge_groupId_idx" ON "GroupBadge"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupBadge_groupId_badgeId_key" ON "GroupBadge"("groupId", "badgeId");

-- CreateIndex
CREATE INDEX "XpLedger_groupId_idx" ON "XpLedger"("groupId");

-- CreateIndex
CREATE INDEX "XpLedger_rm_idx" ON "XpLedger"("rm");

-- CreateIndex
CREATE UNIQUE INDEX "XpLedger_groupId_missionId_key" ON "XpLedger"("groupId", "missionId");

-- CreateIndex
CREATE INDEX "Submission_groupId_idx" ON "Submission"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupTeachingSettings_groupId_key" ON "GroupTeachingSettings"("groupId");

-- AddForeignKey
ALTER TABLE "MissionProgress" ADD CONSTRAINT "MissionProgress_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionProgress" ADD CONSTRAINT "MissionProgress_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBadge" ADD CONSTRAINT "GroupBadge_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBadge" ADD CONSTRAINT "GroupBadge_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "Badge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XpLedger" ADD CONSTRAINT "XpLedger_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupTeachingSettings" ADD CONSTRAINT "GroupTeachingSettings_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

