# Backend Developer Technical Test

## Node.js — HubSpot CRM Integration

**Submitted by:** Rafael Estiven Uribe Álvarez\
**Submitted to:** Triario\
**Purpose:** Technical assessment for the Backend Developer selection process.

### About this submission

This project was developed as a submission for Triario’s Backend Developer technical assessment. It demonstrates Node.js fundamentals and a modular integration with the HubSpot CRM API, covering contacts, deals, associations, synchronization, validation, and error handling.

Everything in the brief is implemented, unit-tested (102 tests) and verified live against the
portal on records created by the project (see [section 12](#12-verification-results)). The
requirements matrix, the decisions and the ambiguities found in the brief are kept in
[docs/design.md](docs/design.md).

---

## 1. Objective and architecture

Goal: show how to build HubSpot API calls from the official documentation, keep them readable,
handle every failure mode explicitly and make writes safe to repeat.

```
examples (executable scripts)  ──►  services  ──►  repositories  ──►  clients  ──►  HubSpot API
      hubSpotApiHandler            hubSpotService   contactRepository   hubSpotClient
      diagnose, create-*, ...      syncService      dealRepository      (axios, bearer,
                                                    associationRepo…    retries)
                     utils: handleHubSpotErrors · validateHubSpotPayload · pagination · logger
                     config: .env loading and validation, API paths, required scopes
```

| Layer | Folder | Responsibility |
|-------|--------|----------------|
| config | `src/config/` | The only module reading `process.env`; validates variables, fails fast; API paths and required scopes live here. |
| clients | `src/clients/` | `hubSpotClient`: axios instance with base URL, bearer token, timeout; the **only** retry layer; converts transport errors into `HubSpotError`. |
| repositories | `src/repositories/` | One module per HubSpot resource (contacts, deals, associations, pipelines, properties, account). Raw endpoint calls, no business rules. |
| services | `src/services/` | `hubSpotService` (the functions named in the brief) and `syncService` (idempotent sync). Validate input, combine repository calls, propagate normalized errors. |
| utils | `src/utils/` | Pure helpers, unit-tested without network: errors and retry policy, validation, pagination, logging with redaction, streams (Section 1.4). |
| fundamentals | `src/fundamentals/` | Section 1 exercises; run without credentials. |
| data | `src/data/` | Local JSON sources for the sync functions. |
| examples | `src/examples/` | `hubSpotApiHandler` (shared runner) and one executable script per operation. |
| test | `test/` | `node:test` suites for the pure logic. HubSpot calls are never mocked. |

Dependencies point one way (examples → services → repositories → clients), so each layer can be
read, tested and replaced on its own.

## 2. Requirements

- Node.js **18.17 or newer** (developed and verified on Node 22.14, npm 10.9). No build step.
- A HubSpot account you own, with a Private App (section 5).

Dependencies (runtime, listed in `package.json`):

| Package | Version | Purpose |
|---------|---------|---------|
| `axios` | ^1.7 | HTTP client (instances, timeouts, typed errors) |
| `dotenv` | ^16.4 | Loads `.env` into `process.env` |

Everything else is Node.js core: `fs`, `path`, `stream`, `stream/promises`, `timers/promises`,
`util.parseArgs`, `node:test`, `node:assert`. No dev dependencies.

## 3. Install

```bash
npm install
```

## 4. Configure `.env`

```bash
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
```

`.env` is git-ignored and must never be committed. Variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `HUBSPOT_ACCESS_TOKEN` | yes | Private App access token (section 5). |
| `HUBSPOT_PORTAL_ID` | recommended | Your Hub ID (numeric). Used to print portal links and to check the token belongs to that account. |
| `HUBSPOT_PIPELINE_ID` | for deals | Deal pipeline id. Copy it from `npm run diagnose`. No default on purpose. |
| `HUBSPOT_STAGE_ID` | for deals | Stage id inside that pipeline. Copy it from `npm run diagnose`. |
| `HUBSPOT_BASE_URL` | no | API base URL. Default `https://api.hubapi.com`. |
| `HUBSPOT_TIMEOUT_MS` | no | Per-request timeout. Default `10000`. |
| `HUBSPOT_MAX_RETRIES` | no | Retries for 429 / 5xx / network errors. Default `3`. |
| `HUBSPOT_RETRY_BASE_DELAY_MS` | no | Base delay of the exponential backoff. Default `1000`. |
| `LOG_LEVEL` | no | `error`, `warn`, `info` (default) or `debug`. |

Two different URLs are involved:

- **API base URL** `https://api.hubapi.com`: where this project sends HTTP requests.
- **Portal URL** `https://app.hubspot.com/contacts/<hubId>`: what you open in the browser.

`HUBSPOT_API_KEY` is intentionally not supported: HubSpot retired API keys and the official
Private Apps documentation only describes access tokens. If it is set without a token the app
stops with a message saying so.

## 5. Private App and scopes

Source: [Private apps](https://developers.hubspot.com/docs/guides/apps/private-apps/overview),
[Scopes](https://developers.hubspot.com/docs/guides/apps/authentication/scopes).

1. In HubSpot: **Settings** (gear) → **Development** → **Legacy apps** → **Create legacy app** → **Private**.
2. **Basic info**: name it, e.g. `triario-node-integration`.
3. **Scopes**: add exactly these seven.

   | Scope | Used for |
   |-------|----------|
   | `crm.objects.contacts.read` | list / read / search contacts, sync lookups |
   | `crm.objects.contacts.write` | create / update / delete contacts, associations |
   | `crm.objects.deals.read` | list / read deals, pipelines |
   | `crm.objects.deals.write` | create / update / delete deals, associations |
   | `crm.schemas.contacts.read` | read contact property definitions (diagnostic) |
   | `crm.schemas.deals.read` | read deal property definitions (diagnostic, sync precondition) |
   | `crm.schemas.deals.write` | create the unique `external_id` deal property used by the sync |

4. **Create app** → **Auth** tab → **Show token** → **Copy**.
5. Paste it as `HUBSPOT_ACCESS_TOKEN` in your local `.env`. Nowhere else. If it leaks, rotate it
   from the same tab.
6. Run `npm run diagnose`: it verifies the token, prints your Hub ID and the pipeline / stage ids
   to copy into `.env`, and flags any missing scope. A `403` from any script names the missing scope.

## 6. Portal

| | |
|---|---|
| Hub ID (portal id) | `51411630` |
| Portal URL | https://app.hubspot.com/contacts/51411630 |
| API base URL | https://api.hubapi.com |
| Deal pipeline used for verification | "Tests" (`4664657`), stage "Pruebas" (`4664661`) |

The portal is a populated account, not an empty sandbox. Every example that writes therefore
works only on records created by this project (reserved `example.*` e-mail addresses, company
"Triario Technical Test", deal names prefixed `Triario Test - `), the delete examples refuse
anything else without `--force`, and listing examples cap the number of pages by default.

## 7. Endpoints and official documentation

| Operation | Method and path | Used by | Documentation |
|-----------|-----------------|---------|---------------|
| List contacts | `GET /crm/v3/objects/contacts?limit=&after=&properties=` | `getHubSpotContactNames`, `getHubSpotContacts` | [Contacts](https://developers.hubspot.com/docs/reference/api/crm/objects/contacts) |
| Read contact | `GET /crm/v3/objects/contacts/{id}` · `.../{email}?idProperty=email` | `getHubSpotContactById`, sync lookup | Contacts |
| Create contact | `POST /crm/v3/objects/contacts` | `createHubSpotContact`, sync | Contacts |
| Update contact | `PATCH /crm/v3/objects/contacts/{id}` | `updateHubSpotContact`, sync | Contacts |
| Delete (archive) contact | `DELETE /crm/v3/objects/contacts/{id}` | `deleteHubSpotContact` | Contacts |
| Search contacts | `POST /crm/objects/2026-09/contacts/search` | `getHubSpotContacts` with filters | [Search](https://developers.hubspot.com/docs/api/crm/search) |
| List deals | `GET /crm/v3/objects/deals?limit=&after=&properties=` | `getHubSpotDeals` | [Deals](https://developers.hubspot.com/docs/reference/api/crm/objects/deals) |
| Read deal | `GET /crm/v3/objects/deals/{id}` · `.../{value}?idProperty=external_id` | `getHubSpotDealById`, sync lookup | Deals |
| Create deal | `POST /crm/v3/objects/deals` | `createHubSpotDeal`, sync | Deals |
| Update deal | `PATCH /crm/v3/objects/deals/{id}` | `updateHubSpotDeal`, sync | Deals |
| Delete (archive) deal | `DELETE /crm/v3/objects/deals/{id}` | `deleteHubSpotDeal` | Deals |
| Search deals | `POST /crm/objects/2026-09/deals/search` | `dealRepository.search` (evidence counts) | Search |
| Deal pipelines | `GET /crm/v3/pipelines/deals` · `GET /crm/v3/pipelines/deals/{id}` | `getDealPipelines`, `resolveDealStage` | [Pipelines](https://developers.hubspot.com/docs/api/crm/pipelines) |
| Properties | `GET /crm/v3/properties/{objectType}` · `GET .../{name}` · `POST /crm/v3/properties/deals` | diagnostic, `ensureDealExternalIdProperty` | [Properties](https://developers.hubspot.com/docs/api/crm/properties) |
| Create default association | `PUT /crm/objects/2026-09/contact/{id}/associations/default/deal/{id}` | `associateContactToDeal` | [Associations](https://developers.hubspot.com/docs/reference/api/crm/associations/association-details) |
| Read associations | `GET /crm/objects/2026-09/{from}/{id}/associations/{to}` | idempotency check, both directions | Associations |
| Association types | `GET /crm/associations/2026-09/contact/deal/labels` | resolves the type id (`4`; reverse `3`) | Associations |
| Token info | `POST /oauth/v2/private-apps/get/access-token-info` | diagnostic (Hub ID, scopes) | [Private apps](https://developers.hubspot.com/docs/guides/apps/private-apps/overview) |
| Rate limits | — | retry policy | [Usage details](https://developers.hubspot.com/docs/api/usage-details) |
| Error format | — | `handleHubSpotErrors` | [Error handling](https://developers.hubspot.com/docs/reference/api/other-resources/error-handling) |

Objects, pipelines and properties are documented under `/crm/v3`; associations and search are
documented under the current date-versioned prefix (`2026-09`), which the portal accepted in every
verification. All paths live in `src/config/index.js`.

## 8. Running the examples

Every script prints a heading, readable output and exits with code `1` on failure. Arguments after
`--` reach the script when using `npm run`; `node src/examples/<file>.js ...` works the same.

### Node.js fundamentals (no credentials)

```bash
npm run fundamentals                       # all four in sequence
node src/fundamentals/callbacks.js         # 1. fs.readFile with an error-first callback
node src/fundamentals/asyncAwait.js        # 2. same operation as a Promise, async/await + try/catch
node src/fundamentals/main.js              # 3. CommonJS: utils_module.js exports sumArray, main.js uses it
node src/utils/streams.js                  # 4. Readable.from -> uppercase Transform -> stdout, with a handled failure
```

### Diagnostic and error evidence (read-only)

```bash
npm run diagnose                           # token, Hub ID, scopes, pipelines/stages, properties
npm run example:errors                     # local validation, real 404 by id, real 404 by e-mail, real 400
npm run example:list-pipelines             # pipelines and stages, marks the configured ones
```

### Contacts

```bash
npm run example:get-contact-names -- --page-size 2 --max-pages 3      # walks real pages; --max-pages 0 = all
npm run example:get-contacts -- --limit 2                              # list endpoint + next cursor
npm run example:get-contacts -- --limit 2 --after <cursor>
npm run example:get-contacts -- --filter "company:EQ:Triario Technical Test"   # Search API
npm run example:create-contact                                         # unique test contact
npm run example:create-contact -- --email ana@example.org --firstname Ana --lastname Torres
npm run example:update-contact -- <contactId> --lastname "Updated" --phone "+57 300 000 0000"
npm run example:delete-contact -- <contactId>                          # guarded; --force for non-test records
```

### Deals and associations

```bash
npm run example:get-deals -- --limit 2
npm run example:get-deals -- --all --max-pages 3
npm run example:create-deal -- "Triario Test - website" 4500
npm run example:create-deal -- "Triario Test - website" 4500 --contact <contactId>
npm run example:update-deal -- <dealId> --amount 2500 --dealstage <stageId>
npm run example:associate -- <contactId> <dealId>                      # run twice: second is a no-op
npm run example:delete-deal -- <dealId>
npm run example:flow                                                   # end-to-end with cleanup (--keep to keep records)
```

### Sync from local JSON

```bash
npm run example:sync-contacts                       # src/data/contacts.json
npm run example:sync-deals                          # src/data/deals.json (run contacts first)
npm run example:sync-contacts -- --file other.json
npm run example:sync-cleanup                        # archives the records created from both files
```

### Unit tests (no network)

```bash
npm test
```

## 9. Pagination, validation, errors and retries

**Pagination.** List endpoints return `{ results, paging: { next: { after } } }` and accept at most
100 records per page. `paginateAll` / `collectPages` (`src/utils/pagination.js`) send `after` back
until it disappears, with an optional page cap. Single-page functions return `nextAfter` so the
caller continues; the Search API uses a numeric cursor and up to 200 per page. Filters are never
sent to the list endpoint; with filters `getHubSpotContacts` switches to the Search API (10,000
results max, 5 requests/second, recent writes may not be indexed yet).

**Validation.** `validateHubSpotPayload(objectType, properties, { partial })` runs before any
request: create mode requires the key fields (`email`; `dealname`, `pipeline`, `dealstage`),
partial mode requires at least one property. E-mails are trimmed and lower-cased, `amount` must be
a non-negative number and is sent as a string, ids are checked numeric before reaching a URL, and
search filters are checked against the documented operators. Pipeline / stage are additionally
verified against the portal (`resolveDealStage`).

**Errors.** Every failure becomes a `HubSpotError` with `code`, `status`, `message`, `category`,
`correlationId`, `details`, `retryable`, `attempts` and `outcomeUncertain`:

| Situation | Code | Retried |
|-----------|------|---------|
| DNS / connection failure | `NETWORK_ERROR` | yes (see POST rule) |
| Timeout (`HUBSPOT_TIMEOUT_MS`) | `TIMEOUT` | yes (see POST rule) |
| 401 | `AUTHENTICATION_ERROR` | no |
| 403 (missing scope) | `AUTHORIZATION_ERROR` | no |
| 400 | `VALIDATION_ERROR` (HubSpot category, errors[], correlationId kept) | no |
| 404 / 409 / other 4xx | `NOT_FOUND` / `CONFLICT` / `CLIENT_ERROR` | no |
| 429 | `RATE_LIMIT` | yes, `Retry-After` first |
| 5xx | `SERVER_ERROR` | yes, 2 s minimum delay |

**Retries.** Only `hubSpotClient.request` retries, up to `HUBSPOT_MAX_RETRIES`, with
`base × 2^(attempt−1)` plus up to 20 % jitter, capped at 30 s; a `Retry-After` header replaces the
formula. Nested `withRetry` calls detect `attempts` and never multiply requests. `POST` requests
that create data are retried only when the request certainly never reached HubSpot (429, refused
connection, DNS failure); after a timeout, reset or 5xx the error is thrown with
`outcomeUncertain: true` so the caller looks the record up instead of creating it blindly.
Read-only `POST`s (search, token lookup) are marked idempotent. Configuration and validation errors
keep their own types and are never retried. Errors are logged once (`handleHubSpotErrors`) and
always propagated; scripts exit with code 1.

**What is never logged.** The original request (with the `Authorization` header and body) is not
attached to errors; the logger redacts credential keys and `Bearer`/`pat-` values and masks e-mail
addresses, including URL-encoded ones in request paths. Validation messages do not echo e-mails.

**Rate limits.** Free/Starter private apps get 100 requests per 10 s. The sync processes records
sequentially (≤ 2 requests per contact, ≤ 4 per deal), the client warns when
`X-HubSpot-RateLimit-Remaining` drops below 10, and 429s are handled by the retry policy. Rate
limits and 5xx were not provoked on purpose; that logic is covered by unit tests.

## 10. Sync identity and idempotency

- **Contacts** are keyed by the normalized e-mail. Lookup is a direct read
  (`GET /contacts/{email}?idProperty=email`), exact and without indexing lag. No or invalid e-mail
  → `failed`, never created. Duplicate e-mail in the file → first wins, others `skipped`.
- **Deals** are keyed by `externalId`, stored in the custom unique property `external_id`
  (created on first run through the Properties API with `hasUniqueValue: true`; aborts if the
  property exists without uniqueness). Lookup:
  `GET /deals/{externalId}?idProperty=external_id`. `external_id` is sent on create only. The deal
  name is never a key.
- **Decision**: lookup → `404` ⇒ create; found ⇒ compare as trimmed strings ⇒ `PATCH` only the
  differences or `unchanged`. `409` on create ⇒ update path. Pipeline/stage set on create only.
- **Per-record errors** do not stop the file; auth/scope errors abort early. Summary:
  `{ total, created[], updated[], unchanged[], skipped[], failed[], aborted }` with ids.
- **Associations**: `contactEmail` on a deal is resolved and associated idempotently
  (`created`, then `already`; `skipped (CONTACT_NOT_FOUND)` if the contact is missing).
- **No local mapping file**: identity lives in HubSpot; losing the checkout changes nothing.

## 11. Technical decisions, discrepancies and limitations

Decisions:

- **axios instead of `@hubspot/api-client`**: the brief evaluates building the calls from the
  documentation and handling errors explicitly; a thin client keeps every path, payload and retry
  visible.
- **Executable scripts, not Express**: allowed by the brief; keeps the submission focused.
- **No invented ids**: pipeline and stage have no defaults; the diagnostic reads the real ones.
- **Association type id resolved at runtime** from the labels endpoint instead of hard-coding `4`.
- **Delete = archive**: `DELETE` moves records to the recycle bin (verified: `GET` → 404,
  `GET ?archived=true` → `archived: true`).

Discrepancies with the brief:

- `hs_pipeline` / `hs_stage` are **ticket** properties; the official Deals API uses
  `properties.pipeline` and `properties.dealstage`, which is what is sent.
- `HUBSPOT_API_KEY` is offered as an alternative, but HubSpot no longer issues API keys; only the
  Private App token is supported.
- Two deadlines appear (one hour before the second interview vs. three calendar days); the
  earlier one is the target, to be confirmed with the evaluator.
- The associations endpoints are versioned by date in the current documentation
  (`/crm/objects/2026-09/...`); the object endpoints keep `/crm/v3`. Both work against the portal.

Limitations:

- Search filters form a single AND group; OR groups, sorting and free-text `query` are not exposed.
- Batch endpoints are not used; the sync is sequential by design (rate-limit friendly, slower).
- 429, 5xx and timeouts are handled by tested code paths but were not reproduced live.
- Labeled associations are implemented in the repository but only the default (unlabeled) one is
  used.
- The `external_id` property created by the sync stays in the portal; remove it with
  `DELETE /crm/v3/properties/deals/external_id` if unwanted.
- Only the properties listed in `validateHubSpotPayload` get type checks; other properties pass
  through and are validated by HubSpot (400 with details).

## 12. Verification results

All runs below were executed on 2026-09-18 against Hub ID `51411630`, on records created by the
project and archived afterwards. Ids are real record ids from those runs.

| Check | Command | Observed |
|-------|---------|----------|
| Unit tests | `npm test` | 102 tests, 33 suites, 0 failures |
| Fundamentals | `npm run fundamentals` | four scripts: success path plus a handled error each (ENOENT, non-numeric element, mid-stream failure) |
| Diagnostic | `npm run diagnose` | token accepted, Hub ID matches `HUBSPOT_PORTAL_ID`, 8 scopes granted (all 7 required), 9 deal pipelines, 877 contact / 540 deal properties, `external_id` present and unique |
| Real errors | `npm run example:errors` | local `PayloadValidationError`; real 404 by id; real 404 by e-mail with the address masked in the log; real 400 "You can only request at most 100 objects in one request" |
| Contact CRUD | create → update → delete | contact `249176066215` created, `lastname`/`phone` patched, archived; `GET` → 404, `GET ?archived=true` → `archived: true` |
| Pagination (list) | `get-contact-names --page-size 2 --max-pages 4` | 4 real pages of 2 following `paging.next.after`, cap reported |
| Pagination (search) | `get-contacts --limit 2 --filter "company:EQ:Triario Technical Test"` over 5 test contacts | `total 5`; pages with cursors `2` and `4`; last page has 1 record and no cursor |
| Deals + associations | `npm run example:flow` (twice) and standalone scripts | deals `65100658190`, `65088368648`, `65111238826` in pipeline "Tests"/"Pruebas"; association created with type `4`, repeat → `alreadyAssociated`, reverse direction type `3`; amount patched; wrong stage `closedwon` rejected locally |
| Sync contacts | 3 runs of `sync-contacts` | run 1 created `249168090233`, `249172281265`, `249177201471`; run 2 → 3 unchanged, same ids; run 3 (one phone changed) → 1 updated, 2 unchanged |
| Sync deals | 3 runs of `sync-deals` | run 1 created property `external_id` and deals `65110455987`, `65090199876`, `65117569931` with 3 associations; run 2 → 3 unchanged, associations `already`; run 3 (one amount changed) → 1 updated |
| No duplicates | Search API counts | 3 deals with `external_id`, 2 contacts at "Example Co" after three runs |
| Per-record errors | `sync-contacts --file` with bad records | missing e-mail → failed, invalid e-mail → failed, duplicate → skipped, valid ones processed, exit code 1 |
| Secrets | grep of the token value over files and `git log -p` | 0 occurrences outside `.env`; `.env` untracked |

Pending / not verified live: 429 and 5xx responses, timeouts and `Retry-After` handling (unit
tests only); labeled associations; pagination with more than 100 records per page (demonstrated
with small page sizes instead).

## 13. Submission contents

The delivery folder / ZIP contains the source, tests, `docs/`, `package.json`,
`package-lock.json`, `.env.example` and this README. It excludes `.env`, `node_modules/`,
the `release/` build folder and local notes. After unzipping: `npm install`, create `.env`
(section 4), `npm run diagnose`.
