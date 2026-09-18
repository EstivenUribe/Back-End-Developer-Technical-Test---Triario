'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildFullName, toContactSummary, DEFAULT_CONTACT_PROPERTIES } = require('../src/utils/contactHelpers');
const { validateSearchFilters, validatePageSize, PayloadValidationError } = require('../src/utils/validateHubSpotPayload');

describe('buildFullName', () => {
  test('joins firstname and lastname with a single space, trimmed', () => {
    assert.equal(buildFullName({ firstname: '  Ana ', lastname: ' Torres  ' }), 'Ana Torres');
    assert.equal(buildFullName({ firstname: 'Ana  María', lastname: 'de la  Torre' }), 'Ana María de la Torre');
  });
  test('uses the only part available when one is missing', () => {
    assert.equal(buildFullName({ firstname: 'Ana' }), 'Ana');
    assert.equal(buildFullName({ firstname: '', lastname: 'Torres' }), 'Torres');
    assert.equal(buildFullName({ firstname: null, lastname: 'Torres' }), 'Torres');
  });
  test('returns an empty string when both are missing', () => {
    assert.equal(buildFullName({}), '');
    assert.equal(buildFullName({ firstname: '  ', lastname: null }), '');
    assert.equal(buildFullName(undefined), '');
  });
});

describe('toContactSummary', () => {
  test('flattens a HubSpot contact', () => {
    const summary = toContactSummary({
      id: '42',
      properties: { firstname: 'Ana', lastname: 'Torres', email: 'a@example.org' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      archived: false,
    });
    assert.deepEqual(summary, {
      id: '42',
      fullName: 'Ana Torres',
      properties: { firstname: 'Ana', lastname: 'Torres', email: 'a@example.org' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      archived: false,
    });
    assert.ok(DEFAULT_CONTACT_PROPERTIES.includes('email'));
  });
});

describe('validatePageSize', () => {
  test('accepts integers within range, as numbers or strings', () => {
    assert.equal(validatePageSize(5, { max: 100 }), 5);
    assert.equal(validatePageSize('100', { max: 100 }), 100);
    assert.equal(validatePageSize(undefined, { max: 100, fallback: 10 }), 10);
  });
  test('rejects out-of-range or non-integer values before any request', () => {
    for (const bad of [0, 101, -1, 1.5, 'abc']) {
      assert.throws(() => validatePageSize(bad, { max: 100, label: 'limit' }), /between 1 and 100/);
    }
  });
});

describe('validateSearchFilters', () => {
  test('normalizes documented operators and keeps values', () => {
    const filters = validateSearchFilters([
      { propertyName: ' company ', operator: 'eq', value: 'Triario Technical Test' },
      { propertyName: 'firstname', operator: 'HAS_PROPERTY' },
      { propertyName: 'lifecyclestage', operator: 'IN', values: ['lead', 'customer'] },
      { propertyName: 'createdate', operator: 'BETWEEN', value: '1', highValue: '2' },
    ]);
    assert.deepEqual(filters, [
      { propertyName: 'company', operator: 'EQ', value: 'Triario Technical Test' },
      { propertyName: 'firstname', operator: 'HAS_PROPERTY' },
      { propertyName: 'lifecyclestage', operator: 'IN', values: ['lead', 'customer'] },
      { propertyName: 'createdate', operator: 'BETWEEN', value: '1', highValue: '2' },
    ]);
  });

  test('rejects unknown operators, missing values and empty arrays', () => {
    assert.throws(() => validateSearchFilters([]), /non-empty array/);
    assert.throws(() => validateSearchFilters([{ propertyName: 'email', operator: 'LIKE', value: 'x' }]), /operator/);
    assert.throws(() => validateSearchFilters([{ propertyName: 'email', operator: 'EQ' }]), /value.*required/);
    assert.throws(() => validateSearchFilters([{ propertyName: 'x', operator: 'IN', values: [] }]), /values/);
    assert.throws(() => validateSearchFilters([{ propertyName: 'x', operator: 'BETWEEN', value: '1' }]), /highValue/);
    assert.throws(() => validateSearchFilters([{ operator: 'EQ', value: '1' }]), /propertyName/);
    assert.throws(
      () => validateSearchFilters(new Array(7).fill({ propertyName: 'x', operator: 'EQ', value: '1' })),
      (error) => error instanceof PayloadValidationError && /at most 6/.test(error.message)
    );
  });
});
