import { getOpenAIClient, trackedChatCompletion, type TrackedCallContext } from "../llm/client";

/**
 * Refine a draft reply based on user instructions.
 * Takes the current draft and free-text instructions, returns an updated draft.
 */
export async function refineDraft(
  currentDraft: string,
  instructions: string,
  context?: { subject?: string; body?: string },
  ctx?: Partial<TrackedCallContext>,
): Promise<string> {
  const client = getOpenAIClient();
  if (!client) throw new Error("OpenAI API key not configured");

  const systemPrompt = `You are a customer support email editor for an e-commerce store.
You will receive:
- The current draft reply to a customer
- The user's instructions on how to modify it
- Optionally, the original customer email for context

Apply the requested changes while keeping the reply:
- Professional and concise
- Factual (never invent information)
- In the same language as the current draft

Return ONLY the updated email text. No explanation, no markdown, no quotes.`;

  let userMessage = `Current draft:\n${currentDraft}\n\nInstructions: ${instructions}`;
  if (context?.subject || context?.body) {
    const original = [
      context.subject ? `Subject: ${context.subject}` : "",
      context.body ? `Body:\n${context.body.slice(0, 800)}` : "",
    ].filter(Boolean).join("\n");
    userMessage += `\n\nOriginal customer email:\n${original}`;
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

  return response.choices[0]?.message?.content?.trim() ?? currentDraft;
}
