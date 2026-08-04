-- CreateIndex
CREATE INDEX "Order_groupId_status_createdAt_idx" ON "Order"("groupId", "status", "createdAt");

