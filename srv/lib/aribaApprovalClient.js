'use strict';

const axios = require('axios');
const cds = require('@sap/cds');
const config = require('./config');
const { withRetry } = require('./retry');
const { createTokenCache } = require('./aribaAuthClient');

const log = cds.log('ariba-approval-api');

// This client's own token cache, backed by the client id/secret you get
// from the Ariba developer portal specifically for the External Approval
// API -- separate from the SDA client id/secret.
const approvalAuth = createTokenCache('approval', {
  tokenUrl: config.ariba.approval.oauthTokenUrl,
  clientId: config.ariba.approval.clientId,
  clientSecret: config.ariba.approval.clientSecret
});

const client = axios.create({
  baseURL: config.ariba.approval.apiBaseUrl,
  timeout: 15000
});

// Every resource call needs BOTH the OAuth bearer token AND the app's own
// apiKey header (from the developer portal) -- two separate auth layers,
// API Gateway (apiKey) and OAuth (Bearer token).
function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, apiKey: config.ariba.approval.appKey };
}

/**
 * GET /pendingApprovables
 * Lists documents/tasks pending approval for a given user. This is the
 * poller's entry point: it replaces the old model where Ariba's approval
 * flow called our webhook directly.
 *
 * Returns an array of { uniqueName, documentType, description, assignedDate,
 * attachments, approver, email } -- uniqueName is the Task id to pass to
 * getTaskDetails/actOnTask.
 */
async function listPendingApprovables({ documentType, offset, limit } = {}) {
  const token = await approvalAuth.getToken();

  if (!config.ariba.approval.actionServiceUser || !config.ariba.approval.actionPasswordAdapter) {
    throw new Error(
      'ARIBA_ACTION_SERVICE_USER / ARIBA_ACTION_PASSWORD_ADAPTER must be configured to call /pendingApprovables'
    );
  }

  return withRetry(
    async () => {
      const { data } = await client.get('/pendingApprovables', {
        params: {
          realm: config.ariba.realm,
          user: config.ariba.approval.actionServiceUser,
          // NOTE: camelCase here, unlike the lowercase "passwordadapter" that
          // /action expects -- the swagger uses different casing per endpoint.
          passwordAdapter: config.ariba.approval.actionPasswordAdapter,
          documentType,
          offset,
          limit
        },
        headers: authHeaders(token)
      });
      return data;
    },
    { label: 'listPendingApprovables' }
  );
}

/**
 * GET /{entity_type}/{entity_id} for entity_type=Task.
 * Returns TaskDetails, including document.content where the
 * questionnaire's Supplier Legal Name and Contact Email ID answers live.
 */
async function getTaskDetails(taskId) {
  const token = await approvalAuth.getToken();

  return withRetry(
    async () => {
      const { data } = await client.get(`/Task/${encodeURIComponent(taskId)}`, {
        params: { realm: config.ariba.realm },
        headers: authHeaders(token)
      });
      return data;
    },
    { label: `getTaskDetails(${taskId})` }
  );
}

/**
 * POST /action
 * actionName is one of: Approve, Deny, DenyWithResubmit (entity type Task).
 *
 * Deny             -> exact-match outcome: approvable rejected, flow stops.
 * DenyWithResubmit -> partial-match outcome: task reverts to the Project
 *                     Owner (pending resubmit); Ariba's built-in
 *                     notification email fires automatically, carrying
 *                     the `comment` text below.
 */
async function actOnTask(taskId, actionName, comment) {
  if (!['Approve', 'Deny', 'DenyWithResubmit'].includes(actionName)) {
    throw new Error(`Unsupported actionName: ${actionName}`);
  }

  if (!config.ariba.approval.actionServiceUser || !config.ariba.approval.actionPasswordAdapter) {
    throw new Error(
      'ARIBA_ACTION_SERVICE_USER / ARIBA_ACTION_PASSWORD_ADAPTER must be configured to call /action'
    );
  }

  const token = await approvalAuth.getToken();

  const body = {
    actionableType: 'Task',
    uniqueName: taskId,
    actionName,
    options: { comment }
  };

  log.info('Calling Ariba /action', { taskId, actionName });

  return withRetry(
    async () => {
      const { data } = await client.post('/action', body, {
        params: {
          realm: config.ariba.realm,
          user: config.ariba.approval.actionServiceUser,
          passwordadapter: config.ariba.approval.actionPasswordAdapter
        },
        headers: {
          ...authHeaders(token),
          'Content-Type': 'application/json'
        }
      });
      return data;
    },
    { label: `actOnTask(${taskId}, ${actionName})` }
  );
}

module.exports = { listPendingApprovables, getTaskDetails, actOnTask };
