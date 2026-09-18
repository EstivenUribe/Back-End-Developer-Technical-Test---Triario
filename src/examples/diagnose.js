'use strict';

/**
 * Read-only diagnostic. Run: node src/examples/diagnose.js
 *
 * 1. Loads and validates configuration (no network).
 * 2. Verifies the token and reports Hub ID, app id and granted scopes
 *    (POST /oauth/v2/private-apps/get/access-token-info — a lookup, nothing is modified).
 * 3. Lists deal pipelines and stages (GET /crm/v3/pipelines/deals) and checks the configured ids.
 * 4. Lists contact properties (GET /crm/v3/properties/contacts).
 * 5. Lists deal properties (GET /crm/v3/properties/deals) and checks for `external_id`.
 *
 * Nothing is created, updated or deleted. Errors are printed without credentials.
 */

const { loadConfig, getPortalUrl } = require('../config');
const hubSpotService = require('../services/hubSpotService');
const { heading, line, printError } = require('./hubSpotApiHandler');

const CONTACT_PROPERTIES_USED = ['email', 'firstname', 'lastname', 'phone', 'company'];
const DEAL_PROPERTIES_USED = ['dealname', 'amount', 'pipeline', 'dealstage'];
const DEAL_EXTERNAL_ID_PROPERTY = 'external_id';

const summary = [];

function record(step, status, note) {
  summary.push({ step, status, note });
}

function describeProperty(property) {
  return `${property.name} (${property.type}/${property.fieldType}${property.hasUniqueValue ? ', unique' : ''})`;
}

async function checkConfiguration() {
  heading('1/5 Configuration');
  const config = loadConfig();
  line('ok', `API base URL:      ${config.hubspot.baseUrl}   (HTTP calls go here)`);
  line(
    config.hubspot.portalId ? 'ok' : 'warn',
    `Portal URL:        ${getPortalUrl(config.hubspot.portalId) || '(set HUBSPOT_PORTAL_ID to print it)'}   (what you open in the browser)`
  );
  line('info', `Timeout: ${config.hubspot.timeoutMs} ms, retries: ${config.hubspot.maxRetries}, log level: ${config.logLevel}`);
  line(config.hubspot.pipelineId ? 'info' : 'warn', `HUBSPOT_PIPELINE_ID: ${config.hubspot.pipelineId || '(not set)'}`);
  line(config.hubspot.stageId ? 'info' : 'warn', `HUBSPOT_STAGE_ID:    ${config.hubspot.stageId || '(not set)'}`);
  record('Configuration', 'OK');
  return config;
}

async function checkAuthentication(config) {
  heading('2/5 Authentication (token info lookup)');
  const auth = await hubSpotService.checkAuthentication();
  line('ok', `Token accepted. Hub ID: ${auth.hubId}, private app id: ${auth.appId}, created by user id: ${auth.userId}`);
  line('ok', `Portal URL for this token: ${getPortalUrl(auth.hubId, config.hubspot.portalBaseUrl)}`);

  if (!config.hubspot.portalId) {
    line('warn', `HUBSPOT_PORTAL_ID is empty. Add to .env:  HUBSPOT_PORTAL_ID=${auth.hubId}`);
  } else if (String(config.hubspot.portalId) !== String(auth.hubId)) {
    line('warn', `HUBSPOT_PORTAL_ID=${config.hubspot.portalId} does not match the token's Hub ID ${auth.hubId}.`);
  } else {
    line('ok', 'HUBSPOT_PORTAL_ID matches the token account.');
  }

  line('info', `Granted scopes (${auth.scopes.length}): ${auth.scopes.join(', ')}`);
  if (auth.missingScopes.length === 0) {
    line('ok', 'All scopes required by this project are granted.');
    record('Authentication', 'OK', `hubId ${auth.hubId}`);
  } else {
    line('warn', `Missing scopes (add them in the private app Scopes tab): ${auth.missingScopes.join(', ')}`);
    record('Authentication', 'WARN', `missing scopes: ${auth.missingScopes.join(', ')}`);
  }
  return auth;
}

async function checkPipelines(config) {
  heading('3/5 Deal pipelines and stages');
  const pipelines = await hubSpotService.getDealPipelines();
  if (pipelines.length === 0) {
    line('warn', 'No deal pipelines returned.');
    record('Pipelines', 'WARN', 'none returned');
    return;
  }
  for (const pipeline of pipelines) {
    line('info', `Pipeline "${pipeline.label}"  id: ${pipeline.id}`);
    for (const stage of pipeline.stages) console.log(`        stage "${stage.label}"  id: ${stage.id}`);
  }

  const configuredPipeline = pipelines.find((p) => p.id === config.hubspot.pipelineId);
  const first = pipelines[0];
  const suggestedStage = first.stages[0];

  if (!config.hubspot.pipelineId) {
    line('warn', `HUBSPOT_PIPELINE_ID is empty. Suggested:  HUBSPOT_PIPELINE_ID=${first.id}   ("${first.label}")`);
  } else if (!configuredPipeline) {
    line('warn', `HUBSPOT_PIPELINE_ID=${config.hubspot.pipelineId} was not found among the pipelines above.`);
  } else {
    line('ok', `HUBSPOT_PIPELINE_ID=${config.hubspot.pipelineId} found ("${configuredPipeline.label}").`);
  }

  const stageOwner = configuredPipeline || first;
  const configuredStage = stageOwner.stages.find((s) => s.id === config.hubspot.stageId);
  if (!config.hubspot.stageId) {
    if (suggestedStage) line('warn', `HUBSPOT_STAGE_ID is empty. Suggested:  HUBSPOT_STAGE_ID=${suggestedStage.id}   ("${suggestedStage.label}")`);
  } else if (!configuredStage) {
    line('warn', `HUBSPOT_STAGE_ID=${config.hubspot.stageId} does not belong to pipeline "${stageOwner.label}".`);
  } else {
    line('ok', `HUBSPOT_STAGE_ID=${config.hubspot.stageId} found ("${configuredStage.label}") in pipeline "${stageOwner.label}".`);
  }

  const ready = Boolean(configuredPipeline && configuredStage);
  record('Pipelines', ready ? 'OK' : 'WARN', ready ? `${pipelines.length} pipeline(s)` : 'copy the suggested ids into .env');
}

async function checkProperties(objectType, usedNames) {
  const properties = await hubSpotService.getObjectProperties(objectType);
  const byName = new Map(properties.map((p) => [p.name, p]));
  const custom = properties.filter((p) => !p.hubspotDefined).length;
  line('ok', `${properties.length} ${objectType} properties (${custom} custom).`);
  const missing = [];
  for (const name of usedNames) {
    const property = byName.get(name);
    if (property) line('ok', `uses ${describeProperty(property)}`);
    else {
      missing.push(name);
      line('warn', `property "${name}" not found`);
    }
  }
  return { byName, missing };
}

async function checkContactProperties() {
  heading('4/5 Contact properties');
  const { missing } = await checkProperties('contacts', CONTACT_PROPERTIES_USED);
  record('Contact properties', missing.length ? 'WARN' : 'OK', missing.length ? `missing: ${missing.join(', ')}` : undefined);
}

async function checkDealProperties() {
  heading('5/5 Deal properties');
  const { byName, missing } = await checkProperties('deals', DEAL_PROPERTIES_USED);
  const externalId = byName.get(DEAL_EXTERNAL_ID_PROPERTY);
  if (!externalId) {
    line('info', `"${DEAL_EXTERNAL_ID_PROPERTY}" does not exist yet; the deal sync creates it as a unique text property (stage 5).`);
  } else if (externalId.hasUniqueValue) {
    line('ok', `"${DEAL_EXTERNAL_ID_PROPERTY}" exists and enforces unique values.`);
  } else {
    line('warn', `"${DEAL_EXTERNAL_ID_PROPERTY}" exists but does NOT enforce unique values; the deal sync will refuse to run.`);
  }
  record('Deal properties', missing.length ? 'WARN' : 'OK', missing.length ? `missing: ${missing.join(', ')}` : undefined);
}

function printSummary() {
  heading('Summary');
  for (const item of summary) {
    line(item.status === 'OK' ? 'ok' : item.status === 'WARN' ? 'warn' : 'fail', `${item.step.padEnd(20)} ${item.status}${item.note ? `  (${item.note})` : ''}`);
  }
  const failed = summary.some((item) => item.status === 'FAILED');
  line(failed ? 'fail' : 'ok', failed ? 'HubSpot connection: NOT VERIFIED' : 'HubSpot connection: VERIFIED (read-only checks)');
  process.exitCode = failed ? 1 : 0;
}

async function main() {
  let config;
  try {
    config = await checkConfiguration();
  } catch (error) {
    printError(error, { prefix: 'Configuration check failed' });
    record('Configuration', 'FAILED', 'fix .env and run again');
    line('warn', 'HubSpot connection: PENDING VERIFICATION (no credentials loaded)');
    process.exitCode = 1;
    return;
  }

  try {
    await checkAuthentication(config);
  } catch (error) {
    printError(error, { prefix: 'Authentication check failed' });
    record('Authentication', 'FAILED', error.code || error.name);
    if (error.code === 'AUTHENTICATION_ERROR') {
      line('warn', 'Stopping: the remaining checks need a valid token.');
      printSummary();
      return;
    }
  }

  const steps = [
    ['Pipelines', () => checkPipelines(config)],
    ['Contact properties', checkContactProperties],
    ['Deal properties', checkDealProperties],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      printError(error, { prefix: `${name} check failed` });
      record(name, 'FAILED', error.code || error.name);
    }
  }
  printSummary();
}

main().catch((error) => {
  printError(error, { prefix: 'Unexpected failure' });
  process.exitCode = 1;
});
