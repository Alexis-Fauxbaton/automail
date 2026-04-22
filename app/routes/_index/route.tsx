import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const headers: HeadersFunction = () => ({
  "Cache-Control": "no-store",
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (shop) {
    // Reconstruct `host` if missing — the SDK requires it for embedded auth.
    // After an OAuth callback, `host` is not in the redirect URL, so we
    // derive it from the shop subdomain (e.g. "2ed20e" from 2ed20e.myshopify.com).
    if (!url.searchParams.get("host")) {
      const shopId = shop.split(".")[0];
      const host = Buffer.from(
        `admin.shopify.com/store/${shopId}`
      ).toString("base64");
      url.searchParams.set("host", host);
    }
    throw redirect(`/app?${url.searchParams.toString()}`, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>A short heading about [your app]</h1>
        <p className={styles.text}>
          A tagline about [your app] that describes your value proposition.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Product feature</strong>. Some detail about your feature and
            its benefit to your customer.
          </li>
          <li>
            <strong>Product feature</strong>. Some detail about your feature and
            its benefit to your customer.
          </li>
          <li>
            <strong>Product feature</strong>. Some detail about your feature and
            its benefit to your customer.
          </li>
        </ul>
      </div>
    </div>
  );
}
