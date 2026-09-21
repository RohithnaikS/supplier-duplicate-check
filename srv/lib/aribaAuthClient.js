'use strict';

const axios = require('axios');
const cds = require('@sap/cds');

const REFRESH_SKEW_MS = 60 * 1000; // refresh 60s before actual expiry

/**
 * Creates an independent, cached OAuth2 client-credentials token getter.
 *
 * Ariba issues a separate client id/secret per API on the developer
 * portal (SDA vs External Approval API each have their own), so each
 * needs its own token cache -- sharing one cache across both would send
 * the wrong client's token to the wrong API.
 *
 * @param {string} label - used only for log lines, e.g. 'sda' | 'approval'
 * @param {{ tokenUrl: string, clientId: string, clientSecret: string }} creds
 */
function createTokenCache(label, creds) {
  const log = cds.log(`ariba-auth:${label}`);
  let token = null;
  let expiryMs = 0;

  async function getToken() {
    const now = Date.now();
    if (token && now < expiryMs - REFRESH_SKEW_MS) {
      return token;
    }

    if (!creds.tokenUrl || !creds.clientId || !creds.clientSecret) {
      throw new Error(`OAuth2 client credentials not configured for '${label}'`);
    }

    log.debug(`Fetching new OAuth2 token for '${label}'`);

    const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');

    const response = await axios.post(
      creds.tokenUrl,
      'grant_type=client_credentials',
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );

    const { access_token: accessToken, expires_in: expiresInSec } = response.data;
    if (!accessToken) {
      throw new Error(`OAuth2 token response for '${label}' did not include access_token`);
    }

    token = accessToken;
    expiryMs = Date.now() + (Number(expiresInSec) || 3600) * 1000;
    return token;
  }

  function invalidate() {
    token = null;
    expiryMs = 0;
  }

  return { getToken, invalidate };
}

module.exports = { createTokenCache };
