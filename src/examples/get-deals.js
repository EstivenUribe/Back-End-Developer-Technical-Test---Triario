'use strict';

/**
 * getHubSpotDeals — GET /crm/v3/objects/deals with cursor pagination.
 *
 *   node src/examples/get-deals.js                       (one page of 10)
 *   node src/examples/get-deals.js --limit 2              (small page to see the cursor)
 *   node src/examples/get-deals.js --limit 2 --after <cursor>
 *   node src/examples/get-deals.js --all --max-pages 3    (walk pages of 100, capped)
 *   node src/examples/get-deals.js --properties dealname,amount,dealstage
 */

const hubSpotService = require('../services/hubSpotService');
const { runExample, parseCliArgs, line } = require('./hubSpotApiHandler');

const { values } = parseCliArgs({
  limit: { type: 'string' },
  after: { type: 'string' },
  properties: { type: 'string' },
  all: { type: 'boolean', default: false },
  'max-pages': { type: 'string', default: '10' },
});

const text = (value) => (value === null || value === undefined ? '' : String(value));
const options = { limit: values.limit, after: values.after, all: values.all };
if (values.all) {
  const max = Number(values['max-pages']);
  options.maxPages = max === 0 ? Infinity : max;
  options.onPage = (page, number) => line('info', `page ${number}: ${(page.results || []).length} deal(s)`);
}
if (values.properties) options.properties = values.properties.split(',').map((p) => p.trim()).filter(Boolean);

runExample(
  'getHubSpotDeals',
  async () => {
    const result = await hubSpotService.getHubSpotDeals(options);
    for (const deal of result.deals) {
      const { dealname, amount, pipeline, dealstage, createdate } = deal.properties;
      console.log(`  ${text(deal.id).padEnd(14)} ${text(dealname).padEnd(40)} ${text(amount).padStart(10)}  ${text(pipeline)}/${text(dealstage)}  ${text(createdate)}`);
    }
    line('ok', `${result.deals.length} deal(s) from ${result.pages} page(s)`);
    if (result.nextAfter) {
      line('info', values.all
        ? `Stopped at --max-pages ${values['max-pages']}; next cursor: ${result.nextAfter}`
        : `Next page: node src/examples/get-deals.js --limit ${values.limit || 10} --after ${result.nextAfter}`);
    } else {
      line('info', 'No more pages.');
    }
    return undefined;
  },
  { printResult: false }
);
