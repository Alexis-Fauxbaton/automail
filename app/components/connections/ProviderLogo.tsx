/**
 * Inline SVG logos for the 3 supported mail providers, sourced from each
 * brand's public design guidelines (simple-icons.org references).
 * Used by the AddMailboxModal so the merchant immediately recognizes
 * the provider they're about to connect.
 */

export type Provider = "gmail" | "outlook" | "zoho";

export default function ProviderLogo({
  provider,
  size = 28,
}: {
  provider: Provider;
  size?: number;
}) {
  switch (provider) {
    case "gmail":
      return <GmailLogo size={size} />;
    case "outlook":
      return <OutlookLogo size={size} />;
    case "zoho":
      return <ZohoLogo size={size} />;
  }
}

function GmailLogo({ size }: { size: number }) {
  // Gmail envelope "M" — Google brand guidelines
  return (
    <svg width={size} height={size} viewBox="0 0 256 192" xmlns="http://www.w3.org/2000/svg" aria-label="Gmail">
      <path d="M58.182 192h-29.09C13.025 192 0 178.974 0 162.909V46.545L58.182 89.6z" fill="#4285F4" />
      <path d="M197.818 192h29.09c16.067 0 29.092-13.026 29.092-29.091V46.545L197.818 89.6" fill="#34A853" />
      <path d="M58.182 96.864v95.136H197.82V96.864L128 144.318z" fill="#EA4335" />
      <path d="M256 32.727v13.818L197.818 89.6V46.545l25.91-19.418A14.546 14.546 0 0 1 256 32.727" fill="#C5221F" />
      <path d="M0 46.545V32.727a14.55 14.55 0 0 1 23.273-11.6l34.909 26.182V89.6z" fill="#C5221F" />
      <path d="M58.182 89.6V46.545L128 96.864 197.818 46.545V89.6L128 144.318z" fill="#FBBC04" />
    </svg>
  );
}

function OutlookLogo({ size }: { size: number }) {
  // Outlook square + envelope — Microsoft brand
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-label="Outlook">
      <path fill="#0364B8" d="M44 13.5v17.7L29.5 39 28 31V14l16 -.5z" />
      <path fill="#0078D4" d="M44 13.5L28 14v17l16-1V13.5z" />
      <path fill="#0078D4" d="M28 14v17H4V14h24z" />
      <path fill="#50D9FF" d="M44 13.5l-22 14L4 14h40z" opacity=".0" />
      <path fill="#fff" d="M16 18.3c-3.1 0-5.6 2.5-5.6 5.6S12.9 29.5 16 29.5s5.6-2.5 5.6-5.6S19.1 18.3 16 18.3zm0 9.2c-2 0-3.6-1.6-3.6-3.6s1.6-3.6 3.6-3.6 3.6 1.6 3.6 3.6-1.6 3.6-3.6 3.6z" />
      <path fill="#0078D4" d="M28 14L4 14v3.5L20 28l8-5.5z" />
      <path fill="#064A8C" d="M44 13.5L28 14v8.5L44 31z" />
      <path fill="#0A2767" d="M44 31L28 22.5V31z" />
      <path fill="#1490DF" d="M28 14H4l16 11z" />
    </svg>
  );
}

function ZohoLogo({ size }: { size: number }) {
  // Zoho Mail "@" envelope mark — Zoho brand colours
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" aria-label="Zoho Mail">
      <rect width="256" height="256" rx="56" fill="#fff" />
      <path d="M48 64 L208 64 L208 192 L48 192 Z" fill="#E42527" />
      <path d="M48 64 L128 144 L208 64" fill="none" stroke="#fff" strokeWidth="14" strokeLinejoin="round" />
      <path d="M48 192 L112 128" fill="none" stroke="#fff" strokeWidth="14" strokeLinecap="round" />
      <path d="M208 192 L144 128" fill="none" stroke="#fff" strokeWidth="14" strokeLinecap="round" />
    </svg>
  );
}
