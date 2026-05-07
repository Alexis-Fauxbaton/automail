import sanitizeHtml from "sanitize-html";
import prisma from "../../db.server";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev.splice(0, n + 1, ...curr);
  }
  return prev[n];
}

// ---------------------------------------------------------------------------
// Pure exports
// ---------------------------------------------------------------------------

/**
 * Normalise an email body for similarity comparison:
 * - strips HTML
 * - removes quoted-reply blocks ("> …", "Le X a écrit :", "On X wrote:")
 * - removes signatures after "-- "
 * - strips accents, lowercases, collapses whitespace
 */
export function normalizeBody(input: string): string {
  // Strip quoted lines and French/English reply blocks BEFORE HTML sanitization
  // (so that ">" characters aren't HTML-encoded to "&gt;" first)
  const withoutQuotes = input
    .replace(/^>.*$/gm, "")
    .replace(/^Le\s.+a\s[eé]crit\s*:[\s\S]*/m, "")
    .replace(/^On\s.+wrote\s*:[\s\S]*/m, "");
  // Strip signature after "-- "
  const withoutSig = withoutQuotes.replace(/\n--\s*\n[\s\S]*/m, "");
  // Strip HTML (after quote removal so ">" chars from quote markers are gone)
  const stripped = sanitizeHtml(withoutSig, { allowedTags: [], allowedAttributes: {} });
  // Strip accents, lowercase, collapse whitespace
  return stripped
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compute a normalised similarity score in [0, 1] between two strings.
 * Uses Levenshtein edit distance relative to the longer string.
 */
export function computeSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Classify how a draft was used relative to the outgoing reply.
 *
 * Thresholds:
 *   >= 0.85 → as_is   (sent essentially unchanged)
 *   >= 0.30 → edited  (noticeably modified)
 *    < 0.30 → ignored (different message sent)
 */
export function classifyDraft(
  draftBody: string,
  outgoingBody: string,
): "as_is" | "edited" | "ignored" {
  const sim = computeSimilarity(normalizeBody(draftBody), normalizeBody(outgoingBody));
  if (sim >= 0.85) return "as_is";
  if (sim >= 0.30) return "edited";
  return "ignored";
}

// ---------------------------------------------------------------------------
// Async persistence
// ---------------------------------------------------------------------------

/**
 * Evaluate all drafts in a thread against the first outgoing reply that
 * followed each draft, then persist the heuristic bucket to the DB.
 */
export async function evaluateThread(
  canonicalThreadId: string,
  shop: string,
): Promise<void> {
  const drafts = await prisma.replyDraft.findMany({
    where: { shop, email: { canonicalThreadId } },
    select: {
      id: true,
      body: true,
      bodyHistory: true,
      createdAt: true,
      heuristicComputedAt: true,
    },
  });

  if (drafts.length === 0) return;

  const outgoings = await prisma.incomingEmail.findMany({
    where: { shop, canonicalThreadId, processingStatus: "outgoing" },
    orderBy: { receivedAt: "asc" },
    select: { receivedAt: true, bodyText: true },
  });

  for (const draft of drafts) {
    const firstOutgoing = outgoings.find((o) => o.receivedAt > draft.createdAt);
    if (!firstOutgoing) continue;

    // Skip if already evaluated against a current or later outgoing
    if (draft.heuristicComputedAt && draft.heuristicComputedAt >= firstOutgoing.receivedAt) {
      continue;
    }

    // Use earliest known draft version (before any edits)
    const history = Array.isArray(draft.bodyHistory) ? (draft.bodyHistory as string[]) : [];
    const draftBodyAtSend = history.length > 0 ? history[0] : (draft.body ?? "");

    let bucket: "as_is" | "edited" | "ignored";
    try {
      bucket = classifyDraft(draftBodyAtSend, firstOutgoing.bodyText);
    } catch (err) {
      console.error(`[draft-heuristic] classify failed for draft=${draft.id}:`, err);
      bucket = "ignored";
    }

    await prisma.replyDraft.update({
      where: { id: draft.id },
      data: { heuristicBucket: bucket, heuristicComputedAt: new Date() },
    });
  }
}
