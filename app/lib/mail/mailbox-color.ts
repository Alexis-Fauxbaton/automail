export type MailboxColor = { bg: string; fg: string };

const PALETTE: MailboxColor[] = [
  { bg: "#dbeafe", fg: "#1e40af" }, // blue
  { bg: "#fef3c7", fg: "#92400e" }, // amber
  { bg: "#d1fae5", fg: "#065f46" }, // emerald
  { bg: "#fae8ff", fg: "#86198f" }, // fuchsia
  { bg: "#ffe4e6", fg: "#9f1239" }, // rose
  { bg: "#e0e7ff", fg: "#3730a3" }, // indigo
];

export function mailboxColor(email: string): MailboxColor {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash * 31 + email.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
