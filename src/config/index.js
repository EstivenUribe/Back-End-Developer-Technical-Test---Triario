'use strict';

/**
 * Central configuration.
 *
 * This is the only module that reads `process.env`. Everything else receives a
 * frozen config object, which keeps secrets handling auditable and lets the app
 * fail fast with a clear message when a required variable is missing.
 *
 * Two different URLs are involved and must not be confused:
 * - API base URL  (HUBSPOT_BASE_URL, default https://api.hubapi.com): where HTTP calls go.
 * - Portal URL    (https://app.hubspot.com/contacts/<hubId>): where a human sees the data.
 */

const path = require('path');
const dotenv = require('dotenv');

// Load `.env` from the project root (two levels up from src/config).
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const DEFAULTS = Object.freeze({
  baseUrl: 'https://api.hubapi.com',
  portalBaseUrl: 'https://app.hubspot.com',
  timeoutMs: 10000,
  maxRetries: 3,
  retryBaseDelayMs: 1000,
  maxRetryWaitMs: 120000, // longest single wait a script accepts from Retry-After before giving up
  logLevel: 'info',
});

/**
 * API paths, grouped so that a version change touches a single place.
 * Objects, pipelines and properties are documented under /crm/v3.
 * Associations and search are documented under a date-versioned prefix.
 * See docs/design.md section 6 for the official documentation URLs.
 */
const API_PATHS = Object.freeze({
  contacts: '/crm/v3/objects/contacts',
  deals: '/crm/v3/objects/deals',
  pipelines: '/crm/v3/pipelines',
  properties: '/crm/v3/properties',
  associations: '/crm/objects/2026-09',
  associationLabels: '/crm/associations/2026-09',
  search: (objectType) => `/crm/objects/2026-09/${objectType}/search`,
  accessTokenInfo: '/oauth/v2/private-apps/get/access-token-info',
});

/**
 * Scopes the Private App must have for every operation in this project.
 * Source: official scopes reference (see README / docs/design.md section 8).
 */
const REQUIRED_SCOPES = Object.freeze([
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.deals.read',
  'crm.objects.deals.write',
  'crm.schemas.contacts.read',
  'crm.schemas.deals.read',
  'crm.schemas.deals.write',
]);

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readInteger(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${name} must be a non-negative integer, received "${raw}"`);
  }
  return value;
}

function readString(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

/**
 * Builds the configuration object.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]  Environment source (defaults to process.env).
 * @param {boolean} [options.requireToken]   Throw when HUBSPOT_ACCESS_TOKEN is missing (default true).
 *                                           Fundamentals scripts and unit tests pass `false`.
 * @returns {Readonly<object>} frozen config
 */
function loadConfig({ env = process.env, requireToken = true } = {}) {
  const accessToken = readString(env, 'HUBSPOT_ACCESS_TOKEN', '');

  if (!accessToken && requireToken) {
    if (readString(env, 'HUBSPOT_API_KEY', '')) {
      throw new ConfigError(
        'HUBSPOT_API_KEY is set but HubSpot no longer supports API keys. ' +
          'Create a Private App and set HUBSPOT_ACCESS_TOKEN instead (see README).'
      );
    }
    throw new ConfigError(
      'HUBSPOT_ACCESS_TOKEN is missing. Copy .env.example to .env and set your Private App token.'
    );
  }

  const logLevel = readString(env, 'LOG_LEVEL', DEFAULTS.logLevel).toLowerCase();
  if (!['error', 'warn', 'info', 'debug'].includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of error|warn|info|debug, received "${logLevel}"`);
  }

  const portalId = readString(env, 'HUBSPOT_PORTAL_ID', '');
  if (portalId && !/^\d+$/.test(portalId)) {
    throw new ConfigError(`HUBSPOT_PORTAL_ID must be numeric (your Hub ID), received "${portalId}"`);
  }

  return Object.freeze({
    hubspot: Object.freeze({
      accessToken,
      baseUrl: readString(env, 'HUBSPOT_BASE_URL', DEFAULTS.baseUrl).replace(/\/+$/, ''),
      portalBaseUrl: DEFAULTS.portalBaseUrl,
      timeoutMs: readInteger(env, 'HUBSPOT_TIMEOUT_MS', DEFAULTS.timeoutMs),
      maxRetries: readInteger(env, 'HUBSPOT_MAX_RETRIES', DEFAULTS.maxRetries),
      retryBaseDelayMs: readInteger(env, 'HUBSPOT_RETRY_BASE_DELAY_MS', DEFAULTS.retryBaseDelayMs),
      maxRetryWaitMs: readInteger(env, 'HUBSPOT_MAX_RETRY_WAIT_MS', DEFAULTS.maxRetryWaitMs),
      portalId,
      // No defaults on purpose: real ids come from the portal (node src/examples/diagnose.js).
      pipelineId: readString(env, 'HUBSPOT_PIPELINE_ID', ''),
      stageId: readString(env, 'HUBSPOT_STAGE_ID', ''),
      paths: API_PATHS,
      requiredScopes: REQUIRED_SCOPES,
    }),
    logLevel,
  });
}

/**
 * Human-facing portal URL for a Hub ID (not an API URL).
 * @param {string|number} hubId
 * @param {string} [portalBaseUrl]
 */
function getPortalUrl(hubId, portalBaseUrl = DEFAULTS.portalBaseUrl) {
  return hubId ? `${portalBaseUrl}/contacts/${hubId}` : null;
}

module.exports = { loadConfig, getPortalUrl, ConfigError, API_PATHS, REQUIRED_SCOPES, DEFAULTS };
