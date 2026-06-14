-- Mail account display name, captured at OAuth, used as the outgoing From
-- display name (e.g. "AMBIENT HOME <info@brand.com>"). Nullable; existing
-- connections backfill on next OAuth / re-auth.
ALTER TABLE "MailConnection" ADD COLUMN "displayName" TEXT;
