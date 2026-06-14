-- Reply-To recipient: parse the Reply-To header at ingestion so replies go to
-- the actual customer (e.g. Shopify contact-form emails are From
-- mailer@shopify.com but Reply-To the customer), matching native mail-client
-- behaviour. Nullable; existing rows backfill on next sync.
ALTER TABLE "IncomingEmail" ADD COLUMN "replyToAddress" TEXT;
