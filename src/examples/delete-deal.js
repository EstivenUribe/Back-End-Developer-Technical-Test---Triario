'use strict';

/**
 * deleteHubSpotDeal — DELETE /crm/v3/objects/deals/{id}
 *
 *   node src/examples/delete-deal.js <dealId>
 *   node src/examples/delete-deal.js <dealId> --force     (a deal not created by this project)
 *
 * Safety: the deal is read first and deleted only when it looks like a test record of
 * this project (name starting with "Triario Test - " or a sync external id), unless --force.
 * DELETE archives the deal into the recycle bin (restorable); it is not a permanent purge.
 */

const hubSpotService = require('../services/hubSpotService');
const { runExample, parseCliArgs, line } = require('./hubSpotApiHandler');
const { isProjectTestDeal } = require('./testRecords');
const { ERROR_CODES } = require('../utils/handleHubSpotErrors');

const { values, positionals } = parseCliArgs({ force: { type: 'boolean', default: false } });
const [dealId] = positionals;

if (!dealId) {
  line('fail', 'Usage: node src/examples/delete-deal.js <dealId> [--force]');
  process.exit(1);
}

runExample('deleteHubSpotDeal', async () => {
  const deal = await hubSpotService.getHubSpotDealById(dealId, { properties: ['dealname', 'amount', 'external_id'] });
  line('info', `target: ${deal.id} "${deal.properties.dealname || ''}" amount ${deal.properties.amount || ''}`);

  if (!isProjectTestDeal(deal) && !values.force) {
    throw new Error('Refusing to delete: this deal was not created by this project. Re-run with --force if you really mean it.');
  }

  const result = await hubSpotService.deleteHubSpotDeal(dealId);
  line('ok', `archived (recycle bin): ${result.id}`);

  try {
    await hubSpotService.getHubSpotDealById(dealId);
    line('warn', 'GET after delete still returns the deal (unexpected).');
  } catch (error) {
    if (error.code === ERROR_CODES.NOT_FOUND) line('ok', 'GET after delete answers 404: archived deals are hidden by default.');
    else throw error;
  }
  return result;
});
