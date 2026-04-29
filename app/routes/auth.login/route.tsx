import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { useTranslation } from "react-i18next";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  if (shop && !url.searchParams.get("host")) {
    const shopId = shop.split(".")[0];
    const host = Buffer.from(`admin.shopify.com/store/${shopId}`).toString("base64");
    url.searchParams.set("host", host);
    const patchedRequest = new Request(url.toString(), request);
    const errors = loginErrorMessage(await login(patchedRequest));
    return { errors };
  }
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;
  const { t } = useTranslation();

  return (
    <AppProvider embedded={false}>
      <s-page>
        <Form method="post">
          <s-section heading={t("login.heading")}>
            <s-text-field
              name="shop"
              label={t("login.shopDomain")}
              details={t("login.shopDomainDetails")}
              value={shop}
              onChange={(e) => setShop(e.currentTarget.value)}
              autocomplete="on"
              error={errors.shop}
            ></s-text-field>
            <s-button type="submit">{t("login.loginButton")}</s-button>
          </s-section>
        </Form>
      </s-page>
    </AppProvider>
  );
}
