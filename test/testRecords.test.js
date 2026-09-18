'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildTestContact, isProjectTestContact, TEST_COMPANY } = require('../src/examples/testRecords');

describe('testRecords (delete safety guard)', () => {
  test('buildTestContact produces a unique reserved-domain address and the marker company', () => {
    const contact = buildTestContact();
    assert.match(contact.email, /^triario\.test\.\d+@example\.com$/);
    assert.equal(contact.company, TEST_COMPANY);
    assert.equal(buildTestContact({ email: 'x@example.org' }).email, 'x@example.org');
  });

  test('recognises project test contacts by reserved domain or marker company', () => {
    assert.equal(isProjectTestContact({ properties: { email: 'a@example.com' } }), true);
    assert.equal(isProjectTestContact({ properties: { email: 'A@EXAMPLE.ORG' } }), true);
    assert.equal(isProjectTestContact({ properties: { email: 'real@gmail.com', company: TEST_COMPANY } }), true);
  });

  test('refuses real-looking contacts', () => {
    assert.equal(isProjectTestContact({ properties: { email: 'someone@gmail.com', company: 'Acme' } }), false);
    assert.equal(isProjectTestContact({ properties: { email: null, company: null } }), false);
    assert.equal(isProjectTestContact({ properties: {} }), false);
    assert.equal(isProjectTestContact({}), false);
    // "example.com.co" is not a reserved domain
    assert.equal(isProjectTestContact({ properties: { email: 'x@example.com.co' } }), false);
  });
});
