'use strict';

const axios = require('axios');
const cds = require('@sap/cds');
const config = require('./config');
const { withRetry } = require('./retry');

const log = cds.log('s4-validation');

/**
 * NOTE: In the SAP Build deployment this should go through the SAP BTP
 * Destination service (the "Destination" component in the architecture
 * diagram) rather than a hardcoded URL/credentials pair. This client is
 * written against a direct URL for local dev/testing; swap the request
 * building below for @sap-cloud-sdk/connectivity's destination lookup
 * when deploying.
 */

async function fetchCandidateSuppliers(legalName) {
  if (!config.s4.baseUrl) {
    log.debug('S4_VALIDATION_BASE_URL not configured, skipping S4 check');
    return [];
  }

  const data = await withRetry(
    async () => {
      const res = await axios.get(`${config.s4.baseUrl}/A_Supplier`, {
        params: {
          $filter: `substringof('${legalName.replace(/'/g, "''")}',SupplierName)`,
          $select: 'SupplierName,Supplier'
        },
        timeout: 15000
      });
      return res.data;
    },
    { label: 'S4 fetchCandidateSuppliers' }
  );

  const items = data?.d?.results || data?.value || [];
  return items.map((item) => ({
    name: item.SupplierName || '',
    email: item.EmailAddress || ''
  }));
}

module.exports = { fetchCandidateSuppliers };
