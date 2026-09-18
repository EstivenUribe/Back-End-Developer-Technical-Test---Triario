'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { paginateAll, collectPages, findAcrossPages, getNextCursor, MAX_PAGE_SIZE } = require('../src/utils/pagination');

describe('collectPages with a larger endpoint maximum (associations: 500)', () => {
  test('clamps to maxPageSize instead of the object default of 100', async () => {
    const limits = [];
    await collectPages(
      async (params) => {
        limits.push(params.limit);
        return { results: [] };
      },
      { limit: 500, maxPageSize: 500 }
    );
    assert.deepEqual(limits, [500]);
    limits.length = 0;
    await collectPages(async (params) => (limits.push(params.limit), { results: [] }), { limit: 500 });
    assert.deepEqual(limits, [100]); // default maximum still protects object endpoints
  });
});

describe('findAcrossPages', () => {
  const pages = {
    undefined: { results: [{ toObjectId: 1 }, { toObjectId: 2 }], paging: { next: { after: 'p2' } } },
    p2: { results: [{ toObjectId: 3 }, { toObjectId: 4 }], paging: { next: { after: 'p3' } } },
    p3: { results: [{ toObjectId: 5 }] },
  };
  const fetcher = (calls) => async (params) => {
    calls.push(params.after);
    return pages[params.after];
  };

  test('finds an item that lives on a later page and stops there (regression: first page only)', async () => {
    const calls = [];
    const { item, pages: read } = await findAcrossPages(fetcher(calls), (e) => e.toObjectId === 4);
    assert.deepEqual(item, { toObjectId: 4 });
    assert.equal(read, 2);
    assert.deepEqual(calls, [undefined, 'p2']); // page 3 was never requested
  });

  test('reads every page when the item does not exist', async () => {
    const calls = [];
    const { item, pages: read } = await findAcrossPages(fetcher(calls), (e) => e.toObjectId === 99);
    assert.equal(item, null);
    assert.equal(read, 3);
    assert.deepEqual(calls, [undefined, 'p2', 'p3']);
  });

  test('stops on the first page when the item is there', async () => {
    const calls = [];
    const { item } = await findAcrossPages(fetcher(calls), (e) => e.toObjectId === 1);
    assert.equal(item.toObjectId, 1);
    assert.deepEqual(calls, [undefined]);
  });
});

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
