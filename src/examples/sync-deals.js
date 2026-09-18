'use strict';

/**
 * syncDealsWithHubSpot — idempotent sync from a local JSON file (key: unique external_id).
 *
 *   node src/examples/sync-deals.js                          (src/data/deals.json)
 *   node src/examples/sync-deals.js --file path/to/other.json
 *
 * On the first run the unique deal property `external_id` is created through the
 * Properties API if it does not exist. Deals land in HUBSPOT_PIPELINE_ID / HUBSPOT_STAGE_ID
 * and are associated with the contact given by `contactEmail` (sync contacts first).
 * Run it twice: the second run reports every record as "unchanged" and creates nothing.
 */

const path = require('path');
const { syncDealsWithHubSpot } = require('../services/syncService');
const { loadJsonArray } = require('../utils/syncHelpers');
const { runExample, parseCliArgs, line } = require('./hubSpotApiHandler');
const { printSyncSummary } = require('./syncOutput');

const { values } = parseCliArgs({
  file: { type: 'string', default: path.join(__dirname, '..', 'data', 'deals.json') },
  pipeline: { type: 'string' },
  stage: { type: 'string' },
});

runExample(
  'syncDealsWithHubSpot',
  async () => {
    const records = await loadJsonArray(values.file);
    line('info', `source: ${path.resolve(values.file)} (${records.length} record(s))`);
    const summary = await syncDealsWithHubSpot(records, { pipelineId: values.pipeline, stageId: values.stage });
    line('info', `external_id property: ${summary.externalIdProperty.created ? 'created now' : 'already present'} (unique)`);
    line('info', `pipeline "${summary.pipeline.label}" (${summary.pipeline.id}), stage "${summary.stage.label}" (${summary.stage.id})`);
    const counts = printSyncSummary(summary);
    if (counts.failed > 0 || counts.aborted) process.exitCode = 1;
    return undefined;
  },
  { printResult: false }
);
