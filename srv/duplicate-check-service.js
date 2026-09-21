'use strict';

const cds = require('@sap/cds');
const { runDuplicateCheck } = require('./lib/duplicateCheckService');
const { startPolling } = require('./lib/poller');

module.exports = cds.service.impl(async function () {
  const { DuplicateCheckLogs } = this.entities;

  // The poller is now the primary trigger (polls /pendingApprovables on an
  // interval); the HTTP action below is kept for manual/one-off invocation.
  cds.on('served', () => startPolling());

  this.on('runDuplicateCheck', async (req) => {
    const { taskId } = req.data;

    if (!taskId || typeof taskId !== 'string') {
      return req.error(400, 'taskId is required');
    }

    let result;
    try {
      result = await runDuplicateCheck(taskId);
    } catch (err) {
      return req.error(502, `Duplicate check failed: ${err.message}`);
    }

    // Audit trail: fire-and-log, don't fail the response if this write hiccups.
    try {
      await INSERT.into(DuplicateCheckLogs).entries({
        taskId: result.taskId,
        outcome: result.outcome,
        matches: JSON.stringify(result.matches)
      });
    } catch (err) {
      req.warn(500, `Duplicate check audit log write failed: ${err.message}`);
    }

    return result;
  });
});
