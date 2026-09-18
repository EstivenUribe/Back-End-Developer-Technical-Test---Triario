'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  toDealSummary,
  findStage,
  buildDealProperties,
  findAssociation,
  pickUnlabeledType,
  OBJECT_TYPES,
} = require('../src/utils/dealHelpers');
const { collectPages } = require('../src/utils/pagination');
const { buildTestDeal, isProjectTestDeal, TEST_DEAL_PREFIX } = require('../src/examples/testRecords');

const pipeline = {
  id: '4664657',
  label: 'Tests',
  stages: [
    { id: '4664658', label: 'Vacante abierta', displayOrder: 0 },
    { id: '4664661', label: 'Pruebas', displayOrder: 3 },
  ],
};

describe('findStage', () => {
  test('finds a stage by id regardless of string/number type', () => {
    assert.equal(findStage(pipeline, '4664661').label, 'Pruebas');
    assert.equal(findStage(pipeline, 4664658).label, 'Vacante abierta');
  });
  test('returns null when the stage is not in the pipeline', () => {
    assert.equal(findStage(pipeline, 'closedwon'), null);
    assert.equal(findStage({}, '1'), null);
  });
});

describe('buildDealProperties', () => {
  test('uses the official property names pipeline and dealstage', () => {
    const properties = buildDealProperties('Deal', 1500, { pipelineId: 'p', stageId: 's', properties: { closedate: '2026-12-31' } });
    assert.deepEqual(properties, { closedate: '2026-12-31', dealname: 'Deal', pipeline: 'p', dealstage: 's', amount: 1500 });
    assert.equal('hs_pipeline' in properties, false);
    assert.equal('hs_stage' in properties, false);
  });
  test('extra properties cannot override the arguments', () => {
    const properties = buildDealProperties('Deal', 1, { pipelineId: 'p', stageId: 's', properties: { dealname: 'x', pipeline: 'y' } });
    assert.equal(properties.dealname, 'Deal');
    assert.equal(properties.pipeline, 'p');
  });
  test('omits amount when not given', () => {
    assert.equal('amount' in buildDealProperties('Deal', undefined, { pipelineId: 'p', stageId: 's' }), false);
  });
});

describe('toDealSummary', () => {
  test('flattens a HubSpot deal', () => {
    assert.deepEqual(toDealSummary({ id: '1', properties: { dealname: 'x' }, createdAt: 'a', updatedAt: 'b', archived: false }), {
      id: '1',
      properties: { dealname: 'x' },
      createdAt: 'a',
      updatedAt: 'b',
      archived: false,
    });
  });
});

describe('association helpers', () => {
  const results = [
    { toObjectId: 111, associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 4, label: null }] },
    { toObjectId: 222, associationTypes: [{ category: 'USER_DEFINED', typeId: 91, label: 'Sponsor' }] },
  ];
  test('findAssociation matches ids as strings or numbers', () => {
    assert.equal(findAssociation(results, '111').associationTypes[0].typeId, 4);
    assert.equal(findAssociation(results, 222).associationTypes[0].label, 'Sponsor');
    assert.equal(findAssociation(results, '333'), null);
    assert.equal(findAssociation(undefined, '1'), null);
  });
  test('pickUnlabeledType selects the HubSpot-defined unlabeled type only', () => {
    const labels = [
      { category: 'USER_DEFINED', typeId: 91, label: 'Sponsor' },
      { category: 'HUBSPOT_DEFINED', typeId: 4, label: null },
    ];
    assert.equal(pickUnlabeledType(labels).typeId, 4);
    assert.equal(pickUnlabeledType([{ category: 'USER_DEFINED', typeId: 91, label: 'Sponsor' }]), null);
    assert.equal(pickUnlabeledType([]), null);
  });
  test('object type names are the singular documented ones', () => {
    assert.deepEqual(OBJECT_TYPES, { contact: 'contact', deal: 'deal' });
  });
});

describe('collectPages', () => {
  test('reports pages read and the unread cursor when capped', async () => {
    const pages = { undefined: { results: [1], paging: { next: { after: 'a' } } }, a: { results: [2], paging: { next: { after: 'b' } } }, b: { results: [3] } };
    const capped = await collectPages(async ({ after }) => pages[after], { maxPages: 2 });
    assert.deepEqual(capped, { results: [1, 2], pages: 2, nextAfter: 'b' });
    const full = await collectPages(async ({ after }) => pages[after]);
    assert.deepEqual(full, { results: [1, 2, 3], pages: 3, nextAfter: null });
  });
});

describe('testRecords (deal safety guard)', () => {
  test('buildTestDeal uses the marker prefix', () => {
    const deal = buildTestDeal();
    assert.ok(deal.dealName.startsWith(TEST_DEAL_PREFIX));
    assert.equal(deal.amount, 1500);
    assert.equal(buildTestDeal({ amount: 9 }).amount, 9);
  });
  test('recognises project deals by name prefix or sync external id, refuses others', () => {
    assert.equal(isProjectTestDeal({ properties: { dealname: `${TEST_DEAL_PREFIX}x` } }), true);
    assert.equal(isProjectTestDeal({ properties: { dealname: 'Real deal', external_id: 'SRC-DEAL-0001' } }), true);
    assert.equal(isProjectTestDeal({ properties: { dealname: 'Website redesign - Example Co' } }), false);
    assert.equal(isProjectTestDeal({ properties: { dealname: null } }), false);
    assert.equal(isProjectTestDeal({}), false);
  });
});
