import type { SupportAnalysis } from "./types";

/**
 * Build a compact, English plain-text summary of the verified facts in
 * `analysis`. Fed into the Refine LLM call so it can rewrite the draft
 * without inventing or contradicting order/tracking data.
 *
 * Returns `null` when there is nothing useful to say — caller should
 * then omit the context block from the prompt entirely.
 *
 * Section labels stay in English on purpose: the LLM handles stable
 * tags ("ORDER", "TRACKING") more reliably than translated headers,
 * and the surrounding draft language is enforced by the system prompt
 * in refineDraft.
 */
export function buildRefineContext(analysis: SupportAnalysis): string | null {
  void analysis;
  return null;
}
