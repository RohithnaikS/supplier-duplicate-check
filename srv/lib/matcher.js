'use strict';

const OUTCOMES = {
  EXACT_MATCH: 'EXACT_MATCH',
  PARTIAL_MATCH: 'PARTIAL_MATCH',
  NO_MATCH: 'NO_MATCH'
};

const LEGAL_SUFFIXES = [
  'ltd', 'limited', 'llc', 'llp', 'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company', 'gmbh', 'pvt', 'private', 'plc', 'sa', 'srl', 'bv', 'nv',
  'ag', 'kg', 'pty'
];

function normalizeName(rawName) {
  if (!rawName) return '';
  let n = rawName.toLowerCase().trim();
  n = n.replace(/[.,'&]/g, ' ');
  n = n.replace(/[^a-z0-9\s]/g, ' ');
  n = n.replace(/\s+/g, ' ').trim();

  const tokens = n.split(' ').filter((t) => !LEGAL_SUFFIXES.includes(t));
  return tokens.join(' ').trim();
}

function normalizeEmail(rawEmail) {
  if (!rawEmail) return '';
  return rawEmail.toLowerCase().trim();
}

/**
 * - EXACT_MATCH:   a candidate matches on BOTH normalized name and email.
 * - PARTIAL_MATCH: a candidate matches on email only, OR name only
 *                   (exact match on the normalized string, no fuzzy
 *                   similarity threshold).
 * - NO_MATCH:      no candidate meets either bar.
 */
function evaluateDuplicate(questionnaireSupplier, candidates) {
  const qName = normalizeName(questionnaireSupplier.name);
  const qEmail = normalizeEmail(questionnaireSupplier.email);

  const matchedExact = [];
  const matchedPartial = [];

  for (const candidate of candidates) {
    const cName = normalizeName(candidate.name);
    const cEmail = normalizeEmail(candidate.email);

    const emailMatch = Boolean(qEmail) && qEmail === cEmail;
    const nameMatch = Boolean(qName) && qName === cName;

    if (emailMatch && nameMatch) {
      matchedExact.push(candidate);
    } else if (emailMatch || nameMatch) {
      matchedPartial.push(candidate);
    }
  }

  if (matchedExact.length > 0) {
    return { outcome: OUTCOMES.EXACT_MATCH, matches: matchedExact };
  }
  if (matchedPartial.length > 0) {
    return { outcome: OUTCOMES.PARTIAL_MATCH, matches: matchedPartial };
  }
  return { outcome: OUTCOMES.NO_MATCH, matches: [] };
}

module.exports = { OUTCOMES, normalizeName, normalizeEmail, evaluateDuplicate };
