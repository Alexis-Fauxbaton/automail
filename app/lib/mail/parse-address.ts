/**
 * Extract the first email address from an RFC822 address-list header value
 * such as Reply-To. Handles `"Name" <email@x.com>`, a bare `email@x.com`, and
 * comma-separated lists (takes the first). Returns the lowercased address, or
 * null when none is present.
 */
export function extractEmailAddress(headerValue: string | undefined | null): string | null {
  if (!headerValue) return null;
  const match = headerValue.match(/[^\s<>@,;"']+@[^\s<>@,;"']+\.[^\s<>@,;"']+/);
  return match ? match[0].toLowerCase() : null;
}
