'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  SyncSourceError,
  loadJsonArray,
  assertRecordArray,
  partitionByKey,
  datesEquivalent,
  computeChangedProperties,
  createSummary,
  applyDealResult,
  summarizeCounts,
  hasSyncFailures,
  isAbortError,
  ABORT_CODES,
} = require('../src/utils/syncHelpers');
const { DEAL_EXTERNAL_ID_PROPERTY } = require('../src/services/syncService');
const { ERROR_CODES } = require('../src/utils/handleHubSpotErrors');

describe('loadJsonArray / assertRecordArray', () => {
  test('loads an array of objects and rejects everything else', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-'));
    const good = path.join(dir, 'good.json');
    await fs.writeFile(good, JSON.stringify([{ email: 'a@example.com' }]));
    assert.deepEqual(await loadJsonArray(good), [{ email: 'a@example.com' }]);

    const notArray = path.join(dir, 'obj.json');
    await fs.writeFile(notArray, '{"email":"a@example.com"}');
    await assert.rejects(loadJsonArray(notArray), (e) => e instanceof SyncSourceError && /array/.test(e.message));

    const broken = path.join(dir, 'broken.json');
    await fs.writeFile(broken, '[{');
    await assert.rejects(loadJsonArray(broken), /not valid JSON/);

    await assert.rejects(loadJsonArray(path.join(dir, 'missing.json')), /Cannot read/);
    assert.throws(() => assertRecordArray([{ a: 1 }, 'x', null]), (e) => e instanceof SyncSourceError && e.details.length === 2);
  });
});

describe('partitionByKey', () => {
  test('first occurrence wins, duplicates and invalid records are reported', () => {
    const records = [{ email: 'A@x.co' }, { email: '' }, { email: 'a@x.co' }, { email: 'b@x.co' }];
    const result = partitionByKey(records, (r) => {
      const key = (r.email || '').trim().toLowerCase();
      return key ? { key } : { reason: 'MISSING_EMAIL', message: 'no email' };
    });
    assert.deepEqual(result.unique.map((u) => [u.index, u.key]), [[0, 'a@x.co'], [3, 'b@x.co']]);
    assert.deepEqual(result.duplicates, [{ index: 2, key: 'a@x.co', duplicateOf: 0 }]);
    assert.deepEqual(result.invalid, [{ index: 1, reason: 'MISSING_EMAIL', message: 'no email' }]);
  });
});

describe('datesEquivalent', () => {
  test('treats the same instant in different notations as equal', () => {
    assert.equal(datesEquivalent('2026-09-18T00:00:00Z', '2026-09-18T00:00:00.000Z'), true);
    assert.equal(datesEquivalent('2026-09-18T00:00:00.000Z', '2026-09-18T02:00:00+02:00'), true);
    assert.equal(datesEquivalent('2026-09-18T00:00:00Z', String(Date.UTC(2026, 8, 18))), true); // epoch ms as text
    assert.equal(datesEquivalent(Date.UTC(2026, 8, 18), '2026-09-18T00:00:00Z'), true);
  });
  test('detects different instants', () => {
    assert.equal(datesEquivalent('2026-09-18T00:00:00Z', '2026-09-18T00:00:01Z'), false);
    assert.equal(datesEquivalent('2026-09-18T00:00:00Z', '2026-09-19T00:00:00Z'), false);
  });
  test('empty values: both empty equal, one empty different', () => {
    assert.equal(datesEquivalent('', null), true);
    assert.equal(datesEquivalent(undefined, ''), true);
    assert.equal(datesEquivalent('', '2026-09-18T00:00:00Z'), false);
    assert.equal(datesEquivalent('2026-09-18T00:00:00Z', null), false);
  });
  test('invalid dates fall back to text comparison, never guessed', () => {
    assert.equal(datesEquivalent('not-a-date', 'not-a-date'), true);
    assert.equal(datesEquivalent('not-a-date', '2026-09-18T00:00:00Z'), false);
    assert.equal(datesEquivalent('2026-09-18T00:00:00Z', 'soon'), false);
  });
});

describe('computeChangedProperties', () => {
  const remote = { firstname: 'Laura', phone: '+57 300', amount: '1200.5', company: null, closedate: '2026-12-31T00:00:00Z' };

  test('compares text properties as trimmed strings and ignores undefined values', () => {
    assert.deepEqual(computeChangedProperties({ firstname: ' Laura ', phone: '+57 301', amount: 1200.5, company: 'Example Co', x: undefined }, remote), {
      phone: '+57 301',
      company: 'Example Co',
    });
    assert.deepEqual(computeChangedProperties({ firstname: 'Laura' }, remote), {});
    assert.deepEqual(computeChangedProperties({ firstname: 'Laura' }, undefined), { firstname: 'Laura' });
  });

  test('does not interpret arbitrary strings as dates: only declared date properties', () => {
    // As text these differ; without dateProperties closedate is reported as changed (regression).
    assert.deepEqual(computeChangedProperties({ closedate: '2026-12-31T00:00:00.000Z' }, remote), { closedate: '2026-12-31T00:00:00.000Z' });
    // Declared as a date, the same instant is unchanged.
    assert.deepEqual(computeChangedProperties({ closedate: '2026-12-31T00:00:00.000Z' }, remote, { dateProperties: ['closedate'] }), {});
    // A different instant is still a change.
    assert.deepEqual(computeChangedProperties({ closedate: '2027-01-01T00:00:00Z' }, remote, { dateProperties: ['closedate'] }), { closedate: '2027-01-01T00:00:00Z' });
    // A text property that happens to look like a number/date keeps text semantics.
    assert.deepEqual(computeChangedProperties({ amount: '1200.50' }, remote, { dateProperties: ['closedate'] }), { amount: '1200.50' });
  });

  test('clearing a date: empty or null desired value is a change sent as an empty string', () => {
    assert.deepEqual(computeChangedProperties({ closedate: '' }, remote, { dateProperties: ['closedate'] }), { closedate: '' });
    assert.deepEqual(computeChangedProperties({ closedate: null }, remote, { dateProperties: ['closedate'] }), { closedate: '' });
    assert.deepEqual(computeChangedProperties({ closedate: '' }, { closedate: null }, { dateProperties: ['closedate'] }), {});
  });

  test('invalid date on either side falls back to text comparison', () => {
    assert.deepEqual(computeChangedProperties({ closedate: 'soon' }, remote, { dateProperties: ['closedate'] }), { closedate: 'soon' });
    assert.deepEqual(computeChangedProperties({ closedate: 'soon' }, { closedate: 'soon' }, { dateProperties: ['closedate'] }), {});
  });
});

describe('summary helpers', () => {
  test('createSummary and summarizeCounts include the partial bucket', () => {
    const summary = createSummary('deals', 4);
    summary.created.push({ index: 0 });
    summary.unchanged.push({ index: 1 }, { index: 2 });
    summary.partial.push({ index: 3 });
    assert.deepEqual(summarizeCounts(summary), { total: 4, created: 1, updated: 0, unchanged: 2, partial: 1, skipped: 0, failed: 0, aborted: null });
  });

  test('applyDealResult counts a saved deal with a failed association once, as partial, keeping its id', () => {
    const summary = createSummary('deals', 3);
    const bucket = applyDealResult(
      summary,
      { index: 0, key: 'SRC-1', id: '111', association: { contactEmail: 'a@example.com', status: 'failed', reason: 'SERVER_ERROR' } },
      'created'
    );
    assert.equal(bucket, 'partial');
    assert.deepEqual(summary.partial, [
      { index: 0, key: 'SRC-1', id: '111', association: { contactEmail: 'a@example.com', status: 'failed', reason: 'SERVER_ERROR' }, dealStatus: 'created' },
    ]);
    assert.equal(summary.created.length, 0);
    assert.equal(summary.failed.length, 0);
  });

  test('applyDealResult keeps a skipped (CONTACT_NOT_FOUND) association under the deal status', () => {
    const summary = createSummary('deals', 3);
    applyDealResult(summary, { index: 1, key: 'SRC-2', id: '222', association: { status: 'skipped', reason: 'CONTACT_NOT_FOUND' } }, 'unchanged');
    applyDealResult(summary, { index: 2, key: 'SRC-3', id: '333', changedProperties: ['amount'], association: { status: 'already' } }, 'updated');
    assert.equal(summary.partial.length, 0);
    assert.equal(summary.unchanged[0].association.reason, 'CONTACT_NOT_FOUND');
    assert.deepEqual(summary.updated[0].changedProperties, ['amount']);
  });

  test('hasSyncFailures is true for failed records, partial failures or an abort', () => {
    assert.equal(hasSyncFailures({ failed: 0, partial: 0, aborted: null }), false);
    assert.equal(hasSyncFailures({ failed: 1, partial: 0, aborted: null }), true);
    assert.equal(hasSyncFailures({ failed: 0, partial: 1, aborted: null }), true);
    assert.equal(hasSyncFailures({ failed: 0, partial: 0, aborted: 'AUTHENTICATION_ERROR' }), true);
  });

  test('isAbortError recognises 401/403 only', () => {
    assert.deepEqual(ABORT_CODES, ['AUTHENTICATION_ERROR', 'AUTHORIZATION_ERROR']);
    assert.equal(isAbortError({ code: ERROR_CODES.AUTHENTICATION_ERROR }), true);
    assert.equal(isAbortError({ code: ERROR_CODES.AUTHORIZATION_ERROR }), true);
    assert.equal(isAbortError({ code: ERROR_CODES.SERVER_ERROR }), false);
    assert.equal(isAbortError({ code: ERROR_CODES.NOT_FOUND }), false);
    assert.equal(isAbortError(null), false);
  });
});

describe('deal external_id property definition', () => {
  test('is a unique text property in the deal information group', () => {
    assert.equal(DEAL_EXTERNAL_ID_PROPERTY.name, 'external_id');
    assert.equal(DEAL_EXTERNAL_ID_PROPERTY.type, 'string');
    assert.equal(DEAL_EXTERNAL_ID_PROPERTY.fieldType, 'text');
    assert.equal(DEAL_EXTERNAL_ID_PROPERTY.hasUniqueValue, true);
    assert.equal(DEAL_EXTERNAL_ID_PROPERTY.groupName, 'dealinformation');
  });
});
