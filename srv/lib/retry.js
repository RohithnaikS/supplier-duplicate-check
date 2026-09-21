'use strict';

const cds = require('@sap/cds');
const log = cds.log('retry');

/**
 * Retries an async function on transient failures (network errors, 429, 5xx).
 * Does NOT retry on other 4xx since those are not transient.
 */
async function withRetry(fn, { retries = 3, baseDelayMs = 500, label = 'operation' } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const retriable = !status || status === 429 || status >= 500;
      attempt += 1;

      if (!retriable || attempt > retries) {
        log.error(`${label} failed permanently`, { attempt, status, message: err.message });
        throw err;
      }

      const delay = baseDelayMs * 2 ** (attempt - 1);
      log.warn(`${label} failed, retrying`, { attempt, retries, status, delayMs: delay });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

module.exports = { withRetry };
