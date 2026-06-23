import prisma from "../../db.server";

/**
 * Clean a user-supplied sender name before it goes into the From header.
 * Strips CR/LF/quotes/control chars (header-injection + quoting defense),
 * trims, and caps length.
 */
export function sanitizeFromName(raw: string): string {
  return raw
    .replace(/[\x00-\x1F\x7F"]/g, "")
    .trim()
    .slice(0, 100);
}

/**
 * Seed MailConnection.displayName from a provider-captured name, but only when
 * it is currently empty — never clobber a manual edit or a prior capture.
 * Used by every provider's saveConnection on reconnect.
 */
export async function seedDisplayNameIfEmpty(
  id: string,
  name: string | null | undefined,
): Promise<void> {
  const n = sanitizeFromName(name ?? "");
  if (!n) return;
  await prisma.mailConnection.updateMany({
    where: { id, OR: [{ displayName: null }, { displayName: "" }] },
    data: { displayName: n },
  });
}
