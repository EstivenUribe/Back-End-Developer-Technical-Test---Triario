'use strict';

/**
 * hubSpotService — orchestrates repositories to implement business operations.
 *
 * Stage 2 exposes the read-only operations used by the diagnostic script.
 * Contacts (stage 3), deals/associations (stage 4) are added here as the
 * functions named in the test brief (getHubSpotContactNames, createHubSpotDeal...).
 *
 * Every function follows the same shape: try the repository call(s), and on
 * failure `throw handleHubSpotErrors(error, { operation })`, which normalizes,
 * logs (redacted) and returns the HubSpotError to throw.
 */

const accountRepository = require('../repositories/accountRepository');
const contactRepository = require('../repositories/contactRepository');
const dealRepository = require('../repositories/dealRepository');
const associationRepository = require('../repositories/associationRepository');
const pipelineRepository = require('../repositories/pipelineRepository');
const propertyRepository = require('../repositories/propertyRepository');
const { handleHubSpotErrors, HubSpotError, ERROR_CODES } = require('../utils/handleHubSpotErrors');
const {
  validateHubSpotPayload,
  validateHubSpotId,
  validatePageSize,
  validateSearchFilters,
  PayloadValidationError,
} = require('../utils/validateHubSpotPayload');
const { paginateAll, collectPages, getNextCursor, MAX_PAGE_SIZE } = require('../utils/pagination');
const {
  CONTACT_NAME_PROPERTIES,
  DEFAULT_CONTACT_PROPERTIES,
  buildFullName,
  toContactSummary,
} = require('../utils/contactHelpers');
const {
  DEFAULT_DEAL_PROPERTIES,
  OBJECT_TYPES,
  toDealSummary,
  findStage,
  buildDealProperties,
  findAssociation,
  pickUnlabeledType,
} = require('../utils/dealHelpers');
const { REQUIRED_SCOPES, loadConfig } = require('../config');

const SEARCH_MAX_PAGE_SIZE = 200; // Search API limit (list endpoints: 100)

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

// Pipeline definitions and association types rarely change: cache them per process
// so creating many deals does not cost an extra request each time.
const pipelineCache = new Map();
const associationTypeCache = new Map();

/** Reads one deal pipeline definition (GET /crm/v3/pipelines/deals/{id}), cached. */
async function getDealPipeline(pipelineId, { refresh = false } = {}) {
  const key = String(pipelineId);
  if (!refresh && pipelineCache.has(key)) return pipelineCache.get(key);
  try {
    const pipeline = await pipelineRepository.getPipeline('deals', key);
    pipelineCache.set(key, pipeline);
    return pipeline;
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'getDealPipeline', pipelineId: key });
  }
}

/**
 * Resolves pipeline and stage (explicit options win over HUBSPOT_PIPELINE_ID /
 * HUBSPOT_STAGE_ID) and verifies against the portal that the stage belongs to
 * the pipeline. Nothing is written when the check fails.
 *
 * @param {object} [options]
 * @param {string} [options.pipelineId]
 * @param {string} [options.stageId]
 * @returns {Promise<{pipeline:{id:string,label:string}, stage:{id:string,label:string}}>}
 * @throws {PayloadValidationError} when ids are missing or the stage is not in the pipeline
 */
async function resolveDealStage({ pipelineId, stageId } = {}) {
  const config = loadConfig().hubspot;
  const resolvedPipelineId = pipelineId || config.pipelineId;
  const resolvedStageId = stageId || config.stageId;

  const errors = [];
  if (!resolvedPipelineId) errors.push({ field: 'pipeline', message: 'is required: set HUBSPOT_PIPELINE_ID or pass options.pipelineId' });
  if (!resolvedStageId) errors.push({ field: 'dealstage', message: 'is required: set HUBSPOT_STAGE_ID or pass options.stageId' });
  if (errors.length > 0) throw new PayloadValidationError('deal pipeline configuration', errors);

  const pipeline = await getDealPipeline(resolvedPipelineId);
  const stage = findStage(pipeline, resolvedStageId);
  if (!stage) {
    const valid = (pipeline.stages || []).map((s) => `${s.id} ("${s.label}")`).join(', ');
    throw new PayloadValidationError('deal pipeline configuration', [
      { field: 'dealstage', message: `stage "${resolvedStageId}" does not belong to pipeline "${pipeline.label}" (${pipeline.id}). Valid stages: ${valid}` },
    ]);
  }
  return { pipeline: { id: pipeline.id, label: pipeline.label }, stage: { id: stage.id, label: stage.label } };
}

/**
 * Lists deals. One page by default; `all: true` walks every page (100 per page)
 * following `paging.next.after`, up to `maxPages`.
 *
 * @param {object} [options]
 * @param {number} [options.limit]          page size (default 10, or 100 with `all`)
 * @param {string} [options.after]          cursor from a previous call
 * @param {string[]} [options.properties]   defaults to DEFAULT_DEAL_PROPERTIES
 * @param {boolean} [options.all=false]
 * @param {number} [options.maxPages=Infinity]
 * @param {(page:object, pageNumber:number)=>void} [options.onPage]
 * @returns {Promise<{deals:object[], nextAfter:string|null, pages:number}>}
 */
async function getHubSpotDeals({ limit, after, properties = DEFAULT_DEAL_PROPERTIES, all = false, maxPages = Infinity, onPage } = {}) {
  const pageSize = validatePageSize(limit, { max: MAX_PAGE_SIZE, label: 'limit', fallback: all ? MAX_PAGE_SIZE : 10 });
  try {
    if (all) {
      const { results, pages, nextAfter } = await collectPages(
        (params) => dealRepository.list({ ...params, properties }),
        { limit: pageSize, maxPages, onPage }
      );
      return { deals: results.map(toDealSummary), nextAfter, pages };
    }
    const page = await dealRepository.list({ limit: pageSize, after: after || undefined, properties });
    return { deals: (page.results || []).map(toDealSummary), nextAfter: getNextCursor(page), pages: 1 };
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'getHubSpotDeals' });
  }
}

/** Reads one deal by record id. */
async function getHubSpotDealById(dealId, { properties, archived } = {}) {
  const id = validateHubSpotId(dealId, 'dealId');
  try {
    return toDealSummary(await dealRepository.getById(id, { properties, archived }));
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'getHubSpotDealById', dealId: id });
  }
}

/**
 * Creates a deal (POST /crm/v3/objects/deals) with properties.dealname, properties.amount,
 * properties.pipeline and properties.dealstage — the official Deals API names (the brief
 * mentions hs_pipeline / hs_stage, which are ticket properties; see docs/design.md A1).
 * Pipeline and stage default to HUBSPOT_PIPELINE_ID / HUBSPOT_STAGE_ID and are verified
 * against the portal before anything is sent.
 *
 * @param {string} dealName
 * @param {number|string} amount
 * @param {object} [options]
 * @param {string} [options.pipelineId]       overrides HUBSPOT_PIPELINE_ID
 * @param {string} [options.stageId]          overrides HUBSPOT_STAGE_ID
 * @param {object} [options.properties]       extra deal properties (e.g. closedate, external_id)
 * @param {string|number} [options.contactId] associate the new deal with this contact
 * @returns {Promise<object>} deal summary + { pipeline, stage, association? }
 */
async function createHubSpotDeal(dealName, amount, { pipelineId, stageId, properties = {}, contactId } = {}) {
  if (amount === undefined || amount === null || amount === '') {
    throw new PayloadValidationError('deals payload', [{ field: 'amount', message: 'is required (createHubSpotDeal(dealName, amount))' }]);
  }
  const target = await resolveDealStage({ pipelineId, stageId });
  const payload = validateHubSpotPayload(
    'deals',
    buildDealProperties(dealName, amount, { pipelineId: target.pipeline.id, stageId: target.stage.id, properties })
  );

  let deal;
  try {
    deal = toDealSummary(await dealRepository.create(payload));
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'createHubSpotDeal' });
  }

  const result = { ...deal, pipeline: target.pipeline, stage: target.stage };
  if (contactId !== undefined && contactId !== null && contactId !== '') {
    try {
      result.association = await associateContactToDeal(contactId, deal.id);
    } catch (error) {
      error.createdDealId = deal.id; // the deal exists; tell the caller which one
      throw error;
    }
  }
  return result;
}

/**
 * Partially updates a deal (PATCH /crm/v3/objects/deals/{id}).
 * When `dealstage` is changed it is verified against the deal's pipeline (or the
 * `pipeline` passed together with it). Changing `pipeline` requires `dealstage` too.
 *
 * @param {string|number} dealId
 * @param {object} properties
 * @returns {Promise<object>} deal summary after the update
 */
async function updateHubSpotDeal(dealId, properties) {
  const id = validateHubSpotId(dealId, 'dealId');
  const payload = validateHubSpotPayload('deals', properties, { partial: true });

  if (payload.pipeline && !payload.dealstage) {
    throw new PayloadValidationError('deals payload', [{ field: 'dealstage', message: 'is required when changing the pipeline' }]);
  }

  try {
    if (payload.dealstage) {
      let pipelineId = payload.pipeline;
      if (!pipelineId) {
        const current = await dealRepository.getById(id, { properties: ['pipeline'] });
        pipelineId = current.properties && current.properties.pipeline;
      }
      await resolveDealStage({ pipelineId, stageId: payload.dealstage });
    }
    return toDealSummary(await dealRepository.update(id, payload));
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'updateHubSpotDeal', dealId: id });
  }
}

/**
 * Deletes a deal (DELETE /crm/v3/objects/deals/{id}): archives it into the recycle bin (204).
 * @returns {Promise<{id:string, archived:true}>}
 */
async function deleteHubSpotDeal(dealId) {
  const id = validateHubSpotId(dealId, 'dealId');
  try {
    await dealRepository.remove(id);
    return { id, archived: true };
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'deleteHubSpotDeal', dealId: id });
  }
}

// ---------------------------------------------------------------------------
// Associations
// ---------------------------------------------------------------------------

/** Association types from one object type to another (cached), e.g. contact -> deal. */
async function getAssociationTypes(fromObjectType, toObjectType) {
  const key = `${fromObjectType}->${toObjectType}`;
  if (associationTypeCache.has(key)) return associationTypeCache.get(key);
  try {
    const page = await associationRepository.listAssociationTypes(fromObjectType, toObjectType);
    const types = Array.isArray(page.results) ? page.results : [];
    associationTypeCache.set(key, types);
    return types;
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'getAssociationTypes', fromObjectType, toObjectType });
  }
}

/** Deals associated with a contact: GET .../contact/{id}/associations/deal */
async function getContactDealAssociations(contactId) {
  const id = validateHubSpotId(contactId, 'contactId');
  try {
    const page = await associationRepository.listAssociations(OBJECT_TYPES.contact, id, OBJECT_TYPES.deal);
    return (page.results || []).map((entry) => ({ dealId: String(entry.toObjectId), associationTypes: entry.associationTypes || [] }));
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'getContactDealAssociations', contactId: id });
  }
}

/** Contacts associated with a deal: GET .../deal/{id}/associations/contact (the reverse direction). */
async function getDealContactAssociations(dealId) {
  const id = validateHubSpotId(dealId, 'dealId');
  try {
    const page = await associationRepository.listAssociations(OBJECT_TYPES.deal, id, OBJECT_TYPES.contact);
    return (page.results || []).map((entry) => ({ contactId: String(entry.toObjectId), associationTypes: entry.associationTypes || [] }));
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'getDealContactAssociations', dealId: id });
  }
}

/**
 * Associates a contact with a deal (direction contact -> deal) using the default
 * association endpoint: PUT .../contact/{contactId}/associations/default/deal/{dealId}.
 *
 * Idempotency: existing associations are read first; when the deal is already
 * associated nothing is written and `alreadyAssociated: true` is returned. The PUT
 * itself is idempotent as well (HubSpot does not create a second link for the same
 * pair), so a concurrent repeat cannot produce duplicates either.
 *
 * The association type applied by HubSpot is resolved from the portal
 * (GET /crm/associations/.../contact/deal/labels, HubSpot-defined unlabeled type) and
 * reported back, instead of being hard-coded.
 *
 * @param {string|number} contactId
 * @param {string|number} dealId
 * @returns {Promise<{contactId:string, dealId:string, created:boolean, alreadyAssociated:boolean, associationTypes:object[]}>}
 */
async function associateContactToDeal(contactId, dealId) {
  const from = validateHubSpotId(contactId, 'contactId');
  const to = validateHubSpotId(dealId, 'dealId');
  try {
    const existing = await associationRepository.listAssociations(OBJECT_TYPES.contact, from, OBJECT_TYPES.deal);
    const found = findAssociation(existing.results, to);
    if (found) {
      return { contactId: from, dealId: to, created: false, alreadyAssociated: true, associationTypes: found.associationTypes || [] };
    }

    const types = await getAssociationTypes(OBJECT_TYPES.contact, OBJECT_TYPES.deal);
    const defaultType = pickUnlabeledType(types);
    const response = await associationRepository.createDefaultAssociation(OBJECT_TYPES.contact, from, OBJECT_TYPES.deal, to);
    return {
      contactId: from,
      dealId: to,
      created: true,
      alreadyAssociated: false,
      associationTypes: defaultType ? [defaultType] : [],
      response,
    };
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'associateContactToDeal', contactId: from, dealId: to });
  }
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/**
 * Returns the full names of all contacts, walking every page of
 * GET /crm/v3/objects/contacts (100 per page, cursor `paging.next.after`).
 *
 * Missing names: when only firstname or lastname exists, the other one is used
 * alone; when both are missing the contact is skipped, unless `includeUnnamed`
 * is true, in which case `unnamedPlaceholder` is pushed instead.
 *
 * @param {object} [options]
 * @param {number} [options.pageSize=100]           1..100 (smaller values make pagination visible)
 * @param {number} [options.maxPages=Infinity]      safety cap for very large portals
 * @param {boolean} [options.includeUnnamed=false]
 * @param {string} [options.unnamedPlaceholder='(no name)']
 * @param {(page:object, pageNumber:number)=>void} [options.onPage]  progress hook
 * @returns {Promise<string[]>}
 */
async function getHubSpotContactNames({
  pageSize = MAX_PAGE_SIZE,
  maxPages = Infinity,
  includeUnnamed = false,
  unnamedPlaceholder = '(no name)',
  onPage,
} = {}) {
  const limit = validatePageSize(pageSize, { max: MAX_PAGE_SIZE, label: 'pageSize' });
  try {
    const contacts = await paginateAll(
      (params) => contactRepository.list({ ...params, properties: CONTACT_NAME_PROPERTIES }),
      { limit, maxPages, onPage }
    );
    const names = [];
    for (const contact of contacts) {
      const fullName = buildFullName(contact.properties);
      if (fullName) names.push(fullName);
      else if (includeUnnamed) names.push(unnamedPlaceholder);
    }
    return names;
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'getHubSpotContactNames' });
  }
}

/**
 * Lists contact details, one page at a time.
 *
 * Without `filters` it uses the list endpoint (GET /crm/v3/objects/contacts, max 100 per
 * page, opaque cursor). With `filters` it uses the Search API (POST .../contacts/search,
 * max 200 per page, numeric cursor, at most 10,000 results per query, 5 requests/second,
 * recent writes may take a moment to be indexed). Filters are never sent to the list endpoint.
 *
 * @param {object} [options]
 * @param {number} [options.limit=10]
 * @param {string} [options.after]                 cursor returned as `nextAfter` by the previous call
 * @param {string[]} [options.properties]          defaults to DEFAULT_CONTACT_PROPERTIES
 * @param {Array<object>} [options.filters]        [{ propertyName, operator, value }] (one AND group)
 * @returns {Promise<{source:'list'|'search', contacts:object[], nextAfter:string|null, total?:number}>}
 */
async function getHubSpotContacts({ limit = 10, after, properties = DEFAULT_CONTACT_PROPERTIES, filters } = {}) {
  const useSearch = Array.isArray(filters) && filters.length > 0;
  const source = useSearch ? 'search' : 'list';
  const pageSize = validatePageSize(limit, { max: useSearch ? SEARCH_MAX_PAGE_SIZE : MAX_PAGE_SIZE, label: 'limit' });
  const normalizedFilters = useSearch ? validateSearchFilters(filters) : null;

  try {
    let page;
    if (useSearch) {
      const body = { filterGroups: [{ filters: normalizedFilters }], properties, limit: pageSize };
      if (after !== undefined && after !== null && after !== '') body.after = String(after);
      page = await contactRepository.search(body);
    } else {
      page = await contactRepository.list({ limit: pageSize, after: after || undefined, properties });
    }
    const result = {
      source,
      contacts: (page.results || []).map(toContactSummary),
      nextAfter: getNextCursor(page),
    };
    if (useSearch && typeof page.total === 'number') result.total = page.total;
    return result;
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'getHubSpotContacts', source });
  }
}

/**
 * Reads one contact by HubSpot record id.
 * @param {string|number} contactId
 * @param {object} [options]
 * @param {string[]} [options.properties]
 * @param {boolean} [options.archived]  true to read a contact that was deleted (recycle bin)
 * @returns {Promise<object>} contact summary { id, fullName, properties, createdAt, updatedAt, archived }
 */
async function getHubSpotContactById(contactId, { properties, archived } = {}) {
  const id = validateHubSpotId(contactId, 'contactId'); // local check, nothing sent when invalid
  try {
    return toContactSummary(await contactRepository.getById(id, { properties, archived }));
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'getHubSpotContactById', contactId: id });
  }
}

/**
 * Creates a contact (POST /crm/v3/objects/contacts). `email` is required and normalized.
 * HubSpot deduplicates contacts by e-mail: an existing address answers 409 CONFLICT.
 * @param {object} properties  e.g. { email, firstname, lastname, phone, company }
 * @returns {Promise<object>} contact summary
 */
async function createHubSpotContact(properties) {
  const payload = validateHubSpotPayload('contacts', properties);
  try {
    return toContactSummary(await contactRepository.create(payload));
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'createHubSpotContact' });
  }
}

/**
 * Partially updates a contact (PATCH /crm/v3/objects/contacts/{id}).
 * Only the properties passed are changed; at least one is required.
 * @param {string|number} contactId
 * @param {object} properties
 * @returns {Promise<object>} contact summary after the update
 */
async function updateHubSpotContact(contactId, properties) {
  const id = validateHubSpotId(contactId, 'contactId');
  const payload = validateHubSpotPayload('contacts', properties, { partial: true });
  try {
    return toContactSummary(await contactRepository.update(id, payload));
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'updateHubSpotContact', contactId: id });
  }
}

/**
 * Deletes a contact (DELETE /crm/v3/objects/contacts/{id}). Per the official
 * documentation this archives the record into the HubSpot recycle bin, from where
 * it can be restored; it is not a permanent purge. HubSpot answers 204.
 * @param {string|number} contactId
 * @returns {Promise<{id:string, archived:true}>}
 */
async function deleteHubSpotContact(contactId) {
  const id = validateHubSpotId(contactId, 'contactId');
  try {
    await contactRepository.remove(id);
    return { id, archived: true };
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'deleteHubSpotContact', contactId: id });
  }
}

// ---------------------------------------------------------------------------
// Account, pipelines, properties (diagnostics)
// ---------------------------------------------------------------------------

/**
 * Verifies the token and reports the account it belongs to and the scopes it carries.
 *
 * Observed behaviour (verified against the live API, 2026-09-18): the token-info
 * endpoint answers 400 when `tokenKey` is missing and 404 "Resource not found"
 * when the token is not recognized. That 404 is therefore reported as an
 * authentication error, which is what it means for the caller.
 *
 * @returns {Promise<{hubId:number, appId:number, userId:number, scopes:string[], missingScopes:string[]}>}
 */
async function checkAuthentication() {
  try {
    const info = await accountRepository.getAccessTokenInfo();
    const scopes = Array.isArray(info.scopes) ? info.scopes : [];
    const missingScopes = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
    return { hubId: info.hubId, appId: info.appId, userId: info.userId, scopes, missingScopes };
  } catch (error) {
    if (error instanceof HubSpotError && error.code === ERROR_CODES.NOT_FOUND) {
      throw handleHubSpotErrors(
        new HubSpotError({
          code: ERROR_CODES.AUTHENTICATION_ERROR,
          status: error.status,
          message:
            'HubSpot does not recognize this access token (token lookup returned 404). ' +
            'Check HUBSPOT_ACCESS_TOKEN: copy it again from the Private App > Auth tab.',
          method: error.method,
          url: error.url,
        }),
        { operation: 'checkAuthentication' }
      );
    }
    throw handleHubSpotErrors(error, { operation: 'checkAuthentication' });
  }
}

/**
 * Lists deal pipelines with their stages sorted by displayOrder.
 * @returns {Promise<Array<{id:string, label:string, displayOrder:number, stages:Array<{id:string,label:string,displayOrder:number}>}>>}
 */
async function getDealPipelines() {
  try {
    const page = await pipelineRepository.listPipelines('deals');
    const pipelines = Array.isArray(page.results) ? page.results : [];
    return pipelines
      .map((pipeline) => ({
        id: pipeline.id,
        label: pipeline.label,
        displayOrder: pipeline.displayOrder,
        stages: (pipeline.stages || [])
          .map((stage) => ({ id: stage.id, label: stage.label, displayOrder: stage.displayOrder }))
          .sort((a, b) => a.displayOrder - b.displayOrder),
      }))
      .sort((a, b) => a.displayOrder - b.displayOrder);
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: 'getDealPipelines' });
  }
}

/**
 * Lists property definitions of an object type (contacts, deals).
 * @param {'contacts'|'deals'} objectType
 * @returns {Promise<Array<{name:string,label:string,type:string,fieldType:string,hasUniqueValue:boolean,hubspotDefined:boolean}>>}
 */
async function getObjectProperties(objectType) {
  try {
    const page = await propertyRepository.listProperties(objectType);
    const properties = Array.isArray(page.results) ? page.results : [];
    return properties.map((property) => ({
      name: property.name,
      label: property.label,
      type: property.type,
      fieldType: property.fieldType,
      groupName: property.groupName,
      hasUniqueValue: Boolean(property.hasUniqueValue),
      hubspotDefined: Boolean(property.hubspotDefined),
    }));
  } catch (error) {
    throw handleHubSpotErrors(error, { operation: `getObjectProperties(${objectType})` });
  }
}

module.exports = {
  // contacts
  getHubSpotContactNames,
  getHubSpotContacts,
  getHubSpotContactById,
  createHubSpotContact,
  updateHubSpotContact,
  deleteHubSpotContact,
  // deals
  getHubSpotDeals,
  getHubSpotDealById,
  createHubSpotDeal,
  updateHubSpotDeal,
  deleteHubSpotDeal,
  getDealPipeline,
  resolveDealStage,
  // associations
  associateContactToDeal,
  getContactDealAssociations,
  getDealContactAssociations,
  getAssociationTypes,
  // diagnostics
  checkAuthentication,
  getDealPipelines,
  getObjectProperties,
  SEARCH_MAX_PAGE_SIZE,
};
