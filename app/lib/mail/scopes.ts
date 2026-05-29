const SEND_SCOPES: Record<string, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.send"],
  outlook: ["mail.send"],
  zoho: ["zohomail.messages.all"],
};

export function canSend(conn: { provider: string; grantedScopes: string | null }): boolean {
  if (!conn.grantedScopes) return false;
  const required = SEND_SCOPES[conn.provider];
  if (!required) return false;
  const granted = new Set(conn.grantedScopes.toLowerCase().split(",").filter(Boolean));
  return required.some((s) => granted.has(s.toLowerCase()));
}
