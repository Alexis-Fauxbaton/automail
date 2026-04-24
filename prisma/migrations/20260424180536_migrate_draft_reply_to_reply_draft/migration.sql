-- Data migration: copy existing draftReply / draftHistory into ReplyDraft
INSERT INTO "ReplyDraft" (id, shop, "emailId", body, "bodyHistory", "replyMode", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  ie.shop,
  ie.id,
  ie."draftReply",
  CASE WHEN ie."draftHistory" IS NOT NULL AND ie."draftHistory" != '' THEN ie."draftHistory"::jsonb ELSE '[]'::jsonb END,
  'thread',
  NOW(),
  NOW()
FROM "IncomingEmail" ie
WHERE ie."draftReply" IS NOT NULL
ON CONFLICT ("emailId") DO NOTHING;

-- Remove migrated columns
ALTER TABLE "IncomingEmail" DROP COLUMN "draftReply";
ALTER TABLE "IncomingEmail" DROP COLUMN "draftHistory";
