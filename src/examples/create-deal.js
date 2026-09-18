'use strict';

/**
 * createHubSpotDeal(dealName, amount) — POST /crm/v3/objects/deals
 *
 *   node src/examples/create-deal.js                                   (test deal "Triario Test - <timestamp>", 1500)
 *   node src/examples/create-deal.js "Triario Test - website" 4500
 *   node src/examples/create-deal.js "Triario Test - website" 4500 --contact <contactId>   (associate after creating)
 *   node src/examples/create-deal.js "Triario Test - x" 10 --pipeline <id> --stage <id>     (override .env)
 *
 * Pipeline and stage come from HUBSPOT_PIPELINE_ID / HUBSPOT_STAGE_ID unless overridden,
 * and the stage is verified to belong to the pipeline before the POST.
 */

const hubSpotService = require('../services/hubSpotService');
const { loadConfig, getPortalUrl } = require('../config');
const { runExample, parseCliArgs, line } = require('./hubSpotApiHandler');
const { buildTestDeal } = require('./testRecords');

const { values, positionals } = parseCliArgs({
  pipeline: { type: 'string' },
  stage: { type: 'string' },
  contact: { type: 'string' },
});

const [nameArg, amountArg] = positionals;
const { dealName, amount } = buildTestDeal(nameArg ? { dealName: nameArg, amount: amountArg } : {});

runExample('createHubSpotDeal', async () => {
  const deal = await hubSpotService.createHubSpotDeal(dealName, amount, {
    pipelineId: values.pipeline,
    stageId: values.stage,
    contactId: values.contact,
  });
  line('ok', `pipeline "${deal.pipeline.label}" (${deal.pipeline.id}), stage "${deal.stage.label}" (${deal.stage.id})`);
  if (deal.association) {
    line('ok', `associated with contact ${deal.association.contactId}${deal.association.alreadyAssociated ? ' (was already associated)' : ''}`);
  }
  const { portalId } = loadConfig().hubspot;
  if (portalId) line('info', `Open in HubSpot: ${getPortalUrl(portalId)}/record/0-3/${deal.id}`);
  line('info', `Keep the id for update/delete/associate examples: ${deal.id}`);
  return deal;
});
