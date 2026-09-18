'use strict';

/**
 * getHubSpotContactNames — full names of all contacts, walking every page.
 *
 *   node src/examples/get-contact-names.js
 *   node src/examples/get-contact-names.js --page-size 2 --max-pages 3   (makes pagination visible)
 *   node src/examples/get-contact-names.js --include-unnamed             (contacts without names too)
 *   node src/examples/get-contact-names.js --max-pages 0                 (no cap, every contact)
 *
 * Default cap: 10 pages (1,000 contacts) so a large portal is not dumped by accident.
 */

const hubSpotService = require('../services/hubSpotService');
const { runExample, parseCliArgs, line } = require('./hubSpotApiHandler');

const { values } = parseCliArgs({
  'page-size': { type: 'string', default: '100' },
  'max-pages': { type: 'string', default: '10' },
  'include-unnamed': { type: 'boolean', default: false },
});

const maxPagesArg = Number(values['max-pages']);
const maxPages = maxPagesArg === 0 ? Infinity : maxPagesArg;
let pagesRead = 0;
let truncated = false;

runExample(
  'getHubSpotContactNames',
  async () => {
    const names = await hubSpotService.getHubSpotContactNames({
      pageSize: values['page-size'],
      maxPages,
      includeUnnamed: values['include-unnamed'],
      onPage: (page, pageNumber) => {
        pagesRead = pageNumber;
        const count = Array.isArray(page.results) ? page.results.length : 0;
        const hasNext = Boolean(page.paging && page.paging.next && page.paging.next.after);
        line('info', `page ${pageNumber}: ${count} contact(s)${hasNext ? ', more pages available' : ', last page'}`);
        if (hasNext && pageNumber >= maxPages) truncated = true;
      },
    });
    names.forEach((name, index) => console.log(`${String(index + 1).padStart(4)}. ${name}`));
    line('ok', `${names.length} name(s) from ${pagesRead} page(s)`);
    if (truncated) line('warn', `Stopped at --max-pages ${maxPagesArg}. Use --max-pages 0 to read every contact.`);
    return undefined; // already printed
  },
  { printResult: false }
);
