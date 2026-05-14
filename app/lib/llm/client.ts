import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import prisma from "../../db.server";
import { createSemaphore } from "../util/semaphore";
import { createBreaker, BreakerOpenError } from "../util/circuit-breaker";
import {
  llmCallsTotal,
  llmTokensTotal,
  llmCostUsdTotal,
  llmDurationSeconds,
  llmSemaphoreInFlight,
  llmSemaphoreQueued,
  breakerState,
  breakerTransitionsTotal,
  startTimer,
} from "../metrics/definitions";

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
// Shared client (lazy-init: don't construct OpenAI at module load, otherwise
// any test or CI env without OPENAI_API_KEY crashes on import — even if the
// caller never actually invokes the LLM).
// ---------------------------------------------------------------------------
let openaiClient: OpenAI | null = null;
export function getOpenAIClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key === "sk-your-key-here") return null;
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: key });
  return openaiClient;
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
  shop: string;
  emailId?: string;
  threadId?: string;
}

// Process-wide semaphore + retry policy for OpenAI calls.
//
// Why: with N shops syncing in parallel, each pipeline pass can issue 5-10
// concurrent LLM calls. Multiplied by AUTOSYNC_CONCURRENCY this trivially
// exceeds OpenAI's per-minute TPM/RPM, after which every shop fails together
// (cascading failure). Bounding global concurrency stops that cascade; a
// short retry-after backoff on 429s recovers transparently from the rest.
//
// Override via OPENAI_MAX_CONCURRENT (default 20). Set lower if you see
// rate-limit errors in logs after launch.
const OPENAI_MAX_CONCURRENT = Math.max(
  1,
  Number(process.env.OPENAI_MAX_CONCURRENT ?? "20"),
);
const openaiSem = createSemaphore(OPENAI_MAX_CONCURRENT);

// Circuit breaker. Distinct purpose from the semaphore:
//   - semaphore caps STEADY-STATE throughput so we don't trip OpenAI's
//     per-minute limits in the first place;
//   - breaker reacts to SUSTAINED FAILURES (network down, account quota
//     exhausted, region outage) by short-circuiting all calls for a few
//     minutes so we stop wasting requests and don't hammer the upstream.
// Server errors (5xx) count as failures; 429 doesn't — that's handled by
// the retry+semaphore combo and is "the upstream is healthy, we're just
// too loud".
export const __openaiBreaker = createBreaker({
  name: "openai",
  failureThreshold: 8,
  failureWindowMs: 5 * 60_000,
  cooldownMs: 2 * 60_000,
});
breakerState.set({ name: "openai" }, 0);
(__openaiBreaker as unknown as { __setListener: (fn: (next: "open" | "closed") => void) => void })
  .__setListener((next) => {
    breakerState.set({ name: "openai" }, next === "open" ? 1 : 0);
    breakerTransitionsTotal.inc({ name: "openai", state: next });
  });

function parseRetryAfterMs(err: unknown): number | null {
  // openai SDK exposes `status` on its APIError class; defensive .any-check
  // here so we don't import the type and risk a version mismatch.
  const e = err as { status?: number; headers?: Record<string, string> } | null;
  if (!e || e.status !== 429) return null;
  const header = e.headers?.["retry-after"] ?? e.headers?.["Retry-After"];
  if (!header) return 2000;
  // RFC 7231: either delta-seconds or an HTTP-date. We only handle seconds.
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 30_000);
  }
  return 2000;
}

/**
 * Run a chat completion while capturing token usage and cost.
 * - Writes a granular row to `LlmCallLog`.
 * - If `emailId` is provided, increments aggregated counters on `IncomingEmail`.
 * - Globally rate-limited (see OPENAI_MAX_CONCURRENT) and retried on 429.
 * All logging is best-effort and never throws.
 */
export async function trackedChatCompletion(
  client: OpenAI,
  params: ChatCompletionCreateParamsNonStreaming,
  ctx: Partial<TrackedCallContext> & { callSite: CallSite },
): Promise<ChatCompletion> {
  // Breaker check is OUTSIDE the semaphore — short-circuit immediately
  // without paying the queue wait when the upstream is known-down.
  if (__openaiBreaker.isOpen()) {
    llmCallsTotal.inc({
      shop: ctx.shop ?? "",
      call_site: ctx.callSite,
      model: params.model,
      status: "breaker_open",
    });
    throw new BreakerOpenError("openai");
  }
  llmSemaphoreQueued.inc();
  const release = await openaiSem.acquire();
  llmSemaphoreQueued.dec();
  llmSemaphoreInFlight.inc();
  const stopDuration = startTimer();
  const start = Date.now();
  let response: ChatCompletion;
  try {
    // Retry once on 429. Two retries would risk piling up requests behind
    // a sustained rate-limit event; one is enough to ride out a momentary
    // burst without making the situation worse.
    const MAX_ATTEMPTS = 2;
    let attempt = 0;
    let last: ChatCompletion | null = null;
    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      try {
        last = await client.chat.completions.create(params);
        break;
      } catch (err) {
        const retryMs = parseRetryAfterMs(err);
        // 429s are upstream-healthy back-pressure, not a breaker signal:
        // we retry once and let the semaphore throttle the next batch.
        if (retryMs !== null && attempt < MAX_ATTEMPTS) {
          console.warn(
            `[llm] OpenAI 429 (attempt ${attempt}/${MAX_ATTEMPTS}), backing off ${retryMs}ms`,
          );
          await new Promise((r) => setTimeout(r, retryMs));
          continue;
        }
        // Any other failure (5xx, network, timeout) counts toward the
        // breaker. We don't tally 429 because the upstream is up.
        if (retryMs === null) __openaiBreaker.recordFailure();
        llmCallsTotal.inc({
          shop: ctx.shop ?? "",
          call_site: ctx.callSite,
          model: params.model,
          status: retryMs !== null ? "rate_limited" : "error",
        });
        throw err;
      }
    }
    if (!last) throw new Error("OpenAI call failed without yielding a response");
    response = last;
    __openaiBreaker.recordSuccess();
  } finally {
    release();
    llmSemaphoreInFlight.dec();
    llmDurationSeconds.observe(
      { call_site: ctx.callSite, model: params.model },
      stopDuration(),
    );
  }
  const duration = Date.now() - start;

  const usage = response.usage;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
  const costUsd = computeCostUsd(params.model, promptTokens, completionTokens);

  if (ctx.shop) {
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
  }

  llmCallsTotal.inc({
    shop: ctx.shop ?? "",
    call_site: ctx.callSite,
    model: params.model,
    status: "ok",
  });
  llmTokensTotal.inc({ shop: ctx.shop ?? "", direction: "prompt" }, promptTokens);
  llmTokensTotal.inc({ shop: ctx.shop ?? "", direction: "completion" }, completionTokens);
  llmCostUsdTotal.inc({ shop: ctx.shop ?? "", call_site: ctx.callSite }, costUsd);

  return response;
}

async function logCall(row: {
  shop: string;
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
        shop: row.shop,
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
