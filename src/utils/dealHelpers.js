'use strict';

/**
 * Pure helpers for deals and associations (no HubSpot calls, unit-tested).
 */

/** Default properties returned by getHubSpotDeals. */
const DEFAULT_DEAL_PROPERTIES = Object.freeze([
  'dealname',
  'amount',
  'pipeline',
  'dealstage',
  'closedate',
  'createdate',
  'hs_lastmodifieddate',
]);

/** Object type names used in association paths (singular, as in the official examples). */
const OBJECT_TYPES = Object.freeze({ contact: 'contact', deal: 'deal' });

/** Flattens a raw HubSpot deal into the shape returned by the service. */
function toDealSummary(deal) {
  return {
    id: deal.id,
    properties: (deal && deal.properties) || {},
    createdAt: deal.createdAt || null,
    updatedAt: deal.updatedAt || null,
    archived: Boolean(deal.archived),
  };
}

/**
 * Finds a stage inside a pipeline definition (GET /crm/v3/pipelines/deals/{id}).
 * @returns {object|null} the stage { id, label, displayOrder } or null
 */
function findStage(pipeline, stageId) {
  const stages = (pipeline && Array.isArray(pipeline.stages) && pipeline.stages) || [];
  return stages.find((stage) => String(stage.id) === String(stageId)) || null;
}

/**
 * Builds the properties object for POST /crm/v3/objects/deals using the official
 * property names: dealname, amount, pipeline, dealstage.
 */
function buildDealProperties(dealName, amount, { pipelineId, stageId, properties = {} } = {}) {
  const payload = { ...properties, dealname: dealName, pipeline: pipelineId, dealstage: stageId };
  if (amount !== undefined && amount !== null) payload.amount = amount;
  return payload;
}

/**
 * Looks for an association to `toObjectId` inside a GET .../associations/{toObjectType} result list.
 * @returns {object|null} the result entry { toObjectId, associationTypes[] } or null
 */
function findAssociation(results, toObjectId) {
  const list = Array.isArray(results) ? results : [];
  return list.find((entry) => String(entry.toObjectId) === String(toObjectId)) || null;
}

/**
 * Picks the HubSpot-defined, unlabeled association type from a labels listing
 * (what the "default" association endpoint applies).
 * @returns {object|null} { category, typeId, label } or null
 */
function pickUnlabeledType(types) {
  const list = Array.isArray(types) ? types : [];
  return (
    list.find((type) => type.category === 'HUBSPOT_DEFINED' && (type.label === null || type.label === undefined || type.label === '')) ||
    null
  );
}

module.exports = {
  DEFAULT_DEAL_PROPERTIES,
  OBJECT_TYPES,
  toDealSummary,
  findStage,
  buildDealProperties,
  findAssociation,
  pickUnlabeledType,
};
