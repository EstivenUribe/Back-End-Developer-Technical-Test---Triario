'use strict';

/**
 * Payload validation and normalization before any HTTP call.
 *
 * - `validateHubSpotPayload(objectType, properties, { partial })` checks a create
 *   payload (required fields present) or a partial update (at least one field,
 *   required fields optional) and returns normalized properties.
 * - `validateHubSpotId(id, label)` checks a HubSpot record id before it is put in a URL.
 *
 * HubSpot returns every property value as a string, so normalized payloads use
 * strings as well (numbers are converted after being validated as numbers).
 * Unknown properties are allowed: portals have custom properties and HubSpot
 * itself reports unknown names with a 400 that handleHubSpotErrors surfaces.
 * Error messages never echo e-mail values (personal data may end up in logs).
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_PATTERN = /^\d+$/;

class PayloadValidationError extends Error {
  /**
   * @param {string} subject  what was validated, e.g. "contacts payload" or "contactId"
   * @param {Array<{field:string, message:string}>} errors
   */
  constructor(subject, errors) {
    const summary = errors.map((e) => `${e.field}: ${e.message}`).join('; ');
    super(`Invalid ${subject}. ${summary}`);
    this.name = 'PayloadValidationError';
    this.subject = subject;
    this.errors = errors;
  }
}

/** Lower-cases and trims an email. Returns '' for non-string input. */
function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

const SCHEMAS = Object.freeze({
  contacts: {
    required: ['email'],
    fields: {
      email: { type: 'email' },
      firstname: { type: 'string', maxLength: 255 },
      lastname: { type: 'string', maxLength: 255 },
      phone: { type: 'string', maxLength: 50 },
      company: { type: 'string', maxLength: 255 },
      website: { type: 'string', maxLength: 255 },
      jobtitle: { type: 'string', maxLength: 255 },
      lifecyclestage: { type: 'string' },
    },
  },
  deals: {
    required: ['dealname', 'pipeline', 'dealstage'],
    fields: {
      dealname: { type: 'string', minLength: 1, maxLength: 255 },
      amount: { type: 'number', min: 0 },
      pipeline: { type: 'string', minLength: 1 },
      dealstage: { type: 'string', minLength: 1 },
      closedate: { type: 'date' }, // datetime property: ISO 8601 or epoch ms; '' clears it
      external_id: { type: 'string', minLength: 1, maxLength: 255 },
    },
  },
});

function validateField(name, rule, value, errors) {
  if (value === null || value === undefined) return value;

  switch (rule.type) {
    case 'email': {
      const normalized = normalizeEmail(value);
      if (!EMAIL_PATTERN.test(normalized)) {
        errors.push({ field: name, message: 'must be a valid email address' });
      }
      return normalized;
    }
    case 'string': {
      if (typeof value !== 'string' && typeof value !== 'number') {
        errors.push({ field: name, message: 'must be a string' });
        return value;
      }
      const normalized = String(value).trim();
      if (rule.minLength !== undefined && normalized.length < rule.minLength) {
        errors.push({ field: name, message: `must have at least ${rule.minLength} character(s)` });
      }
      if (rule.maxLength !== undefined && normalized.length > rule.maxLength) {
        errors.push({ field: name, message: `must have at most ${rule.maxLength} characters` });
      }
      return normalized;
    }
    case 'number': {
      const numeric = typeof value === 'string' ? Number(value.trim()) : value;
      if (typeof numeric !== 'number' || !Number.isFinite(numeric) || value === '') {
        errors.push({ field: name, message: `must be a finite number (received "${value}")` });
        return value;
      }
      if (rule.min !== undefined && numeric < rule.min) {
        errors.push({ field: name, message: `must be >= ${rule.min}` });
      }
      return String(numeric);
    }
    case 'date': {
      // '' (or null, handled above) clears the property in HubSpot.
      if (typeof value === 'string' && value.trim() === '') return '';
      const ms = parseDateValue(value);
      if (ms === null || Number.isNaN(ms)) {
        errors.push({ field: name, message: 'must be an ISO 8601 date/datetime or epoch milliseconds' });
        return value;
      }
      return new Date(ms).toISOString(); // canonical form, e.g. 2026-12-31T00:00:00.000Z
    }
    default:
      return value;
  }
}

/**
 * Parses a date-like value into epoch milliseconds.
 * @returns {number|null|NaN} null for empty input, NaN for unparseable input
 */
function parseDateValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const text = String(value).trim();
  if (text === '') return null;
  return /^-?\d+$/.test(text) ? Number(text) : Date.parse(text);
}

/**
 * Validates and normalizes a `properties` object for a HubSpot object type.
 *
 * @param {'contacts'|'deals'} objectType
 * @param {object} properties          Raw properties.
 * @param {object} [options]
 * @param {boolean} [options.partial]  When true (updates), required fields may be absent.
 * @returns {object} normalized properties (trimmed strings, lower-cased email, numbers as strings)
 * @throws {PayloadValidationError}
 */
function validateHubSpotPayload(objectType, properties, { partial = false } = {}) {
  const schema = SCHEMAS[objectType];
  const subject = `${objectType} payload`;
  if (!schema) {
    throw new PayloadValidationError(subject, [{ field: 'objectType', message: `unsupported object type "${objectType}"` }]);
  }

  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new PayloadValidationError(subject, [{ field: 'properties', message: 'must be an object' }]);
  }

  const errors = [];
  const normalized = {};
  for (const [name, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object') {
      errors.push({ field: name, message: 'must be a primitive value (string, number, boolean or null)' });
      continue;
    }
    const rule = schema.fields[name];
    normalized[name] = rule ? validateField(name, rule, value, errors) : value;
  }

  if (!partial) {
    for (const required of schema.required) {
      const value = normalized[required];
      if (value === undefined || value === null || value === '') {
        errors.push({ field: required, message: 'is required' });
      }
    }
  } else if (Object.keys(normalized).length === 0) {
    errors.push({ field: 'properties', message: 'must contain at least one property to update' });
  }

  if (errors.length > 0) throw new PayloadValidationError(subject, errors);
  return normalized;
}

/**
 * Validates a HubSpot record id (numeric) before it is interpolated into a URL.
 * @param {string|number} id
 * @param {string} [label='id']
 * @returns {string} the id as a string
 * @throws {PayloadValidationError}
 */
function validateHubSpotId(id, label = 'id') {
  const value = typeof id === 'number' ? String(id) : typeof id === 'string' ? id.trim() : '';
  if (!ID_PATTERN.test(value)) {
    throw new PayloadValidationError(label, [{ field: label, message: 'must be a numeric HubSpot record id' }]);
  }
  return value;
}

/**
 * Validates a page size before it is sent. HubSpot list endpoints accept up to 100
 * records per page; the Search API accepts up to 200.
 * @param {number|string|undefined} limit
 * @param {object} options
 * @param {number} options.max
 * @param {string} [options.label='limit']
 * @param {number} [options.fallback]  used when limit is undefined
 * @returns {number|undefined}
 */
function validatePageSize(limit, { max, label = 'limit', fallback } = {}) {
  if (limit === undefined || limit === null || limit === '') return fallback;
  const value = typeof limit === 'string' ? Number(limit.trim()) : limit;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new PayloadValidationError(label, [{ field: label, message: `must be an integer between 1 and ${max}` }]);
  }
  return value;
}

/**
 * Operators documented for the CRM Search API filters.
 * Source: https://developers.hubspot.com/docs/api/crm/search
 */
const SEARCH_OPERATORS = Object.freeze([
  'EQ',
  'NEQ',
  'LT',
  'LTE',
  'GT',
  'GTE',
  'BETWEEN',
  'IN',
  'NOT_IN',
  'HAS_PROPERTY',
  'NOT_HAS_PROPERTY',
  'CONTAINS_TOKEN',
  'NOT_CONTAINS_TOKEN',
]);
const SEARCH_MAX_FILTERS_PER_GROUP = 6;

/**
 * Validates filters for one Search API filter group.
 * Each filter is { propertyName, operator, value } — or { values: [] } for IN / NOT_IN,
 * { value, highValue } for BETWEEN, and no value for HAS_PROPERTY / NOT_HAS_PROPERTY.
 * @param {Array<object>} filters
 * @returns {Array<object>} normalized filters
 */
function validateSearchFilters(filters) {
  const subject = 'search filters';
  if (!Array.isArray(filters) || filters.length === 0) {
    throw new PayloadValidationError(subject, [{ field: 'filters', message: 'must be a non-empty array' }]);
  }
  if (filters.length > SEARCH_MAX_FILTERS_PER_GROUP) {
    throw new PayloadValidationError(subject, [
      { field: 'filters', message: `at most ${SEARCH_MAX_FILTERS_PER_GROUP} filters per group are allowed` },
    ]);
  }

  const errors = [];
  const normalized = filters.map((filter, index) => {
    const field = `filters[${index}]`;
    if (!filter || typeof filter !== 'object') {
      errors.push({ field, message: 'must be an object' });
      return filter;
    }
    const propertyName = typeof filter.propertyName === 'string' ? filter.propertyName.trim() : '';
    const operator = typeof filter.operator === 'string' ? filter.operator.trim().toUpperCase() : '';
    if (!propertyName) errors.push({ field: `${field}.propertyName`, message: 'is required' });
    if (!SEARCH_OPERATORS.includes(operator)) {
      errors.push({ field: `${field}.operator`, message: `must be one of ${SEARCH_OPERATORS.join(', ')}` });
      return filter;
    }

    const output = { propertyName, operator };
    if (operator === 'HAS_PROPERTY' || operator === 'NOT_HAS_PROPERTY') return output;
    if (operator === 'IN' || operator === 'NOT_IN') {
      if (!Array.isArray(filter.values) || filter.values.length === 0) {
        errors.push({ field: `${field}.values`, message: `must be a non-empty array for ${operator}` });
      }
      output.values = filter.values;
      return output;
    }
    if (filter.value === undefined || filter.value === null || filter.value === '') {
      errors.push({ field: `${field}.value`, message: `is required for ${operator}` });
    }
    output.value = filter.value;
    if (operator === 'BETWEEN') {
      if (filter.highValue === undefined || filter.highValue === null || filter.highValue === '') {
        errors.push({ field: `${field}.highValue`, message: 'is required for BETWEEN' });
      }
      output.highValue = filter.highValue;
    }
    return output;
  });

  if (errors.length > 0) throw new PayloadValidationError(subject, errors);
  return normalized;
}

module.exports = {
  validateHubSpotPayload,
  validateHubSpotId,
  validatePageSize,
  validateSearchFilters,
  parseDateValue,
  PayloadValidationError,
  normalizeEmail,
  SCHEMAS,
  SEARCH_OPERATORS,
  SEARCH_MAX_FILTERS_PER_GROUP,
};
