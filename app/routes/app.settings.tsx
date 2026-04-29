import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useTranslation } from "react-i18next";

import { authenticate } from "../shopify.server";
import { getSettings, saveSettings } from "../lib/support/settings";
import { SettingsIcon } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  return { settings };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const saved = await saveSettings(session.shop, {
    signatureName: String(formData.get("signatureName") ?? ""),
    brandName: String(formData.get("brandName") ?? ""),
    tone: String(formData.get("tone") ?? "friendly"),
    language: String(formData.get("language") ?? "auto"),
    closingPhrase: String(formData.get("closingPhrase") ?? ""),
    shareTrackingNumber: formData.get("shareTrackingNumber") === "true",
    customerGreetingStyle: String(formData.get("customerGreetingStyle") ?? "auto"),
    refundPolicy: String(formData.get("refundPolicy") ?? ""),
  });

  return { settings: saved, saved: true };
};

export default function SettingsPage() {
  const { settings: initial } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const { t } = useTranslation();

  const settings = actionData?.settings ?? initial;

  return (
    <s-page heading={t("settings.pageHeading")}>
      <Form method="post">
        <s-stack direction="block" gap="base">

          <div className="ui-hero">
            <span className="ui-hero__eyebrow">
              <SettingsIcon size={14} />
              {t("settings.eyebrow")}
            </span>
            <h2 className="ui-hero__title">{t("settings.heroTitle")}</h2>
            <p className="ui-hero__lead">{t("settings.heroLead")}</p>
          </div>

          <s-section heading={t("settings.draftPersonalization")}>
            <s-paragraph>{t("settings.draftPersonalizationDesc")}</s-paragraph>

            <s-stack direction="block" gap="base">
              <s-text-field
                label={t("settings.signatureName")}
                name="signatureName"
                defaultValue={settings.signatureName}
                placeholder={t("settings.signatureNamePlaceholder")}
                details={t("settings.signatureNameDetails")}
              />

              <s-text-field
                label={t("settings.brandName")}
                name="brandName"
                defaultValue={settings.brandName}
                placeholder={t("settings.brandNamePlaceholder")}
                details={t("settings.brandNameDetails")}
              />

              <s-select
                label={t("settings.tone")}
                name="tone"
                value={settings.tone}
                details={t("settings.toneDetails")}
              >
                <s-option value="friendly">{t("settings.toneFriendly")}</s-option>
                <s-option value="formal">{t("settings.toneFormal")}</s-option>
                <s-option value="neutral">{t("settings.toneNeutral")}</s-option>
              </s-select>

              <s-select
                label={t("settings.replyLanguage")}
                name="language"
                value={settings.language}
                details={t("settings.replyLanguageDetails")}
              >
                <s-option value="auto">{t("settings.languageAuto")}</s-option>
                <s-option value="fr">{t("settings.languageFrench")}</s-option>
                <s-option value="en">{t("settings.languageEnglish")}</s-option>
              </s-select>

              <s-text-field
                label={t("settings.closingPhrase")}
                name="closingPhrase"
                defaultValue={settings.closingPhrase}
                placeholder={t("settings.closingPhrasePlaceholder")}
                details={t("settings.closingPhraseDetails")}
              />

              <s-select
                label={t("settings.greetingStyle")}
                name="customerGreetingStyle"
                value={settings.customerGreetingStyle}
                details={t("settings.greetingStyleDetails")}
              >
                <s-option value="auto">{t("settings.greetingAuto")}</s-option>
                <s-option value="first_name">{t("settings.greetingFirstName")}</s-option>
                <s-option value="full_name">{t("settings.greetingFullName")}</s-option>
                <s-option value="neutral">{t("settings.greetingNeutral")}</s-option>
              </s-select>

              <s-select
                label={t("settings.shareTracking")}
                name="shareTrackingNumber"
                value={settings.shareTrackingNumber ? "true" : "false"}
                details={t("settings.shareTrackingDetails")}
              >
                <s-option value="true">{t("settings.shareTrackingYes")}</s-option>
                <s-option value="false">{t("settings.shareTrackingNo")}</s-option>
              </s-select>
            </s-stack>
          </s-section>

          <s-section heading={t("settings.refundSection")}>
            <s-paragraph>{t("settings.refundDesc")}</s-paragraph>

            <s-text-area
              label={t("settings.refundPolicy")}
              name="refundPolicy"
              defaultValue={settings.refundPolicy}
              placeholder={t("settings.refundPolicyPlaceholder")}
              rows={6}
            />
          </s-section>

          <s-section>
            <s-stack direction="inline" gap="base">
              <s-button
                type="submit"
                {...(isSubmitting ? { loading: true } : {})}
              >
                {t("settings.saveSettings")}
              </s-button>

              {actionData?.saved && (
                <s-banner tone="success">{t("settings.settingsSaved")}</s-banner>
              )}
            </s-stack>
          </s-section>

        </s-stack>
      </Form>
    </s-page>
  );
}
