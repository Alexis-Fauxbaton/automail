/**
 * SSRF-safe outbound fetch helpers.
 *
 * Any fetch whose URL derives (even partially) from merchant-controlled or
 * customer-controlled data must go through these guards. A malicious
 * merchant could plant a tracking URL pointing to cloud metadata
 * (169.254.169.254), a loopback service (127.0.0.1), or an RFC1918 host
 * on our VPC — none of which we want our server to dereference.
 *
 * The guard layers:
 *   1. HTTPS-only (http:// is refused).
 *   2. Hostname allowlist (optional, per call site).
 *   3. DNS resolution + block on private / link-local / loopback /
 *      metadata / CGNAT ranges.
 *   4. No automatic redirect following to a disallowed host (we set
 *      redirect: "manual" when an allowlist is active and re-validate).
 *
 * This is the standard OWASP SSRF mitigation recipe. It does not replace
 * network-level egress controls (which should also exist in production),
 * but it gives us application-level defense-in-depth.
 */

import { lookup } from "dns/promises";

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // reject malformed
  const [a, b] = parts;
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 127) return true;                      // 127.0.0.0/8
  if (a === 0) return true;                        // 0.0.0.0/8
  if (a === 169 && b === 254) return true;         // link-local / AWS metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;         // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true;                       // multicast / reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true;                          // link-local
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped
    const v4 = lower.slice(7);
    return isPrivateIPv4(v4);
  }
  return false;
}

export interface SafeFetchOptions {
  /** Hostname allowlist. If provided, any other host is refused. */
  allowedHosts?: ReadonlySet<string>;
  /** Timeout in ms. Default 8000. */
  timeoutMs?: number;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Max redirects (default 3). */
  maxRedirects?: number;
}

/**
 * Perform a GET request that is guarded against SSRF. Resolves to the
 * Response on success, or throws on validation failure.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { allowedHosts, timeoutMs = 8000, headers, maxRedirects = 3 } = opts;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("safe_fetch_invalid_url");
  }
  if (url.protocol !== "https:") throw new Error("safe_fetch_non_https");

  const host = url.hostname.toLowerCase();
  if (allowedHosts && !allowedHosts.has(host)) {
    throw new Error("safe_fetch_host_not_allowlisted");
  }

  // Resolve DNS and reject private/internal targets. `lookup` returns
  // whatever the OS resolver gives us — good enough to stop accidental
  // SSRF via merchant-controlled URLs. For full belt-and-braces you'd
  // also re-check after each redirect, which we do below.
  await assertPublicHost(host);

  // Manual redirect handling so we can re-validate each hop.
  let currentUrl = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(currentUrl, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      let next: URL;
      try {
        next = new URL(loc, currentUrl);
      } catch {
        throw new Error("safe_fetch_bad_redirect");
      }
      if (next.protocol !== "https:") throw new Error("safe_fetch_redirect_non_https");
      if (allowedHosts && !allowedHosts.has(next.hostname.toLowerCase())) {
        throw new Error("safe_fetch_redirect_off_allowlist");
      }
      await assertPublicHost(next.hostname.toLowerCase());
      currentUrl = next;
      continue;
    }
    return res;
  }
  throw new Error("safe_fetch_too_many_redirects");
}

async function assertPublicHost(host: string): Promise<void> {
  // Literal IP in the hostname — validate directly.
  if (/^[0-9.]+$/.test(host)) {
    if (isPrivateIPv4(host)) throw new Error("safe_fetch_private_ip");
    return;
  }
  if (host.includes(":")) {
    if (isPrivateIPv6(host)) throw new Error("safe_fetch_private_ip");
    return;
  }
  const addrs = await lookup(host, { all: true });
  if (!addrs.length) throw new Error("safe_fetch_dns_empty");
  for (const a of addrs) {
    if (a.family === 4 && isPrivateIPv4(a.address)) throw new Error("safe_fetch_private_ip");
    if (a.family === 6 && isPrivateIPv6(a.address)) throw new Error("safe_fetch_private_ip");
  }
}
