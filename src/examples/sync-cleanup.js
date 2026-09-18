'use strict';

/**
 * Archives the records created by the sync examples, and nothing else.
 *
 *   node src/examples/sync-cleanup.js
 *   node src/examples/sync-cleanup.js --contacts src/data/contacts.json --deals src/data/deals.json
 *
 * Deals are looked up by external_id and contacts by e-mail, exactly as the sync does;
 * each record is checked with the project test-record guard before DELETE.
 * The custom `external_id` property is left in place (see README).
 */

const path = require('path');
const hubSpotService = require('../services/hubSpotService');
const contactRepository = require('../repositories/contactRepository');
const dealRepository = require('../repositories/dealRepository');
const { loadJsonArray } = require('../utils/syncHelpers');
const { normalizeEmail } = require('../utils/validateHubSpotPayload');
const { ERROR_CODES } = require('../utils/handleHubSpotErrors');
const { runExample, parseCliArgs, line } = require('./hubSpotApiHandler');
const { isProjectTestContact, isProjectTestDeal } = require('./testRecords');

const { values } = parseCliArgs({
  contacts: { type: 'string', default: path.join(__dirname, '..', 'data', 'contacts.json') },
  deals: { type: 'string', default: path.join(__dirname, '..', 'data', 'deals.json') },
});

async function lookup(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error.code === ERROR_CODES.NOT_FOUND) return null;
    throw error;
  }
}

runExample(
  'sync cleanup (test records only)',
  async () => {
    let archived = 0;
    for (const record of await loadJsonArray(values.deals)) {
      const key = record.externalId || record.external_id;
      const deal = key ? await lookup(() => dealRepository.getById(key, { idProperty: 'external_id', properties: ['dealname', 'external_id'] })) : null;
      if (!deal) {
        line('info', `deal ${key || '(no externalId)'}: not found, nothing to do`);
        continue;
      }
      if (!isProjectTestDeal(deal)) {
        line('warn', `deal ${key} (${deal.id}) does not look like a project test record: left untouched`);
        continue;
      }
      await hubSpotService.deleteHubSpotDeal(deal.id);
      archived += 1;
      line('ok', `deal ${key} (${deal.id}) archived`);
    }
    for (const record of await loadJsonArray(values.contacts)) {
      const email = normalizeEmail(record.email);
      const contact = email ? await lookup(() => contactRepository.getByEmail(email, { properties: ['email', 'company'] })) : null;
      if (!contact) {
        line('info', `contact ${email || '(no email)'}: not found, nothing to do`);
        continue;
      }
      if (!isProjectTestContact(contact)) {
        line('warn', `contact ${email} (${contact.id}) does not look like a project test record: left untouched`);
        continue;
      }
      await hubSpotService.deleteHubSpotContact(contact.id);
      archived += 1;
      line('ok', `contact ${email} (${contact.id}) archived`);
    }
    line('ok', `${archived} record(s) archived`);
    return undefined;
  },
  { printResult: false }
);
