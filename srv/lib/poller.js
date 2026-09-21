'use strict';

const cds = require('@sap/cds');
const config = require('./config');
const approvalClient = require('./aribaApprovalClient');
const { runDuplicateCheck } = require('./duplicateCheckService');

const log = cds.log('duplicate-check-poller');

let timer = null;
let ticking = false; // re-entrancy guard: don't overlap ticks if one runs long

async function alreadyProcessed(taskId) {
  const { DuplicateCheckLog } = cds.entities('com.acme.slp');
  const existing = await cds.run(SELECT.one.from(DuplicateCheckLog).where({ taskId }));
  return !!existing;
}

async function logResult(result) {
  const { DuplicateCheckLog } = cds.entities('com.acme.slp');
  await cds.run(
    INSERT.into(DuplicateCheckLog).entries({
      taskId: result.taskId,
      outcome: result.outcome,
      matches: JSON.stringify(result.matches)
    })
  );
}

// taskDetails.workspaceTitle reflects the surrounding process/workspace name
// (e.g. "Supplier Registration for Test 21.09"), NOT the specific
// questionnaire template -- confirmed live, two different templates can
// share a generic workspace title. document.content.questionnaireTitle is
// the questionnaire's own title and matches the configured target exactly,
// with no supplier-name suffix appended.
function matchTemplate(taskDetails) {
  const questionnaireTitle = (taskDetails?.document?.content?.questionnaireTitle || '').trim();
  return config.poll.targetTemplates.find((t) => questionnaireTitle === t.title);
}

async function processApprovable(item) {
  const taskId = item.uniqueName;

  if (await alreadyProcessed(taskId)) {
    log.debug('Task already has a duplicate-check log entry, skipping', { taskId });
    return;
  }

  const taskDetails = await approvalClient.getTaskDetails(taskId);
  const template = matchTemplate(taskDetails);
  if (!template) {
    log.debug('Task is not one of the target questionnaires, skipping', {
      taskId,
      questionnaireTitle: taskDetails?.document?.content?.questionnaireTitle
    });
    return;
  }

  const result = await runDuplicateCheck(taskId, template, taskDetails);

  try {
    await logResult(result);
  } catch (err) {
    log.warn('Duplicate check audit log write failed', { taskId, message: err.message });
  }
}

async function poll() {
  if (ticking) {
    log.warn('Previous poll tick still running, skipping this tick');
    return;
  }
  ticking = true;

  try {
    const approvables = await approvalClient.listPendingApprovables({
      documentType: config.poll.documentType
    });

    log.info('Polled pending approvables', { count: approvables.length });

    for (const item of approvables) {
      try {
        await processApprovable(item);
      } catch (err) {
        log.error('Failed processing pending approvable', {
          taskId: item.uniqueName,
          message: err.message
        });
      }
    }
  } catch (err) {
    log.error('Failed to list pending approvables', { message: err.message });
  } finally {
    ticking = false;
  }
}

function startPolling() {
  if (!config.poll.enabled) {
    log.info('Polling disabled via POLL_ENABLED=false');
    return;
  }
  if (timer) return; // already started

  log.info('Starting duplicate-check poller', { intervalMs: config.poll.intervalMs });
  poll(); // run once immediately, then on the interval
  timer = setInterval(poll, config.poll.intervalMs);
}

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startPolling, stopPolling };
