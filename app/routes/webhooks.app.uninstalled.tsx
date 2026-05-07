import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await db.$transaction([
    db.syncJob.deleteMany({ where: { shop } }),
    db.llmCallLog.deleteMany({ where: { shop } }),
    db.incomingEmail.deleteMany({ where: { shop } }),
    db.thread.deleteMany({ where: { shop } }),
    db.mailConnection.deleteMany({ where: { shop } }),
    db.supportSettings.deleteMany({ where: { shop } }),
    db.userPreference.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);

  return new Response();
};
