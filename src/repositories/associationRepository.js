'use strict';

/**
 * associationRepository — Associations API (current, date-versioned paths).
 *
 * Official endpoints (Associations reference, see docs/design.md section 6):
 *   PUT    /crm/objects/2026-09/{fromObjectType}/{fromObjectId}/associations/default/{toObjectType}/{toObjectId}
 *          -> creates the unlabeled (default) association; no body
 *          -> { fromObjectTypeId, fromObjectId, toObjectTypeId, toObjectId, labels[] }
 *   PUT    /crm/objects/2026-09/{fromObjectType}/{fromObjectId}/associations/{toObjectType}/{toObjectId}
 *          body [{ associationCategory, associationTypeId }]  -> labeled association
 *   GET    /crm/objects/2026-09/{fromObjectType}/{fromObjectId}/associations/{toObjectType}
 *          -> { results: [{ toObjectId, associationTypes: [{ category, typeId, label }] }], paging? }
 *   DELETE /crm/objects/2026-09/{fromObjectType}/{fromObjectId}/associations/{toObjectType}/{toObjectId}
 *   GET    /crm/associations/2026-09/{fromObjectType}/{toObjectType}/labels
 *          -> { results: [{ category, typeId, label }] }   (HubSpot-defined contact→deal is typeId 4, deal→contact 3)
 *
 * Object types are the singular names used in the documentation examples ("contact", "deal").
 * PUT and GET are idempotent by method, so the client's normal retry policy applies.
 */

const { getHubSpotClient } = require('../clients/hubSpotClient');
const { API_PATHS } = require('../config');

function objectPath(fromObjectType, fromObjectId) {
  return `${API_PATHS.associations}/${fromObjectType}/${encodeURIComponent(fromObjectId)}/associations`;
}

function listAssociations(fromObjectType, fromObjectId, toObjectType, { limit, after } = {}, { client = getHubSpotClient() } = {}) {
  return client.get(`${objectPath(fromObjectType, fromObjectId)}/${toObjectType}`, { limit, after });
}

function createDefaultAssociation(fromObjectType, fromObjectId, toObjectType, toObjectId, { client = getHubSpotClient() } = {}) {
  return client.put(`${objectPath(fromObjectType, fromObjectId)}/default/${toObjectType}/${encodeURIComponent(toObjectId)}`);
}

function createLabeledAssociation(fromObjectType, fromObjectId, toObjectType, toObjectId, associationTypes, { client = getHubSpotClient() } = {}) {
  return client.put(`${objectPath(fromObjectType, fromObjectId)}/${toObjectType}/${encodeURIComponent(toObjectId)}`, associationTypes);
}

function removeAssociation(fromObjectType, fromObjectId, toObjectType, toObjectId, { client = getHubSpotClient() } = {}) {
  return client.delete(`${objectPath(fromObjectType, fromObjectId)}/${toObjectType}/${encodeURIComponent(toObjectId)}`);
}

/** Association types (labels) available from one object type to another. */
function listAssociationTypes(fromObjectType, toObjectType, { client = getHubSpotClient() } = {}) {
  return client.get(`${API_PATHS.associationLabels}/${fromObjectType}/${toObjectType}/labels`);
}

module.exports = {
  listAssociations,
  createDefaultAssociation,
  createLabeledAssociation,
  removeAssociation,
  listAssociationTypes,
};
