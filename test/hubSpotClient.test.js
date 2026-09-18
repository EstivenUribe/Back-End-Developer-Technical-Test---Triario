'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createHubSpotClient, IDEMPOTENT_METHODS } = require('../src/clients/hubSpotClient');
const { loadConfig } = require('../src/config');
const logger = require('../src/utils/logger');

describe('hubSpotClient.createHubSpotClient', () => {
  const config = loadConfig({
    env: { HUBSPOT_ACCESS_TOKEN: 'pat-na1-unit-test-token', HUBSPOT_TIMEOUT_MS: '1234', HUBSPOT_MAX_RETRIES: '2' },
  });

  test('builds a client from an explicit config without touching process.env', () => {
    const client = createHubSpotClient({ config });
    assert.equal(client.settings.baseUrl, 'https://api.hubapi.com');
    assert.equal(client.settings.timeoutMs, 1234);
    assert.equal(client.settings.maxRetries, 2);
    assert.equal(client.settings.paths.contacts, '/crm/v3/objects/contacts');
    for (const method of ['request', 'get', 'post', 'patch', 'put', 'delete']) {
      assert.equal(typeof client[method], 'function');
    }
  });

  test('never exposes the token through its public settings', () => {
    const client = createHubSpotClient({ config });
    assert.doesNotMatch(JSON.stringify(client.settings), /unit-test-token/);
  });

  test('logger.redact masks Authorization headers, token-looking strings and e-mails', () => {
    const redacted = logger.redact({
      headers: { Authorization: 'Bearer pat-na1-unit-test-token' },
      note: 'sent Bearer pat-na1-unit-test-token to api',
      nested: [{ access_token: 'x' }],
      properties: { email: 'jane.doe@example.com' },
      url: '/crm/v3/objects/contacts/jane.doe@example.com?idProperty=email',
    });
    assert.equal(redacted.headers.Authorization, '[REDACTED]');
    assert.doesNotMatch(redacted.note, /unit-test-token/);
    assert.equal(redacted.nested[0].access_token, '[REDACTED]');
    assert.equal(redacted.properties.email, 'j***@example.com');
    assert.equal(redacted.url, '/crm/v3/objects/contacts/j***@example.com?idProperty=email');
    assert.equal(logger.maskPersonalData('contact a@b.co and c@d.org'), 'contact a***@b.co and c***@d.org');
  });

  test('treats GET/PUT/PATCH/DELETE as idempotent and POST as not', () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.ok(IDEMPOTENT_METHODS.has(method));
    assert.equal(IDEMPOTENT_METHODS.has('POST'), false);
  });
});
