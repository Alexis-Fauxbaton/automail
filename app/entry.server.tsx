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

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
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
