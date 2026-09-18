'use strict';

/**
 * createHubSpotContact — POST /crm/v3/objects/contacts
 *
 *   node src/examples/create-contact.js                       (unique test contact, company "Triario Technical Test")
 *   node src/examples/create-contact.js --email ana@example.org --firstname Ana --lastname Torres --phone "+57 300 000 0000"
 *
 * The payload is validated locally first; an invalid e-mail never reaches HubSpot.
 * HubSpot deduplicates contacts by e-mail: creating an existing address answers 409.
 */

const hubSpotService = require('../services/hubSpotService');
const { loadConfig, getPortalUrl } = require('../config');
const { runExample, parseCliArgs, line } = require('./hubSpotApiHandler');
const { buildTestContact } = require('./testRecords');

const { values } = parseCliArgs({
  email: { type: 'string' },
  firstname: { type: 'string' },
  lastname: { type: 'string' },
  phone: { type: 'string' },
  company: { type: 'string' },
});

const overrides = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
const properties = buildTestContact(overrides);

runExample('createHubSpotContact', async () => {
  const contact = await hubSpotService.createHubSpotContact(properties);
  const { portalId } = loadConfig().hubspot;
  if (portalId) line('info', `Open in HubSpot: ${getPortalUrl(portalId)}/record/0-1/${contact.id}`);
  line('info', `Keep the id for update/delete examples: ${contact.id}`);
  return contact;
});
