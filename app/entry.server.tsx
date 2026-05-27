import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { startAutoSyncLoop, stopAutoSyncLoop } from "./lib/mail/auto-sync";
import { runBootCleanup } from "./lib/attachments/boot-cleanup";
import { backfillBillingShopFlags } from "./lib/billing/migration";

export const streamTimeout = 5000;

// Boot-time env validation: production deployments must explicitly set
// the security-sensitive env vars below, otherwise we either silently
// degrade (rate limit, metrics) or use a known-insecure default. We log
// loudly so the missing var shows up in deploy logs; we don't crash boot
// because there's an HMR / dev edge case where these aren't set.
if (process.env.NODE_ENV === "production") {
  const warnings: string[] = [];
  if (!process.env.METRICS_LABEL_SALT) {
    warnings.push(
      "METRICS_LABEL_SALT is not set — Prometheus shop labels will all hash to the same dev salt, " +
        "making per-shop dashboards/alerts indistinguishable. Set a stable random value (32+ chars).",
    );
  }
  if (process.env.TRUSTED_PROXY !== "true" && process.env.TRUSTED_PROXY !== "1") {
    warnings.push(
      "TRUSTED_PROXY is not set — getClientIp returns 'unknown' for all requests, " +
        "so /mail-auth's per-IP rate limit becomes a per-deployment limit. " +
        "Set TRUSTED_PROXY=true behind Render's edge proxy.",
    );
  }
  if (process.env.METRICS_TOKEN && process.env.METRICS_TOKEN.length < 32) {
    warnings.push("METRICS_TOKEN should be at least 32 chars long.");
  }
  for (const w of warnings) console.error(`[BOOT_DEGRADED] ${w}`);
}

// Fire up the backend auto-sync loop exactly once at server boot
// (spec §10). The function itself is idempotent, so double-import
// (HMR, etc.) is safe.
//
// All three boot tasks are wrapped in try/catch so a single failure can't
// brick boot. A failure here is logged and emits BOOT_DEGRADED so ops can
// distinguish "running with reduced functionality" from "running healthy".
try {
  startAutoSyncLoop();
} catch (err) {
  console.error("[BOOT_DEGRADED] startAutoSyncLoop failed at boot:", err);
}
runBootCleanup().catch((err) =>
  console.error("[BOOT_DEGRADED] boot cleanup failed:", err),
);
backfillBillingShopFlags().catch((err) =>
  console.error("[BOOT_DEGRADED] billing flags backfill failed:", err),
);

// Graceful shutdown: when the platform sends SIGTERM (Render waits 30s
// before SIGKILL), stop claiming new jobs and let in-flight syncs drain up
// to 20s. Anything still running past that is reclaimed as a zombie on the
// next boot, so no data loss — just a small retry delay. The 20s + 5s
// post-drain buffer leaves 5s of margin before Render force-kills, which
// is enough for prisma.$disconnect, log flush, and tcp FIN.
let shutdownStarted = false;
async function handleShutdown(signal: string) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`[shutdown] received ${signal}, draining auto-sync...`);
  try {
    await stopAutoSyncLoop(20_000);
  } catch (err) {
    console.error("[shutdown] drain error:", err);
  }
  process.exit(0);
}
process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
process.on("SIGINT", () => void handleShutdown("SIGINT"));

// Defence-in-depth headers applied to every document response.
//
// Intentionally orthogonal to Content-Security-Policy: the Shopify SDK owns
// the CSP header (it sets `frame-ancestors` per-request based on the shop
// query param so the embedded admin frame can load us). Adding script-src /
// style-src directives here would either overwrite Shopify's frame-ancestors
// or require careful merging with App Bridge + Polaris CDN allowances — left
// as a follow-up so we don't ship a broken embedded admin frame.
function setSecurityHeaders(headers: Headers) {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  // HSTS only in production — over HTTP in dev (or behind a non-HTTPS
  // tunnel) the directive would block the very next request.
  if (process.env.NODE_ENV === "production") {
    headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
  setSecurityHeaders(responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? '')
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
