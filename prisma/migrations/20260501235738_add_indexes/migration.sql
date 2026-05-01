-- CreateIndex
CREATE INDEX "MailConnection_autoSyncEnabled_lastSyncAt_idx" ON "MailConnection"("autoSyncEnabled", "lastSyncAt");

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE INDEX "Thread_shop_operationalState_operationalStateUpdatedAt_idx" ON "Thread"("shop", "operationalState", "operationalStateUpdatedAt");
