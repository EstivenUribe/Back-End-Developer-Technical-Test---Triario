'use strict';

/** Console rendering shared by the sync examples. */

const { line } = require('./hubSpotApiHandler');
const { summarizeCounts } = require('../utils/syncHelpers');

function printSyncSummary(summary) {
  const rows = [];
  for (const status of ['created', 'updated', 'unchanged', 'skipped', 'failed']) {
    for (const entry of summary[status]) rows.push({ status, ...entry });
  }
  rows.sort((a, b) => a.index - b.index);
  for (const row of rows) {
    const extra = [];
    if (row.changedProperties) extra.push(`changed: ${row.changedProperties.join(', ')}`);
    if (row.reason) extra.push(row.reason + (row.duplicateOf !== undefined ? ` (same key as #${row.duplicateOf})` : ''));
    if (row.message && row.status === 'failed') extra.push(row.message);
    if (row.association) {
      const a = row.association;
      extra.push(`association: ${a.status}${a.contactId ? ` contact ${a.contactId}` : ''}${a.reason ? ` (${a.reason})` : ''}`);
    }
    console.log(`  #${String(row.index).padEnd(3)} ${row.status.padEnd(9)} ${String(row.key || '-').padEnd(34)} ${String(row.id || '-').padEnd(14)} ${extra.join(' | ')}`);
  }
  const counts = summarizeCounts(summary);
  line(
    counts.failed || counts.aborted ? 'warn' : 'ok',
    `${summary.source}: ${counts.total} record(s) -> created ${counts.created}, updated ${counts.updated}, unchanged ${counts.unchanged}, skipped ${counts.skipped}, failed ${counts.failed}${counts.aborted ? `, ABORTED (${counts.aborted})` : ''}`
  );
  return counts;
}

module.exports = { printSyncSummary };
