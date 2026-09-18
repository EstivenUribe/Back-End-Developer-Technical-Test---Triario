'use strict';

/**
 * syncContactsWithHubSpot — idempotent sync from a local JSON file (key: normalized e-mail).
 *
 *   node src/examples/sync-contacts.js                          (src/data/contacts.json)
 *   node src/examples/sync-contacts.js --file path/to/other.json
 *
 * Run it twice: the second run reports every record as "unchanged" and creates nothing.
 */

const path = require('path');
const { syncContactsWithHubSpot } = require('../services/syncService');
const { loadJsonArray, hasSyncFailures } = require('../utils/syncHelpers');
const { runExample, parseCliArgs, line } = require('./hubSpotApiHandler');
const { printSyncSummary } = require('./syncOutput');

const { values } = parseCliArgs({ file: { type: 'string', default: path.join(__dirname, '..', 'data', 'contacts.json') } });

runExample(
  'syncContactsWithHubSpot',
  async () => {
    const records = await loadJsonArray(values.file);
    line('info', `source: ${path.resolve(values.file)} (${records.length} record(s))`);
    const summary = await syncContactsWithHubSpot(records);
    const counts = printSyncSummary(summary);
    if (hasSyncFailures(counts)) process.exitCode = 1;
    return undefined;
  },
  { printResult: false }
);
