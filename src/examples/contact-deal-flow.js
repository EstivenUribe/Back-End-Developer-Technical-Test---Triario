'use strict';

/**
 * End-to-end flow on project test records only:
 *
 *   1. create a test contact                     POST   /crm/v3/objects/contacts
 *   2. create a test deal                        POST   /crm/v3/objects/deals
 *   3. associate contact -> deal                 PUT    .../contact/{id}/associations/default/deal/{id}
 *   4. associate again (idempotent, no write)    GET    .../contact/{id}/associations/deal
 *   5. read both directions                      GET    .../deal/{id}/associations/contact
 *   6. update the deal amount                    PATCH  /crm/v3/objects/deals/{id}
 *   7. list deals (one page)                     GET    /crm/v3/objects/deals?limit=3
 *   8. delete the test deal and contact          DELETE /crm/v3/objects/deals/{id}, /contacts/{id}
 *
 *   node src/examples/contact-deal-flow.js
 *   node src/examples/contact-deal-flow.js --keep     (skip step 8, leave the records in the portal)
 */

const hubSpotService = require('../services/hubSpotService');
const { parseCliArgs, heading, line, printError } = require('./hubSpotApiHandler');
const { buildTestContact, buildTestDeal, isProjectTestContact, isProjectTestDeal } = require('./testRecords');

const { values } = parseCliArgs({ keep: { type: 'boolean', default: false } });

const types = (list) => (list || []).map((t) => `${t.category}:${t.typeId}`).join(', ') || 'none';

async function cleanup(created) {
  heading('8/8 Cleanup (test records only)');
  if (created.deal && isProjectTestDeal(created.deal)) {
    await hubSpotService.deleteHubSpotDeal(created.deal.id);
    line('ok', `deal ${created.deal.id} archived`);
  }
  if (created.contact && isProjectTestContact(created.contact)) {
    await hubSpotService.deleteHubSpotContact(created.contact.id);
    line('ok', `contact ${created.contact.id} archived`);
  }
}

async function main() {
  const created = {};
  try {
    heading('1/8 Create test contact');
    created.contact = await hubSpotService.createHubSpotContact(buildTestContact());
    line('ok', `contact ${created.contact.id} <${created.contact.properties.email}>`);

    heading('2/8 Create test deal (pipeline/stage from .env, verified)');
    const { dealName, amount } = buildTestDeal();
    created.deal = await hubSpotService.createHubSpotDeal(dealName, amount);
    line('ok', `deal ${created.deal.id} "${created.deal.properties.dealname}" amount ${created.deal.properties.amount}`);
    line('ok', `pipeline "${created.deal.pipeline.label}" / stage "${created.deal.stage.label}"`);

    heading('3/8 Associate contact -> deal');
    const first = await hubSpotService.associateContactToDeal(created.contact.id, created.deal.id);
    line('ok', `created=${first.created} alreadyAssociated=${first.alreadyAssociated} types: ${types(first.associationTypes)}`);

    heading('4/8 Associate again (must not duplicate)');
    const second = await hubSpotService.associateContactToDeal(created.contact.id, created.deal.id);
    line(second.alreadyAssociated ? 'ok' : 'warn', `created=${second.created} alreadyAssociated=${second.alreadyAssociated}`);

    heading('5/8 Read both directions');
    const fromContact = await hubSpotService.getContactDealAssociations(created.contact.id);
    const fromDeal = await hubSpotService.getDealContactAssociations(created.deal.id);
    const hit = fromContact.find((e) => e.dealId === created.deal.id);
    const reverseHit = fromDeal.find((e) => e.contactId === created.contact.id);
    line(hit ? 'ok' : 'warn', `contact -> deal: ${hit ? types(hit.associationTypes) : 'NOT FOUND'} (${fromContact.length} deal(s) on the contact)`);
    line(reverseHit ? 'ok' : 'warn', `deal -> contact: ${reverseHit ? types(reverseHit.associationTypes) : 'NOT FOUND'} (${fromDeal.length} contact(s) on the deal)`);
    if (fromDeal.length !== 1) line('warn', `expected exactly 1 contact on the deal, found ${fromDeal.length}`);

    heading('6/8 Update deal amount (PATCH)');
    const updated = await hubSpotService.updateHubSpotDeal(created.deal.id, { amount: 2500 });
    line('ok', `amount ${created.deal.properties.amount} -> ${updated.properties.amount}, stage unchanged: ${updated.properties.dealstage}`);

    heading('7/8 List deals (one page of 3)');
    const page = await hubSpotService.getHubSpotDeals({ limit: 3 });
    for (const deal of page.deals) console.log(`  ${deal.id}  ${deal.properties.dealname || ''}`);
    line('ok', `${page.deals.length} deal(s), next cursor ${page.nextAfter ? 'available' : 'none'}`);
  } catch (error) {
    printError(error, { prefix: 'Flow failed' });
    process.exitCode = 1;
  } finally {
    if (values.keep) {
      line('info', `--keep: leaving contact ${created.contact ? created.contact.id : '-'} and deal ${created.deal ? created.deal.id : '-'} in the portal`);
    } else {
      try {
        await cleanup(created);
      } catch (error) {
        printError(error, { prefix: 'Cleanup failed' });
        process.exitCode = 1;
      }
    }
  }
  line(process.exitCode ? 'fail' : 'ok', process.exitCode ? 'Flow finished with errors' : 'Flow completed');
}

main();
