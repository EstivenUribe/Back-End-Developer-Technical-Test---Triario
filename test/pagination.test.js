'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { paginateAll, getNextCursor, MAX_PAGE_SIZE } = require('../src/utils/pagination');

describe('getNextCursor', () => {
  test('returns the after cursor or null', () => {
    assert.equal(getNextCursor({ paging: { next: { after: '123' } } }), '123');
    assert.equal(getNextCursor({ results: [] }), null);
    assert.equal(getNextCursor(null), null);
  });
});

describe('paginateAll', () => {
  test('follows paging.next.after until it disappears and concatenates results', async () => {
    const calls = [];
    const pages = {
      undefined: { results: [1, 2], paging: { next: { after: 'c1' } } },
      c1: { results: [3], paging: { next: { after: 'c2' } } },
      c2: { results: [4, 5] },
    };
    const results = await paginateAll(async (params) => {
      calls.push(params);
      return pages[params.after];
    });
    assert.deepEqual(results, [1, 2, 3, 4, 5]);
    assert.deepEqual(calls, [
      { limit: MAX_PAGE_SIZE },
      { limit: MAX_PAGE_SIZE, after: 'c1' },
      { limit: MAX_PAGE_SIZE, after: 'c2' },
    ]);
  });

  test('caps the page size at 100 and honours maxPages', async () => {
    const calls = [];
    const results = await paginateAll(
      async (params) => {
        calls.push(params.limit);
        return { results: ['x'], paging: { next: { after: 'more' } } };
      },
      { limit: 500, maxPages: 2 }
    );
    assert.deepEqual(calls, [100, 100]);
    assert.equal(results.length, 2);
  });

  test('reports progress through onPage', async () => {
    const seen = [];
    await paginateAll(async () => ({ results: [] }), { onPage: (_page, number) => seen.push(number) });
    assert.deepEqual(seen, [1]);
  });
});
