'use strict';

/**
 * Error-handling evidence. Run: node src/examples/error-handling.js
 *
 * Every case is read-only and creates nothing in the portal. Cases 2 to 4 are
 * REAL requests answered by HubSpot; case 1 never leaves the process.
 *
 *   1. Local validation: an invalid payload is rejected before any HTTP call.
 *   2. Real 404: GET /crm/v3/objects/contacts/{id} with an id that does not exist.
 *   3. Real 404 by e-mail: GET /crm/v3/objects/contacts/{email}?idProperty=email for an
 *      address that does not exist (also shows the e-mail masked in the log line).
 *   4. Real 400: GET /crm/v3/objects/contacts?limit=1000 (the documented maximum is 100).
 *      The service layer would refuse this locally, so the repository is called directly.
 *
 * Rate limits (429) and 5xx are NOT provoked on purpose; their handling is covered by
 * unit tests of the retry policy and documented in the README.
 */

const hubSpotService = require('../services/hubSpotService');
const contactRepository = require('../repositories/contactRepository');
const { validateHubSpotPayload } = require('../utils/validateHubSpotPayload');
const { handleHubSpotErrors } = require('../utils/handleHubSpotErrors');
const { heading, line, printError } = require('./hubSpotApiHandler');

const NON_EXISTENT_CONTACT_ID = '1';
const NON_EXISTENT_EMAIL = 'nobody.here@example.invalid';

const results = [];

/** Runs one case; returns the error that was raised (or null). */
async function expectFailure(label, expected, operation) {
  heading(label);
  try {
    const value = await operation();
    line('warn', `No error was raised (expected ${expected}). Response:`);
    console.log(JSON.stringify(value, null, 2));
    results.push({ label, expected, got: 'no error' });
    return null;
  } catch (error) {
    const got = error.code || error.name;
    printError(error, { prefix: got === expected ? `Handled as expected (${expected})` : `Unexpected error (expected ${expected})` });
    results.push({ label, expected, got });
    return error;
  }
}

async function main() {
  await expectFailure('1/4 Local validation, nothing sent to HubSpot', 'PayloadValidationError', async () =>
    validateHubSpotPayload('contacts', { email: 'not-an-email', firstname: { nested: true } })
  );

  const first = await expectFailure('2/4 Real 404 by record id', 'NOT_FOUND', () =>
    hubSpotService.getHubSpotContactById(NON_EXISTENT_CONTACT_ID)
  );
  if (first && first.name === 'ConfigError') {
    line('warn', 'Real cases 2-4 are PENDING: no credentials loaded. Fill .env and run again.');
    process.exitCode = 1;
    return;
  }

  await expectFailure('3/4 Real 404 by e-mail (masked in logs)', 'NOT_FOUND', async () => {
    try {
      return await contactRepository.getByEmail(NON_EXISTENT_EMAIL);
    } catch (error) {
      throw handleHubSpotErrors(error, { operation: 'getContactByEmail' });
    }
  });

  await expectFailure('4/4 Real 400, limit above the documented maximum', 'VALIDATION_ERROR', async () => {
    try {
      return await contactRepository.list({ limit: 1000 });
    } catch (error) {
      throw handleHubSpotErrors(error, { operation: 'listContacts(limit=1000)' });
    }
  });

  heading('Summary');
  let mismatches = 0;
  for (const item of results) {
    const ok = item.got === item.expected;
    if (!ok) mismatches += 1;
    line(ok ? 'ok' : 'warn', `${item.label.padEnd(50)} expected ${item.expected}, got ${item.got}`);
  }
  process.exitCode = mismatches === 0 ? 0 : 1;
}

main().catch((error) => {
  printError(error, { prefix: 'Unexpected failure' });
  process.exitCode = 1;
});
