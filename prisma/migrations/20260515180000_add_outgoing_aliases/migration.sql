-- Add outgoingAliases to MailConnection.
-- Stores a JSON-encoded array of lowercased email addresses the merchant
-- can send from (primary mailbox + aliases). Replaces the legacy
-- self-reinforcing knownOutgoingAddresses pool in outgoing-detection.ts.
ALTER TABLE "MailConnection" ADD COLUMN "outgoingAliases" TEXT NOT NULL DEFAULT '[]';
