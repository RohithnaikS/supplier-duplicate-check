'use strict';

const cds = require('@sap/cds');
const config = require('./config');
const approvalClient = require('./aribaApprovalClient');
const sdaClient = require('./supplierDataClient');
const { OUTCOMES, evaluateDuplicate } = require('./matcher');

const log = cds.log('duplicate-check');

/**
 * Gate on config.dryRun so this can be validated against a real tenant
 * without actually mutating any real approval task until the matching
 * logic (esp. the answer correlation ids) is confirmed correct.
 */
async function act(taskId, actionName, comment) {
  if (config.dryRun) {
    log.info('[DRY RUN] Would call actOnTask', { taskId, actionName, comment });
    return;
  }
  await approvalClient.actOnTask(taskId, actionName, comment);
}

const normalizeLabel = (s) => (s || '').trim().toLowerCase();

// Item definitions can nest (repeatable sections, sub-items), so flatten
// before searching by label.
function flattenItems(items) {
  const flat = [];
  for (const item of items || []) {
    flat.push(item);
    if (Array.isArray(item.items)) flat.push(...flattenItems(item.items));
  }
  return flat;
}

/**
 * Pulls Supplier Legal Name and Contact Email off the TaskDetails payload.
 * The questionnaire's externalSystemCorrelationId per item is an opaque,
 * auto-generated id (e.g. "KI_1234567") we have no way to guess -- so
 * instead we look up the item definition whose *label* matches the known
 * question text ("Full Legal Name of Supplier" / "Email Address" by
 * default), then use that item's own correlation id to find the matching
 * answer. `labels` lets a caller override which label pair to look for,
 * e.g. a different questionnaire template using different question text.
 */
function extractSupplierAnswers(taskDetails, labels) {
  const legalNameLabel = labels?.legalNameLabel || config.matching.legalNameLabel;
  const contactEmailLabel = labels?.contactEmailLabel || config.matching.contactEmailLabel;

  const content = taskDetails?.document?.content;
  const answers = content?.answers || [];
  const items = flattenItems(content?.items);

  const findAnswerByCorrelationId = (correlationId) =>
    answers.find((a) => a.externalSystemCorrelationId === correlationId)?.answer || '';

  const findAnswerByLabel = (label) => {
    const target = normalizeLabel(label);
    const item = items.find((it) => normalizeLabel(it.label) === target);
    return item ? findAnswerByCorrelationId(item.externalSystemCorrelationId) : '';
  };

  const name = findAnswerByLabel(legalNameLabel);
  const email = findAnswerByLabel(contactEmailLabel);

  if (!name && !email) {
    log.warn('Could not resolve supplier name/email from questionnaire items', {
      taskId: taskDetails?.id,
      itemLabels: items.map((it) => it.label).filter(Boolean),
      answerCorrelationIds: answers.map((a) => a.externalSystemCorrelationId).filter(Boolean)
    });
  }

  // Ariba creates a placeholder SM Vendor record for the submission itself
  // as soon as the questionnaire is initiated, so that record is already
  // sitting in the SDA candidate pool by the time we check it -- exclude it
  // by id or every submission would match itself.
  const ownSmVendorId = content?.supplier?.smVendorId || '';

  return { name, email, ownSmVendorId };
}

// Ariba's task comment field renders this as plain text, not HTML -- an
// HTML <table> was tried and came through as literal markup, not a
// rendered table. Plain-text/ASCII table it is.
function buildMatchesTable(matches) {
  const header = ['Supplier Name', 'Email'];
  const rows = matches.map((m) => [m.name || 'Unknown name', m.email || 'no email on file']);
  const colWidths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));

  const formatRow = (row) => row.map((cell, i) => cell.padEnd(colWidths[i])).join(' | ');
  const divider = colWidths.map((w) => '-'.repeat(w)).join('-|-');
  return [formatRow(header), divider, ...rows.map(formatRow)].join('\n');
}

function buildExactMatchComment(matches) {
  return `Supplier already exists in Ariba, Duplicate Supplier registration is not allowed.\n\n${buildMatchesTable(matches)}`;
}

function buildResubmitComment(matches) {
  return `Potential duplicate supplier(s) found:\n\n${buildMatchesTable(matches)}\n\nPlease review and update the questionnaire with the necessary information before resubmitting.`;
}

/**
 * @param {string} taskId - Ariba Task uniqueName (e.g. "TSK123")
 * @param {{ legalNameLabel?: string, contactEmailLabel?: string }} [labels] -
 *   which question-label pair to extract; defaults to the global config
 *   (single-template callers, e.g. the manual/HTTP action, can omit this).
 * @param {object} [taskDetails] - pre-fetched TaskDetails, to avoid a
 *   redundant getTaskDetails call when the caller (the poller) already
 *   fetched it to decide whether this task is one of ours.
 * @returns {{ outcome: string, taskId: string, matches: object[] }}
 */
async function runDuplicateCheck(taskId, labels, taskDetails) {
  log.info('Duplicate check started', { taskId });

  const details = taskDetails || (await approvalClient.getTaskDetails(taskId));
  const supplierAnswers = extractSupplierAnswers(details, labels);

  let outcome;
  let matches = [];

  if (!supplierAnswers.name && !supplierAnswers.email) {
    log.warn('No supplier name/email found on questionnaire, skipping match', { taskId });
    outcome = OUTCOMES.NO_MATCH;
  } else {
    const allCandidates = await sdaClient.fetchCandidateSuppliers().catch((err) => {
      log.error('SDA candidate fetch failed', { taskId, message: err.message });
      return [];
    });
    const candidates = supplierAnswers.ownSmVendorId
      ? allCandidates.filter((c) => c.smVendorId !== supplierAnswers.ownSmVendorId)
      : allCandidates;

    ({ outcome, matches } = evaluateDuplicate(supplierAnswers, candidates));

    log.info('Duplicate check evaluated', {
      taskId,
      outcome,
      candidateCount: candidates.length,
      matchCount: matches.length
    });
  }

  // This service is now the sole gate on the approval step: it's polled as
  // the assigned approver's own pending work, so every outcome -- including
  // NO_MATCH -- has to explicitly act on the task or it never clears the
  // pending-approvables queue.
  switch (outcome) {
    case OUTCOMES.EXACT_MATCH: {
      const comment = buildExactMatchComment(matches);
      await act(taskId, 'Deny', comment);
      break;
    }
    case OUTCOMES.PARTIAL_MATCH: {
      const comment = buildResubmitComment(matches);
      await act(taskId, 'DenyWithResubmit', comment);
      break;
    }
    case OUTCOMES.NO_MATCH:
    default:
      log.info('No duplicate found, approving task', { taskId });
      await act(taskId, 'Approve', 'No duplicate supplier found; auto-approved by duplicate check.');
      break;
  }

  return { outcome, taskId, matches };
}

module.exports = { runDuplicateCheck, extractSupplierAnswers };
