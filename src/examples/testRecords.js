'use strict';

/**
 * Markers for records created by this project, so the examples never touch real data.
 *
 * - Test contacts use an address under a reserved documentation domain (RFC 2606) and
 *   the company "Triario Technical Test".
 * - delete-contact.js refuses to delete anything that does not look like a test record
 *   unless --force is given.
 */

const TEST_COMPANY = 'Triario Technical Test';
const TEST_EMAIL_DOMAINS = Object.freeze(['example.com', 'example.org', 'example.net', 'example.invalid']);

/** Builds properties for a new, uniquely addressed test contact. */
function buildTestContact(overrides = {}) {
  const stamp = Date.now();
  return {
    email: `triario.test.${stamp}@example.com`,
    firstname: 'Test',
    lastname: `Contact ${stamp}`,
    company: TEST_COMPANY,
    ...overrides,
  };
}

/** True when the contact was created by this project (by e-mail domain or company). */
function isProjectTestContact(contact) {
  const properties = (contact && contact.properties) || {};
  const email = typeof properties.email === 'string' ? properties.email.toLowerCase() : '';
  const domain = email.includes('@') ? email.split('@').pop() : '';
  return TEST_EMAIL_DOMAINS.includes(domain) || properties.company === TEST_COMPANY;
}

const TEST_DEAL_PREFIX = 'Triario Test - ';

/** Builds arguments for a new test deal: { dealName, amount }. */
function buildTestDeal(overrides = {}) {
  return { dealName: `${TEST_DEAL_PREFIX}${Date.now()}`, amount: 1500, ...overrides };
}

/** True when the deal was created by this project (name prefix or sync external id). */
function isProjectTestDeal(deal) {
  const properties = (deal && deal.properties) || {};
  const name = typeof properties.dealname === 'string' ? properties.dealname : '';
  const externalId = typeof properties.external_id === 'string' ? properties.external_id : '';
  return name.startsWith(TEST_DEAL_PREFIX) || externalId.startsWith('SRC-');
}

module.exports = {
  TEST_COMPANY,
  TEST_EMAIL_DOMAINS,
  TEST_DEAL_PREFIX,
  buildTestContact,
  isProjectTestContact,
  buildTestDeal,
  isProjectTestDeal,
};
