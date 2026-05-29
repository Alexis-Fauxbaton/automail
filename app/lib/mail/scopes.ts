// Required scopes per provider for the Send flow to actually work.
// All listed scopes must be granted (AND semantics) — Outlook needs both
// Mail.ReadWrite (to create the draft via POST /me/messages) AND Mail.Send
// (to actually send it). The create-draft + send pattern is used because
// /me/sendMail returns 202 No Content, leaving no message id we could
// use for the pre-emptive outgoing IncomingEmail insert.
const SEND_SCOPES: Record<string, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.send"],
  outlook: ["mail.readwrite", "mail.send"],
  zoho: ["zohomail.messages.all"],
};

export function canSend(conn: { provider: string; grantedScopes: string | null }): boolean {
  if (!conn.grantedScopes) return false;
  const required = SEND_SCOPES[conn.provider];
  if (!required) return false;
  const granted = new Set(conn.grantedScopes.toLowerCase().split(",").filter(Boolean));
  return required.every((s) => granted.has(s.toLowerCase()));
}
