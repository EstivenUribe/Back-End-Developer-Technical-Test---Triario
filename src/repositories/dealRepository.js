'use strict';

/**
 * dealRepository — Deals API (raw endpoint calls, no business rules).
 *
 * Official endpoints (Deals reference and Search guide, see docs/design.md section 6):
 *   GET    /crm/v3/objects/deals?limit=&after=&properties=          -> { results[], paging? }   (max 100/page)
 *   GET    /crm/v3/objects/deals/{dealId}?properties=&archived=      -> deal
 *   GET    /crm/v3/objects/deals/{value}?idProperty={uniqueProperty} -> deal (custom unique property lookup)
 *   POST   /crm/v3/objects/deals            { properties }            -> deal (201)
 *   PATCH  /crm/v3/objects/deals/{dealId}   { properties }            -> deal
 *   DELETE /crm/v3/objects/deals/{dealId}                            -> 204 (archives to the recycle bin)
 *   POST   {search path}/deals/search       { filterGroups, properties, limit, after }
 *                                                                    -> { total, results[], paging? }
 * A deal is { id, properties: { dealname, amount, pipeline, dealstage, ... }, createdAt, updatedAt, archived }.
 * Property names follow the official Deals API: `pipeline` and `dealstage`
 * (the brief's `hs_pipeline` / `hs_stage` are ticket property names, see docs/design.md A1).
 */

const { getHubSpotClient } = require('../clients/hubSpotClient');
const { API_PATHS } = require('../config');

function propertiesParam(properties) {
  return Array.isArray(properties) && properties.length > 0 ? properties.join(',') : undefined;
}

function dealPath(dealId) {
  return `${API_PATHS.deals}/${encodeURIComponent(dealId)}`;
}

function list({ limit, after, properties } = {}, { client = getHubSpotClient() } = {}) {
  return client.get(API_PATHS.deals, { limit, after, properties: propertiesParam(properties) });
}

/**
 * @param {string} dealId  HubSpot record id, or the value of `idProperty` when given
 * @param {object} [options]
 * @param {string[]} [options.properties]
 * @param {boolean} [options.archived]
 * @param {string} [options.idProperty]  name of a unique custom property (e.g. external_id)
 */
function getById(dealId, { properties, archived, idProperty } = {}, { client = getHubSpotClient() } = {}) {
  return client.get(dealPath(dealId), {
    properties: propertiesParam(properties),
    archived: archived ? 'true' : undefined,
    idProperty,
  });
}

/** POST — creates a deal. Not idempotent: the client does not retry uncertain failures. */
function create(properties, { client = getHubSpotClient() } = {}) {
  return client.post(API_PATHS.deals, { properties });
}

/** PATCH — partial update; only the properties sent are changed. */
function update(dealId, properties, { client = getHubSpotClient() } = {}) {
  return client.patch(dealPath(dealId), { properties });
}

/** DELETE — archives the deal (recycle bin); HubSpot answers 204. */
function remove(dealId, { client = getHubSpotClient() } = {}) {
  return client.delete(dealPath(dealId));
}

/** Search API (read-only POST, hence idempotent: true). */
function search(body, { client = getHubSpotClient() } = {}) {
  return client.post(API_PATHS.search('deals'), body, undefined, { idempotent: true });
}

module.exports = { list, getById, create, update, remove, search };
