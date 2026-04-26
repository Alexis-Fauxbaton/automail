import { describe, it, expect } from 'vitest';
import { mergeNature } from '../thread-state';

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
