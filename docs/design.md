# Design Document — Node.js / HubSpot CRM Integration

Living design document: written as the stage 1 analysis and updated at the end of every stage
with what was actually built and verified (the "How verified" column and section 10).
Source of acceptance criteria: `Back End Developer Technical Test.pdf` (Triario).
Official HubSpot documentation was consulted on 2026-09-17 and 2026-09-18; URLs are listed in section 6.

---

## 1. Scope

The project must:

1. Demonstrate Node.js fundamentals (callbacks, promises/async-await, CommonJS modules, streams).
2. Integrate with a real HubSpot portal through a Private App token: CRUD for contacts and deals,
   contact-to-deal association, idempotent sync from local JSON, validation, error handling with
   retries/backoff, and pagination.
3. Follow a modular structure, with a README (English) that explains setup, endpoints, scopes and
   technical decisions.

Runtime: Node.js 22.x (CommonJS). Language: JavaScript. No TypeScript, no build step.

---

## 2. Requirements traceability matrix

Legend for the "How verified" column:

- **Run**: execute the script and read its console output.
- **UI**: confirm the effect in the HubSpot portal (Contacts / Deals views).
- **Test**: automated test with the built-in `node:test` runner (`npm test`), no network required.
- **Review**: read the code/README against the PDF wording.

### 2.1 Section 1 — Node.js fundamentals (40 %)

| ID | Requirement (PDF) | Responsible file / function | How verified |
|----|-------------------|-----------------------------|--------------|
| F1 | Async operation with a callback (`setTimeout` or `fs.readFile`); usage and result handling in a separate file | `src/fundamentals/asyncOperation.js` → `readDataWithCallback(cb)` (uses `fs.readFile`); consumer `src/fundamentals/callbacks.js` | Run `node src/fundamentals/callbacks.js`; shows error-first callback handling for success and for a missing file |
| F2 | Refactor to return a Promise; consume with async/await | `src/fundamentals/asyncOperation.js` → `readDataAsync()` (wraps F1 in a Promise); consumer `src/fundamentals/asyncAwait.js` | Run `node src/fundamentals/asyncAwait.js`; shows `try/catch` around `await` |
| F3 | `utils_module.js` exports (CommonJS) a function that sums an array; `main.js` imports and uses it | `src/fundamentals/utils_module.js` → `sumArray(numbers)`; `src/fundamentals/main.js` | Run `node src/fundamentals/main.js`; Test `test/fundamentals.test.js` covers `sumArray` (empty array, non-numeric input) |
| F4 | `src/utils/streams.js`: `Readable.from("...")` → uppercase Transform → `process.stdout`; handle stream errors | `src/utils/streams.js` → `createUppercaseTransform()` and `runUppercasePipeline(source, destination)` using `stream/promises.pipeline` (`end: false` for stdout so it stays open); `failingSource()` demonstrates error propagation | Run `node src/utils/streams.js` (success, then a mid-stream failure caught by `try/catch`, then stdout still usable); Test pipes into a writable buffer, asserts the uppercase output, and asserts the rejection plus cleanup on failure |

### 2.2 Section 2 — HubSpot API (60 %): configuration and infrastructure

| ID | Requirement (PDF) | Responsible file / function | How verified |
|----|-------------------|-----------------------------|--------------|
| C1 | Auth with Private App token from env var `HUBSPOT_ACCESS_TOKEN`; no secrets in repo | `src/config/index.js` (loads `.env` with `dotenv`, validates required vars, fails fast); `.env.example`; `.gitignore` excludes `.env` | Review; Run any example without the var → clear startup error; `git status` never shows `.env` |
| C2 | Pipeline/stage configurable via env vars | `src/config/index.js` → `hubspot.pipelineId`, `hubspot.stageId` from `HUBSPOT_PIPELINE_ID` / `HUBSPOT_STAGE_ID` | Run `node src/examples/list-pipelines.js` to obtain real IDs; Run `create-deal.js` and check pipeline/stage in UI |
| C3 | `hubSpotClient` — central HTTP client, configurable via config and env vars | `src/clients/hubSpotClient.js` (axios instance: base URL, `Authorization: Bearer`, JSON headers, timeout; response interceptor delegates to `handleHubSpotErrors`) | Review; Run any example; Test `hubSpotClient` is created with the expected base URL and no token in logs |
| C4 | `handleHubSpotErrors` — normalize and log errors; retries with exponential backoff for 429/5xx | `src/utils/handleHubSpotErrors.js` → `normalizeHubSpotError(err)`, `shouldRetry(err, { idempotent })`, `isOutcomeUncertain(err)`, `withRetry(fn, options)`, `computeBackoffDelay(attempt, options)`, `handleHubSpotErrors(err, context)` (logs once, `logged` flag); the only retry layer is `hubSpotClient.request` | Test: backoff grows exponentially with jitter, `Retry-After` wins, 4xx never retried, 429/5xx/network retried up to `HUBSPOT_MAX_RETRIES`, POST not retried on uncertain outcomes, nested `withRetry` does not multiply calls, errors logged once; Run `npm run example:errors` (real 404 by id, real 404 by e-mail, real 400 with `limit=1000`, read-only) |
| C5 | Handle network errors / timeouts | `hubSpotClient` timeout (`HUBSPOT_TIMEOUT_MS`); `handleHubSpotErrors` maps `ECONNABORTED`, `ENOTFOUND`, `ECONNRESET` to `NETWORK_ERROR` and marks them retryable | Test with a stubbed axios error object (no network); documented in README |
| C6 | Handle 401/403 | `handleHubSpotErrors` maps to `AUTHENTICATION_ERROR` / `AUTHORIZATION_ERROR`, not retryable, message points to token/scopes | Run an example with an invalid token in a temporary shell variable (never committed) |
| C7 | Handle validation errors and other 4xx | `handleHubSpotErrors` maps 400 → `VALIDATION_ERROR` (keeps HubSpot `category`, `errors[]`, `correlationId`), 404 → `NOT_FOUND`, other 4xx → `CLIENT_ERROR`; not retryable | Run `node src/examples/error-handling.js` (invalid property on purpose) |
| C8 | Handle 429 with exponential backoff | `withRetry`: on 429 wait `Retry-After` seconds if present, otherwise `base * 2^attempt + jitter` | Test; Run (cannot be forced reliably; strategy documented) |
| C9 | Handle 5xx | `withRetry`: retry with exponential backoff, minimum 2 s delay as recommended by HubSpot error-handling docs | Test |
| C10 | Log errors without exposing tokens or sensitive data | `src/utils/logger.js` → `redact(obj)` strips credential keys, masks `Bearer`/`pat-` values and e-mails (`j***@example.com`); normalized errors never include the request config or body; validation messages never echo e-mails; log context carries ids only | Test: serialized error contains no token, header or body; request path with an e-mail is masked; Review |
| C11 | `validateHubSpotPayload` — validate payloads before sending | `src/utils/validateHubSpotPayload.js` → `validateHubSpotPayload(objectType, properties, { partial })` (create vs partial update), `validateHubSpotId(id, label)`; schemas per object (contacts: `email` format, `firstname`/`lastname` strings; deals: `dealname` non-empty, `amount` numeric ≥ 0, `pipeline`, `dealstage`) | Test: valid/invalid payloads, partial mode, ids; Run `npm run example:errors` case 1 (rejected locally, nothing sent) |
| C12 | Pagination handled per docs | `src/utils/pagination.js` → `paginateAll` / `collectPages` loop on `paging.next.after` (page size capped at 100, optional `maxPages`); single-page functions return `nextAfter` | Verified 2026-09-18 with small pages: list endpoint 4 real pages of 2 (`get-contact-names --page-size 2 --max-pages 4`); Search API over 5 project test contacts with `limit 2`: `total 5`, cursors `2` and `4`, last page of 1 with no cursor; Test `paginateAll`/`collectPages` |
| C13 | Rate limits handled per docs | C8 + sequential processing in sync (no parallel bursts) | Review; README explains limits (100 requests / 10 s on Free/Starter private apps) |

### 2.3 Section 2 — Contacts

| ID | Requirement (PDF) | Responsible file / function | How verified |
|----|-------------------|-----------------------------|--------------|
| K1 | `contactRepository` — encapsulates CRUD calls | `src/repositories/contactRepository.js` → `list({ limit, after, properties })`, `getById(id, { properties, archived })`, `getByEmail(email)`, `create(properties)`, `update(id, properties)`, `remove(id)`, `search(body)` (`idempotent: true`) | Review; exercised by K2–K6. Done 2026-09-18 |
| K2 | `getHubSpotContactNames` — full names of all contacts, paginated, real `GET /crm/v3/objects/contacts` | `hubSpotService.getHubSpotContactNames({ pageSize, maxPages, includeUnnamed, onPage })` (uses `paginateAll` + `contactRepository.list`, requests `firstname,lastname`; `buildFullName` trims and joins; one missing part → the other alone; both missing → skipped or placeholder) | Verified 2026-09-18: `--page-size 2 --max-pages 3` read 3 real pages following `paging.next.after`; Test `buildFullName` cases |
| K3 | `getHubSpotContacts` — paginated contact details with filter/pagination options | `hubSpotService.getHubSpotContacts({ limit, after, properties, filters })` → list endpoint (max 100) without filters, Search API (max 200) with filters validated by `validateSearchFilters`; returns `{ source, contacts, nextAfter, total? }` | Verified 2026-09-18: list with `--limit 2`, continuation with `--after`, and search `company EQ "Triario Technical Test"` on `POST /crm/objects/2026-09/contacts/search` (total 1) |
| K4 | `createHubSpotContact` — POST | `hubSpotService.createHubSpotContact(properties)` → `validateHubSpotPayload` → `contactRepository.create`; non-idempotent (no retry on uncertain outcome) | Verified 2026-09-18: test contact created (record id printed with its portal link) |
| K5 | `updateHubSpotContact` — PATCH | `hubSpotService.updateHubSpotContact(id, properties)` → `validateHubSpotId` + partial validation → `contactRepository.update` | Verified 2026-09-18: `lastname` and `phone` changed, other properties untouched |
| K6 | `deleteHubSpotContact` — DELETE | `hubSpotService.deleteHubSpotContact(id)` → `contactRepository.remove` (204; archives to the recycle bin). Example refuses non-test contacts without `--force` (`testRecords.isProjectTestContact`, unit-tested) | Verified 2026-09-18: 204, then `GET` → 404 and `GET ?archived=true` → `archived: true` |

### 2.4 Section 2 — Deals and pipelines

| ID | Requirement (PDF) | Responsible file / function | How verified |
|----|-------------------|-----------------------------|--------------|
| D1 | `dealRepository` — encapsulates CRUD calls | `src/repositories/dealRepository.js` → `list`, `getById(id, { properties, archived, idProperty })`, `create`, `update`, `remove`, `search` (`idempotent: true`) | Review; exercised by D2–D5. Done 2026-09-18 |
| D2 | `getHubSpotDeals` — list with pagination | `hubSpotService.getHubSpotDeals({ limit, after, properties, all, maxPages, onPage })` → one page `{ deals, nextAfter }` or, with `all`, every page via `collectPages` | Verified 2026-09-18: `--limit 2` with next cursor; `--limit 3` inside the flow |
| D3 | `createHubSpotDeal(dealName, amount)` — POST with `dealname`, `amount`, pipeline and stage from env | `hubSpotService.createHubSpotDeal(dealName, amount, { pipelineId, stageId, properties, contactId })` → `resolveDealStage` (env or options, verified against `GET /crm/v3/pipelines/deals/{id}`, cached) → `validateHubSpotPayload` → `dealRepository.create` with `pipeline` / `dealstage` (A1) | Verified 2026-09-18: deal created in pipeline "Tests" / stage "Pruebas"; wrong stage (`closedwon`) rejected locally listing the valid stages |
| D4 | `updateHubSpotDeal` — PATCH | `hubSpotService.updateHubSpotDeal(id, properties)` → partial validation; `dealstage` verified against the deal's pipeline; `pipeline` requires `dealstage` | Verified 2026-09-18: amount 1500 → 2500, stage untouched |
| D5 | `deleteHubSpotDeal` — DELETE | `hubSpotService.deleteHubSpotDeal(id)` → 204, archived; example refuses non-test deals without `--force` (`isProjectTestDeal`, unit-tested) | Verified 2026-09-18 in the flow cleanup |
| D6 | Pipelines endpoint used; pipeline/stage discoverable | `pipelineRepository.listPipelines('deals')`, `getPipeline('deals', id)`; `hubSpotService.getDealPipelines()`, `getDealPipeline(id)` | Verified 2026-09-18: `list-pipelines.js` marks the configured pipeline and stage |
| D7 | Properties endpoint used | `src/repositories/propertyRepository.js` → `getProperty(objectType, name)`, `createProperty(objectType, definition)`; used by the deal sync natural key (see S3 / A6) | Run `node src/examples/sync-deals.js` (creates the unique property on first run) |

### 2.5 Section 2 — Associations and sync

| ID | Requirement (PDF) | Responsible file / function | How verified |
|----|-------------------|-----------------------------|--------------|
| S1 | `associateContactToDeal(contactId, dealId)` via associations endpoint, idempotent where possible | `src/repositories/associationRepository.js` → `listAssociations`, `createDefaultAssociation`, `createLabeledAssociation`, `removeAssociation`, `listAssociationTypes`; `hubSpotService.associateContactToDeal` reads existing associations first (`alreadyAssociated: true`, no write), otherwise `PUT .../contact/{id}/associations/default/deal/{id}`; the applied type is resolved from `GET /crm/associations/2026-09/contact/deal/labels` (not hard-coded); `getContactDealAssociations` / `getDealContactAssociations` read both directions | Verified 2026-09-18 in the flow: first call `created=true` type `HUBSPOT_DEFINED:4`; second call `alreadyAssociated=true`; reverse direction shows `HUBSPOT_DEFINED:3`; exactly one contact on the deal |
| S2 | `syncContactsWithHubSpot` — sync local JSON, idempotent create/update | `src/services/syncService.js` → `syncContactsWithHubSpot(contacts)`; key = normalized `email`; `partitionByKey` (first wins, duplicates skipped, missing/invalid e-mail failed); per record `contactRepository.getByEmail` (`idProperty=email`) → 404 ⇒ create, else `computeChangedProperties` ⇒ PATCH or unchanged; 409 on create ⇒ update path; source `src/data/contacts.json` | Verified 2026-09-18 with real ids: run 1 created 3 (249168090233, 249172281265, 249177201471); run 2 same file → 3 unchanged, same ids, 0 created; run 3 with one phone changed → 1 updated (`phone`), 2 unchanged |
| S3 | `syncDealsWithHubSpot` — same for deals | `syncService.syncDealsWithHubSpot(deals, { pipelineId, stageId })`; key = unique custom property `external_id` ensured by `ensureDealExternalIdProperty` (GET → 404 → POST `/crm/v3/properties/deals`, aborts if not unique); lookup `dealRepository.getById(value, { idProperty: 'external_id' })`; create sends pipeline/stage + `external_id`; update compares dealname/amount/closedate only; `contactEmail` → `associateContactToDeal` | Verified 2026-09-18 with real ids: run 1 created the property and 3 deals (65110455987, 65090199876, 65117569931) with 3 associations; run 2 → 3 unchanged, same ids, associations `already`; run 3 with one amount changed → 1 updated (`amount`); Search API count of deals with `external_id` = 3 |
| S4 | Sync must handle errors per record without aborting the batch | `syncService` wraps each record in `try/catch`, returns `{ total, created[], updated[], unchanged[], skipped[], failed[], aborted }`; auth/scope errors abort early | Verified 2026-09-18: a file with a missing e-mail, an invalid e-mail and a duplicate → 2 failed, 1 skipped, the valid records processed |

### 2.6 Section 2 — Orchestration, examples and documentation

| ID | Requirement (PDF) | Responsible file / function | How verified |
|----|-------------------|-----------------------------|--------------|
| O1 | `hubSpotService` — orchestrator using `hubSpotClient` for business operations | `src/services/hubSpotService.js` (contacts, deals, associations, pipelines); `src/services/syncService.js` (sync logic, kept separate to keep files small) | Review |
| O2 | `hubSpotApiHandler` — executable scripts to test operations with clear console output | `src/examples/hubSpotApiHandler.js` → `runExample(name, fn)`: loads config, runs the async operation, prints a readable result, prints normalized errors, sets exit code; every `src/examples/*.js` script uses it | Run any example; exit code 0 on success, 1 on failure |
| O3 | `try/catch` in all calls | Every service function and every example uses `try/catch` with async/await; repositories propagate normalized errors | Review |
| O4 | Modular structure, justified | Section 3 of this document, summarized in README | Review |
| O5 | README: install, env vars, run examples, private app setup and scopes, endpoints with official doc URLs, technical decisions in English, libraries used, portal id | `README.md` (stage 6) | Review against this matrix |
| O6 | `.env.example` with `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_PIPELINE_ID`, `HUBSPOT_STAGE_ID`, etc. | `.env.example` | Review |
| O7 | Indicate portal base URL / hubId | README "Portal" section: `https://app.hubspot.com/contacts/<hubId>` (value provided by the candidate at submission time; `HUBSPOT_PORTAL_ID` env var is optional and only used for printing links) | Review |
| O8 | Submission: ZIP or public GitHub repo, notify evaluator | Git repository (this one); see ambiguity A2 on deadlines | Manual |
| O9 | Read-only diagnostic: verify auth, list pipelines/stages, list contact and deal properties through official endpoints, identify real ids, show errors without credentials | `src/examples/diagnose.js` → `hubSpotService.checkAuthentication()` (`POST /oauth/v2/private-apps/get/access-token-info`), `getDealPipelines()` (`GET /crm/v3/pipelines/deals`), `getObjectProperties('contacts'|'deals')` (`GET /crm/v3/properties/{objectType}`); `accountRepository`, `pipelineRepository`, `propertyRepository` | Run `npm run diagnose` without `.env` → configuration error, connection "pending verification", exit 1; with a token → Hub ID, scopes, pipeline/stage ids and property checks; with a wrong token → `AUTHENTICATION_ERROR` block without the token |

---

## 3. Project structure

```
.
├── .env.example
├── .gitignore
├── package.json
├── README.md
├── docs/
│   └── design.md                 # this document
├── src/
│   ├── config/
│   │   └── index.js              # env loading + validation, HubSpot settings, API paths
│   ├── clients/
│   │   └── hubSpotClient.js      # axios instance with auth, timeout, error interceptor
│   ├── repositories/
│   │   ├── accountRepository.js  # token info lookup (auth check, hubId, scopes)
│   │   ├── contactRepository.js  # raw CRUD for /crm/v3/objects/contacts
│   │   ├── dealRepository.js     # raw CRUD for /crm/v3/objects/deals
│   │   ├── associationRepository.js
│   │   ├── pipelineRepository.js
│   │   └── propertyRepository.js
│   ├── services/
│   │   ├── hubSpotService.js     # business operations (required function names live here)
│   │   └── syncService.js        # syncContactsWithHubSpot / syncDealsWithHubSpot
│   ├── utils/
│   │   ├── handleHubSpotErrors.js
│   │   ├── validateHubSpotPayload.js
│   │   ├── pagination.js
│   │   ├── logger.js
│   │   └── streams.js            # Section 1.4 (path fixed by the PDF)
│   ├── fundamentals/
│   │   ├── asyncOperation.js     # callback + promise versions of the same operation
│   │   ├── callbacks.js
│   │   ├── asyncAwait.js
│   │   ├── utils_module.js
│   │   ├── main.js
│   │   └── sample.txt            # file read by fs.readFile
│   ├── data/
│   │   ├── contacts.json         # local source for syncContactsWithHubSpot
│   │   └── deals.json            # local source for syncDealsWithHubSpot
│   └── examples/
│       ├── hubSpotApiHandler.js  # shared runner used by every script
│       ├── diagnose.js           # read-only: auth, pipelines, properties, ids to configure
│       ├── get-contact-names.js
│       ├── get-contacts.js
│       ├── create-contact.js
│       ├── update-contact.js
│       ├── delete-contact.js
│       ├── get-deals.js
│       ├── create-deal.js
│       ├── update-deal.js
│       ├── delete-deal.js
│       ├── list-pipelines.js
│       ├── associate-contact-deal.js
│       ├── sync-contacts.js
│       ├── sync-deals.js
│       └── error-handling.js
└── test/
    ├── fundamentals.test.js
    ├── validateHubSpotPayload.test.js
    ├── handleHubSpotErrors.test.js
    └── pagination.test.js
```

### Why this structure

Each folder has one responsibility, and dependencies point in one direction:

```
examples → services → repositories → clients → HubSpot API
                 ↘        ↘             ↘
                  utils   utils         utils (errors, logger)
                                config (read by clients and services)
```

- **config** centralizes environment access. Nothing else reads `process.env`, which makes secrets
  handling auditable and the app fail fast when a variable is missing.
- **clients** knows *how* to talk HTTP to HubSpot (auth header, base URL, timeout, retries) but
  nothing about contacts or deals.
- **repositories** know the endpoints and payload shapes for one object type each. They return raw
  HubSpot responses and contain no business rules. Swapping the HTTP library or the API version
  touches only clients/repositories.
- **services** implement the operations the PDF names. They validate input, combine repository
  calls (pagination, idempotency checks, association after creation) and return plain results.
- **utils** are pure, reusable helpers with no HubSpot state, so they can be unit-tested without
  network access.
- **fundamentals** is isolated from the integration on purpose: Section 1 must run without any
  credentials.
- **data** holds the local JSON sources the sync functions read.
- **examples** are the executable entry points (`hubSpotApiHandler`). They do argument parsing and
  printing only.
- **test** uses the Node.js built-in runner (`node --test`) for pure logic. Real HubSpot behaviour is
  verified with the example scripts, because the PDF forbids mocking HubSpot calls.

Additions to the folder list requested in the brief: `src/data/` (sync sources) and `test/`
(pure-logic tests). Both are small and keep responsibilities separated.

---

## 4. Dependencies

### HTTP layer: `axios` (chosen) vs `@hubspot/api-client`

| Criterion | axios | @hubspot/api-client |
|-----------|-------|---------------------|
| Shows understanding of the raw endpoints the PDF lists (`GET /crm/v3/objects/contacts`, `POST /crm/v3/objects/deals`, associations) | Yes — paths, query params and bodies are explicit in the repositories | Hidden behind generated method names |
| Error handling / retries as required (`handleHubSpotErrors` with backoff for 429/5xx) | Implemented and explained by the candidate; interceptor + retry wrapper | The SDK has its own `numberOfApiCallRetries`; harder to demonstrate and to explain |
| Pagination "per the documentation" | Explicit `paging.next.after` loop | Also explicit, but wrapped |
| Newer date-versioned endpoints (`/crm/objects/2026-09/...` for associations and search) | Just a path string in config | Depends on SDK release cadence |
| Weight | 1 dependency | Large generated client with many transitive files |
| Interview defensibility | Every request is readable in the code | Requires knowing SDK internals |

Decision: **axios**. The test evaluates the candidate's ability to build the calls from the official
documentation and to handle errors; a thin, explicit client demonstrates that better than a SDK.

### Full dependency list

| Package | Type | Purpose |
|---------|------|---------|
| `axios` | runtime | HTTP client with instances, interceptors and timeouts |
| `dotenv` | runtime | Load `.env` into `process.env` in local development |

No other runtime dependencies. Everything else comes from Node.js core:

- `fs`, `fs/promises`, `path` — fundamentals and JSON sources.
- `stream` (`Readable`, `Transform`, `pipeline`) — Section 1.4.
- `timers/promises` (`setTimeout`) — backoff delays without blocking.
- `node:test` and `node:assert` — tests, no framework required.
- `util` (`parseArgs`) — argument parsing in example scripts.

Dev tooling is intentionally minimal (no ESLint/Prettier config) to keep the submission focused;
this is stated in the README.

---

## 5. Configuration design

`.env.example` (values are placeholders, never real):

```
# Required
HUBSPOT_ACCESS_TOKEN=pat-xxx-your-private-app-token

# Deal defaults (obtain real IDs with: node src/examples/list-pipelines.js)
HUBSPOT_PIPELINE_ID=default
HUBSPOT_STAGE_ID=appointmentscheduled

# Optional
HUBSPOT_BASE_URL=https://api.hubapi.com
HUBSPOT_TIMEOUT_MS=10000
HUBSPOT_MAX_RETRIES=3
HUBSPOT_RETRY_BASE_DELAY_MS=1000
HUBSPOT_PORTAL_ID=            # only used to print links to records in the console
LOG_LEVEL=info                # error | warn | info | debug
```

`src/config/index.js` exposes a frozen object:

```js
{
  hubspot: {
    accessToken, baseUrl, timeoutMs, maxRetries, retryBaseDelayMs, portalId,
    pipelineId, stageId,
    paths: {
      contacts: '/crm/v3/objects/contacts',
      deals: '/crm/v3/objects/deals',
      pipelines: '/crm/v3/pipelines',
      properties: '/crm/v3/properties',
      associations: '/crm/objects/2026-09',   // see ambiguity A4
      search: (objectType) => `/crm/objects/2026-09/${objectType}/search`
    }
  },
  logLevel
}
```

The token is validated for presence only. It is never logged, never printed, never written to disk.

---

## 6. Official documentation used (verified 2026-09-17)

| Topic | URL | Facts relied on |
|-------|-----|-----------------|
| Contacts API | https://developers.hubspot.com/docs/reference/api/crm/objects/contacts | `GET/POST /crm/v3/objects/contacts`, `GET/PATCH/DELETE /crm/v3/objects/contacts/{id}`, `?idProperty=email`, `limit` max 100, `paging.next.after`, DELETE archives to recycle bin, scopes `crm.objects.contacts.read/write` |
| Deals API | https://developers.hubspot.com/docs/reference/api/crm/objects/deals and https://developers.hubspot.com/docs/api/crm/deals | `POST /crm/v3/objects/deals` with `properties.dealname`, `properties.pipeline`, `properties.dealstage`; `GET /crm/v3/objects/deals`; `PATCH`/`DELETE /crm/v3/objects/deals/{id}`; scopes `crm.objects.deals.read/write` |
| Associations API (current) | https://developers.hubspot.com/docs/reference/api/crm/associations/association-details and https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide | `PUT /crm/objects/2026-09/{fromObjectType}/{fromObjectId}/associations/default/{toObjectType}/{toObjectId}`; labeled `PUT .../associations/{toObjectType}/{toObjectId}` with `[{ associationCategory: "HUBSPOT_DEFINED", associationTypeId }]`; `GET .../associations/{toObjectType}`; type ids contact→deal = 4, deal→contact = 3 |
| Associations (previous, v3 on object endpoints) | Contacts/Deals pages above | `PUT /crm/v3/objects/{objectType}/{objectId}/associations/{toObjectType}/{toObjectId}/{associationTypeId}` — documented fallback |
| Pipelines API | https://developers.hubspot.com/docs/api/crm/pipelines | `GET /crm/v3/pipelines/{objectType}`, `GET /crm/v3/pipelines/{objectType}/{pipelineId}/stages`; response `id`, `label`, `stages[].id` |
| Properties API | https://developers.hubspot.com/docs/api/crm/properties | `GET /crm/v3/properties/{objectType}`, `GET /crm/v3/properties/{objectType}/{name}`, `POST /crm/v3/properties/{objectType}` with `{ name, label, type, fieldType, groupName, hasUniqueValue }`; `hasUniqueValue: true` enforces uniqueness, max ten unique properties per object; text property = `type: "string"`, `fieldType: "text"`; scopes `crm.schemas.{objectType}.read/write` |
| Search API | https://developers.hubspot.com/docs/api/crm/search | `POST /crm/objects/2026-09/{object}/search`; `filterGroups[].filters[] { propertyName, operator, value }`; `limit` max 200; 10,000 results max; 5 requests/second; new records may take a moment to be indexed |
| Rate limits | https://developers.hubspot.com/docs/api/usage-details | Private apps: 100 requests / 10 s (Free/Starter), 190 / 10 s (Pro/Enterprise); headers `X-HubSpot-RateLimit-Max`, `-Remaining`, `-Interval-Milliseconds`, `-Daily`, `-Daily-Remaining`; 429 body includes `policyName`; search responses carry no rate-limit headers |
| Error handling | https://developers.hubspot.com/docs/reference/api/other-resources/error-handling | Error body `{ status, message, category, correlationId, errors[] }` with optional fields; 401 = invalid auth, 403 = missing scopes, 429 = back off, 502/504 = pause a few seconds, 5xx = exponential backoff with ≥ 2 s delays; honour `Retry-After` |
| Private apps | https://developers.hubspot.com/docs/guides/apps/private-apps/overview | Created under Development → Legacy apps → Create legacy app → Private; token under Auth tab; header `Authorization: Bearer <token>`; scopes chosen in the Scopes tab; token lookup `POST /oauth/v2/private-apps/get/access-token-info` with body `{ "tokenKey": "<token>" }` → `{ userId, hubId, appId, scopes[] }`; rate limits 100 requests / 10 s (Free/Starter), 190 (Pro/Enterprise) |
| Scopes reference | https://developers.hubspot.com/docs/guides/apps/authentication/scopes | `crm.objects.contacts.read/write`, `crm.objects.deals.read/write`, `crm.schemas.contacts.read`, `crm.schemas.deals.read/write` |

---

## 7. Ambiguities and decisions

| ID | Ambiguity | Decision |
|----|-----------|----------|
| A1 | The PDF asks for `hs_pipeline` and `hs_stage` on deal creation. The official Deals API example uses `properties.pipeline` and `properties.dealstage`. `hs_pipeline`/`hs_stage` are the property names used by **tickets**, not deals. | Send `pipeline` and `dealstage`, sourced from `HUBSPOT_PIPELINE_ID` / `HUBSPOT_STAGE_ID`. The intent of the PDF (configurable pipeline and stage) is fully met. README documents the mapping explicitly. Confirmed live 2026-09-18: the diagnostic lists `pipeline` (enumeration/select) and `dealstage` (enumeration/radio) among the deal properties, and a deal created with them lands in the configured pipeline and stage. |
| A2 | Two submission deadlines: page 1 says "one hour before the second interview"; page 5 says "no later than 3 calendar days after receiving the test". | Plan to satisfy the earlier of the two and confirm with the evaluator by email. Recorded here and in the README's submission notes. |
| A3 | The PDF allows `HUBSPOT_API_KEY` as an alternative. HubSpot retired API keys; the private-apps documentation only describes access tokens. | Support only `HUBSPOT_ACCESS_TOKEN`. If `HUBSPOT_API_KEY` is set without a token, fail fast with a message explaining that API keys are no longer supported by HubSpot. |
| A4 | The PDF says "using the HubSpot associations endpoints" without a version. As of 2026-09-17 the official reference documents date-versioned paths (`/crm/objects/2026-09/...`) as current and links to the previous version on the object endpoints (`/crm/v3/objects/{type}/{id}/associations/...`). | Use the current documented path, kept in one config constant. Verify with a real call in stage 4; if the portal rejects it, switch the constant to the documented previous version and record the outcome in the README. |
| A5 | "Ensuring idempotency where possible" for associations. HubSpot does not document idempotency explicitly. | The default-association PUT is naturally idempotent (repeating it does not create duplicates). The service also lists existing associations first so the script can report `alreadyAssociated` and avoid the write. |
| A6 | Idempotent sync of deals: deals have no built-in unique key (deal names may repeat), and the Search API has indexing lag, so "search by name" can create duplicates on quick re-runs. | Approved decision: use a custom unique deal property `external_id` (`hasUniqueValue: true`), created once with the Properties API, and read deals by that value. The deal name is never used as a key. This is exact, has no indexing lag and exercises the Properties endpoint the PDF requires. Requires scope `crm.schemas.deals.write`. Contacts use the normalized `email` the same way. Full rules in section 11. |
| A13 | A `POST` that creates a record can fail with an answer that leaves the outcome unknown (timeout, connection reset, 5xx). Retrying it blindly can create duplicates. | Retries are decided per request idempotency in `withRetry`: `GET/PUT/PATCH/DELETE` retry every retryable error; `POST` retries only `429`, connection refused and DNS failures (the request never reached HubSpot). Otherwise the error is thrown with `outcomeUncertain: true` and the caller (the sync, stage 6) looks the record up by its natural key before creating again. Read-only `POST`s (search, token lookup, batch read) pass `idempotent: true`. Only `hubSpotClient` retries; nested `withRetry` calls detect `attempts` and do not retry again. |
| A15 | The portal used for verification is a populated account (hundreds of custom properties, several business pipelines, real contacts), not an empty developer sandbox. | Every example that writes works only on records created by this project: test contacts use reserved `example.*` addresses and the company "Triario Technical Test"; `delete-contact.js` reads the record first and refuses anything else unless `--force`; listings cap pages by default; no bulk operations exist. Verified live: the date-versioned Search API path (`/crm/objects/2026-09/contacts/search`) is accepted by the portal, so A4's assumption holds for search. |
| A14 | The service `try/catch` also receives non-HubSpot errors (a lazy `ConfigError` from the client, a `PayloadValidationError`, a programming error). Wrapping them as HubSpot errors would misclassify them (found while running `error-handling.js` without a token: a `ConfigError` surfaced as `NETWORK_ERROR`). | `normalizeHubSpotError` only converts transport errors (axios errors carrying a request config or a response). Everything else keeps its type, is never retried, and is logged once by `handleHubSpotErrors`. |
| A12 | The token-info endpoint (`POST /oauth/v2/private-apps/get/access-token-info`) is documented with its request/response shape but not its error codes. Verified live on 2026-09-18 without real credentials: empty body → `400 VALIDATION_ERROR` naming `tokenKey`; unknown token → `404 Resource not found` (HTML body); CRM endpoints with the same unknown token → `401 INVALID_AUTHENTICATION`. | `hubSpotService.checkAuthentication()` reports that 404 as `AUTHENTICATION_ERROR` with a message that names the variable to fix; the diagnostic stops after it because every other check would fail the same way. HTML bodies are never used as error messages. |
| A11 | The Deals reference documents `idProperty` explicitly only for batch read (`POST /crm/v3/objects/deals/batch/read` with `idProperty` in the body); the Contacts reference documents it on the single-record `GET`/`PATCH` as well. | `GET /crm/v3/objects/deals/{value}?idProperty=external_id` verified live on 2026-09-18: 404 for an unknown value, the deal for a known one. The batch read remains the documented fallback. |
| A7 | `getHubSpotContacts` "with filter/pagination options". The list endpoint has no property filters; filtering requires the Search API. | `getHubSpotContacts({ limit, after, properties })` uses the list endpoint; when `filters` is provided it switches to the Search API with the documented `filterGroups` body. |
| A8 | `hubSpotApiHandler` may be "executable scripts, or Express endpoints". | Executable scripts. Express would add a dependency, a server lifecycle and request parsing without adding evaluative value. `hubSpotApiHandler.js` is the shared runner every script uses. |
| A9 | Section 1.4 Streams places the file in `src/utils/streams.js`, not under fundamentals. | Keep the PDF path. The file is also referenced from the fundamentals section of the README. |
| A10 | The PDF calls `deleteHubSpotContact` a DELETE. In HubSpot, `DELETE /crm/v3/objects/contacts/{id}` archives the record (recycle bin), not a permanent purge. | Use the documented DELETE; README notes the archive semantics. Permanent deletion (GDPR endpoint) is out of scope. |

---

## 8. Manual setup required in HubSpot (done by the candidate before stage 3)

1. Create or reuse a HubSpot account and note the **Hub ID** (visible in the top-right account menu
   and in every portal URL: `https://app.hubspot.com/contacts/<hubId>/...`).
2. Create a **Private App**: Settings (gear) → Development → Legacy apps → Create legacy app → Private.
   Give it a name such as `triario-node-integration`.
3. In the **Scopes** tab select exactly:

   | Scope | Used by |
   |-------|---------|
   | `crm.objects.contacts.read` | list/get contacts, contact names, sync lookups |
   | `crm.objects.contacts.write` | create/update/delete contacts, associations |
   | `crm.objects.deals.read` | list/get deals, pipelines listing |
   | `crm.objects.deals.write` | create/update/delete deals, associations |
   | `crm.schemas.contacts.read` | read contact property definitions |
   | `crm.schemas.deals.read` | read deal property definitions |
   | `crm.schemas.deals.write` | create the `external_id` unique property for deal sync (A6) |

4. Create the app, open the **Auth** tab, click *Show token* → *Copy*.
5. Locally: copy `.env.example` to `.env` and paste the token into `HUBSPOT_ACCESS_TOKEN`.
   `.env` is git-ignored. Never paste the token in chat, code, logs or commits.
6. Run `node src/examples/diagnose.js` and copy the Hub ID, the pipeline id and a stage id it
   prints into `HUBSPOT_PORTAL_ID`, `HUBSPOT_PIPELINE_ID` and `HUBSPOT_STAGE_ID`. No ids are
   assumed by the project: `.env.example` ships them empty and the config has no defaults for them.
7. Optional: create a few contacts by hand in the UI so listing scripts have data before the sync runs.

If a script returns 403, the message will name the missing scope; add it in the app's Scopes tab
(the token does not change when scopes are edited).

---

## 9. Error-handling strategy (design)

```
hubSpotClient.request(config)
  └─ withRetry(() => axiosInstance(config), { maxRetries, baseDelayMs })
        ├─ success → response.data
        └─ error  → normalizeHubSpotError(error)
              ├─ no response (ECONNABORTED / ENOTFOUND / ECONNRESET) → NETWORK_ERROR, retryable
              ├─ 401 → AUTHENTICATION_ERROR, not retryable
              ├─ 403 → AUTHORIZATION_ERROR (missing scope), not retryable
              ├─ 400 → VALIDATION_ERROR (category, errors[], correlationId), not retryable
              ├─ 404 → NOT_FOUND, not retryable
              ├─ 429 → RATE_LIMIT, retryable, delay = Retry-After ?? 2^attempt * base + jitter
              ├─ 5xx → SERVER_ERROR, retryable, delay ≥ 2000 ms
              └─ other 4xx → CLIENT_ERROR, not retryable
```

Normalized error shape (a `HubSpotError` class extending `Error`):

```js
{
  name: 'HubSpotError',
  code: 'RATE_LIMIT',          // one of the categories above
  status: 429,                  // HTTP status or null for network errors
  message: 'human readable',    // from HubSpot when available
  category: 'RATE_LIMITS',      // HubSpot category, if present
  correlationId: '...',         // for support tickets
  details: [...],               // HubSpot errors[] if present
  retryable: true,
  method: 'GET', url: '/crm/v3/objects/contacts'   // path only, no headers, no token
}
```

Logging goes through `logger.js`, which serializes only whitelisted fields. The axios `config`
object (which contains the `Authorization` header) is never attached to the normalized error.

---

## 10. Stage plan

| Stage | Content | Exit criterion |
|-------|---------|----------------|
| 1 | Analysis and design (this document) | Matrix, structure, dependencies and decisions approved |
| 2 | Project scaffold (`package.json`, `.gitignore`, `.env.example`, folder structure, initial README) + Section 1 fundamentals + `hubSpotClient`, `handleHubSpotErrors`, `validateHubSpotPayload`, `logger`, `pagination` with tests + read-only diagnostic (`diagnose.js`) with account/pipeline/property repositories | Done 2026-09-18: `npm test` green (59 tests); fundamentals run without credentials; diagnostic verified without token and with an unknown token (real 400/404/401 responses); connection with a real token pending |
| 3 | Node.js fundamentals reviewed and hardened (stream error handling, npm scripts) | Done 2026-09-18: `npm run fundamentals` shows success and handled errors for all four exercises; 61 tests |
| 4 | Validation and error infrastructure: `validateHubSpotPayload` (create vs partial, ids), `handleHubSpotErrors` (normalization, single retry layer, idempotency-aware retries, `Retry-After`, uncertain POST outcomes, log once), PII masking, `error-handling.js` evidence script, `contactRepository` read functions | Done 2026-09-18 (code and tests); real 404/400 evidence pending until the token is in `.env` |
| 5 | Contacts: `contactRepository` CRUD + search, `getHubSpotContactNames`, `getHubSpotContacts` (list vs search), create / update / delete, five example scripts with a delete safety guard | Done 2026-09-18: verified live on a test contact (create → names with 3 real pages → list + cursor → search by company → PATCH → DELETE → 404 / archived=true) |
| 6 | Deals and associations: `dealRepository`, `associationRepository`, `getHubSpotDeals`, `createHubSpotDeal` (stage verified against the pipeline), `updateHubSpotDeal`, `deleteHubSpotDeal`, `associateContactToDeal` (idempotent, type id resolved from the portal), seven example scripts including an end-to-end flow with cleanup | Done 2026-09-18: `contact-deal-flow.js` verified live (create contact + deal → associate → repeat without duplicate → both directions 4/3 → PATCH → list → archive both); wrong stage rejected locally |
| 7 | Sync from local JSON: `syncService` (`syncContactsWithHubSpot` keyed by normalized e-mail, `syncDealsWithHubSpot` keyed by the unique `external_id` property created via the Properties API), `syncHelpers`, examples `sync-contacts.js`, `sync-deals.js`, `sync-cleanup.js` | Done 2026-09-18: three real runs each (create → unchanged with the same ids → one property updated), Search API counts show no duplicates, per-record failures reported, test records archived afterwards |
| 8 | Final audit and delivery: every required name and file checked programmatically, fundamentals + tests + diagnostic + error evidence + end-to-end flow re-run, real pagination with small pages (list and search), secrets review (token absent from files and git history), final README, delivery folder and ZIP (excludes `.env`, `node_modules`, `release/`, local notes) | Done 2026-09-18: all checks green; pending items listed in README section 12 |

---

## 11. Sync identity rules (approved in stage 1 review)

### 11.1 Contacts — key: normalized email

- **Normalization**: `email.trim().toLowerCase()` (`normalizeEmail` in `validateHubSpotPayload.js`).
  HubSpot treats contact email as the primary unique identifier and deduplicates on it, so the
  normalized value is what is sent, looked up and compared.
- **Lookup**: `GET /crm/v3/objects/contacts/{email}?idProperty=email`. `404` means "does not
  exist" → `POST`. Any other status → `PATCH /crm/v3/objects/contacts/{id}` with only the
  properties whose values differ from the record in HubSpot (no-op when nothing changed).
- **Record without email** (missing, empty or invalid format): not sent. Reported in the summary as
  `failed` with reason `MISSING_EMAIL` / `INVALID_EMAIL` and the record index. A contact without
  email cannot be matched on a re-run, so creating it would break idempotency.
- **Duplicate emails inside the source JSON** (after normalization): the first occurrence is
  processed; later ones are reported as `skipped` with reason `DUPLICATE_IN_SOURCE` and both
  indexes, so the data owner can fix the source. Records are never merged silently.
- **Race with HubSpot deduplication**: if a `POST` returns `409 CONFLICT` (the contact was created
  between lookup and create), the sync treats it as "exists" and re-reads by email, then updates.

### 11.2 Deals — key: `external_id` (stable identifier of the source record)

- **Property**: custom deal property `external_id`, `type: "string"`, `fieldType: "text"`,
  `groupName: "dealinformation"`, `hasUniqueValue: true`. Verified in the official Properties
  documentation: `hasUniqueValue` is supported, a portal may have up to ten unique-value
  properties per object, and creating deal properties requires `crm.schemas.deals.write`.
- **Ensure once, never assume**: before the first sync, `propertyRepository.getProperty('deals',
  'external_id')`; on `404` create it with `POST /crm/v3/properties/deals`; if it exists but is
  not unique, abort the sync with a clear error (the property must be recreated by an admin).
- **Lookup**: by `external_id` value (see A11). `404` → `POST` with `external_id` included in the
  properties. Found → `PATCH` by HubSpot id with the changed properties only. `external_id` is
  never included in a `PATCH`, so it cannot change on update.
- **Record without `external_id`**: reported as `failed` with reason `MISSING_EXTERNAL_ID`, not sent.
- **Duplicate `external_id` inside the source JSON**: first occurrence processed, later ones
  `skipped` with `DUPLICATE_IN_SOURCE`.
- **Contact link**: an optional `contactEmail` on the deal record is resolved through the contact
  lookup above and associated after create/update, using the idempotent association call (A5).
- **Guarantee**: running the same JSON twice creates nothing on the second run. Running it after
  editing a record updates only that record.

### 11.3 Summary returned by both sync functions

```js
{
  created: [{ index, key, id }],
  updated: [{ index, key, id, changedProperties }],
  unchanged: [{ index, key, id }],
  skipped: [{ index, key, reason, duplicateOf }],
  failed: [{ index, key, reason, error }]
}
```
