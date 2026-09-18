'use strict';

/**
 * hubSpotApiHandler — shared runner for the executable example scripts.
 *
 * Every script in src/examples/ calls `runExample(name, operation)`:
 * - prints a heading, runs the async operation, prints the result as JSON;
 * - on failure prints a readable, redacted error block and sets exit code 1;
 * - never prints the token (errors are normalized upstream and the logger redacts).
 *
 * `parseCliArgs` wraps util.parseArgs so scripts share one argument style:
 *   node src/examples/get-contacts.js --limit 5 --after <cursor>
 */

const { parseArgs } = require('util');
const { ConfigError } = require('../config');
const { HubSpotError } = require('../utils/handleHubSpotErrors');
const { PayloadValidationError } = require('../utils/validateHubSpotPayload');
const logger = require('../utils/logger');

const SYMBOLS = { ok: 'OK ', fail: 'ERR', warn: '!  ', info: '-  ' };

function line(symbol, message) {
  console.log(`${SYMBOLS[symbol] || '   '} ${message}`);
}

function heading(title) {
  console.log(`\n=== ${title} ===`);
}

/** Operator-facing output: secrets are always redacted; e-mails stay readable (this is not a log). */
function printJson(value) {
  console.log(JSON.stringify(logger.redact(value, { maskEmails: false }), null, 2));
}

/** Prints a human-readable, redacted description of any error. */
function printError(error, { prefix = 'Operation failed' } = {}) {
  const alreadyLogged = Boolean(error && error.logged);
  if (error instanceof ConfigError) {
    line('fail', `${prefix}: configuration error`);
    console.error(alreadyLogged ? '    (details in the log line above)' : `    ${error.message}`);
    return;
  }
  if (error instanceof PayloadValidationError) {
    line('fail', `${prefix}: invalid payload (nothing was sent to HubSpot)`);
    if (alreadyLogged) console.error('    (details in the log line above)');
    else for (const item of error.errors) console.error(`    - ${item.field}: ${item.message}`);
    return;
  }
  if (error instanceof HubSpotError) {
    const status = error.status ? `HTTP ${error.status}` : 'no HTTP response';
    line('fail', `${prefix}: ${error.code} (${status})`);
    if (error.logged) {
      // handleHubSpotErrors already wrote the full record: do not duplicate it.
      console.error('    (details in the log line above)');
    } else {
      console.error(`    ${error.message}`);
      if (error.method && error.url) console.error(`    request: ${error.method} ${error.url}`);
      if (error.category) console.error(`    category: ${error.category}`);
      if (error.correlationId) console.error(`    correlationId: ${error.correlationId}`);
      if (error.attempts) console.error(`    attempts: ${error.attempts}`);
      for (const detail of error.details || []) {
        console.error(`    - ${detail.message || JSON.stringify(logger.redact(detail))}`);
      }
    }
    if (error.outcomeUncertain) {
      console.error('    outcome uncertain: HubSpot may have processed the request. Look the record up before creating it again.');
    }
    return;
  }
  line('fail', `${prefix}: ${error && error.name ? error.name : 'Error'}`);
  console.error(alreadyLogged ? '    (details in the log line above)' : `    ${logger.redact(error && error.message ? error.message : String(error))}`);
}

/**
 * Runs one example operation with uniform output and exit codes.
 *
 * @param {string} name
 * @param {() => Promise<any>} operation
 * @param {object} [options]
 * @param {boolean} [options.printResult=true]
 * @returns {Promise<any>} the operation result, or undefined on failure
 */
async function runExample(name, operation, { printResult = true } = {}) {
  heading(name);
  const startedAt = Date.now();
  try {
    const result = await operation();
    if (printResult && result !== undefined) printJson(result);
    line('ok', `${name} finished in ${Date.now() - startedAt} ms`);
    return result;
  } catch (error) {
    printError(error);
    process.exitCode = 1;
    return undefined;
  }
}

/**
 * @param {object} options  util.parseArgs `options` map
 * @param {object} [extra]
 * @param {boolean} [extra.allowPositionals=true]
 */
function parseCliArgs(options, { allowPositionals = true } = {}) {
  try {
    return parseArgs({ options, allowPositionals, strict: true });
  } catch (error) {
    line('fail', `Invalid arguments: ${error.message}`);
    process.exit(1);
  }
  return undefined;
}

module.exports = { runExample, printError, parseCliArgs, heading, line, printJson };
