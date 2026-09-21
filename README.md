# Supplier Duplicate Check — SAP CAP (Node.js)

CAP service implementing the **Supplier Duplication Validation** step of the
SLP internal-questionnaire approval flow. It compares the submitted
Supplier Legal Name + Contact Email against SAP Ariba (SDA) and S/4, then
drives the outcome through Ariba's own workflow actions directly — no
separate email service needed.

Uses **two independent OAuth2 clients**, matching how Ariba's developer
portal issues credentials: one client id/secret for the **Supplier Data
API (SDA)**, a different one for the **External Approval API**.

## Outcome handling

| Outcome | Action called | Effect |
|---|---|---|
| Exact match | `Deny` | Approvable rejected, process stops |
| Partial match | `DenyWithResubmit` | Task reverts to Project Owner (pending resubmit); Ariba's built-in "additional information required" email fires automatically, carrying the match details as a comment |
| No match | *(no action)* | Approval flow proceeds to the next node on its own |

## Project layout (CAP conventions)

```
db/
  schema.cds                   DuplicateCheckLog entity (audit trail)
srv/
  duplicate-check-service.cds  Service definition: runDuplicateCheck action + DuplicateCheckLogs
  duplicate-check-service.js   CAP service handler (cds.service.impl)
  lib/
    config.js                   Env config, two separate credential blocks (sda / approval)
    aribaAuthClient.js          OAuth2 token-cache FACTORY - one instance per API
    aribaApprovalClient.js      External Approval API client (its own token cache)
    supplierDataClient.js       SDA client (its own, separate token cache)
    s4ValidationClient.js       S/4 Business Partner OData lookup
    matcher.js                  Name/email normalization + EXACT/PARTIAL/NO_MATCH logic
    duplicateCheckService.js    Orchestration, called from the CAP handler
    retry.js                    Retry-with-backoff for transient upstream failures
test/
  matcher.test.js               Unit tests (node:test, no network calls)
```

## Why two token caches

`aribaAuthClient.js` exports `createTokenCache(label, { tokenUrl, clientId, clientSecret })`
instead of a single shared cache. `aribaApprovalClient.js` and
`supplierDataClient.js` each instantiate their own cache with their own
credentials, so the SDA client's token is never sent to the Approval API
or vice versa. If Ariba later rotates one client secret, only that one
client's env vars change — nothing else in the codebase does.

## Setup

```bash
npm install
cp .env.example .env   # fill in real values -- see below
npm test                 # matcher unit tests, no network needed
npx cds deploy --to sqlite:db.sqlite   # local dev DB for the audit log
npx cds watch             # or: npm run watch
```

This was verified end-to-end locally: `cds compile` produces a clean
OData/action model, `cds watch` boots the service on port 4004, and
`POST /api/runDuplicateCheck` correctly reaches the handler (it fails past
that point without real Ariba credentials, as expected).

## Configuration — two separate credential pairs

From `.env.example`:

```
# Supplier Data API client (from Ariba developer portal)
ARIBA_SDA_OAUTH_TOKEN_URL=...
ARIBA_SDA_CLIENT_ID=...
ARIBA_SDA_CLIENT_SECRET=...

# External Approval API client (different client on the same portal)
ARIBA_APPROVAL_OAUTH_TOKEN_URL=...
ARIBA_APPROVAL_CLIENT_ID=...
ARIBA_APPROVAL_CLIENT_SECRET=...

# Service user, only for the /action endpoint (Deny / DenyWithResubmit)
ARIBA_ACTION_SERVICE_USER=...
ARIBA_ACTION_PASSWORD_ADAPTER=...
```

On SAP BTP, bind these through the Destination and Credential Store
services instead of a flat `.env` — `config.js` is the single place to
swap that in; nothing else needs to change.

## Calling the service

```bash
curl -X POST http://localhost:4004/api/runDuplicateCheck \
  -H "Content-Type: application/json" \
  -d '{"taskId": "TSK123"}'
```

Response:
```json
{
  "outcome": "PARTIAL_MATCH",
  "taskId": "TSK123",
  "matches": [{ "name": "Acme Supplies Ltd", "email": "contact@acme.com" }]
}
```

Every run is also written to the `DuplicateCheckLogs` entity
(`GET /api/DuplicateCheckLogs`) for audit/support purposes.

## Wiring into the Ariba approval flow

1. Add/confirm the **Duplicate Supplier Validation** custom node in the
   internal questionnaire's approval flow, right after submission.
2. Configure that node to call `POST /api/runDuplicateCheck` on this
   service with `{ "taskId": "<Ariba Task uniqueName>" }`.
3. This service takes it from there — no further Ariba flow config is
   needed for the email itself; `DenyWithResubmit` triggers it natively.

## Things to verify before go-live

- **SDA endpoint/params** in `supplierDataClient.js` follow the documented
  pagination pattern but aren't confirmed against a swagger — check the
  path (`/suppliers`) and field names against your tenant's actual SDA API
  reference.
- **Questionnaire item IDs** in `duplicateCheckService.extractSupplierAnswers`
  (`SUPPLIER_LEGAL_NAME`, `SUPPLIER_CONTACT_EMAIL`) must match the
  `externalSystemCorrelationId` values on your actual questionnaire.
- **S/4 auth**: `s4ValidationClient.js` is stubbed for direct calls; swap
  in your BTP Destination service lookup before deploying.
- **Least-privilege review** of both Ariba OAuth2 clients and the
  `/action` service user.
