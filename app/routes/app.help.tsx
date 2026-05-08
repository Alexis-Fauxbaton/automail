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
  const isFr = (typeof navigator !== "undefined" ? navigator.language : "en")
    .toLowerCase()
    .startsWith("fr");

  return (
    <s-page heading={t("help.title")}>
      <s-section heading={t("help.contactHeading")}>
        <s-paragraph>
          {isFr ? (
            <>
              Une question, un bug, ou une suggestion ? Écrivez-nous à{" "}
              <s-link href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</s-link>.
              Nous répondons sous 1 jour ouvré.
            </>
          ) : (
            <>
              Question, bug, or feature request? Reach us at{" "}
              <s-link href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</s-link>.
              We reply within 1 business day.
            </>
          )}
        </s-paragraph>
      </s-section>

      <s-section heading={isFr ? "Démarrage rapide" : "Quick start"}>
        <s-unordered-list>
          <s-list-item>
            {isFr
              ? "Connectez votre boîte mail (Gmail, Zoho ou Outlook) depuis l'onglet Inbox."
              : "Connect your mailbox (Gmail, Zoho or Outlook) from the Inbox tab."}
          </s-list-item>
          <s-list-item>
            {isFr
              ? "Configurez votre signature et votre ton dans Settings."
              : "Configure your signature and tone in Settings."}
          </s-list-item>
          <s-list-item>
            {isFr
              ? "Automail analyse les emails entrants et propose un brouillon. Vous gardez toujours la main pour valider et envoyer."
              : "Automail analyzes incoming emails and drafts replies. You always keep control to review and send."}
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading={isFr ? "Confidentialité" : "Privacy"}>
        <s-paragraph>
          {isFr
            ? "Notre politique de confidentialité est disponible sur "
            : "Our privacy policy is available at "}
          <s-link href="/privacy" target="_blank">
            /privacy
          </s-link>
          .
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
