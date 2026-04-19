/**
 * Infer the likely carrier from a tracking number pattern and return
 * the tracking page URL(s) to try — prioritizing pages that render server-side.
 *
 * Aggregators (ordertracker.com, parcelsapp.com, etc.) are intentionally
 * avoided as primary sources because they all rely on client-side JS to fetch
 * and display tracking data, making them unfetchable without a real browser.
 */

export interface CarrierCandidate {
  name: string;
  trackingUrl: string;
}

const CARRIERS: Array<{
  name: string;
  pattern: RegExp;
  url: (n: string) => string;
}> = [
  // Chronopost (FR) — CNFR, CJD, etc.
  {
    name: "Chronopost",
    pattern: /^(CNFR|CJD|XB|XF)[0-9A-Z]+$/i,
    url: (n) =>
      `https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumeros=${n}`,
  },
  // Colissimo / La Poste — 13-digit or CN...FR format
  {
    name: "Colissimo",
    pattern: /^(6[A-Z][0-9]{11}|[A-Z]{2}[0-9]{9}FR)$/i,
    url: (n) => `https://www.laposte.fr/outils/suivre-vos-envois?code=${n}`,
  },
  // Colis Privé
  {
    name: "Colis Privé",
    pattern: /^CP[0-9]{10,}/i,
    url: (n) =>
      `https://www.colisprive.fr/moncolis/pages/detailColis.aspx?numColis=${n}`,
  },
  // DPD France
  {
    name: "DPD",
    pattern: /^(08|09)[0-9]{11}$/,
    url: (n) => `https://www.dpd.fr/trace/${n}`,
  },
  // GLS France
  {
    name: "GLS",
    pattern: /^[0-9]{11}$/,
    url: (n) =>
      `https://gls-group.com/track/${n}`,
  },
  // Mondial Relay
  {
    name: "Mondial Relay",
    pattern: /^(MR|24R)[0-9]+$/i,
    url: (n) => `https://www.mondialrelay.fr/suivi-de-colis/?NumColis=${n}`,
  },
  // UPS
  {
    name: "UPS",
    pattern: /^1Z[0-9A-Z]{16}$/i,
    url: (n) => `https://www.ups.com/track?tracknum=${n}&requester=ST/trackdetails`,
  },
  // FedEx
  {
    name: "FedEx",
    pattern: /^[0-9]{12,15}$/,
    url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  },
];

/**
 * Return the list of tracking URLs to try for a given tracking number,
 * from most to least likely to yield SSR content.
 *
 * @param trackingNumber  raw tracking number
 * @param shopifyUrl      Shopify-provided URL (highest priority if present)
 */
export function resolveCarrierUrls(
  trackingNumber: string,
  shopifyUrl?: string | null,
): CarrierCandidate[] {
  const candidates: CarrierCandidate[] = [];

  // Shopify URL first if provided
  if (shopifyUrl) {
    candidates.push({ name: "Shopify tracking", trackingUrl: shopifyUrl });
  }

  // Pattern-matched carrier pages
  for (const c of CARRIERS) {
    if (c.pattern.test(trackingNumber.trim())) {
      candidates.push({ name: c.name, trackingUrl: c.url(trackingNumber) });
    }
  }

  return candidates;
}
