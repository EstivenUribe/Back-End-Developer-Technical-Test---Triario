'use strict';

/**
 * getHubSpotContacts — one page of contact details, with pagination and optional filters.
 *
 *   node src/examples/get-contacts.js                          (list endpoint, 10 per page)
 *   node src/examples/get-contacts.js --limit 2                 (small page to see the cursor)
 *   node src/examples/get-contacts.js --limit 2 --after <cursor>
 *   node src/examples/get-contacts.js --properties email,firstname,lastname,lifecyclestage
 *   node src/examples/get-contacts.js --filter "company:EQ:Triario Technical Test"   (Search API)
 *   node src/examples/get-contacts.js --filter "email:CONTAINS_TOKEN:*@example.com" --filter "firstname:HAS_PROPERTY"
 *
 * --filter is "propertyName:OPERATOR[:value]" and may be repeated (filters are ANDed).
 * With filters the Search API is used; without them the list endpoint is used.
 */

const hubSpotService = require('../services/hubSpotService');
const { runExample, parseCliArgs, line } = require('./hubSpotApiHandler');

const { values } = parseCliArgs({
  limit: { type: 'string', default: '10' },
  after: { type: 'string' },
  properties: { type: 'string' },
  filter: { type: 'string', multiple: true },
});

function parseFilter(text) {
  const [propertyName, operator, ...rest] = text.split(':');
  const filter = { propertyName, operator };
  if (rest.length > 0) filter.value = rest.join(':');
  return filter;
}

const options = { limit: values.limit, after: values.after };
if (values.properties) options.properties = values.properties.split(',').map((p) => p.trim()).filter(Boolean);
if (values.filter && values.filter.length > 0) options.filters = values.filter.map(parseFilter);

runExample(
  'getHubSpotContacts',
  async () => {
    const page = await hubSpotService.getHubSpotContacts(options);
    line('info', `source: ${page.source} endpoint${page.total !== undefined ? `, total matches: ${page.total}` : ''}`);
    // HubSpot returns null for empty properties, so coalesce before formatting.
    const text = (value) => (value === null || value === undefined ? '' : String(value));
    for (const contact of page.contacts) {
      const { email, company, createdate } = contact.properties;
      console.log(
        `  ${text(contact.id).padEnd(14)} ${(contact.fullName || '(no name)').padEnd(32)} ${text(email).padEnd(40)} ${text(company).padEnd(24)} ${text(createdate)}`
      );
    }
    line('ok', `${page.contacts.length} contact(s) on this page`);
    if (page.nextAfter) {
      const filters = (values.filter || []).map((f) => ` --filter "${f}"`).join('');
      line('info', `Next page: node src/examples/get-contacts.js --limit ${values.limit}${filters} --after ${page.nextAfter}`);
    } else {
      line('info', 'No more pages.');
    }
    return undefined;
  },
  { printResult: false }
);
