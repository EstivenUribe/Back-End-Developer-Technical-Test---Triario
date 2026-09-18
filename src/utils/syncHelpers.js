'use strict';

/**
 * Pure helpers for the sync services (no HubSpot calls, unit-tested).
 */

const fs = require('fs/promises');
const path = require('path');
const { ERROR_CODES } = require('./handleHubSpotErrors');
const { parseDateValue } = require('./validateHubSpotPayload');

class SyncSourceError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'SyncSourceError';
    this.details = details;
  }
}

/** Error codes that abort a whole sync run: every remaining record would fail the same way. */
const ABORT_CODES = Object.freeze([ERROR_CODES.AUTHENTICATION_ERROR, ERROR_CODES.AUTHORIZATION_ERROR]);

function isAbortError(error) {
  return Boolean(error && ABORT_CODES.includes(error.code));
}

/**
 * Reads a JSON file that must contain an array of plain objects.
 * @param {string} filePath
 * @returns {Promise<object[]>}
 * @throws {SyncSourceError}
 */
async function loadJsonArray(filePath) {
  const absolute = path.resolve(filePath);
  let text;
  try {
    text = await fs.readFile(absolute, 'utf8');
  } catch (error) {
    throw new SyncSourceError(`Cannot read source file ${absolute}: ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new SyncSourceError(`Source file ${absolute} is not valid JSON: ${error.message}`);
  }
  return assertRecordArray(data, absolute);
}

/** Validates that `data` is an array of plain objects. */
function assertRecordArray(data, label = 'source') {
  if (!Array.isArray(data)) throw new SyncSourceError(`${label} must be a JSON array of records`);
  const bad = data.map((item, index) => ({ item, index })).filter(({ item }) => !item || typeof item !== 'object' || Array.isArray(item));
  if (bad.length > 0) {
    throw new SyncSourceError(`${label} contains ${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} that are not objects`, bad.map((b) => ({ index: b.index })));
  }
  return data;
}

/**
 * Splits source records into unique ones, duplicates (same key seen earlier) and invalid ones.
 * The first occurrence of a key wins; later ones are reported, never merged silently.
 *
 * @param {object[]} records
 * @param {(record:object, index:number) => {key?:string, reason?:string, message?:string}} keyOf
 *        returns { key } for a valid record or { reason, message } for an invalid one
 * @returns {{unique: Array<{index:number, key:string, record:object}>,
 *            duplicates: Array<{index:number, key:string, duplicateOf:number}>,
 *            invalid: Array<{index:number, reason:string, message:string}>}}
 */
function partitionByKey(records, keyOf) {
  const seen = new Map();
  const unique = [];
  const duplicates = [];
  const invalid = [];
  records.forEach((record, index) => {
    const result = keyOf(record, index) || {};
    if (!result.key) {
      invalid.push({ index, reason: result.reason || 'INVALID_RECORD', message: result.message || 'invalid record' });
      return;
    }
    if (seen.has(result.key)) {
      duplicates.push({ index, key: result.key, duplicateOf: seen.get(result.key) });
      return;
    }
    seen.set(result.key, index);
    unique.push({ index, key: result.key, record });
  });
  return { unique, duplicates, invalid };
}

function normalizeValue(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * Compares two date-like values by instant. Rules:
 * - both empty (null/undefined/'') → equal; one empty → different;
 * - both parseable (ISO 8601 or epoch ms) → equal when they are the same instant,
 *   so "2026-09-18T00:00:00Z" and "2026-09-18T00:00:00.000Z" are equivalent;
 * - any side unparseable → falls back to the trimmed text comparison (never guessed).
 */
function datesEquivalent(left, right) {
  const a = parseDateValue(left);
  const b = parseDateValue(right);
  if (a === null || b === null) return a === b;
  if (Number.isNaN(a) || Number.isNaN(b)) return normalizeValue(left) === normalizeValue(right);
  return a === b;
}

/**
 * Properties whose desired value differs from the remote one. HubSpot returns every
 * value as a string, so both sides are compared as trimmed strings; a missing remote
 * property counts as ''. Properties listed in `dateProperties` are compared by
 * instant instead (see datesEquivalent); no other string is interpreted as a date.
 * A desired '' or null means "clear the property": it is reported as changed when the
 * remote value is not empty and sent as '' (how HubSpot clears a property).
 *
 * @param {object} desired  normalized properties to apply
 * @param {object} remote   `properties` of the HubSpot record
 * @param {object} [options]
 * @param {string[]} [options.dateProperties=[]]  names compared as dates
 * @returns {object} subset of `desired` that changed (empty when nothing changed)
 */
function computeChangedProperties(desired, remote = {}, { dateProperties = [] } = {}) {
  const dates = new Set(dateProperties);
  const changed = {};
  for (const [name, value] of Object.entries(desired || {})) {
    if (value === undefined) continue;
    const remoteValue = remote ? remote[name] : undefined;
    const equal = dates.has(name) ? datesEquivalent(value, remoteValue) : normalizeValue(value) === normalizeValue(remoteValue);
    if (!equal) changed[name] = value === null ? '' : value;
  }
  return changed;
}

/** Empty summary shared by both sync functions. */
function createSummary(source, total) {
  return { source, total, created: [], updated: [], unchanged: [], partial: [], skipped: [], failed: [], aborted: null };
}

/**
 * Records the outcome of one deal in the summary. A deal whose save succeeded but
 * whose association failed goes to `partial` (with `dealStatus` telling whether the
 * deal was created, updated or unchanged) instead of being counted as a plain success
 * or as a failed record. A skipped association (CONTACT_NOT_FOUND) is not a failure:
 * the deal is counted under its own status and the association is reported on the entry.
 *
 * @param {object} summary        from createSummary
 * @param {object} result         { index, key, id, changedProperties?, association? }
 * @param {'created'|'updated'|'unchanged'} dealStatus
 * @returns {string} the bucket the entry went to
 */
function applyDealResult(summary, { index, key, id, changedProperties, association }, dealStatus) {
  const entry = { index, key, id };
  if (changedProperties) entry.changedProperties = changedProperties;
  if (association) entry.association = association;
  if (association && association.status === 'failed') {
    summary.partial.push({ ...entry, dealStatus });
    return 'partial';
  }
  summary[dealStatus].push(entry);
  return dealStatus;
}

/** Counts per status, for console output and tests. */
function summarizeCounts(summary) {
  return {
    total: summary.total,
    created: summary.created.length,
    updated: summary.updated.length,
    unchanged: summary.unchanged.length,
    partial: summary.partial ? summary.partial.length : 0,
    skipped: summary.skipped.length,
    failed: summary.failed.length,
    aborted: summary.aborted,
  };
}

/** True when a run must exit with a non-zero code: failed records, partial failures or an abort. */
function hasSyncFailures(counts) {
  return counts.failed > 0 || counts.partial > 0 || Boolean(counts.aborted);
}

module.exports = {
  SyncSourceError,
  ABORT_CODES,
  isAbortError,
  loadJsonArray,
  assertRecordArray,
  partitionByKey,
  datesEquivalent,
  computeChangedProperties,
  createSummary,
  applyDealResult,
  summarizeCounts,
  hasSyncFailures,
};
