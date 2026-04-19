import OpenAI from "openai";

export type EmailClassification = "support_client" | "probable_non_client" | "incertain";

const SYSTEM_PROMPT = `You classify incoming emails for an e-commerce customer support inbox.

Classify the email as ONE of:
- support_client: a real customer writing to ask about their order, delivery, product, return, refund, complaint, or any support question. The email is FROM a customer TO the store.
- probable_non_client: anything else, including:
  - B2B inquiries, supplier emails, marketing pitches, partnership/collaboration requests, recruitment
  - automated notifications and system emails (order placed, shipping confirmation, payment received, etc.)
  - internal emails or notifications FROM the store's own system TO the store owner
  - emails ABOUT orders that are clearly notifications, not requests (e.g. "Order #123 placed by John" is a notification, not a customer asking for help)
- incertain: cannot determine with confidence

Key distinction: a CUSTOMER writes "where is my order #123?" = support_client. The STORE's system sends "Order #123 has been placed" = probable_non_client.

Reply with JSON only: {"classification":"..."}`;

function getClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key === "sk-your-key-here") return null;
  return new OpenAI({ apiKey: key });
}

export async function classifyEmail(
  subject: string,
  body: string,
): Promise<EmailClassification> {
  const client = getClient();
  if (!client) return "incertain";

  try {
    // Truncate body to save tokens
    const truncatedBody = body.length > 600 ? body.slice(0, 600) + "…" : body;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Subject: ${subject}\n\nBody:\n${truncatedBody}` },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 30,
    });

    const raw = response.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as { classification?: string };

    const valid: EmailClassification[] = ["support_client", "probable_non_client", "incertain"];
    if (valid.includes(parsed.classification as EmailClassification)) {
      return parsed.classification as EmailClassification;
    }
    return "incertain";
  } catch (err) {
    console.error("[gmail/classifier] LLM classification failed:", err);
    return "incertain";
  }
}
