'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OUTCOMES, normalizeName, normalizeEmail, evaluateDuplicate } = require('../srv/lib/matcher');

test('normalizeName strips legal suffixes and punctuation', () => {
  assert.equal(normalizeName('Acme Supplies, Ltd.'), 'acme supplies');
  assert.equal(normalizeName('ACME SUPPLIES INC'), 'acme supplies');
  assert.equal(normalizeName('  Acme   Supplies  '), 'acme supplies');
});

test('normalizeEmail lowercases and trims', () => {
  assert.equal(normalizeEmail(' John.Doe@Example.com '), 'john.doe@example.com');
});

test('evaluateDuplicate returns EXACT_MATCH when name and email both match', () => {
  const questionnaire = { name: 'Acme Supplies Ltd', email: 'contact@acme.com' };
  const candidates = [{ name: 'Acme Supplies Inc', email: 'contact@acme.com' }];

  const result = evaluateDuplicate(questionnaire, candidates);
  assert.equal(result.outcome, OUTCOMES.EXACT_MATCH);
  assert.equal(result.matches.length, 1);
});

test('evaluateDuplicate returns PARTIAL_MATCH when only email matches', () => {
  const questionnaire = { name: 'Brand New Vendor LLC', email: 'contact@acme.com' };
  const candidates = [{ name: 'Acme Supplies Ltd', email: 'contact@acme.com' }];

  const result = evaluateDuplicate(questionnaire, candidates);
  assert.equal(result.outcome, OUTCOMES.PARTIAL_MATCH);
});

test('evaluateDuplicate returns PARTIAL_MATCH when only name matches', () => {
  const questionnaire = { name: 'Acme Supplies Ltd', email: 'new-contact@acme.com' };
  const candidates = [{ name: 'Acme Supplies Inc', email: 'old-contact@acme.com' }];

  const result = evaluateDuplicate(questionnaire, candidates);
  assert.equal(result.outcome, OUTCOMES.PARTIAL_MATCH);
});

test('evaluateDuplicate returns NO_MATCH when nothing overlaps', () => {
  const questionnaire = { name: 'Totally New Co', email: 'new@newco.com' };
  const candidates = [{ name: 'Acme Supplies Ltd', email: 'contact@acme.com' }];

  const result = evaluateDuplicate(questionnaire, candidates);
  assert.equal(result.outcome, OUTCOMES.NO_MATCH);
  assert.equal(result.matches.length, 0);
});

test('evaluateDuplicate is resilient to an empty candidate list', () => {
  const questionnaire = { name: 'Acme Supplies Ltd', email: 'contact@acme.com' };
  const result = evaluateDuplicate(questionnaire, []);
  assert.equal(result.outcome, OUTCOMES.NO_MATCH);
});

test('evaluateDuplicate does not fuzzy-match near-identical but distinct names', () => {
  // Real false positive seen live: these differ by one character (~93%
  // Levenshtein similarity), which used to clear the old 90% threshold.
  const questionnaire = { name: 'Dialog Test 01', email: 'one@example.com' };
  const candidates = [{ name: 'Dialog Test 02', email: 'two@example.com' }];

  const result = evaluateDuplicate(questionnaire, candidates);
  assert.equal(result.outcome, OUTCOMES.NO_MATCH);
});
