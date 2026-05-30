-- ReplyDraft : track send lifecycle
ALTER TABLE "ReplyDraft" ADD COLUMN "sendingStartedAt" TIMESTAMP(3);
ALTER TABLE "ReplyDraft" ADD COLUMN "sentAt" TIMESTAMP(3);
ALTER TABLE "ReplyDraft" ADD COLUMN "sentRfcMessageId" TEXT;
ALTER TABLE "ReplyDraft" ADD COLUMN "sendError" TEXT;
ALTER TABLE "ReplyDraft" ADD COLUMN "linkedOutgoingEmailId" TEXT;

CREATE INDEX "ReplyDraft_sendingStartedAt_idx" ON "ReplyDraft"("sendingStartedAt") WHERE "sendingStartedAt" IS NOT NULL;
CREATE INDEX "ReplyDraft_sentAt_idx" ON "ReplyDraft"("sentAt") WHERE "sentAt" IS NOT NULL;

-- IncomingEmail : mark messages created by our send action vs synced from provider
ALTER TABLE "IncomingEmail" ADD COLUMN "sourceMarker" TEXT;
CREATE INDEX "IncomingEmail_sourceMarker_idx" ON "IncomingEmail"("sourceMarker") WHERE "sourceMarker" IS NOT NULL;

-- MailConnection : persist OAuth scopes granted at callback (CSV, lowercase)
ALTER TABLE "MailConnection" ADD COLUMN "grantedScopes" TEXT;

-- ThreadStateHistory : record WHY a transition happened (e.g. draft_sent)
ALTER TABLE "ThreadStateHistory" ADD COLUMN "reason" TEXT;
