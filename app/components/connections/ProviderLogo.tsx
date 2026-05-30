/**
 * Inline SVG logos for the 3 supported mail providers, drawn from each
 * brand's public mark. Used by the AddMailboxModal so the merchant
 * immediately recognises the provider they're about to connect.
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
  // Gmail envelope "M" — Google brand mark
  return (
    <svg width={size} height={size} viewBox="0 0 256 192" xmlns="http://www.w3.org/2000/svg" aria-label="Gmail">
      <path fill="#4285F4" d="M58.182 192V79.27L0 33.821v144.94c0 7.32 5.936 13.24 13.27 13.24h44.912Z" />
      <path fill="#34A853" d="M197.818 192h44.912c7.334 0 13.27-5.92 13.27-13.24v-144.94L197.818 79.27V192Z" />
      <path fill="#FBBC04" d="M197.818 13.27v65.999L256 33.821V19.91c0-12.892-14.715-20.244-25-12.49l-33.182 25.85Z" />
      <path fill="#EA4335" d="M58.182 79.27v-66L128 65.45l69.818-52.18v66L128 131.45 58.182 79.27Z" />
      <path fill="#C5221F" d="M0 19.91v13.911L58.182 79.27V13.27L25 -12.58C14.715 -20.334 0 -12.982 0 0V19.91Z" />
    </svg>
  );
}

function OutlookLogo({ size }: { size: number }) {
  // Outlook "O" mark — Microsoft brand
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-label="Outlook">
      <path
        fill="#0072C6"
        d="M14 4v24L2 25.5v-19L14 4zm2 2.5v19L30 28V4L16 6.5zM8 11.5c-2.5 0-4.5 2-4.5 4.5s2 4.5 4.5 4.5 4.5-2 4.5-4.5-2-4.5-4.5-4.5zm0 2.2c1.3 0 2.3 1 2.3 2.3s-1 2.3-2.3 2.3-2.3-1-2.3-2.3 1-2.3 2.3-2.3z"
      />
      <path fill="#fff" d="M16 6.5L23 11l7-4.5V8l-7 4.5L16 8z" opacity=".3" />
    </svg>
  );
}

function ZohoLogo({ size }: { size: number }) {
  // Zoho Mail envelope mark — Zoho brand red
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-label="Zoho Mail">
      <rect width="32" height="32" rx="6" fill="#E42527" />
      <path
        fill="#fff"
        d="M6 10.5c0-.83.67-1.5 1.5-1.5h17c.83 0 1.5.67 1.5 1.5v11c0 .83-.67 1.5-1.5 1.5h-17c-.83 0-1.5-.67-1.5-1.5v-11Zm2 .8v9.7c0 .28.22.5.5.5h15c.28 0 .5-.22.5-.5v-9.7l-8 5.5-8-5.5Zm.4-1.3 7.6 5.25 7.6-5.25H8.4Z"
      />
    </svg>
  );
}
