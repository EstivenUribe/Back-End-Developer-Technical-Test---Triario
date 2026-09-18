'use strict';

/**
 * updateHubSpotContact — PATCH /crm/v3/objects/contacts/{id} (partial update)
 *
 *   node src/examples/update-contact.js <contactId> --lastname "Updated" --phone "+57 300 111 2233"
 *
 * Only the properties given are sent; everything else stays untouched.
 */

const hubSpotService = require('../services/hubSpotService');
const { runExample, parseCliArgs, line } = require('./hubSpotApiHandler');

const { values, positionals } = parseCliArgs({
  email: { type: 'string' },
  firstname: { type: 'string' },
  lastname: { type: 'string' },
  phone: { type: 'string' },
  company: { type: 'string' },
  jobtitle: { type: 'string' },
});

const [contactId] = positionals;
const properties = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));

if (!contactId) {
  line('fail', 'Usage: node src/examples/update-contact.js <contactId> --lastname "New name" [--phone ...]');
  process.exit(1);
}

runExample('updateHubSpotContact', async () => {
  const before = await hubSpotService.getHubSpotContactById(contactId, { properties: Object.keys(properties) });
  line('info', `before: ${JSON.stringify(before.properties)}`);
  const after = await hubSpotService.updateHubSpotContact(contactId, properties);
  line('info', `after:  ${JSON.stringify(Object.fromEntries(Object.keys(properties).map((k) => [k, after.properties[k]])))}`);
  return after;
});
