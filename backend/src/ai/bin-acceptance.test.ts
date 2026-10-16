import test from 'node:test';
import assert from 'node:assert/strict';
import { decideBinAcceptance } from './bin-acceptance.js';

const bin01 = { min_confidence: 0.65, label_rules: { bottle: { category: 'beverage_container', volume_liters: 0.5 } } };
const bin02 = { min_confidence: 0.65, label_rules: { bottle: { category: 'beverage_container', volume_liters: 0.5 }, book: { category: 'paper_product', volume_liters: 0.7 } } };
const evaluate = (overrides: Partial<Parameters<typeof decideBinAcceptance>[0]> = {}) => decideBinAcceptance({
  label: 'bottle', confidence: 0.91, interpretationGroup: 'possible', policy: bin01, remainingLiters: 100, ...overrides,
});

test('a policy-matching AI candidate above the configured threshold is accepted automatically', () => {
  const result = evaluate();
  assert.equal(result.status, 'accepted');
  assert.equal(result.category, 'beverage_container');
  assert.equal(result.volumeLiters, 0.5);
  assert.match(result.reason, /automatically accepted/i);
});

test('person, tie, and snowboard detections are rejected without capacity', () => {
  for (const label of ['person', 'tie', 'snowboard']) {
    assert.equal(evaluate({ label }).status, 'rejected');
    assert.equal(evaluate({ label }).volumeLiters, null);
  }
});

test('cell phone and other labels outside policy are rejected', () => {
  assert.equal(evaluate({ label: 'cell phone' }).status, 'rejected');
  assert.equal(evaluate({ label: 'wine glass' }).status, 'rejected');
});

test('low-confidence and unclassified detections stay in review', () => {
  assert.equal(evaluate({ confidence: 0.6 }).status, 'needs_review');
  assert.equal(evaluate({ interpretationGroup: 'missing' }).status, 'needs_review');
});

test('confidence equal to the configured threshold qualifies', () => {
  assert.equal(evaluate({ confidence: 0.65 }).status, 'accepted');
  assert.equal(evaluate({ confidence: 0.64 }).status, 'needs_review');
});

test('a book policy remains bin-specific', () => {
  assert.equal(evaluate({ label: 'book' }).status, 'rejected');
  assert.equal(evaluate({ label: 'book', policy: bin02 }).status, 'accepted');
});

test('a policy-matching paper product is independently accepted by Bin 02', () => {
  const result = evaluate({ label: 'book', policy: bin02, confidence: 0.88 });
  assert.equal(result.status, 'accepted');
  assert.equal(result.category, 'paper_product');
  assert.equal(result.volumeLiters, 0.7);
});

test('insufficient space rejects an item and never proposes an increment', () => {
  const result = evaluate({ remainingLiters: 0.4 });
  assert.equal(result.status, 'rejected');
  assert.equal(result.volumeLiters, null);
});

test('AI-excluded detections remain rejected even if the label is configured', () => {
  assert.equal(evaluate({ interpretationGroup: 'excluded' }).status, 'rejected');
});
