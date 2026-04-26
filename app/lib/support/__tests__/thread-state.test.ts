import { describe, it, expect } from 'vitest';
import { mergeNature, deriveOperationalState } from '../thread-state';

describe('mergeNature — règle sticky de classification', () => {
  // Progressions vers le haut (autorisées)
  it('unknown + probable_support → probable_support', () => {
    expect(mergeNature('unknown', 'probable_support')).toBe('probable_support');
  });

  it('unknown + non_support → non_support', () => {
    expect(mergeNature('unknown', 'non_support')).toBe('non_support');
  });

  it('probable_support + confirmed_support → confirmed_support', () => {
    expect(mergeNature('probable_support', 'confirmed_support')).toBe('confirmed_support');
  });

  it('non_support + probable_support → probable_support (escalation autorisée)', () => {
    expect(mergeNature('non_support', 'probable_support')).toBe('probable_support');
  });

  it('confirmed_support + mixed → mixed', () => {
    expect(mergeNature('confirmed_support', 'mixed')).toBe('mixed');
  });

  // Régressions (interdites — règle critique REQ-STATE-14)
  it('confirmed_support + unknown → confirmed_support (jamais de régression)', () => {
    expect(mergeNature('confirmed_support', 'unknown')).toBe('confirmed_support');
  });

  it('confirmed_support + non_support → confirmed_support (jamais de régression)', () => {
    expect(mergeNature('confirmed_support', 'non_support')).toBe('confirmed_support');
  });

  it('confirmed_support + needs_review → confirmed_support (needs_review ne régresse pas)', () => {
    expect(mergeNature('confirmed_support', 'needs_review')).toBe('confirmed_support');
  });

  it('probable_support + unknown → probable_support (stable sur unknown entrant)', () => {
    expect(mergeNature('probable_support', 'unknown')).toBe('probable_support');
  });

  // Idempotence
  it('confirmed_support + confirmed_support → confirmed_support', () => {
    expect(mergeNature('confirmed_support', 'confirmed_support')).toBe('confirmed_support');
  });

  it('unknown + unknown → unknown', () => {
    expect(mergeNature('unknown', 'unknown')).toBe('unknown');
  });
});

describe('deriveOperationalState — machine d\'états opérationnels (REQ-STATE-01, 02, 03, 04, 07)', () => {
  // REQ-STATE-01: open state — thread with no incoming, no outgoing messages
  it('open: thread with 0 incoming, 0 outgoing messages → "open" (REQ-STATE-01)', () => {
    const state = deriveOperationalState({
      lastDirection: 'unknown',
      replyNeeded: false,
      noReplyNeeded: false,
      hasIncoming: false,
    });
    expect(state).toBe('open');
  });

  // REQ-STATE-02: waiting_merchant — first incoming message arrives
  it('waiting_merchant: first incoming message → "waiting_merchant" (REQ-STATE-02)', () => {
    const state = deriveOperationalState({
      lastDirection: 'incoming',
      replyNeeded: true,
      noReplyNeeded: false,
      hasIncoming: true,
    });
    expect(state).toBe('waiting_merchant');
  });

  // REQ-STATE-03: waiting_customer — outgoing message after incoming
  it('waiting_customer: outgoing message after incoming → "waiting_customer" (REQ-STATE-03)', () => {
    const state = deriveOperationalState({
      lastDirection: 'outgoing',
      replyNeeded: true,
      noReplyNeeded: false,
      hasIncoming: true,
    });
    expect(state).toBe('waiting_customer');
  });

  // REQ-STATE-04: waiting_merchant again — customer replies after our message
  // Note: deriveOperationalState is a pure function — it has no memory of prior messages.
  // REQ-STATE-04 (customer replies after outgoing) collapses to the same input as REQ-STATE-02
  // at this function's interface. The distinction is enforced upstream by recomputeThreadState.
  it('waiting_merchant: customer replies after our message → "waiting_merchant" (REQ-STATE-04)', () => {
    const state = deriveOperationalState({
      lastDirection: 'incoming',
      replyNeeded: true,
      noReplyNeeded: false,
      hasIncoming: true,
    });
    expect(state).toBe('waiting_merchant');
  });

  // REQ-STATE-07: no_reply_needed — LLM detected end of conversation
  it('no_reply_needed: LLM detected end of conversation (noReplyNeeded: true) → "no_reply_needed" (REQ-STATE-07)', () => {
    const state = deriveOperationalState({
      lastDirection: 'incoming',
      replyNeeded: false,
      noReplyNeeded: true,
      hasIncoming: true,
    });
    expect(state).toBe('no_reply_needed');
  });
});
