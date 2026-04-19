import type { MetaFunction } from "react-router";

export const meta: MetaFunction = () => [
  { title: "Privacy Policy – Automail" },
  { name: "description", content: "Automail privacy policy — how we collect, use and protect your data." },
];

export default function PrivacyPage() {
  return (
    <main style={styles.page}>
      <div style={styles.container}>
        <h1 style={styles.h1}>Privacy Policy</h1>
        <p style={styles.subtitle}>
          <strong>Automail</strong> &mdash; Last updated: April 2026
        </p>

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
              <strong>Email content</strong> — if you connect a Gmail or Zoho Mail account, we
              read incoming emails to detect customer support inquiries. Email body, subject, sender
              address, and thread context are processed to generate draft replies.
            </li>
            <li>
              <strong>App settings</strong> — your signature name, brand name, tone preferences,
              language, and refund policy text, as configured in the App settings page.
            </li>
          </ul>
        </Section>

        <Section title="3. How we use your data">
          <p>We use the data described above exclusively to:</p>
          <ul style={styles.ul}>
            <li>Identify the Shopify order related to a customer email.</li>
            <li>Retrieve live parcel tracking status (via the 17track API).</li>
            <li>Generate a draft customer support reply using OpenAI&rsquo;s language models.</li>
            <li>Display the analysis and draft within the App interface for your review.</li>
          </ul>
          <p>We do not use your data for advertising, profiling, or any purpose unrelated to the App&rsquo;s core function.</p>
        </Section>

        <Section title="4. Third-party services">
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
          </ul>
        </Section>

        <Section title="5. Data storage and security">
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

        <Section title="6. Data retention">
          <p>
            Processed emails and generated drafts are retained as long as your Automail account
            is active. When you uninstall the App, your session data is deleted immediately via
            Shopify&rsquo;s uninstall webhook. You may request deletion of all remaining data
            by contacting us (see section 9).
          </p>
        </Section>

        <Section title="7. Your rights">
          <p>
            Depending on your jurisdiction, you may have the right to access, correct, or delete
            personal data we hold about you or your customers. To exercise these rights, please
            contact us using the information below.
          </p>
        </Section>

        <Section title="8. Shopify merchant responsibilities">
          <p>
            As a Shopify merchant using Automail, you are responsible for ensuring that your
            customers are informed about how their data is processed in connection with your
            customer support operations, including the use of AI tools to generate draft replies.
          </p>
        </Section>

        <Section title="9. Contact">
          <p>
            For any questions or data requests related to this Privacy Policy, please contact
            us at:{" "}
            <a style={styles.a} href="mailto:blmcontactpro1@gmail.com">blmcontactpro1@gmail.com</a>
          </p>
        </Section>
      </div>
    </main>
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
