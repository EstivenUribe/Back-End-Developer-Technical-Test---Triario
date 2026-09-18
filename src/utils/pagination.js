'use strict';

/**
 * Cursor pagination helpers for HubSpot endpoints.
 *
 * HubSpot paged responses look like:
 *   { results: [...], paging: { next: { after: "cursor", link: "..." } } }
 * The `after` cursor is sent back as a query parameter until `paging.next`
 * disappears. Object list endpoints accept at most 100 records per page; the
 * associations read endpoint accepts up to 500 (pass `maxPageSize` accordingly).
 */

const MAX_PAGE_SIZE = 100;

/** Returns the next cursor of a HubSpot page, or null when there is no next page. */
function getNextCursor(page) {
  return page && page.paging && page.paging.next && page.paging.next.after
    ? String(page.paging.next.after)
    : null;
}

function clampPageSize(limit, maxPageSize) {
  return Math.min(Math.max(1, limit), maxPageSize);
}

/**
 * Fetches every page and concatenates `results`.
 *
 * @param {(params:{limit:number, after?:string}) => Promise<object>} fetchPage
 * @param {object} [options]  see collectPages
 * @returns {Promise<object[]>}
 */
async function paginateAll(fetchPage, options = {}) {
  const { results } = await collectPages(fetchPage, options);
  return results;
}

/**
 * Like paginateAll, but also reports how many pages were read and the cursor left
 * unread when `maxPages` stopped the walk (`nextAfter` is null when everything was read).
 *
 * @param {(params:{limit:number, after?:string}) => Promise<object>} fetchPage
 * @param {object} [options]
 * @param {number} [options.limit=100]                 Page size, clamped to `maxPageSize`.
 * @param {number} [options.maxPageSize=100]           Endpoint maximum (100 objects, 500 associations).
 * @param {number} [options.maxPages=Infinity]         Safety cap.
 * @param {(page:object, pageNumber:number)=>void} [options.onPage]  Progress hook.
 * @returns {Promise<{results:object[], pages:number, nextAfter:string|null}>}
 */
async function collectPages(fetchPage, { limit = MAX_PAGE_SIZE, maxPageSize = MAX_PAGE_SIZE, maxPages = Infinity, onPage } = {}) {
  const pageSize = clampPageSize(limit, maxPageSize);
  const results = [];
  let after;
  let pageNumber = 0;

  do {
    const page = await fetchPage(after ? { limit: pageSize, after } : { limit: pageSize });
    pageNumber += 1;
    if (Array.isArray(page && page.results)) results.push(...page.results);
    if (onPage) onPage(page, pageNumber);
    after = getNextCursor(page);
  } while (after && pageNumber < maxPages);

  return { results, pages: pageNumber, nextAfter: after || null };
}

/**
 * Walks pages until `predicate` matches an item and stops there (later pages are
 * not requested). Useful for "does X already exist?" checks.
 *
 * @param {(params:{limit:number, after?:string}) => Promise<object>} fetchPage
 * @param {(item:object) => boolean} predicate
 * @param {object} [options]  limit, maxPageSize, maxPages as in collectPages
 * @returns {Promise<{item:object|null, pages:number}>}
 */
async function findAcrossPages(fetchPage, predicate, { limit = MAX_PAGE_SIZE, maxPageSize = MAX_PAGE_SIZE, maxPages = Infinity } = {}) {
  const pageSize = clampPageSize(limit, maxPageSize);
  let after;
  let pageNumber = 0;

  do {
    const page = await fetchPage(after ? { limit: pageSize, after } : { limit: pageSize });
    pageNumber += 1;
    const results = Array.isArray(page && page.results) ? page.results : [];
    const item = results.find(predicate);
    if (item) return { item, pages: pageNumber };
    after = getNextCursor(page);
  } while (after && pageNumber < maxPages);

  return { item: null, pages: pageNumber };
}

module.exports = { paginateAll, collectPages, findAcrossPages, getNextCursor, MAX_PAGE_SIZE };
