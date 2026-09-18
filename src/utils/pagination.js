'use strict';

/**
 * Cursor pagination helper for HubSpot list endpoints.
 *
 * HubSpot list responses look like:
 *   { results: [...], paging: { next: { after: "cursor", link: "..." } } }
 * The `after` cursor is sent back as a query parameter until `paging.next`
 * disappears. List endpoints accept at most 100 records per page.
 */

const MAX_PAGE_SIZE = 100;

/** Returns the next cursor of a HubSpot page, or null when there is no next page. */
function getNextCursor(page) {
  return page && page.paging && page.paging.next && page.paging.next.after
    ? String(page.paging.next.after)
    : null;
}

/**
 * Fetches every page and concatenates `results`.
 *
 * @param {(params:{limit:number, after?:string}) => Promise<object>} fetchPage
 * @param {object} [options]
 * @param {number} [options.limit=100]           Page size (capped at 100).
 * @param {number} [options.maxPages=Infinity]   Safety cap.
 * @param {(page:object, pageNumber:number)=>void} [options.onPage]  Progress hook.
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
 * @returns {Promise<{results:object[], pages:number, nextAfter:string|null}>}
 */
async function collectPages(fetchPage, { limit = MAX_PAGE_SIZE, maxPages = Infinity, onPage } = {}) {
  const pageSize = Math.min(Math.max(1, limit), MAX_PAGE_SIZE);
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

module.exports = { paginateAll, collectPages, getNextCursor, MAX_PAGE_SIZE };
