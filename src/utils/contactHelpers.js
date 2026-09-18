'use strict';

/**
 * Pure helpers for contact records (no HubSpot calls, unit-tested).
 */

/** Properties requested when only names are needed. */
const CONTACT_NAME_PROPERTIES = Object.freeze(['firstname', 'lastname']);

/** Default properties returned by getHubSpotContacts. */
const DEFAULT_CONTACT_PROPERTIES = Object.freeze([
  'email',
  'firstname',
  'lastname',
  'phone',
  'company',
  'createdate',
  'lastmodifieddate',
]);

function cleanName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

/**
 * Full name = firstname + " " + lastname, trimmed, with single spaces.
 * A missing part is skipped ("Ana" or "Torres"); when both are missing the
 * result is '' so callers can decide whether to skip or label the contact.
 *
 * @param {object} [properties]  HubSpot contact properties
 * @returns {string}
 */
function buildFullName(properties = {}) {
  return [cleanName(properties && properties.firstname), cleanName(properties && properties.lastname)]
    .filter(Boolean)
    .join(' ');
}

/**
 * Flattens a raw HubSpot contact into the shape returned by the service.
 * @param {object} contact  { id, properties, createdAt, updatedAt, archived }
 */
function toContactSummary(contact) {
  const properties = (contact && contact.properties) || {};
  return {
    id: contact.id,
    fullName: buildFullName(properties),
    properties,
    createdAt: contact.createdAt || null,
    updatedAt: contact.updatedAt || null,
    archived: Boolean(contact.archived),
  };
}

module.exports = { CONTACT_NAME_PROPERTIES, DEFAULT_CONTACT_PROPERTIES, buildFullName, toContactSummary };
