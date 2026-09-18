'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, getPortalUrl, ConfigError, DEFAULTS, REQUIRED_SCOPES } = require('../src/config');

describe('config.loadConfig', () => {
  test('throws a clear error when the token is missing', () => {
    assert.throws(() => loadConfig({ env: {} }), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /HUBSPOT_ACCESS_TOKEN is missing/);
      return true;
    });
  });

  test('explains that API keys are no longer supported', () => {
    assert.throws(() => loadConfig({ env: { HUBSPOT_API_KEY: 'legacy' } }), /no longer supports API keys/);
  });

  test('does not require the token when requireToken is false', () => {
    const config = loadConfig({ env: {}, requireToken: false });
    assert.equal(config.hubspot.accessToken, '');
    assert.equal(config.hubspot.baseUrl, DEFAULTS.baseUrl);
    // No invented ids: pipeline and stage stay empty until the user copies real ones from the portal.
    assert.equal(config.hubspot.pipelineId, '');
    assert.equal(config.hubspot.stageId, '');
  });

  test('validates HUBSPOT_PORTAL_ID as numeric and builds the portal URL', () => {
    assert.throws(() => loadConfig({ env: { HUBSPOT_ACCESS_TOKEN: 'x', HUBSPOT_PORTAL_ID: 'abc' } }), /HUBSPOT_PORTAL_ID/);
    const config = loadConfig({ env: { HUBSPOT_ACCESS_TOKEN: 'x', HUBSPOT_PORTAL_ID: '12345' } });
    assert.equal(config.hubspot.portalId, '12345');
    assert.equal(getPortalUrl(config.hubspot.portalId), 'https://app.hubspot.com/contacts/12345');
    assert.equal(getPortalUrl(''), null);
    // The API base URL and the portal URL are different hosts.
    assert.notEqual(new URL(config.hubspot.baseUrl).host, new URL(getPortalUrl('1')).host);
  });

  test('lists the required scopes', () => {
    assert.ok(REQUIRED_SCOPES.includes('crm.objects.contacts.read'));
    assert.ok(REQUIRED_SCOPES.includes('crm.schemas.deals.write'));
    assert.equal(REQUIRED_SCOPES.length, 7);
  });

  test('parses integers and strips trailing slashes from the base URL', () => {
    const config = loadConfig({
      env: {
        HUBSPOT_ACCESS_TOKEN: 'x',
        HUBSPOT_BASE_URL: 'https://api.hubapi.com///',
        HUBSPOT_TIMEOUT_MS: '2500',
        HUBSPOT_MAX_RETRIES: '0',
        HUBSPOT_PIPELINE_ID: ' pipe ',
        LOG_LEVEL: 'DEBUG',
      },
    });
    assert.equal(config.hubspot.baseUrl, 'https://api.hubapi.com');
    assert.equal(config.hubspot.timeoutMs, 2500);
    assert.equal(config.hubspot.maxRetries, 0);
    assert.equal(config.hubspot.pipelineId, 'pipe');
    assert.equal(config.logLevel, 'debug');
    assert.ok(Object.isFrozen(config.hubspot));
  });

  test('rejects invalid integers and log levels', () => {
    assert.throws(() => loadConfig({ env: { HUBSPOT_ACCESS_TOKEN: 'x', HUBSPOT_TIMEOUT_MS: 'abc' } }), /HUBSPOT_TIMEOUT_MS/);
    assert.throws(() => loadConfig({ env: { HUBSPOT_ACCESS_TOKEN: 'x', LOG_LEVEL: 'loud' } }), /LOG_LEVEL/);
  });

  test('exposes the documented API paths', () => {
    const { paths } = loadConfig({ env: {}, requireToken: false }).hubspot;
    assert.equal(paths.contacts, '/crm/v3/objects/contacts');
    assert.equal(paths.deals, '/crm/v3/objects/deals');
    assert.equal(paths.search('contacts'), '/crm/objects/2026-09/contacts/search');
  });
});
