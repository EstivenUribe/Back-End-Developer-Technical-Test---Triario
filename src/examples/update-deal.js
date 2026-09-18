'use strict';

/**
 * updateHubSpotDeal — PATCH /crm/v3/objects/deals/{id} (partial update)
 *
 *   node src/examples/update-deal.js <dealId> --amount 2500
 *   node src/examples/update-deal.js <dealId> --dealname "Triario Test - renamed" --dealstage <stageId>
 *   node src/examples/update-deal.js <dealId> --pipeline <id> --dealstage <id>
 *
 * A new dealstage is verified against the deal's pipeline before the PATCH.
 */

const hubSpotService = require('../services/hubSpotService');
const { runExample, parseCliArgs, line } = require('./hubSpotApiHandler');

const { values, positionals } = parseCliArgs({
  dealname: { type: 'string' },
  amount: { type: 'string' },
  dealstage: { type: 'string' },
  pipeline: { type: 'string' },
  closedate: { type: 'string' },
});

const [dealId] = positionals;
const properties = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));

if (!dealId) {
  line('fail', 'Usage: node src/examples/update-deal.js <dealId> --amount 2500 [--dealname ...] [--dealstage ...]');
  process.exit(1);
}

runExample('updateHubSpotDeal', async () => {
  const keys = Object.keys(properties);
  const before = await hubSpotService.getHubSpotDealById(dealId, { properties: keys });
  line('info', `before: ${JSON.stringify(Object.fromEntries(keys.map((k) => [k, before.properties[k]])))}`);
  const after = await hubSpotService.updateHubSpotDeal(dealId, properties);
  line('info', `after:  ${JSON.stringify(Object.fromEntries(keys.map((k) => [k, after.properties[k]])))}`);
  return after;
});
