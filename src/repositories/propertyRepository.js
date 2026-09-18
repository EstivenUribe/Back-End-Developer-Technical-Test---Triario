'use strict';

/**
 * propertyRepository — Properties API.
 *
 * Official endpoints:
 *   GET  /crm/v3/properties/{objectType}                 -> { results: [property] }
 *   GET  /crm/v3/properties/{objectType}/{propertyName}  -> property (404 when it does not exist)
 *   POST /crm/v3/properties/{objectType}                 -> property (used by the deal sync, stage 5)
 * property: { name, label, type, fieldType, groupName, hasUniqueValue, hubspotDefined, options[] }
 * Scopes: crm.schemas.{objectType}.read for GET, crm.schemas.{objectType}.write for POST.
 */

const { getHubSpotClient } = require('../clients/hubSpotClient');
const { API_PATHS } = require('../config');
const { ERROR_CODES } = require('../utils/handleHubSpotErrors');

function listProperties(objectType, { client = getHubSpotClient() } = {}) {
  return client.get(`${API_PATHS.properties}/${objectType}`);
}

function getProperty(objectType, propertyName, { client = getHubSpotClient() } = {}) {
  return client.get(`${API_PATHS.properties}/${objectType}/${encodeURIComponent(propertyName)}`);
}

/**
 * Returns the property definition or null when HubSpot answers 404.
 * Any other error is propagated.
 */
async function findProperty(objectType, propertyName, deps) {
  try {
    return await getProperty(objectType, propertyName, deps);
  } catch (error) {
    if (error && error.code === ERROR_CODES.NOT_FOUND) return null;
    throw error;
  }
}

function createProperty(objectType, definition, { client = getHubSpotClient() } = {}) {
  return client.post(`${API_PATHS.properties}/${objectType}`, definition);
}

module.exports = { listProperties, getProperty, findProperty, createProperty };
