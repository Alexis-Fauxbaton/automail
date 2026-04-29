import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useNavigation } from "react-router";
import { useTranslation } from "react-i18next";

import { authenticate } from "../shopify.server";
import {
  analyzeSupportEmail,
  type SupportAnalysisExtended,
} from "../lib/support/orchestrator";
import { AnalysisDisplay } from "../components/SupportAnalysisDisplay";
import { SparklesIcon } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const subject = String(formData.get("subject") ?? "");
  const body = String(formData.get("body") ?? "");

  if (!subject.trim() && !body.trim()) {
    return {
      errorKey: "support.missingContent" as string | null,
      analysis: null as SupportAnalysisExtended | null,
    };
  }

  const analysis = await analyzeSupportEmail({
    subject,
    body,
    admin,
    shop: session.shop,
  });
  return { errorKey: null as string | null, analysis };
};

export default function SupportPage() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const analysis = actionData?.analysis ?? null;
  const { t } = useTranslation();

  return (
    <s-page heading={t("support.pageHeading")}>
      <div className="ui-page">
        <div className="ui-hero">
          <span className="ui-hero__eyebrow">
            <SparklesIcon size={14} />
            {t("support.eyebrow")}
          </span>
          <h2 className="ui-hero__title">{t("support.heroTitle")}</h2>
          <p className="ui-hero__lead">{t("support.heroLead")}</p>
        </div>

        <s-section heading={t("support.incomingEmail")}>
          <Form method="post">
            <s-stack direction="block" gap="base">
              <s-text-field
                label={t("support.subject")}
                name="subject"
                placeholder={t("support.subjectPlaceholder")}
              />
              <s-text-area
                label={t("support.body")}
                name="body"
                rows={10}
                placeholder={t("support.bodyPlaceholder")}
              />
              <s-button
                type="submit"
                {...(isSubmitting ? { loading: true } : {})}
              >
                {isSubmitting ? t("support.analyzing") : t("support.analyze")}
              </s-button>
              {actionData?.errorKey && (
                <s-banner tone="critical">{t(actionData.errorKey)}</s-banner>
              )}
            </s-stack>
          </Form>
        </s-section>

        {analysis && (
          <>
            <s-section heading={t("support.analysisSection")}>
              <AnalysisDisplay analysis={analysis} />
            </s-section>

            <s-section heading={t("support.draftReplySection")}>
              <s-stack direction="block" gap="base">
                {analysis.conversation.noReplyNeeded ? (
                  <s-banner tone="info">
                    {t("support.noReplyBanner")}
                  </s-banner>
                ) : (
                  <s-text-area
                    label={t("support.draftLabel")}
                    name="draft"
                    rows={14}
                    defaultValue={analysis.draftReply}
                  />
                )}
                <s-paragraph>
                  <s-text>{t("support.draftDisclaimer")}</s-text>
                </s-paragraph>
              </s-stack>
            </s-section>
          </>
        )}
      </div>
    </s-page>
  );
}
