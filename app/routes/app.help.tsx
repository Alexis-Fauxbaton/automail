import type { LoaderFunctionArgs } from "react-router";
import { useTranslation } from "react-i18next";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

const SUPPORT_EMAIL = "blmcontactpro1@gmail.com";

export default function HelpPage() {
  const { t } = useTranslation();

  return (
    <s-page heading={t("help.title")}>
      <s-section heading={t("help.contactHeading")}>
        <s-paragraph>
          {t("help.contactBody1")}{" "}
          <s-link href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</s-link>
          {t("help.contactBody2")}
        </s-paragraph>
      </s-section>

      <s-section heading={t("help.quickStartHeading")}>
        <s-unordered-list>
          <s-list-item>{t("help.quickStartStep1")}</s-list-item>
          <s-list-item>{t("help.quickStartStep2")}</s-list-item>
          <s-list-item>{t("help.quickStartStep3")}</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading={t("help.privacyHeading")}>
        <s-paragraph>
          {t("help.privacyBody")}{" "}
          <s-link href="/privacy" target="_blank">
            /privacy
          </s-link>
          .
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
