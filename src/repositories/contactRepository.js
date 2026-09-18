'use strict';

/**
 * contactRepository — Contacts API (raw endpoint calls, no business rules).
 *
 * Official endpoints (Contacts reference and Search guide, see docs/design.md section 6):
 *   GET    /crm/v3/objects/contacts?limit=&after=&properties=      -> { results[], paging? }   (max 100/page)
 *   GET    /crm/v3/objects/contacts/{contactId}?properties=         -> contact
 *   GET    /crm/v3/objects/contacts/{email}?idProperty=email        -> contact (404 when absent)
 *   POST   /crm/v3/objects/contacts            { properties }        -> contact (201)
 *   PATCH  /crm/v3/objects/contacts/{contactId} { properties }       -> contact
 *   DELETE /crm/v3/objects/contacts/{contactId}                     -> 204 (archives to the recycle bin)
 *   POST   {search path}/contacts/search  { filterGroups, properties, limit, after }
 *                                                                   -> { total, results[], paging? } (max 200/page)
 * A contact is { id, properties: { ... }, createdAt, updatedAt, archived }.
 *
 * List vs search: the list endpoint has no filters and returns records in id order with
 * an opaque cursor; the search endpoint filters by property values but is limited to
 * 10,000 results per query, 5 requests per second, and newly written records may take a
 * moment to be indexed. The search POST is read-only, hence `idempotent: true`.
 */

const { getHubSpotClient } = require('../clients/hubSpotClient');
const { API_PATHS } = require('../config');

function propertiesParam(properties) {
  return Array.isArray(properties) && properties.length > 0 ? properties.join(',') : undefined;
}

function contactPath(contactId) {
  return `${API_PATHS.contacts}/${encodeURIComponent(contactId)}`;
}

/**
 * One page of contacts (no filtering available on this endpoint).
 * @param {object} [options]
 * @param {number} [options.limit]         1..100
 * @param {string} [options.after]         cursor from paging.next.after
 * @param {string[]} [options.properties]  property names to return
 */
function list({ limit, after, properties } = {}, { client = getHubSpotClient() } = {}) {
  return client.get(API_PATHS.contacts, { limit, after, properties: propertiesParam(properties) });
}

function getById(contactId, { properties, archived } = {}, { client = getHubSpotClient() } = {}) {
  return client.get(contactPath(contactId), { properties: propertiesParam(properties), archived: archived ? 'true' : undefined });
}

function getByEmail(email, { properties } = {}, { client = getHubSpotClient() } = {}) {
  return client.get(contactPath(email), { idProperty: 'email', properties: propertiesParam(properties) });
}

/** POST — creates a contact. Not idempotent: the client does not retry uncertain failures. */
function create(properties, { client = getHubSpotClient() } = {}) {
  return client.post(API_PATHS.contacts, { properties });
}

/** PATCH — partial update; only the properties sent are changed. */
function update(contactId, properties, { client = getHubSpotClient() } = {}) {
  return client.patch(contactPath(contactId), { properties });
}

/** DELETE — archives the contact (recycle bin); HubSpot answers 204. */
function remove(contactId, { client = getHubSpotClient() } = {}) {
  return client.delete(contactPath(contactId));
}

/**
 * Search API. `body` follows the documented shape:
 * { filterGroups: [{ filters: [{ propertyName, operator, value }] }], properties, limit, after }
 */
function search(body, { client = getHubSpotClient() } = {}) {
  return client.post(API_PATHS.search('contacts'), body, undefined, { idempotent: true });
}

module.exports = { list, getById, getByEmail, create, update, remove, search };
