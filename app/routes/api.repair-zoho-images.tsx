import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createZohoClient } from "../lib/zoho/client";

/**
 * GET /api/repair-zoho-images
 *
 * One-shot route that finds all IncomingEmail rows for the shop whose bodyHtml
 * still contains raw Zoho /mail/ImageDisplay? URLs and re-fetches them so that
 * inline images are embedded as data: URIs.
 *
 * Processes up to 20 emails per call to avoid timeouts.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const emails = await prisma.incomingEmail.findMany({
    where: {
      shop,
      bodyHtml: { contains: "/mail/ImageDisplay?" },
    },
    select: { id: true, externalMessageId: true },
    take: 20,
  });

  if (emails.length === 0) {
    return new Response(JSON.stringify({ fixed: 0, message: "Nothing to fix" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  let client: Awaited<ReturnType<typeof createZohoClient>>;
  try {
    client = await createZohoClient(shop);
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const results: Array<{ id: string; ok: boolean; error?: string }> = [];

  const BATCH_SIZE = 5;
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (email) => {
        try {
          const msg = await client.getMessage(email.externalMessageId);
          if (msg.bodyHtml) {
            await prisma.incomingEmail.update({
              where: { id: email.id },
              data: { bodyHtml: msg.bodyHtml },
            });
            results.push({ id: email.id, ok: true });
          } else {
            results.push({ id: email.id, ok: false, error: "no bodyHtml returned" });
          }
        } catch (err) {
          console.error(`[repair-zoho-images] failed for ${email.id}:`, err);
          results.push({ id: email.id, ok: false, error: String(err) });
        }
      }),
    );
  }

  const fixed = results.filter((r) => r.ok).length;
  console.log(`[repair-zoho-images] fixed=${fixed}/${emails.length} for shop=${shop}`);

  return new Response(JSON.stringify({ fixed, total: emails.length, results }), {
    headers: { "Content-Type": "application/json" },
  });
}
