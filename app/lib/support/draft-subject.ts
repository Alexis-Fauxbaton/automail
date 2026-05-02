export function buildReplySubject(originalSubject: string): string {
  const stripped = originalSubject.replace(/^((re|fwd?|fw):\s*)+/i, "");
  return `Re: ${stripped}`;
}
