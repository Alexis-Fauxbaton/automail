import type { MetaFunction } from "react-router";
import { useTranslation } from "react-i18next";

export const meta: MetaFunction = () => [
  { title: "Privacy Policy – Automail" },
  { name: "description", content: "Automail privacy policy — how we collect, use and protect your data." },
];

export default function PrivacyPage() {
  const { t, i18n } = useTranslation();
  const isFr = i18n.language === "fr";

  return (
    <main style={styles.page}>
      <div style={styles.container}>
        <h1 style={styles.h1}>{t("privacy.title")}</h1>
        <p style={styles.subtitle}>
          <strong>Automail</strong> &mdash; {t("privacy.lastUpdated")}
        </p>

        {isFr ? <PrivacyFr /> : <PrivacyEn />}
      </div>
    </main>
  );
}

function PrivacyEn() {
  return (
    <>
      <Section title="1. Introduction">
        <p>
          Automail (&ldquo;we&rdquo;, &ldquo;our&rdquo;, &ldquo;the App&rdquo;) is a Shopify embedded
          application that helps e-commerce merchants draft customer support replies. This Privacy
          Policy explains what data we access, why we access it, and how we protect it.
        </p>
      </Section>

      <Section title="2. Data we access">
        <p>When you install and use Automail, we access the following data:</p>
        <ul style={styles.ul}>
          <li>
            <strong>Shopify order data</strong> — order number, customer name, email address,
            fulfillment status, financial status, and tracking information. This is retrieved
            via the Shopify Admin API solely to identify the order related to a customer inquiry.
          </li>
          <li>
            <strong>Email content</strong> — if you connect a Gmail, Zoho Mail or Microsoft 365 (Outlook)
            account, we read incoming emails to detect customer support inquiries. Email body, subject,
            sender address, and thread context are processed to generate draft replies.
          </li>
          <li>
            <strong>App settings</strong> — your signature name, brand name, tone preferences,
            language, and refund policy text, as configured in the App settings page.
          </li>
        </ul>
      </Section>

      <Section title="3. Subscription and usage data">
        <p>
          To operate the paid plans (Starter, Pro), we store the following data per shop:
        </p>
        <ul style={styles.ul}>
          <li>
            <strong>Subscription state</strong> — read on demand from Shopify's Billing API
            (active plan name, billing period end). We do not store this; Shopify is the source
            of truth.
          </li>
          <li>
            <strong>Monthly draft counter</strong> — an integer per shop per calendar month,
            incremented each time the AI generates a reply draft. Used to enforce plan quotas.
            Retained for billing audit purposes.
          </li>
          <li>
            <strong>Install date</strong> — to compute trial expiry. Stored once when the app
            is first installed.
          </li>
          <li>
            <strong>Scheduled plan changes</strong> — when a merchant requests a downgrade,
            we record the target plan and effective date until the change is applied.
          </li>
        </ul>
        <p>
          No payment card details ever transit through our servers. All charges are processed
          by Shopify's Billing API directly between the merchant and Shopify.
        </p>
      </Section>

      <Section title="4. How we use your data">
        <p>We use the data described above exclusively to:</p>
        <ul style={styles.ul}>
          <li>Identify the Shopify order related to a customer email.</li>
          <li>Retrieve live parcel tracking status (via the 17track API).</li>
          <li>Generate a draft customer support reply using OpenAI&rsquo;s language models.</li>
          <li>Display the analysis and draft within the App interface for your review.</li>
        </ul>
        <p>We do not use your data for advertising, profiling, or any purpose unrelated to the App&rsquo;s core function.</p>
      </Section>

      <Section title="5. Third-party services">
        <p>To operate, Automail sends data to the following third parties:</p>
        <ul style={styles.ul}>
          <li>
            <strong>OpenAI</strong> — email content and order facts are sent to OpenAI&rsquo;s API
            to classify intent and generate draft replies. OpenAI&rsquo;s data handling is governed
            by their{" "}
            <a style={styles.a} href="https://openai.com/policies/privacy-policy" target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </a>.
            Data submitted via the API is not used to train OpenAI models by default.
          </li>
          <li>
            <strong>17track</strong> — parcel tracking numbers are sent to the 17track API to
            retrieve live delivery status. See their{" "}
            <a style={styles.a} href="https://www.17track.net/en/privacy" target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </a>.
          </li>
          <li>
            <strong>Google (Gmail API)</strong> — if you connect a Gmail account, we use
            Google&rsquo;s OAuth 2.0 and Gmail API with read-only scopes. Tokens are encrypted
            at rest. See{" "}
            <a style={styles.a} href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">
              Google&rsquo;s Privacy Policy
            </a>.
          </li>
          <li>
            <strong>Zoho Mail API</strong> — if you connect a Zoho Mail account, we use Zoho&rsquo;s
            OAuth 2.0 with read-only scopes. Tokens are encrypted at rest. See{" "}
            <a style={styles.a} href="https://www.zoho.com/privacy.html" target="_blank" rel="noopener noreferrer">
              Zoho&rsquo;s Privacy Policy
            </a>.
          </li>
          <li>
            <strong>Microsoft Graph (Outlook / Microsoft 365)</strong> — if you connect a Microsoft
            account, we use Microsoft&rsquo;s OAuth 2.0 and the Microsoft Graph API with mailbox
            read scopes. Tokens are encrypted at rest. See{" "}
            <a style={styles.a} href="https://privacy.microsoft.com/en-us/privacystatement" target="_blank" rel="noopener noreferrer">
              Microsoft&rsquo;s Privacy Statement
            </a>.
          </li>
        </ul>
      </Section>

      <Section title="6. Data storage and security">
        <ul style={styles.ul}>
          <li>
            App data is stored in a PostgreSQL database hosted on{" "}
            <a style={styles.a} href="https://neon.tech" target="_blank" rel="noopener noreferrer">Neon</a>{" "}
            (EU region, encrypted at rest).
          </li>
          <li>
            Gmail and Zoho OAuth tokens are encrypted before storage using AES-256-GCM.
            They are never logged or exposed in API responses.
          </li>
          <li>
            Incoming email bodies are stored temporarily to allow re-analysis and draft refinement.
            They are associated with your shop and are never shared with other merchants.
          </li>
          <li>
            All data in transit is protected by TLS 1.2 or higher.
          </li>
        </ul>
      </Section>

      <Section title="7. Data retention">
        <p>
          Processed emails and generated drafts are retained as long as your Automail account
          is active. When you uninstall the App, your session data is deleted immediately via
          Shopify&rsquo;s uninstall webhook. You may request deletion of all remaining data
          by contacting us (see section 10).
        </p>
      </Section>

      <Section title="8. Your rights">
        <p>
          Depending on your jurisdiction, you may have the right to access, correct, or delete
          personal data we hold about you or your customers. To exercise these rights, please
          contact us using the information below.
        </p>
      </Section>

      <Section title="9. Shopify merchant responsibilities">
        <p>
          As a Shopify merchant using Automail, you are responsible for ensuring that your
          customers are informed about how their data is processed in connection with your
          customer support operations, including the use of AI tools to generate draft replies.
        </p>
      </Section>

      <Section title="10. Contact">
        <p>
          For any questions or data requests related to this Privacy Policy, please contact
          us at:{" "}
          <a style={styles.a} href="mailto:blmcontactpro1@gmail.com">blmcontactpro1@gmail.com</a>
        </p>
      </Section>
    </>
  );
}

function PrivacyFr() {
  return (
    <>
      <Section title="1. Introduction">
        <p>
          Automail (« nous », « notre », « l'Application ») est une application Shopify embarquée qui aide
          les marchands e-commerce à rédiger des réponses au support client. Cette politique de
          confidentialité explique les données auxquelles nous accédons, pourquoi nous y accédons et
          comment nous les protégeons.
        </p>
      </Section>

      <Section title="2. Données auxquelles nous accédons">
        <p>Lors de l'installation et de l'utilisation d'Automail, nous accédons aux données suivantes&nbsp;:</p>
        <ul style={styles.ul}>
          <li>
            <strong>Données de commande Shopify</strong> — numéro de commande, nom du client, adresse email,
            statut d'expédition, statut financier et informations de suivi. Ces données sont récupérées
            via l'API Admin Shopify uniquement pour identifier la commande liée à une demande client.
          </li>
          <li>
            <strong>Contenu des emails</strong> — si vous connectez un compte Gmail, Zoho Mail ou
            Microsoft 365 (Outlook), nous lisons les emails entrants pour détecter les demandes de
            support client. Le corps de l'email, l'objet, l'adresse de l'expéditeur et le contexte
            du fil de discussion sont traités pour générer des brouillons de réponse.
          </li>
          <li>
            <strong>Paramètres de l'application</strong> — votre nom de signature, nom de marque,
            préférences de ton, langue et texte de politique de remboursement, tels que configurés
            dans les paramètres de l'application.
          </li>
        </ul>
      </Section>

      <Section title="3. Données d'abonnement et d'utilisation">
        <p>
          Pour faire fonctionner les plans payants (Starter, Pro), nous stockons les données
          suivantes par boutique&nbsp;:
        </p>
        <ul style={styles.ul}>
          <li>
            <strong>État de l'abonnement</strong> — lu à la demande depuis l'API Shopify Billing
            (nom du plan actif, fin de période de facturation). Nous ne stockons pas cette
            information&nbsp;; Shopify est la source de vérité.
          </li>
          <li>
            <strong>Compteur mensuel de brouillons</strong> — un entier par boutique et par mois
            calendaire, incrémenté à chaque génération d'un brouillon de réponse par l'IA.
            Utilisé pour appliquer les quotas du plan. Conservé pour audit de facturation.
          </li>
          <li>
            <strong>Date d'installation</strong> — pour calculer l'expiration de l'essai.
            Stockée une seule fois lors de la première installation.
          </li>
          <li>
            <strong>Changements de plan planifiés</strong> — lorsqu'un marchand demande un
            downgrade, nous enregistrons le plan cible et la date d'application jusqu'à
            ce que le changement soit appliqué.
          </li>
        </ul>
        <p>
          Aucune donnée de carte de paiement ne transite par nos serveurs. Tous les paiements
          sont traités par l'API Shopify Billing directement entre le marchand et Shopify.
        </p>
      </Section>

      <Section title="4. Utilisation de vos données">
        <p>Nous utilisons les données décrites ci-dessus exclusivement pour&nbsp;:</p>
        <ul style={styles.ul}>
          <li>Identifier la commande Shopify liée à un email client.</li>
          <li>Récupérer le statut de suivi des colis en temps réel (via l'API 17track).</li>
          <li>Générer un brouillon de réponse au support client en utilisant les modèles de langage d'OpenAI.</li>
        </ul>
        <p>
          Nous ne vendons pas, ne partageons pas et ne louons pas vos données à des tiers à des fins
          commerciales. Nous ne stockons pas les emails clients au-delà de ce qui est nécessaire pour
          générer une réponse.
        </p>
      </Section>

      <Section title="5. Services tiers">
        <p>Automail fait appel aux services tiers suivants&nbsp;:</p>
        <ul style={styles.ul}>
          <li><strong>Shopify</strong> — pour l'authentification et l'accès aux données de commande.</li>
          <li><strong>OpenAI</strong> — pour la génération des brouillons de réponse. Les données de commande et d'email pertinentes sont transmises à OpenAI uniquement pour cette fin.</li>
          <li><strong>17track</strong> — pour la récupération du statut de suivi des colis, si applicable.</li>
          <li><strong>Gmail / Zoho Mail / Microsoft 365 (Outlook)</strong> — si vous connectez votre compte email, nous utilisons leur API (avec OAuth 2.0 et scopes en lecture seule) pour lire et surveiller les emails entrants. Les jetons OAuth sont chiffrés au repos.</li>
        </ul>
      </Section>

      <Section title="6. Stockage et sécurité">
        <ul style={styles.ul}>
          <li>
            Les données de l'application sont stockées dans une base PostgreSQL hébergée chez{" "}
            <a style={styles.a} href="https://neon.tech" target="_blank" rel="noopener noreferrer">Neon</a>{" "}
            (région UE, chiffrée au repos).
          </li>
          <li>
            Les jetons OAuth Gmail, Zoho et Microsoft 365 sont chiffrés avant stockage avec AES-256-GCM.
            Ils ne sont jamais journalisés ni exposés dans des réponses d'API.
          </li>
          <li>
            Le contenu des emails entrants est stocké temporairement pour permettre la ré-analyse et le
            raffinement des brouillons. Ces données sont rattachées à votre boutique et ne sont jamais
            partagées avec d'autres marchands.
          </li>
          <li>
            Toutes les données en transit sont protégées par TLS 1.2 ou supérieur.
          </li>
        </ul>
      </Section>

      <Section title="7. Conservation des données">
        <p>
          Nous conservons les emails traités et les brouillons générés tant que votre boutique est
          connectée à Automail. Lorsque vous désinstallez l'application, votre session est immédiatement
          supprimée via le webhook Shopify <code>app/uninstalled</code>. L'intégralité des données de
          la boutique est ensuite purgée 48 heures plus tard via le webhook <code>shop/redact</code>
          conformément aux exigences RGPD.
        </p>
        <p>
          Nous respectons les webhooks de suppression de données Shopify (
          <code>customers/data_request</code>, <code>customers/redact</code>, <code>shop/redact</code>)
          pour garantir la conformité avec la politique de distribution de l'App Store et le RGPD.
        </p>
      </Section>

      <Section title="8. Vos droits">
        <p>
          Selon votre lieu de résidence, vous pouvez disposer de droits sur vos données personnelles,
          notamment le droit d'accès, de rectification ou de suppression. Pour exercer ces droits,
          contactez-nous à l'adresse indiquée ci-dessous.
        </p>
      </Section>

      <Section title="9. Contact">
        <p>
          Pour toute question concernant cette politique de confidentialité ou vos données&nbsp;:{" "}
          <a href="mailto:blmcontactpro1@gmail.com" style={styles.a}>
            blmcontactpro1@gmail.com
          </a>
        </p>
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={styles.section}>
      <h2 style={styles.h2}>{title}</h2>
      {children}
    </section>
  );
}

const styles = {
  page: {
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: "16px",
    lineHeight: "1.7",
    color: "#1a1a1a",
    backgroundColor: "#ffffff",
    minHeight: "100vh",
    padding: "48px 24px 80px",
  } as React.CSSProperties,
  container: {
    maxWidth: "720px",
    margin: "0 auto",
  } as React.CSSProperties,
  h1: {
    fontSize: "2rem",
    fontWeight: "700",
    marginBottom: "4px",
    color: "#111",
  } as React.CSSProperties,
  subtitle: {
    color: "#666",
    marginBottom: "40px",
    fontSize: "0.95rem",
  } as React.CSSProperties,
  section: {
    marginBottom: "36px",
  } as React.CSSProperties,
  h2: {
    fontSize: "1.15rem",
    fontWeight: "600",
    marginBottom: "10px",
    color: "#111",
    borderBottom: "1px solid #eee",
    paddingBottom: "6px",
  } as React.CSSProperties,
  ul: {
    paddingLeft: "20px",
    marginTop: "8px",
  } as React.CSSProperties,
  a: {
    color: "#0070f3",
    textDecoration: "none",
  } as React.CSSProperties,
} as const;
