import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { markChecklistDismissed } from "../lib/onboarding/repo";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const { session } = await authenticate.admin(request);
  await markChecklistDismissed(session.shop);
  return { ok: true };
};
