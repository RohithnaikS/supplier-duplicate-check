'use strict';

const cds = require('@sap/cds');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const config = require('./config');
const { withRetry } = require('./retry');

const log = cds.log('s4-validation');

/**
 * Auth goes through the SAP BTP Destination service -- getDestination()
 * resolves the URL and credentials by name at request time, so this client
 * never holds S4 credentials itself. For local dev without a bound
 * Destination service, the Cloud SDK also reads destinations from the
 * "destinations" env var (a JSON array) -- see @sap-cloud-sdk/connectivity's
 * docs for the local-testing shape.
 *
 * Entity/field names below (A_Supplier, A_BusinessPartner, AddressID,
 * A_AddressEmailAddress) are the standard API_BUSINESS_PARTNER service
 * shape -- confirm against the real system on first live call, the same way
 * Ariba's pagination cap and apiKey header were only confirmed by hitting
 * the real API.
 */

const PAGE_SIZE = 500;
const MAX_PAGES = 50; // hard safety cap so a bad response can't loop forever
const LOOKUP_BATCH_SIZE = 50; // keep $filter ...eq...or... chains reasonably short

// Local-dev-only: registers S4_DESTINATION_URL/USER/PASSWORD/SAP_CLIENT as a
// local destination via the Cloud SDK's own documented "destinations" env
// var mechanism, so getDestination({ destinationName }) below resolves
// without a real BTP destination-service binding. Runs once at module load;
// no-ops once this is deployed to BTP with the destination actually bound
// (config.s4.local.url will be unset there).
if (config.s4.local.url && config.s4.destinationName) {
  const existing = process.env.destinations ? JSON.parse(process.env.destinations) : [];
  if (!existing.some((d) => d.name === config.s4.destinationName)) {
    existing.push({
      name: config.s4.destinationName,
      url: config.s4.local.url,
      authentication: 'BasicAuthentication',
      username: config.s4.local.username,
      password: config.s4.local.password,
      sapClient: config.s4.local.sapClient
    });
    process.env.destinations = JSON.stringify(existing);
    log.info('Registered local S4 destination for dev testing (no BTP destination-service binding needed)', {
      name: config.s4.destinationName
    });
  }
}

let cachedDestination = null;
let destinationFetchedAt = 0;
const DESTINATION_CACHE_MS = 5 * 60 * 1000; // re-resolve every 5 min in case it's rotated

async function resolveDestination() {
  const name = config.s4.destinationName;
  if (!name) {
    throw new Error('S4_DESTINATION_NAME not configured');
  }

  const now = Date.now();
  if (cachedDestination && now - destinationFetchedAt < DESTINATION_CACHE_MS) {
    return cachedDestination;
  }

  const destination = await getDestination({ destinationName: name });
  if (!destination) {
    throw new Error(`S4 destination '${name}' not found`);
  }

  cachedDestination = destination;
  destinationFetchedAt = now;
  return destination;
}

function odataOrFilter(field, values) {
  return values.map((v) => `${field} eq '${String(v).replace(/'/g, "''")}'`).join(' or ');
}

/**
 * Batches an array into chunks of `size` and runs `fn` on each, returning
 * the flattened results. Each batch's failure is caught and logged rather
 * than failing the whole lookup -- partial data (e.g. names without emails)
 * still supports name-based matching.
 */
async function batched(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    try {
      out.push(...(await fn(batch)));
    } catch (err) {
      log.error('S4 batch lookup failed, continuing without it', { batchStart: i, message: err.message });
    }
  }
  return out;
}

/**
 * Step 2: Supplier (BP) number -> AddressID, via A_BusinessPartner.
 */
async function fetchAddressIds(destination, businessPartnerIds) {
  const rows = await batched(businessPartnerIds, LOOKUP_BATCH_SIZE, async (batch) => {
    const res = await withRetry(
      () =>
        executeHttpRequest(destination, {
          method: 'get',
          url: '/A_BusinessPartner',
          params: {
            $filter: odataOrFilter('BusinessPartner', batch),
            $select: 'BusinessPartner,AddressID'
          }
        }),
      { label: 'S4 fetchAddressIds' }
    );
    return res.data?.d?.results || res.data?.value || [];
  });

  const map = new Map();
  for (const row of rows) {
    if (row.BusinessPartner && row.AddressID) map.set(row.BusinessPartner, row.AddressID);
  }
  return map;
}

/**
 * Step 3: AddressID -> EmailAddress, via A_AddressEmailAddress.
 */
async function fetchEmailsByAddressId(destination, addressIds) {
  const rows = await batched(addressIds, LOOKUP_BATCH_SIZE, async (batch) => {
    const res = await withRetry(
      () =>
        executeHttpRequest(destination, {
          method: 'get',
          url: '/A_AddressEmailAddress',
          params: {
            $filter: odataOrFilter('AddressID', batch),
            $select: 'AddressID,EmailAddress'
          }
        }),
      { label: 'S4 fetchEmailsByAddressId' }
    );
    return res.data?.d?.results || res.data?.value || [];
  });

  const map = new Map();
  for (const row of rows) {
    if (row.AddressID && row.EmailAddress && !map.has(row.AddressID)) {
      map.set(row.AddressID, row.EmailAddress);
    }
  }
  return map;
}

/**
 * Fetches all suppliers from S4 via A_Supplier, one page at a time, then
 * resolves each one's email through the BusinessPartner -> Address ->
 * EmailAddress chain. Mirrors supplierDataClient.js's "fetch everything,
 * match locally" shape (rather than filtering server-side by the
 * questionnaire's name) so a candidate can match on email alone too, per
 * the same OR-based partial-match rule used for Ariba.
 */
async function fetchCandidateSuppliers() {
  if (!config.s4.destinationName) {
    log.debug('S4_DESTINATION_NAME not configured, skipping S4 check');
    return [];
  }

  const destination = await resolveDestination();
  const results = [];
  let skip = 0;
  let page = 0;

  while (page < MAX_PAGES) {
    const res = await withRetry(
      () =>
        executeHttpRequest(destination, {
          method: 'get',
          url: '/A_Supplier',
          params: {
            $select: 'Supplier,SupplierName',
            $top: PAGE_SIZE,
            $skip: skip
          }
        }),
      { label: `S4 fetchCandidateSuppliers(skip=${skip})` }
    );

    const items = res.data?.d?.results || res.data?.value || [];
    for (const item of items) {
      results.push({
        name: item.SupplierName || '',
        email: '',
        erpVendorId: item.Supplier || ''
      });
    }

    log.debug('S4 A_Supplier page fetched', { skip, count: items.length });

    if (items.length < PAGE_SIZE) break; // last page
    skip += PAGE_SIZE;
    page += 1;
  }

  if (page >= MAX_PAGES) {
    log.warn('S4 fetchCandidateSuppliers hit MAX_PAGES safety cap', { skip });
  }

  const bpIds = results.filter((r) => r.erpVendorId).map((r) => r.erpVendorId);
  if (bpIds.length > 0) {
    const addressIdByBp = await fetchAddressIds(destination, bpIds).catch((err) => {
      log.error('S4 fetchAddressIds failed, proceeding without emails', { message: err.message });
      return new Map();
    });

    const addressIds = [...new Set(addressIdByBp.values())];
    const emailByAddressId =
      addressIds.length > 0
        ? await fetchEmailsByAddressId(destination, addressIds).catch((err) => {
            log.error('S4 fetchEmailsByAddressId failed, proceeding without emails', { message: err.message });
            return new Map();
          })
        : new Map();

    for (const candidate of results) {
      const addressId = addressIdByBp.get(candidate.erpVendorId);
      if (addressId && emailByAddressId.has(addressId)) {
        candidate.email = emailByAddressId.get(addressId);
      }
    }
  }

  return results;
}

module.exports = { fetchCandidateSuppliers };
