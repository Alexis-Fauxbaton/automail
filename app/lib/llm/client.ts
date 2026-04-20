import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import prisma from "../../db.server";

// ---------------------------------------------------------------------------
// Pricing (USD per 1M tokens) — OpenAI public pricing, 2026-04.
// Update this table if models or pricing change.
// ---------------------------------------------------------------------------
interface Pricing { input: number; output: number }
const PRICING: Record<string, Pricing> = {
  "gpt-4o":         { input: 2.50,  output: 10.00 },
  "gpt-4o-mini":    { input: 0.15,  output: 0.60 },
  "gpt-4.1":        { input: 2.00,  output: 8.00 },
  "gpt-4.1-mini":   { input: 0.40,  output: 1.60 },
  "gpt-4.1-nano":   { input: 0.10,  output: 0.40 },
};

function priceFor(model: string): Pricing {
  // Exact match first, then prefix match ("gpt-4o-mini-2024-07-18" → "gpt-4o-mini")
  if (PRICING[model]) return PRICING[model];
  const key = Object.keys(PRICING)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  return key ? PRICING[key] : { input: 0, output: 0 };
}

export function computeCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = priceFor(model);
  return (promptTokens * p.input + completionTokens * p.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Shared client
// ---------------------------------------------------------------------------
let cachedClient: OpenAI | null = null;
export function getOpenAIClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key === "sk-your-key-here") return null;
  if (cachedClient) return cachedClient;
  cachedClient = new OpenAI({ apiKey: key });
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Cost-tracked chat completion
// ---------------------------------------------------------------------------
export type CallSite =
  | "classifier"
  | "llm-parser"
  | "llm-draft"
  | "refine-draft"
  | "tracking-agent"
  | "context-crawler";

export interface TrackedCallContext {
  callSite: CallSite;
  shop?: string;
  emailId?: string;
  threadId?: string;
}

/**
 * Run a chat completion while capturing token usage and cost.
 * - Writes a granular row to `LlmCallLog`.
 * - If `emailId` is provided, increments aggregated counters on `IncomingEmail`.
 * All logging is best-effort and never throws.
 */
export async function trackedChatCompletion(
  client: OpenAI,
  params: ChatCompletionCreateParamsNonStreaming,
  ctx: TrackedCallContext,
): Promise<ChatCompletion> {
  const start = Date.now();
  const response = await client.chat.completions.create(params);
  const duration = Date.now() - start;

  const usage = response.usage;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
  const costUsd = computeCostUsd(params.model, promptTokens, completionTokens);

  // Fire-and-forget logging — never block or break the caller.
  void logCall({
    shop: ctx.shop,
    emailId: ctx.emailId,
    threadId: ctx.threadId,
    callSite: ctx.callSite,
    model: params.model,
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd,
    durationMs: duration,
  }).catch((err) => console.error("[llm] logCall failed:", err));

  return response;
}

async function logCall(row: {
  shop?: string;
  emailId?: string;
  threadId?: string;
  callSite: CallSite;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
}) {
  // Granular row
  try {
    await prisma.llmCallLog.create({
      data: {
        shop: row.shop ?? "",
        emailId: row.emailId ?? null,
        threadId: row.threadId ?? null,
        callSite: row.callSite,
        model: row.model,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        costUsd: row.costUsd,
        durationMs: row.durationMs,
      },
    });
  } catch (err) {
    console.error("[llm] llmCallLog.create failed:", err);
  }

  // Aggregated per-email counters (only when we know the email)
  if (row.emailId) {
    try {
      await prisma.incomingEmail.update({
        where: { id: row.emailId },
        data: {
          llmTokensTotal: { increment: row.totalTokens },
          llmCostUsd: { increment: row.costUsd },
        },
      });
    } catch (err) {
      console.error("[llm] incomingEmail cost increment failed:", err);
    }
  }
}
