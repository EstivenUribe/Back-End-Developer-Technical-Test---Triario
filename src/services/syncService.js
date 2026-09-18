'use strict';

/**
 * syncService — idempotent create/update of contacts and deals from a local source.
 *
 * Identity (docs/design.md section 11):
 * - Contacts: normalized e-mail (trim + lower case). HubSpot deduplicates contacts by
 *   e-mail and lets us read one directly (GET /contacts/{email}?idProperty=email), so the
 *   lookup is exact and has no indexing lag. Records without a valid e-mail cannot be
 *   matched on a re-run and are reported as failed, never created. Duplicated e-mails in
 *   the source: the first record wins, later ones are reported as skipped.
 * - Deals: `external_id`, a custom unique deal property created once through the
 *   Properties API (POST /crm/v3/properties/deals, hasUniqueValue: true, requires
 *   crm.schemas.deals.write) and read with GET /deals/{value}?idProperty=external_id.
 *   The deal name is never used as a key. `external_id` is sent on create only, so an
 *   update can never change it.
 * - No local mapping file is kept: the identity lives in HubSpot itself, so losing the
 *   local checkout (or running from another machine) changes nothing.
 *
 * Decision per record: lookup by key → 404 ⇒ create; found ⇒ compare the desired
 * properties with the remote ones ⇒ PATCH only what changed, or "unchanged".
 * Records are processed sequentially (at most 2 requests per contact, 4 per deal)
 * so a Free/Starter portal (100 requests / 10 s) is never flooded; 429s, if any, are
 * handled by the client's Retry-After policy.
 */

const contactRepository = require('../repositories/contactRepository');
const dealRepository = require('../repositories/dealRepository');
const propertyRepository = require('../repositories/propertyRepository');
const hubSpotService = require('./hubSpotService');
const { handleHubSpotErrors, ERROR_CODES } = require('../utils/handleHubSpotErrors');
const { validateHubSpotPayload, normalizeEmail, PayloadValidationError } = require('../utils/validateHubSpotPayload');
const { toContactSummary } = require('../utils/contactHelpers');
const {
  assertRecordArray,
  partitionByKey,
  computeChangedProperties,
  createSummary,
  applyDealResult,
  isAbortError,
} = require('../utils/syncHelpers');
const logger = require('../utils/logger');

const DEAL_EXTERNAL_ID_PROPERTY = Object.freeze({
  name: 'external_id',
  label: 'External ID',
  description: 'Stable identifier of the record in the source system (used by syncDealsWithHubSpot).',
  groupName: 'dealinformation',
  type: 'string',
  fieldType: 'text',
  hasUniqueValue: true,
  formField: false,
});

function isNotFound(error) {
  return Boolean(error && error.code === ERROR_CODES.NOT_FOUND);
}

function failureOf(error) {
  return { reason: error.code || error.name || 'ERROR', message: error.message };
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/** Validates one source contact; returns { key, properties } or { reason, message }. */
function prepareContact(record) {
  const email = normalizeEmail(record.email);
  if (!email) return { reason: 'MISSING_EMAIL', message: 'record has no email; it cannot be matched on a re-run' };
  try {
    const properties = validateHubSpotPayload('contacts', record);
    return { key: properties.email, properties };
  } catch (error) {
    if (error instanceof PayloadValidationError) {
      const invalidEmail = error.errors.some((e) => e.field === 'email');
      return { reason: invalidEmail ? 'INVALID_EMAIL' : 'INVALID_RECORD', message: error.message };
    }
    throw error;
  }
}

/**
 * Syncs contacts into HubSpot. Idempotent: running the same source twice creates nothing.
 *
 * @param {object[]} contacts  records with HubSpot contact property names (email required)
 * @returns {Promise<object>} summary { source, total, created[], updated[], unchanged[], skipped[], failed[], aborted }
 */
async function syncContactsWithHubSpot(contacts) {
  const records = assertRecordArray(contacts, 'contacts source');
  const summary = createSummary('contacts', records.length);

  const prepared = new Map();
  const { unique, duplicates, invalid } = partitionByKey(records, (record, index) => {
    const result = prepareContact(record);
    if (result.key) prepared.set(index, result.properties);
    return result;
  });
  for (const item of invalid) summary.failed.push({ index: item.index, key: null, reason: item.reason, message: item.message });
  for (const item of duplicates) summary.skipped.push({ index: item.index, key: item.key, reason: 'DUPLICATE_IN_SOURCE', duplicateOf: item.duplicateOf });

  for (const { index, key } of unique) {
    const properties = prepared.get(index);
    try {
      const outcome = await upsertContact(key, properties);
      summary[outcome.status].push({ index, key, id: outcome.id, ...(outcome.changedProperties ? { changedProperties: outcome.changedProperties } : {}) });
    } catch (error) {
      summary.failed.push({ index, key, ...failureOf(error) });
      if (isAbortError(error)) {
        summary.aborted = error.code;
        logger.warn(`syncContactsWithHubSpot aborted after record ${index}: ${error.code}`);
        break;
      }
    }
  }
  return summary;
}

/** Lookup by e-mail → create / update / unchanged. Handles the create race (409). */
async function upsertContact(email, properties) {
  const wanted = Object.keys(properties);
  let remote = null;
  try {
    remote = await contactRepository.getByEmail(email, { properties: wanted });
  } catch (error) {
    if (!isNotFound(error)) throw handleHubSpotErrors(error, { operation: 'syncContacts.lookup' });
  }

  if (!remote) {
    try {
      const created = toContactSummary(await contactRepository.create(properties));
      return { status: 'created', id: created.id };
    } catch (error) {
      if (error.code !== ERROR_CODES.CONFLICT) throw handleHubSpotErrors(error, { operation: 'syncContacts.create' });
      // Created concurrently (or lookup lag): re-read and fall through to the update path.
      logger.warn('syncContacts: create answered 409, re-reading the contact by e-mail');
      try {
        remote = await contactRepository.getByEmail(email, { properties: wanted });
      } catch (readError) {
        throw handleHubSpotErrors(readError, { operation: 'syncContacts.lookupAfterConflict' });
      }
    }
  }

  const changed = computeChangedProperties(properties, remote.properties);
  if (Object.keys(changed).length === 0) return { status: 'unchanged', id: remote.id };
  try {
    await contactRepository.update(remote.id, changed);
    return { status: 'updated', id: remote.id, changedProperties: Object.keys(changed) };
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'syncContacts.update', contactId: remote.id });
  }
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

let externalIdPropertyChecked = false;

/**
 * Makes sure the unique `external_id` deal property exists. Never assumes it does:
 * GET /crm/v3/properties/deals/external_id → 404 ⇒ POST /crm/v3/properties/deals.
 * Aborts when the property exists but does not enforce unique values, because the
 * sync could then create duplicates.
 *
 * @returns {Promise<{name:string, created:boolean, hasUniqueValue:boolean}>}
 */
async function ensureDealExternalIdProperty({ refresh = false } = {}) {
  if (externalIdPropertyChecked && !refresh) return { name: DEAL_EXTERNAL_ID_PROPERTY.name, created: false, hasUniqueValue: true };
  const name = DEAL_EXTERNAL_ID_PROPERTY.name;
  let property;
  try {
    property = await propertyRepository.findProperty('deals', name);
    if (!property) {
      logger.info(`Creating unique deal property "${name}" (POST /crm/v3/properties/deals)`);
      property = await propertyRepository.createProperty('deals', DEAL_EXTERNAL_ID_PROPERTY);
      externalIdPropertyChecked = true;
      return { name, created: true, hasUniqueValue: Boolean(property.hasUniqueValue) };
    }
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'ensureDealExternalIdProperty' });
  }
  if (!property.hasUniqueValue) {
    throw new PayloadValidationError('deal external_id property', [
      { field: name, message: 'exists in the portal but does not enforce unique values; the deal sync cannot guarantee idempotency. Recreate it with hasUniqueValue: true.' },
    ]);
  }
  externalIdPropertyChecked = true;
  return { name, created: false, hasUniqueValue: true };
}

/** Validates one source deal; returns { key, properties, contactEmail } or { reason, message }. */
function prepareDeal(record, target) {
  const externalId = typeof record.externalId === 'string' ? record.externalId.trim() : typeof record.external_id === 'string' ? record.external_id.trim() : '';
  if (!externalId) return { reason: 'MISSING_EXTERNAL_ID', message: 'record has no externalId; it cannot be matched on a re-run' };
  const raw = { dealname: record.dealname, amount: record.amount, pipeline: target.pipeline.id, dealstage: target.stage.id, external_id: externalId };
  if (record.closedate !== undefined) raw.closedate = record.closedate;
  try {
    const properties = validateHubSpotPayload('deals', raw);
    const contactEmail = record.contactEmail !== undefined && record.contactEmail !== null ? normalizeEmail(record.contactEmail) : '';
    return { key: externalId, properties, contactEmail };
  } catch (error) {
    if (error instanceof PayloadValidationError) return { reason: 'INVALID_RECORD', message: error.message };
    throw error;
  }
}

/**
 * Syncs deals into HubSpot, keyed by `external_id`. Idempotent: running the same source
 * twice creates nothing. Pipeline and stage are applied on create only (from
 * HUBSPOT_PIPELINE_ID / HUBSPOT_STAGE_ID or `options`); updates compare dealname,
 * amount and closedate (closedate by instant, not by text). `contactEmail`, when
 * present, is resolved to a contact and associated with the deal (idempotently).
 *
 * Association outcomes per deal entry (`entry.association.status`):
 * - `created` / `already`: association in place.
 * - `skipped` (CONTACT_NOT_FOUND): the contact does not exist in HubSpot. This is a
 *   source-data condition, not an integration failure: the deal keeps its own status
 *   (created/updated/unchanged) and the association is completed by a later run once
 *   the contact exists (sync contacts first).
 * - `failed`: the deal was saved but HubSpot rejected the association (or the contact
 *   lookup failed). The entry is reported under `partial` with its deal id and
 *   `dealStatus`, never as a failed deal and never twice. A later run re-attempts the
 *   association without touching the deal (lookup by external_id → unchanged → associate).
 * - 401/403 while associating abort the run like any other auth/scope error; the deal
 *   that was already saved is still reported (as partial).
 *
 * @param {object[]} deals  records { externalId, dealname, amount, contactEmail?, closedate? }
 * @param {object} [options]
 * @param {string} [options.pipelineId]
 * @param {string} [options.stageId]
 * @returns {Promise<object>} summary with created/updated/unchanged/partial/skipped/failed
 */
async function syncDealsWithHubSpot(deals, { pipelineId, stageId } = {}) {
  const records = assertRecordArray(deals, 'deals source');
  const summary = createSummary('deals', records.length);

  // Preconditions (abort the whole run when they fail: every record would fail the same way).
  summary.externalIdProperty = await ensureDealExternalIdProperty();
  const target = await hubSpotService.resolveDealStage({ pipelineId, stageId });
  summary.pipeline = target.pipeline;
  summary.stage = target.stage;

  const prepared = new Map();
  const { unique, duplicates, invalid } = partitionByKey(records, (record, index) => {
    const result = prepareDeal(record, target);
    if (result.key) prepared.set(index, result);
    return result;
  });
  for (const item of invalid) summary.failed.push({ index: item.index, key: null, reason: item.reason, message: item.message });
  for (const item of duplicates) summary.skipped.push({ index: item.index, key: item.key, reason: 'DUPLICATE_IN_SOURCE', duplicateOf: item.duplicateOf });

  for (const { index, key } of unique) {
    const { properties, contactEmail } = prepared.get(index);

    // 1. Save the deal. A failure here means the deal itself was not saved.
    let outcome;
    try {
      outcome = await upsertDeal(key, properties);
    } catch (error) {
      summary.failed.push({ index, key, ...failureOf(error) });
      if (isAbortError(error)) {
        summary.aborted = error.code;
        logger.warn(`syncDealsWithHubSpot aborted after record ${index}: ${error.code}`);
        break;
      }
      continue;
    }

    // 2. Associate. The deal is already saved: a failure here is a partial failure,
    //    reported with the deal id and never as "deal not created".
    let association;
    let abortCode = null;
    if (contactEmail) {
      try {
        association = await associateDealWithContact(outcome.id, contactEmail);
      } catch (error) {
        association = { contactEmail, status: 'failed', ...failureOf(error) };
        abortCode = error.code;
      }
    }
    applyDealResult(summary, { index, key, id: outcome.id, changedProperties: outcome.changedProperties, association }, outcome.status);

    if (abortCode) {
      summary.aborted = abortCode;
      logger.warn(`syncDealsWithHubSpot aborted after record ${index}: ${abortCode} (deal ${outcome.id} was saved; its association was not)`);
      break;
    }
  }
  return summary;
}

const DEAL_SYNC_PROPERTIES = ['dealname', 'amount', 'closedate', 'external_id', 'pipeline', 'dealstage'];
const DEAL_DATE_PROPERTIES = ['closedate'];

/** Lookup by external_id → create / update / unchanged. external_id is never sent on update. */
async function upsertDeal(externalId, properties) {
  let remote = null;
  try {
    remote = await dealRepository.getById(externalId, { idProperty: 'external_id', properties: DEAL_SYNC_PROPERTIES });
  } catch (error) {
    if (!isNotFound(error)) throw handleHubSpotErrors(error, { operation: 'syncDeals.lookup' });
  }

  if (!remote) {
    try {
      const created = await dealRepository.create(properties);
      return { status: 'created', id: created.id };
    } catch (error) {
      if (error.code !== ERROR_CODES.CONFLICT) throw handleHubSpotErrors(error, { operation: 'syncDeals.create' });
      logger.warn('syncDeals: create answered 409 (external_id already exists), re-reading the deal');
      try {
        remote = await dealRepository.getById(externalId, { idProperty: 'external_id', properties: DEAL_SYNC_PROPERTIES });
      } catch (readError) {
        throw handleHubSpotErrors(readError, { operation: 'syncDeals.lookupAfterConflict' });
      }
    }
  }

  // Compare only the source-owned properties; pipeline/stage/external_id are not touched on update.
  const { dealname, amount, closedate } = properties;
  const desired = { dealname, amount };
  if (closedate !== undefined) desired.closedate = closedate;
  const changed = computeChangedProperties(desired, remote.properties, { dateProperties: DEAL_DATE_PROPERTIES });
  if (Object.keys(changed).length === 0) return { status: 'unchanged', id: remote.id };
  try {
    await dealRepository.update(remote.id, changed);
    return { status: 'updated', id: remote.id, changedProperties: Object.keys(changed) };
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'syncDeals.update', dealId: remote.id });
  }
}

/**
 * Resolves the contact by e-mail and associates it (idempotent).
 * Returns { status: 'created' | 'already' | 'skipped' | 'failed', ... }.
 * Throws only for authentication / scope errors (401/403), so the caller aborts the run.
 */
async function associateDealWithContact(dealId, contactEmail) {
  let contact;
  try {
    contact = await contactRepository.getByEmail(contactEmail, { properties: ['email'] });
  } catch (error) {
    if (isNotFound(error)) return { contactEmail, status: 'skipped', reason: 'CONTACT_NOT_FOUND' };
    const handled = handleHubSpotErrors(error, { operation: 'syncDeals.lookupContact', dealId });
    if (isAbortError(handled)) throw handled;
    return { contactEmail, status: 'failed', ...failureOf(handled) };
  }
  try {
    const result = await hubSpotService.associateContactToDeal(contact.id, dealId);
    return { contactEmail, contactId: contact.id, status: result.alreadyAssociated ? 'already' : 'created' };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { contactEmail, contactId: contact.id, status: 'failed', ...failureOf(error) };
  }
}

module.exports = {
  syncContactsWithHubSpot,
  syncDealsWithHubSpot,
  ensureDealExternalIdProperty,
  DEAL_EXTERNAL_ID_PROPERTY,
};
