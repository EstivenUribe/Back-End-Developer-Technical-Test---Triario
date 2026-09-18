'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { validateHubSpotPayload, validateHubSpotId, PayloadValidationError, normalizeEmail } = require('../src/utils/validateHubSpotPayload');

describe('validateHubSpotId', () => {
  test('accepts numeric ids as numbers or strings', () => {
    assert.equal(validateHubSpotId(12345, 'contactId'), '12345');
    assert.equal(validateHubSpotId(' 67 ', 'dealId'), '67');
  });
  test('rejects anything else before it reaches a URL', () => {
    for (const bad of ['', 'abc', '12/34', null, undefined, {}, -1, 1.5]) {
      assert.throws(() => validateHubSpotId(bad, 'contactId'), (error) => {
        assert.ok(error instanceof PayloadValidationError);
        assert.match(error.message, /Invalid contactId/);
        return true;
      });
    }
  });
});

describe('normalizeEmail', () => {
  test('trims and lower-cases', () => {
    assert.equal(normalizeEmail('  Ana.Perez@Example.COM '), 'ana.perez@example.com');
    assert.equal(normalizeEmail(null), '');
  });
});

describe('validateHubSpotPayload - contacts', () => {
  test('accepts a valid contact and normalizes it', () => {
    const result = validateHubSpotPayload('contacts', {
      email: ' Jane.Doe@Example.com ',
      firstname: ' Jane ',
      lastname: 'Doe',
      phone: '+57 300 000 0000',
    });
    assert.deepEqual(result, {
      email: 'jane.doe@example.com',
      firstname: 'Jane',
      lastname: 'Doe',
      phone: '+57 300 000 0000',
    });
  });

  test('requires email on create', () => {
    assert.throws(() => validateHubSpotPayload('contacts', { firstname: 'NoEmail' }), (error) => {
      assert.ok(error instanceof PayloadValidationError);
      assert.deepEqual(error.errors.map((e) => e.field), ['email']);
      return true;
    });
  });

  test('rejects an invalid email format without echoing the value', () => {
    assert.throws(() => validateHubSpotPayload('contacts', { email: 'secret.person@nowhere' }), (error) => {
      assert.match(error.message, /valid email/);
      assert.doesNotMatch(error.message, /secret\.person/);
      return true;
    });
  });

  test('allows partial updates without email', () => {
    const result = validateHubSpotPayload('contacts', { lastname: 'Updated' }, { partial: true });
    assert.deepEqual(result, { lastname: 'Updated' });
  });

  test('rejects empty partial updates', () => {
    assert.throws(() => validateHubSpotPayload('contacts', {}, { partial: true }), /at least one property/);
  });

  test('passes unknown (custom) properties through untouched', () => {
    const result = validateHubSpotPayload('contacts', { email: 'a@b.co', custom_field: 'x' });
    assert.equal(result.custom_field, 'x');
  });

  test('rejects nested objects as property values', () => {
    assert.throws(() => validateHubSpotPayload('contacts', { email: 'a@b.co', address: { city: 'X' } }), /primitive/);
  });

  test('drops undefined values', () => {
    const result = validateHubSpotPayload('contacts', { email: 'a@b.co', firstname: undefined });
    assert.deepEqual(result, { email: 'a@b.co' });
  });
});

describe('validateHubSpotPayload - deals', () => {
  test('accepts a valid deal and converts amount to a string', () => {
    const result = validateHubSpotPayload('deals', {
      dealname: ' Big deal ',
      amount: 1500.5,
      pipeline: 'default',
      dealstage: 'appointmentscheduled',
    });
    assert.deepEqual(result, {
      dealname: 'Big deal',
      amount: '1500.5',
      pipeline: 'default',
      dealstage: 'appointmentscheduled',
    });
  });

  test('accepts numeric strings for amount', () => {
    const result = validateHubSpotPayload('deals', { dealname: 'x', amount: '99', pipeline: 'p', dealstage: 's' });
    assert.equal(result.amount, '99');
  });

  test('rejects negative or non-numeric amounts', () => {
    assert.throws(() => validateHubSpotPayload('deals', { dealname: 'x', amount: -1, pipeline: 'p', dealstage: 's' }), />= 0/);
    assert.throws(() => validateHubSpotPayload('deals', { dealname: 'x', amount: 'abc', pipeline: 'p', dealstage: 's' }), /finite number/);
  });

  test('requires dealname, pipeline and dealstage on create', () => {
    assert.throws(() => validateHubSpotPayload('deals', { amount: 1 }), (error) => {
      assert.deepEqual(error.errors.map((e) => e.field).sort(), ['dealname', 'dealstage', 'pipeline']);
      return true;
    });
  });

  test('rejects an empty dealname', () => {
    assert.throws(() => validateHubSpotPayload('deals', { dealname: '   ', pipeline: 'p', dealstage: 's' }), /dealname/);
  });

  test('normalizes closedate to canonical ISO 8601 and accepts epoch milliseconds', () => {
    const base = { dealname: 'x', pipeline: 'p', dealstage: 's' };
    assert.equal(validateHubSpotPayload('deals', { ...base, closedate: '2026-12-31T00:00:00Z' }).closedate, '2026-12-31T00:00:00.000Z');
    assert.equal(validateHubSpotPayload('deals', { ...base, closedate: '2026-12-31' }).closedate, '2026-12-31T00:00:00.000Z');
    assert.equal(validateHubSpotPayload('deals', { ...base, closedate: Date.UTC(2026, 11, 31) }).closedate, '2026-12-31T00:00:00.000Z');
    assert.equal(validateHubSpotPayload('deals', { ...base, closedate: String(Date.UTC(2026, 11, 31)) }).closedate, '2026-12-31T00:00:00.000Z');
  });

  test('closedate: empty string clears the property, invalid values are rejected', () => {
    const base = { dealname: 'x', pipeline: 'p', dealstage: 's' };
    assert.equal(validateHubSpotPayload('deals', { ...base, closedate: '' }).closedate, '');
    assert.equal(validateHubSpotPayload('deals', { ...base, closedate: null }).closedate, null);
    assert.throws(() => validateHubSpotPayload('deals', { ...base, closedate: 'next quarter' }), /closedate: must be an ISO 8601/);
    assert.throws(() => validateHubSpotPayload('deals', { closedate: 'soon' }, { partial: true }), /closedate/);
  });
});

describe('validateHubSpotPayload - generic', () => {
  test('rejects unsupported object types', () => {
    assert.throws(() => validateHubSpotPayload('tickets', {}), /unsupported object type/);
  });
  test('rejects non-object payloads', () => {
    assert.throws(() => validateHubSpotPayload('contacts', null), /must be an object/);
    assert.throws(() => validateHubSpotPayload('contacts', ['a']), /must be an object/);
  });
});
