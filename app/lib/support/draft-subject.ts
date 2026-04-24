export function buildReplySubject(originalSubject: string): string {
  const stripped = originalSubject.replace(/^(re:\s*)+/i, "");
  return `Re: ${stripped}`;
}
