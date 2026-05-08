import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    const { payload, session, topic, shop } = await authenticate.webhook(request);
    console.log(`Received ${topic} webhook for ${shop}`);

    const current = payload.current as string[];
    if (session) {
        await db.session.update({
            where: {
                id: session.id
            },
            data: {
                scope: current.toString(),
            },
        });
    } else {
        // The webhook signature was valid but no Shopify session row exists for
        // this shop — likely an orphaned uninstall/reinstall window. Log so this
        // does not silently fail to update scopes.
        console.warn(`[webhook] ${topic} for ${shop} arrived without a session — scope update skipped`);
    }
    return new Response();
};
