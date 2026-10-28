'use strict';

// override: true -- dotenv normally refuses to overwrite variables already
// present in process.env. On this machine stale ARIBA_* values were set at
// the shell/OS level, silently shadowing every edit made to .env and
// causing hours of confusing 401s against long-dead credentials.
require('dotenv').config({ override: true });

/**
 * Reads config via process.env. On SAP BTP, bind these through the
 * Destination / Credential Store service and populate the same env var
 * names (e.g. via a VCAP_SERVICES-aware bootstrap, or cds.env) rather than
 * plain .env files -- this module doesn't care how the values got there.
 *
 * Ariba issues separate OAuth2 clients per API on the developer portal, so
 * SDA and the External Approval API each get their own client id/secret
 * and (usually) their own token endpoint / base URL.
 */

module.exports = {
  // When true, actOnTask() is skipped and only logged -- used while
  // validating the poller/matching logic against a real tenant before
  // trusting it to actually Approve/Deny/DenyWithResubmit live tasks.
  dryRun: process.env.DRY_RUN === 'true',

  ariba: {
    realm: process.env.ARIBA_REALM,

    sda: {
      oauthTokenUrl: process.env.ARIBA_SDA_OAUTH_TOKEN_URL,
      clientId: process.env.ARIBA_SDA_CLIENT_ID,
      clientSecret: process.env.ARIBA_SDA_CLIENT_SECRET,
      // Every actual resource call (not just the token request) must also carry
      // this apiKey header -- the app's "Application key" from the developer
      // portal, separate from the OAuth client id/secret.
      appKey: process.env.ARIBA_SDA_APP_KEY,
      apiBaseUrl: process.env.ARIBA_SDA_API_BASE_URL || 'https://openapi.ariba.com/api'
    },

    approval: {
      oauthTokenUrl: process.env.ARIBA_APPROVAL_OAUTH_TOKEN_URL,
      clientId: process.env.ARIBA_APPROVAL_CLIENT_ID,
      clientSecret: process.env.ARIBA_APPROVAL_CLIENT_SECRET,
      appKey: process.env.ARIBA_APPROVAL_APP_KEY,
      apiBaseUrl: process.env.ARIBA_APPROVAL_API_BASE_URL || 'https://openapi.ariba.com/api',
      // /action additionally requires these two query params per the
      // External Approval API swagger -- separate from the OAuth2 client.
      actionServiceUser: process.env.ARIBA_ACTION_SERVICE_USER,
      actionPasswordAdapter: process.env.ARIBA_ACTION_PASSWORD_ADAPTER
    }
  },

  s4: {
    baseUrl: process.env.S4_VALIDATION_BASE_URL,
    clientId: process.env.S4_VALIDATION_CLIENT_ID,
    clientSecret: process.env.S4_VALIDATION_CLIENT_SECRET
  },

  matching: {
    // Matched against the questionnaire's item *label* (the text shown to
    // the requester), not the internal externalSystemCorrelationId -- those
    // are usually opaque auto-generated ids (e.g. KI_1234567) we can't
    // guess, but the label text is stable and known from the real form.
    // These are also the defaults used by any target template below that
    // doesn't set its own SUPPLIER_*_LABEL_N override.
    legalNameLabel: process.env.SUPPLIER_LEGAL_NAME_LABEL || 'Full Legal Name of Supplier',
    contactEmailLabel: process.env.SUPPLIER_CONTACT_EMAIL_LABEL || 'Email Address'
  },

  // Polling replaces the old "Ariba calls our webhook" model: this service
  // now pulls its own work from GET /pendingApprovables on an interval,
  // scoped to the service account in ARIBA_ACTION_SERVICE_USER.
  poll: {
    enabled: process.env.POLL_ENABLED !== 'false',
    intervalMs: parseInt(process.env.POLL_INTERVAL_MS || '120000', 10),
    // Optional server-side filter on /pendingApprovables; left unset fetches
    // everything pending for the user and relies on the workspaceTitle
    // check below to pick out the right questionnaire(s).
    documentType: process.env.PENDING_APPROVABLES_DOCUMENT_TYPE || undefined,
    // One or more questionnaire templates to act on. TARGET_WORKSPACE_TITLE
    // is template #1 (defaulted for backward compatibility); TARGET_WORKSPACE_TITLE_2,
    // _3, etc. add more -- scanning stops at the first unset number. Each
    // may set its own SUPPLIER_LEGAL_NAME_LABEL_N / SUPPLIER_CONTACT_EMAIL_LABEL_N
    // if that form's question labels differ from the defaults above.
    targetTemplates: buildTargetTemplates()
  }
};

function buildTargetTemplates() {
  const templates = [];

  const firstTitle =
    process.env.TARGET_WORKSPACE_TITLE ||
    'Internal form for Sole, LLC, Partnership, Club & Society and Virtual Platforms';
  templates.push({
    title: firstTitle,
    legalNameLabel: process.env.SUPPLIER_LEGAL_NAME_LABEL_1 || process.env.SUPPLIER_LEGAL_NAME_LABEL || 'Full Legal Name of Supplier',
    contactEmailLabel: process.env.SUPPLIER_CONTACT_EMAIL_LABEL_1 || process.env.SUPPLIER_CONTACT_EMAIL_LABEL || 'Email Address'
  });

  for (let n = 2; process.env[`TARGET_WORKSPACE_TITLE_${n}`]; n += 1) {
    templates.push({
      title: process.env[`TARGET_WORKSPACE_TITLE_${n}`],
      legalNameLabel:
        process.env[`SUPPLIER_LEGAL_NAME_LABEL_${n}`] ||
        process.env.SUPPLIER_LEGAL_NAME_LABEL ||
        'Full Legal Name of Supplier',
      contactEmailLabel:
        process.env[`SUPPLIER_CONTACT_EMAIL_LABEL_${n}`] ||
        process.env.SUPPLIER_CONTACT_EMAIL_LABEL ||
        'Email Address'
    });
  }

  return templates;
}
