# Node.js — HubSpot CRM Integration

Technical test for Triario (Back End Developer). A small, modular Node.js (CommonJS) project that
demonstrates core Node.js concepts and integrates with a real HubSpot portal through a Private App
token: contacts and deals CRUD, contact-to-deal associations, idempotent sync from local JSON,
payload validation, pagination and error handling with retries.

> **Status:** stage 6 of 8. Scaffold, Node.js fundamentals, HTTP client, error handling,
> validation, pagination, diagnostic script, contacts, deals and associations are implemented,
> unit-tested and verified against a real portal on project test records. The sync functions are
> the next stage. The full design, requirements matrix and technical decisions are in
> [docs/design.md](docs/design.md).

## Requirements

- Node.js 18.17 or newer (developed on Node 22). No build step, no TypeScript.
- A HubSpot account you own (a free account or a developer test account is enough).

## Install

```bash
npm install
```

Libraries used (runtime): `axios` (HTTP client) and `dotenv` (loads `.env`). Tests use the Node.js
built-in `node:test` runner. No other dependencies.

## Configure

```bash
cp .env.example .env      # PowerShell: Copy-Item .env.example .env
```

Then edit `.env`. It is git-ignored and must never be committed.

| Variable | Required | Description |
|----------|----------|-------------|
| `HUBSPOT_ACCESS_TOKEN` | yes | Private App access token (see next section). |
| `HUBSPOT_PORTAL_ID` | recommended | Your Hub ID (numeric). Used to print portal links and to check the token belongs to that account. |
| `HUBSPOT_PIPELINE_ID` | for deals | Deal pipeline id. Copy it from the diagnostic output. |
| `HUBSPOT_STAGE_ID` | for deals | Deal stage id inside that pipeline. Copy it from the diagnostic output. |
| `HUBSPOT_BASE_URL` | no | API base URL. Default `https://api.hubapi.com`. |
| `HUBSPOT_TIMEOUT_MS` | no | Per-request timeout. Default `10000`. |
| `HUBSPOT_MAX_RETRIES` | no | Retries for 429 / 5xx / network errors. Default `3`. |
| `HUBSPOT_RETRY_BASE_DELAY_MS` | no | Base delay of the exponential backoff. Default `1000`. |
| `LOG_LEVEL` | no | `error`, `warn`, `info` (default) or `debug`. |

Two URLs are involved and are different things:

- **API base URL** `https://api.hubapi.com`: where this project sends HTTP requests.
- **Portal URL** `https://app.hubspot.com/contacts/<hubId>`: where you open the CRM in a browser.
  `<hubId>` is your Hub ID, shown in every portal URL and in the account menu (top right).

`HUBSPOT_API_KEY` is intentionally not supported: HubSpot retired API keys, and the official
Private Apps documentation only describes access tokens. If it is set without a token, the app
stops with a message explaining this.

## Create the Private App (your own portal)

Source: [Private apps overview](https://developers.hubspot.com/docs/guides/apps/private-apps/overview)
and the [scopes reference](https://developers.hubspot.com/docs/guides/apps/authentication/scopes).

1. In HubSpot open **Settings** (gear icon) → **Development** → **Legacy apps** →
   **Create legacy app** → choose **Private**.
2. **Basic info** tab: name it, for example `triario-node-integration`.
3. **Scopes** tab: add exactly these scopes.

   | Scope | Used for |
   |-------|----------|
   | `crm.objects.contacts.read` | list / read contacts, contact names, sync lookups |
   | `crm.objects.contacts.write` | create / update / delete contacts, associations |
   | `crm.objects.deals.read` | list / read deals, pipelines |
   | `crm.objects.deals.write` | create / update / delete deals, associations |
   | `crm.schemas.contacts.read` | read contact property definitions |
   | `crm.schemas.deals.read` | read deal property definitions |
   | `crm.schemas.deals.write` | create the unique `external_id` deal property used by the sync |

4. Click **Create app**, open the **Auth** tab, click **Show token**, then **Copy**.
5. Paste it as the value of `HUBSPOT_ACCESS_TOKEN` in your local `.env`. Nowhere else: not in
   code, not in logs, not in git, not in chat. If it ever leaks, rotate it from the same Auth tab.
6. Run the diagnostic (next section). It prints your Hub ID and the pipeline / stage ids to copy
   into `HUBSPOT_PORTAL_ID`, `HUBSPOT_PIPELINE_ID` and `HUBSPOT_STAGE_ID`.

Scopes can be edited later without changing the token. A `403` from any script names the
missing scope.

## Run

### Node.js fundamentals (no credentials needed)

```bash
npm run fundamentals            # runs the four scripts below in sequence
node src/fundamentals/callbacks.js     # 1. async operation with an error-first callback
node src/fundamentals/asyncAwait.js    # 2. same operation as a Promise, consumed with async/await
node src/fundamentals/main.js          # 3. CommonJS module (utils_module.js) imported by main.js
node src/utils/streams.js              # 4. Readable.from -> uppercase Transform -> process.stdout
```

Each script shows the happy path and a handled error: a missing file (`ENOENT`) for the callback
and async/await versions, a non-numeric element for `sumArray`, and a source that fails
mid-stream for the pipeline (caught by `try/catch` around `stream/promises.pipeline`).

| npm script | Runs |
|------------|------|
| `npm run fundamentals` | all four in sequence |
| `npm run fundamentals:callbacks` | `src/fundamentals/callbacks.js` |
| `npm run fundamentals:async-await` | `src/fundamentals/asyncAwait.js` |
| `npm run fundamentals:modules` | `src/fundamentals/main.js` |
| `npm run fundamentals:streams` | `src/utils/streams.js` |

### Read-only diagnostic (needs the token)

```bash
npm run diagnose                # same as: node src/examples/diagnose.js
```

It never creates, updates or deletes anything. It:

1. loads and validates `.env`, printing the API base URL and the portal URL;
2. verifies the token and prints Hub ID, private app id and granted scopes, flagging any
   missing scope from the table above (`POST /oauth/v2/private-apps/get/access-token-info`, a lookup);
3. lists deal pipelines and their stages (`GET /crm/v3/pipelines/deals`) and tells you which
   ids to copy into `.env`;
4. lists contact properties (`GET /crm/v3/properties/contacts`);
5. lists deal properties (`GET /crm/v3/properties/deals`) and reports whether the unique
   `external_id` property already exists.

Without a token it stops at step 1 with a configuration message and exit code 1. With a token
HubSpot does not recognize, step 2 reports an authentication error (the token lookup answers 404
for unknown tokens, verified live) and the remaining steps are skipped. The token value is never
printed.

### Contacts (real calls, only on test records)

| Script | Function | HubSpot call |
|--------|----------|--------------|
| `npm run example:get-contact-names -- --page-size 2 --max-pages 3` | `getHubSpotContactNames` | `GET /crm/v3/objects/contacts` walking `paging.next.after` |
| `npm run example:get-contacts -- --limit 2` | `getHubSpotContacts` | `GET /crm/v3/objects/contacts?limit=&after=&properties=` |
| `npm run example:get-contacts -- --filter "company:EQ:Triario Technical Test"` | `getHubSpotContacts` with filters | `POST /crm/objects/2026-09/contacts/search` |
| `npm run example:create-contact` | `createHubSpotContact` | `POST /crm/v3/objects/contacts` |
| `npm run example:update-contact -- <id> --lastname "New" --phone "+57 ..."` | `updateHubSpotContact` | `PATCH /crm/v3/objects/contacts/{id}` |
| `npm run example:delete-contact -- <id>` | `deleteHubSpotContact` | `DELETE /crm/v3/objects/contacts/{id}` |

(`--` separates npm's own arguments from the script's; `node src/examples/<file>.js ...` works too.)

**Names.** `getHubSpotContactNames` requests only `firstname,lastname`, reads every page (100 per
page) and returns `"firstname lastname"` trimmed to single spaces. A contact with only one of the
two names returns that one; a contact with neither is skipped, or replaced by a placeholder when
`includeUnnamed` is set. The example caps at 10 pages by default (`--max-pages 0` lifts the cap)
so a large portal is not dumped by accident.

**List vs search.** Without filters, `getHubSpotContacts` uses the list endpoint: no filtering,
up to 100 per page, opaque cursor, results in record-id order. With `filters` it uses the Search
API instead: `{ propertyName, operator, value }` filters combined with AND, up to 200 per page,
a numeric cursor, at most 10,000 results per query, 5 requests per second, and records written a
moment ago may not be indexed yet. Filters are validated locally against the documented operators
(`EQ`, `NEQ`, `LT`, `LTE`, `GT`, `GTE`, `BETWEEN`, `IN`, `NOT_IN`, `HAS_PROPERTY`,
`NOT_HAS_PROPERTY`, `CONTAINS_TOKEN`, `NOT_CONTAINS_TOKEN`) and are never sent to the list
endpoint. Both paths return `{ source, contacts, nextAfter, total? }`; pass `nextAfter` back as
`after` to continue.

**Create / update / delete.** Creation validates the payload locally (`email` required and
normalized to lower case) and sends `POST`; HubSpot deduplicates by e-mail and answers `409` for
an existing address. Updates are partial `PATCH`es: only the properties passed change, at least one
is required. `DELETE` **archives** the contact into the HubSpot recycle bin (restorable from the
portal) rather than purging it: afterwards a normal `GET` answers `404`, while
`GET ...?archived=true` still returns the record with `archived: true`. The delete example reads the
record first and refuses anything that is not a project test contact (reserved `example.*`
address or company "Triario Technical Test") unless `--force` is given.

### Deals and associations (real calls, only on test records)

| Script | Function | HubSpot call |
|--------|----------|--------------|
| `npm run example:list-pipelines` | `getDealPipelines` | `GET /crm/v3/pipelines/deals` |
| `npm run example:get-deals -- --limit 2` | `getHubSpotDeals` | `GET /crm/v3/objects/deals?limit=&after=&properties=` |
| `npm run example:get-deals -- --all --max-pages 3` | `getHubSpotDeals({ all })` | same, walking `paging.next.after` |
| `npm run example:create-deal -- "Triario Test - x" 4500 [--contact <id>]` | `createHubSpotDeal(dealName, amount, options)` | `POST /crm/v3/objects/deals` (+ association) |
| `npm run example:update-deal -- <id> --amount 2500` | `updateHubSpotDeal` | `PATCH /crm/v3/objects/deals/{id}` |
| `npm run example:delete-deal -- <id>` | `deleteHubSpotDeal` | `DELETE /crm/v3/objects/deals/{id}` |
| `npm run example:associate -- <contactId> <dealId>` | `associateContactToDeal` | `PUT /crm/objects/2026-09/contact/{id}/associations/default/deal/{id}` |
| `npm run example:flow` | all of the above end to end | creates, associates, updates and archives one test contact and one test deal |

**Pipeline and stage.** `createHubSpotDeal(dealName, amount)` keeps the signature from the brief;
the optional third argument accepts `{ pipelineId, stageId, properties, contactId }`. Pipeline and
stage default to `HUBSPOT_PIPELINE_ID` and `HUBSPOT_STAGE_ID`. Before the `POST`, the pipeline
definition is read once per process (`GET /crm/v3/pipelines/deals/{id}`, cached) and the stage is
checked to belong to it; a wrong stage is rejected locally with the list of valid stage ids, and
nothing is written. `updateHubSpotDeal` applies the same check when `dealstage` changes (against
the deal's current pipeline, or the `pipeline` passed with it).

**Property names.** The brief lists `hs_pipeline` and `hs_stage`; those are the pipeline and stage
properties of **tickets**. The official Deals API uses `properties.pipeline` and
`properties.dealstage`, which is what this project sends (`buildDealProperties`, unit-tested).
`amount` is validated as a non-negative number and sent as a string, the way HubSpot stores it.

**Associations.** `associateContactToDeal(contactId, dealId)` reads the contact's existing deal
associations first (`GET .../contact/{id}/associations/deal`); if the deal is already there it
returns `alreadyAssociated: true` and writes nothing. Otherwise it calls the *default association*
endpoint (`PUT .../associations/default/...`), which applies the HubSpot-defined unlabeled type and
is itself idempotent, so even a concurrent repeat cannot create a duplicate link. The type id is
not hard-coded: it is read from `GET /crm/associations/2026-09/contact/deal/labels` (verified live:
contact → deal is `4`, and the reverse direction deal → contact is `3`, both `HUBSPOT_DEFINED`).
HubSpot creates both directions; the example reads `deal → contact` back to prove it.

**Delete = archive.** As with contacts, `DELETE` moves the deal to the recycle bin; the delete
example refuses deals not created by this project (name prefix `Triario Test - ` or a sync
`external_id`) unless `--force` is given.

### Unit tests (no network)

```bash
npm test
```

Covers the fundamentals, configuration, payload validation, pagination, error normalization,
backoff and retry policy, and token redaction. HubSpot calls themselves are never mocked; they are
exercised by the example scripts against the real portal.

## Project structure

```
src/
  config/         env loading and validation, API paths, required scopes
  clients/        hubSpotClient: axios instance, bearer auth, timeout, retries
  repositories/   one module per HubSpot resource, raw endpoint calls, no business rules
  services/       hubSpotService (business operations) and, later, syncService
  utils/          handleHubSpotErrors, validateHubSpotPayload, pagination, logger, streams
  fundamentals/   Section 1 exercises (callbacks, async/await, CommonJS)
  data/           local JSON sources for the sync functions
  examples/       hubSpotApiHandler (shared runner) and one executable script per operation
test/             node:test suites for the pure logic
docs/design.md    requirements matrix, decisions, endpoints, ambiguities
```

Why: dependencies point one way (examples → services → repositories → client → HubSpot), so each
layer can be read, tested and replaced on its own. Utilities are pure and unit-tested without
network; the fundamentals run without credentials. The rationale in full is in
[docs/design.md](docs/design.md#3-project-structure).

## Error handling

All HubSpot calls go through `hubSpotClient`, which wraps them with `withRetry` and converts any
failure into a `HubSpotError` (`src/utils/handleHubSpotErrors.js`):

| Situation | Code | Retried | Notes |
|-----------|------|---------|-------|
| DNS / connection failure | `NETWORK_ERROR` | yes | exponential backoff |
| Timeout (`HUBSPOT_TIMEOUT_MS`) | `TIMEOUT` | yes | exponential backoff |
| 401 | `AUTHENTICATION_ERROR` | no | message points to the token |
| 403 | `AUTHORIZATION_ERROR` | no | message points to scopes; HubSpot category kept |
| 400 | `VALIDATION_ERROR` | no | HubSpot `category`, `errors[]`, `correlationId` kept |
| 404 / 409 / other 4xx | `NOT_FOUND` / `CONFLICT` / `CLIENT_ERROR` | no | |
| 429 | `RATE_LIMIT` | yes | waits `Retry-After` when present, else `base × 2^attempt` + jitter |
| 5xx | `SERVER_ERROR` | yes | backoff with a 2 s minimum, as the HubSpot docs recommend |

Retries stop after `HUBSPOT_MAX_RETRIES` and use `base × 2^(attempt−1)` plus up to 20 % random
jitter, capped at 30 s. A `Retry-After` header, when HubSpot sends one, replaces the formula.
Normalized errors expose `code`, `status`, `message`, `category`, `correlationId`, `details`,
`retryable`, `attempts` and `outcomeUncertain`. Payloads are validated locally before any request
(`validateHubSpotPayload`, with a `partial` mode for updates), so obvious mistakes never reach
the API.

**One retry layer.** Only `hubSpotClient.request` retries. Repositories and services never wrap
calls in their own retry loops, and `withRetry` refuses to retry an error that already carries
`attempts` from an inner layer, so a request can never be multiplied by nested retries.

**Uncertain POST outcomes: no blind re-creation.** `POST` requests that create data are not
idempotent. If such a request fails with a timeout, a connection reset or a 5xx, HubSpot may have
processed it anyway. The client therefore does not retry those failures for `POST`; it throws
the error with `outcomeUncertain: true` and a message telling the caller to look the record up
(by e-mail for contacts, by `external_id` for deals) before creating it again. A `POST` is still
retried when the request certainly never reached HubSpot: a `429` (rejected by the rate
limiter), a refused connection or a DNS failure. Read-only `POST`s such as search or the token
lookup are marked `idempotent: true` by their repository and follow the normal policy.
`GET`, `PUT`, `PATCH` and `DELETE` are treated as idempotent.

**Errors are propagated, never swallowed.** Every service function re-throws the normalized
error through `handleHubSpotErrors`, which logs it exactly once (a `logged` flag prevents a
second layer from logging it again). Example scripts print a summary and exit with code 1.
Configuration and validation errors keep their own types (`ConfigError`,
`PayloadValidationError`) and are never retried.

**What is never logged.** The original axios error (request config, `Authorization` header,
request body) is not attached to normalized errors. The logger redacts credential-looking keys
and `Bearer`/`pat-` values, and masks e-mail addresses (`j***@example.com`) wherever they appear,
including in request paths such as `/contacts/{email}?idProperty=email`. Validation messages do
not echo e-mail values. Log context carries record ids, not personal data.

Rate limits are not provoked on purpose. The retry policy is covered by unit tests, and the
client logs a warning when `X-HubSpot-RateLimit-Remaining` drops below 10.

To see the handling of real HubSpot answers (read-only, nothing is created):

```bash
npm run example:errors        # local validation, real 404 by id, real 404 by e-mail, real 400
```

## Official documentation used

| Topic | URL |
|-------|-----|
| Private apps | https://developers.hubspot.com/docs/guides/apps/private-apps/overview |
| Scopes | https://developers.hubspot.com/docs/guides/apps/authentication/scopes |
| Contacts | https://developers.hubspot.com/docs/reference/api/crm/objects/contacts |
| Deals | https://developers.hubspot.com/docs/reference/api/crm/objects/deals |
| Associations | https://developers.hubspot.com/docs/reference/api/crm/associations/association-details |
| Pipelines | https://developers.hubspot.com/docs/api/crm/pipelines |
| Properties | https://developers.hubspot.com/docs/api/crm/properties |
| Search | https://developers.hubspot.com/docs/api/crm/search |
| Rate limits | https://developers.hubspot.com/docs/api/usage-details |
| Error handling | https://developers.hubspot.com/docs/reference/api/other-resources/error-handling |

The endpoints used by each function are listed per stage in [docs/design.md](docs/design.md#6-official-documentation-used-verified-2026-09-17).

## Technical decisions (summary)

- **axios instead of `@hubspot/api-client`**: the brief evaluates building the calls from the
  official documentation and handling errors explicitly. A thin client keeps every path, payload
  and retry visible and explainable.
- **Deal pipeline and stage property names**: the brief mentions `hs_pipeline` / `hs_stage`; the
  official Deals API uses `properties.pipeline` and `properties.dealstage`. The project sends the
  official names, fed from `HUBSPOT_PIPELINE_ID` / `HUBSPOT_STAGE_ID`.
- **No invented ids**: pipeline and stage ids have no defaults. The diagnostic reads the real ones
  from your portal.
- **Idempotent sync keys**: contacts by normalized email (`trim` + lower case), deals by a custom
  unique `external_id` property created through the Properties API. Deal names are never used as
  keys. Details in [docs/design.md](docs/design.md#11-sync-identity-rules-approved-in-stage-1-review).
- **Executable scripts, not Express**: the brief allows either; scripts keep the submission
  focused on the integration.
- **Submission deadline**: the brief states both "one hour before the second interview" and
  "3 calendar days after receiving the test"; the earlier one is the target and is confirmed with
  the evaluator.

## Portal

Hub ID / portal URL: filled in at submission time (`https://app.hubspot.com/contacts/<hubId>`).
