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
  computeChangedProperties,
  createSummary,
  summarizeCounts,
} = require('../src/utils/syncHelpers');
const { DEAL_EXTERNAL_ID_PROPERTY } = require('../src/services/syncService');

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

describe('computeChangedProperties', () => {
  test('compares as trimmed strings and ignores unchanged or undefined values', () => {
    const remote = { firstname: 'Laura', phone: '+57 300', amount: '1200.5', company: null };
    assert.deepEqual(computeChangedProperties({ firstname: ' Laura ', phone: '+57 301', amount: 1200.5, company: 'Example Co', x: undefined }, remote), {
      phone: '+57 301',
      company: 'Example Co',
    });
    assert.deepEqual(computeChangedProperties({ firstname: 'Laura' }, remote), {});
    assert.deepEqual(computeChangedProperties({ firstname: 'Laura' }, undefined), { firstname: 'Laura' });
  });
});

describe('summary helpers', () => {
  test('createSummary and summarizeCounts', () => {
    const summary = createSummary('contacts', 3);
    summary.created.push({ index: 0 });
    summary.unchanged.push({ index: 1 }, { index: 2 });
    assert.deepEqual(summarizeCounts(summary), { total: 3, created: 1, updated: 0, unchanged: 2, skipped: 0, failed: 0, aborted: null });
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
