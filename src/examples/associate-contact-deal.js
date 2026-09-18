'use strict';

/**
 * associateContactToDeal(contactId, dealId)
 *   PUT /crm/objects/2026-09/contact/{contactId}/associations/default/deal/{dealId}
 *
 *   node src/examples/associate-contact-deal.js <contactId> <dealId>
 *
 * Run it twice: the second run reports alreadyAssociated=true and writes nothing.
 * The script also reads the reverse direction (deal -> contact) to show that
 * HubSpot created both sides of the association.
 */

const hubSpotService = require('../services/hubSpotService');
const { runExample, parseCliArgs, line } = require('./hubSpotApiHandler');

const { positionals } = parseCliArgs({});
const [contactId, dealId] = positionals;

if (!contactId || !dealId) {
  line('fail', 'Usage: node src/examples/associate-contact-deal.js <contactId> <dealId>');
  process.exit(1);
}

function describeTypes(types) {
  return (types || []).map((t) => `${t.category}:${t.typeId}${t.label ? ` "${t.label}"` : ' (unlabeled)'}`).join(', ') || 'none';
}

runExample('associateContactToDeal', async () => {
  const result = await hubSpotService.associateContactToDeal(contactId, dealId);
  line(
    'ok',
    result.alreadyAssociated
      ? `already associated, nothing written (types: ${describeTypes(result.associationTypes)})`
      : `association created (types: ${describeTypes(result.associationTypes)})`
  );

  const forward = await hubSpotService.getContactDealAssociations(contactId);
  const forwardHit = forward.find((entry) => entry.dealId === String(dealId));
  line(forwardHit ? 'ok' : 'warn', `contact -> deal: ${forwardHit ? describeTypes(forwardHit.associationTypes) : 'NOT FOUND'}`);

  const reverse = await hubSpotService.getDealContactAssociations(dealId);
  const reverseHit = reverse.find((entry) => entry.contactId === String(contactId));
  line(reverseHit ? 'ok' : 'warn', `deal -> contact: ${reverseHit ? describeTypes(reverseHit.associationTypes) : 'NOT FOUND'}`);

  line('info', `contact ${contactId} is linked to ${forward.length} deal(s); deal ${dealId} is linked to ${reverse.length} contact(s)`);
  return result;
});
