import { getOpenAIClient, trackedChatCompletion, type TrackedCallContext } from "../llm/client";
import { markdownToHtml } from "../support/markdown-to-html";

/**
 * Strip HTML tags to plain text for LLM input.
 * Replaces block-level closing tags with newlines to preserve readability.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<\/p>|<\/li>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Refine a draft reply based on user instructions.
 * Accepts HTML draft input (from TipTap), returns HTML output.
 */
export async function refineDraft(
  currentDraft: string,
  instructions: string,
  context?: { subject?: string; body?: string; contextSummary?: string },
  ctx?: Partial<TrackedCallContext>,
): Promise<string> {
  const client = getOpenAIClient();
  if (!client) throw new Error("OpenAI API key not configured");

  // Strip HTML to plain text so the LLM sees clean content, not markup
  const currentDraftText = htmlToPlainText(currentDraft);

  const systemPrompt = `You are a customer support email editor for an e-commerce store.
You will receive:
- The current draft reply to a customer (as plain text)
- The user's instructions on how to modify it
- Optionally, the original customer email for context
- Optionally, a "Verified facts" block summarising the matched order
  and shipment data

Apply the requested changes while keeping the reply:
- Professional and concise
- Factual (never invent information)
- In the same language as the current draft

When a "Verified facts" block is present, treat it as the authoritative
source for order numbers, statuses, tracking numbers, and delivery
information. Do not invent or contradict it, but do not blindly recite
it either — only reference its details when relevant to the user's
instructions.

Use light Markdown formatting where it helps readability:
- **bold** for key information
- bullet lists (- item) for multiple steps or items
- numbered lists (1. item) for sequential steps

Return ONLY the updated email text. No explanation, no quotes.`;

  let userMessage = `Current draft:\n${currentDraftText}\n\nInstructions: ${instructions}`;
  if (context?.subject || context?.body) {
    const original = [
      context.subject ? `Subject: ${context.subject}` : "",
      context.body ? `Body:\n${context.body.slice(0, 800)}` : "",
    ].filter(Boolean).join("\n");
    userMessage += `\n\nOriginal customer email:\n${original}`;
  }
  if (context?.contextSummary) {
    userMessage += `\n\nVerified facts about this customer's order:\n${context.contextSummary}`;
  }

  const response = await trackedChatCompletion(
    client,
    {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 600,
    },
    { callSite: "refine-draft", ...ctx },
  );

  const markdown = response.choices[0]?.message?.content?.trim() ?? currentDraft;
  return markdownToHtml(markdown);
}
