'use strict';

/**
 * deleteHubSpotContact — DELETE /crm/v3/objects/contacts/{id}
 *
 *   node src/examples/delete-contact.js <contactId>
 *   node src/examples/delete-contact.js <contactId> --force     (a contact not created by this project)
 *
 * Safety: the contact is read first and deleted only when it looks like a test record
 * of this project (reserved e-mail domain or company "Triario Technical Test"),
 * unless --force is given.
 *
 * Per the official documentation, DELETE archives the record into the recycle bin
 * (restorable from HubSpot); it is not a permanent purge. After deleting, the script
 * shows that a normal GET answers 404 while GET ?archived=true still returns it.
 */

const hubSpotService = require('../services/hubSpotService');
const { runExample, parseCliArgs, line } = require('./hubSpotApiHandler');
const { isProjectTestContact } = require('./testRecords');
const { ERROR_CODES } = require('../utils/handleHubSpotErrors');

const { values, positionals } = parseCliArgs({ force: { type: 'boolean', default: false } });
const [contactId] = positionals;

if (!contactId) {
  line('fail', 'Usage: node src/examples/delete-contact.js <contactId> [--force]');
  process.exit(1);
}

runExample('deleteHubSpotContact', async () => {
  const contact = await hubSpotService.getHubSpotContactById(contactId, {
    properties: ['email', 'firstname', 'lastname', 'company'],
  });
  line('info', `target: ${contact.id} ${contact.fullName || '(no name)'} <${contact.properties.email || 'no e-mail'}> ${contact.properties.company || ''}`);

  if (!isProjectTestContact(contact) && !values.force) {
    throw new Error('Refusing to delete: this contact was not created by this project. Re-run with --force if you really mean it.');
  }

  const result = await hubSpotService.deleteHubSpotContact(contactId);
  line('ok', `archived (recycle bin): ${result.id}`);

  try {
    await hubSpotService.getHubSpotContactById(contactId);
    line('warn', 'GET after delete still returns the contact (unexpected).');
  } catch (error) {
    if (error.code === ERROR_CODES.NOT_FOUND) line('ok', 'GET after delete answers 404: archived contacts are hidden by default.');
    else throw error;
  }
  const archived = await hubSpotService.getHubSpotContactById(contactId, { archived: true, properties: ['email'] });
  line('ok', `GET ?archived=true still returns it with archived=${archived.archived} (restorable from the recycle bin).`);
  return result;
});
