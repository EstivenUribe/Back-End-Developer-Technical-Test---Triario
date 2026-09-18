'use strict';

/**
 * Pure helpers for the sync services (no HubSpot calls, unit-tested).
 */

const fs = require('fs/promises');
const path = require('path');

class SyncSourceError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'SyncSourceError';
    this.details = details;
  }
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
 * Properties whose desired value differs from the remote one. HubSpot returns every
 * value as a string, so both sides are compared as trimmed strings; a missing remote
 * property counts as ''.
 *
 * @param {object} desired  normalized properties to apply
 * @param {object} remote   `properties` of the HubSpot record
 * @returns {object} subset of `desired` that changed (empty when nothing changed)
 */
function computeChangedProperties(desired, remote = {}) {
  const changed = {};
  for (const [name, value] of Object.entries(desired || {})) {
    if (value === undefined) continue;
    if (normalizeValue(value) !== normalizeValue(remote ? remote[name] : undefined)) changed[name] = value;
  }
  return changed;
}

/** Empty summary shared by both sync functions. */
function createSummary(source, total) {
  return { source, total, created: [], updated: [], unchanged: [], skipped: [], failed: [], aborted: null };
}

/** Counts per status, for console output and tests. */
function summarizeCounts(summary) {
  return {
    total: summary.total,
    created: summary.created.length,
    updated: summary.updated.length,
    unchanged: summary.unchanged.length,
    skipped: summary.skipped.length,
    failed: summary.failed.length,
    aborted: summary.aborted,
  };
}

module.exports = {
  SyncSourceError,
  loadJsonArray,
  assertRecordArray,
  partitionByKey,
  computeChangedProperties,
  createSummary,
  summarizeCounts,
};
