import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useActionData, useLoaderData, useNavigation } from "react-router";
import { useTranslation } from "react-i18next";
import { useRef, useEffect, useState } from "react";

import { authenticate } from "../shopify.server";
import { getSettings, saveSettings } from "../lib/support/settings";
import { getUiLanguage, saveUiLanguage } from "../lib/user-preferences";
import { SettingsIcon } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  const userId = sessionToken?.sub ?? null;
  const uiLanguage = userId ? await getUiLanguage(userId, session.shop) : "en";
  return { settings, uiLanguage };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "saveUiLanguage") {
    const userId = sessionToken?.sub ?? null;
    if (userId) {
      await saveUiLanguage(userId, session.shop, String(formData.get("uiLanguage") ?? "en"));
    }
    return { saved: false, settings: null };
  }

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

function CharacterCount({ children, max, initial, hasDetails = false }: { children: React.ReactNode; max: number; initial: string; hasDetails?: boolean }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(initial.length);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const handler = (e: Event) => {
      const el = e.target as HTMLElement & { value?: string };
      if (el.value !== undefined) setCount(el.value.length);
    };
    wrapper.addEventListener("input", handler);
    return () => wrapper.removeEventListener("input", handler);
  }, []);

  const color = count > max ? "#c0392b" : count > max * 0.85 ? "#b45309" : "#9ca3af";

  return (
    <div ref={wrapperRef}>
      {children}
      <div style={{ textAlign: "right", fontSize: 11, marginTop: hasDetails ? "-1rem" : "4px", color }}>{count} / {max}</div>
    </div>
  );
}

export default function SettingsPage() {
  const { settings: initial, uiLanguage: savedUiLanguage } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const langFetcher = useFetcher();
  const isSubmitting = navigation.state === "submitting";
  const { t, i18n } = useTranslation();

  const settings = actionData?.settings ?? initial;
  const langSelectRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = langSelectRef.current?.querySelector("s-select");
    if (!el) return;
    const handleChange = () => {
      const value = (el as unknown as { value: string }).value;
      if (!value) return;
      i18n.changeLanguage(value);
      langFetcher.submit(
        { intent: "saveUiLanguage", uiLanguage: value },
        { method: "post" },
      );
    };
    el.addEventListener("change", handleChange);
    return () => el.removeEventListener("change", handleChange);
  }, [i18n, langFetcher]);

  return (
    <s-page heading={t("settings.pageHeading")}>
      <>
      <s-section heading={t("settings.uiLanguageSection")}>
        <div ref={langSelectRef}>
          <s-select
            name="uiLanguage"
            label={t("settings.uiLanguageLabel")}
            value={savedUiLanguage}
            details={t("settings.uiLanguageDetails")}
          >
            <s-option value="fr">{t("settings.uiLanguageFr")}</s-option>
            <s-option value="en">{t("settings.uiLanguageEn")}</s-option>
          </s-select>
        </div>
      </s-section>
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
              <CharacterCount max={80} initial={settings.signatureName} hasDetails>
                <s-text-field
                  label={t("settings.signatureName")}
                  name="signatureName"
                  defaultValue={settings.signatureName}
                  placeholder={t("settings.signatureNamePlaceholder")}
                  details={t("settings.signatureNameDetails")}
                />
              </CharacterCount>

              <CharacterCount max={80} initial={settings.brandName} hasDetails>
                <s-text-field
                  label={t("settings.brandName")}
                  name="brandName"
                  defaultValue={settings.brandName}
                  placeholder={t("settings.brandNamePlaceholder")}
                  details={t("settings.brandNameDetails")}
                />
              </CharacterCount>

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

              <CharacterCount max={120} initial={settings.closingPhrase} hasDetails>
                <s-text-field
                  label={t("settings.closingPhrase")}
                  name="closingPhrase"
                  defaultValue={settings.closingPhrase}
                  placeholder={t("settings.closingPhrasePlaceholder")}
                  details={t("settings.closingPhraseDetails")}
                />
              </CharacterCount>

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

            <CharacterCount max={2000} initial={settings.refundPolicy}>
              <s-text-area
                label={t("settings.refundPolicy")}
                name="refundPolicy"
                defaultValue={settings.refundPolicy}
                placeholder={t("settings.refundPolicyPlaceholder")}
                rows={6}
              />
            </CharacterCount>
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
      </>
    </s-page>
  );
}
