'use strict';

const axios = require('axios');
const cds = require('@sap/cds');
const config = require('./config');
const { withRetry } = require('./retry');
const { createTokenCache } = require('./aribaAuthClient');

const log = cds.log('ariba-sda');

/**
 * Candidate suppliers come from POST /vendorDataRequests/ (per the SDA/SM
 * Vendor Data API swagger) -- an empty filter body fetches every vendor in
 * the realm, paginated. Field names on each returned record use display
 * labels with spaces ("Supplier Name", "Primary contact email"), not
 * camelCase -- that's the API's own shape, not a typo.
 */

// This client's own token cache, backed by the client id/secret issued
// specifically for the Supplier Data API on the Ariba developer portal --
// separate from the External Approval API's client id/secret.
const sdaAuth = createTokenCache('sda', {
  tokenUrl: config.ariba.sda.oauthTokenUrl,
  clientId: config.ariba.sda.clientId,
  clientSecret: config.ariba.sda.clientSecret
});

const client = axios.create({
  baseURL: config.ariba.sda.apiBaseUrl,
  timeout: 15000
});

// The docs say 1000, but this tenant's live API actually caps $top at 500
// ("Invalid Parameter: $top value to be greater than 0 and lesser than or
// equal to 500") -- confirmed against the real endpoint.
const PAGE_SIZE = 500;
const MAX_PAGES = 50; // hard safety cap so a bad response can't loop forever

// vendorContactsRequests documents a max of 100 vendor ids per call.
const CONTACT_BATCH_SIZE = 100;

/**
 * vendorDataRequests's own "Primary contact email" field is frequently
 * absent even when the vendor has a real primary contact on file (confirmed
 * live: a record with no email there still has one via vendorContactsRequests).
 * Without this, email-based matching silently never fires. Returns a Map of
 * smVendorId -> primary contact email.
 */
async function fetchContactEmails(token, smVendorIds) {
  const emailMap = new Map();

  for (let i = 0; i < smVendorIds.length; i += CONTACT_BATCH_SIZE) {
    const batch = smVendorIds.slice(i, i + CONTACT_BATCH_SIZE);
    const res = await withRetry(
      async () =>
        client.post(
          '/vendorContactsRequests/',
          { smVendorIds: batch },
          {
            params: { realm: config.ariba.realm },
            headers: {
              Authorization: `Bearer ${token}`,
              apiKey: config.ariba.sda.appKey
            }
          }
        ),
      { label: `fetchContactEmails(batch=${i / CONTACT_BATCH_SIZE})` }
    );

    for (const vendor of res.data?.vendorDetails || []) {
      const contacts = vendor.vendorContactInfos || [];
      const primary = contacts.find((c) => c.primary) || contacts[0];
      if (primary?.email) emailMap.set(vendor.smVendorId, primary.email);
    }
  }

  return emailMap;
}

/**
 * Fetches all vendors from the realm via vendorDataRequests, one page at a
 * time, and returns a flat array of { name, email, smVendorId } candidates
 * for the matcher. $skip is a plain numeric offset per the API docs
 * ("$skip=0 is equivalent to not passing any $skip parameter") -- not an
 * opaque token. Email is then backfilled via vendorContactsRequests for any
 * candidate vendorDataRequests didn't return one for.
 */
async function fetchCandidateSuppliers() {
  const token = await sdaAuth.getToken();
  const results = [];
  let skip = 0;
  let page = 0;

  while (page < MAX_PAGES) {
    const res = await withRetry(
      async () =>
        client.post(
          '/vendorDataRequests/',
          { outputFormat: 'JSON' },
          {
            params: { realm: config.ariba.realm, $top: PAGE_SIZE, $skip: skip },
            headers: {
              Authorization: `Bearer ${token}`,
              apiKey: config.ariba.sda.appKey
            }
          }
        ),
      { label: `fetchCandidateSuppliers(skip=${skip})` }
    );

    const items = Array.isArray(res.data) ? res.data : [];
    for (const item of items) {
      results.push({
        name: item['Supplier Name'] || '',
        email: item['Primary contact email'] || '',
        smVendorId: item['SM Vendor ID'] || '',
        erpVendorId: item['ERP Vendor ID'] || ''
      });
    }

    log.debug('SDA vendorDataRequests page fetched', { skip, count: items.length });

    if (items.length < PAGE_SIZE) break; // last page
    skip += PAGE_SIZE;
    page += 1;
  }

  if (page >= MAX_PAGES) {
    log.warn('fetchCandidateSuppliers hit MAX_PAGES safety cap', { skip });
  }

  const missingEmailIds = results.filter((r) => !r.email && r.smVendorId).map((r) => r.smVendorId);
  if (missingEmailIds.length > 0) {
    const emailMap = await fetchContactEmails(token, missingEmailIds).catch((err) => {
      log.error('fetchContactEmails failed, proceeding without backfilled emails', { message: err.message });
      return new Map();
    });
    for (const candidate of results) {
      if (!candidate.email && emailMap.has(candidate.smVendorId)) {
        candidate.email = emailMap.get(candidate.smVendorId);
      }
    }
  }

  return results;
}

module.exports = { fetchCandidateSuppliers };
