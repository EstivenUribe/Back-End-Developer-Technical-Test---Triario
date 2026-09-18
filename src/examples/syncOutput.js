'use strict';

/** Console rendering shared by the sync examples. */

const { line } = require('./hubSpotApiHandler');
const { summarizeCounts } = require('../utils/syncHelpers');

const STATUSES = ['created', 'updated', 'unchanged', 'partial', 'skipped', 'failed'];

function describeAssociation(a) {
  const who = a.contactId ? ` contact ${a.contactId}` : '';
  const why = a.reason ? ` (${a.reason})` : '';
  return `association: ${a.status}${who}${why}`;
}

function printSyncSummary(summary) {
  const rows = [];
  for (const status of STATUSES) {
    for (const entry of summary[status] || []) rows.push({ status, ...entry });
  }
  rows.sort((a, b) => a.index - b.index);

  let skippedAssociations = 0;
  for (const row of rows) {
    const extra = [];
    if (row.status === 'partial') extra.push(`deal ${row.dealStatus} (id kept), association FAILED`);
    if (row.changedProperties) extra.push(`changed: ${row.changedProperties.join(', ')}`);
    if (row.reason) extra.push(row.reason + (row.duplicateOf !== undefined ? ` (same key as #${row.duplicateOf})` : ''));
    if (row.message && row.status === 'failed') extra.push(row.message);
    if (row.association) {
      extra.push(describeAssociation(row.association));
      if (row.association.status === 'skipped') skippedAssociations += 1;
      if (row.association.status === 'failed' && row.association.message) extra.push(row.association.message);
    }
    console.log(`  #${String(row.index).padEnd(3)} ${row.status.padEnd(9)} ${String(row.key || '-').padEnd(34)} ${String(row.id || '-').padEnd(14)} ${extra.join(' | ')}`);
  }

  const counts = summarizeCounts(summary);
  const problems = counts.failed > 0 || counts.partial > 0 || Boolean(counts.aborted);
  line(
    problems ? 'warn' : 'ok',
    `${summary.source}: ${counts.total} record(s) -> created ${counts.created}, updated ${counts.updated}, unchanged ${counts.unchanged}, ` +
      `partial ${counts.partial}, skipped ${counts.skipped}, failed ${counts.failed}${counts.aborted ? `, ABORTED (${counts.aborted})` : ''}`
  );
  if (counts.partial > 0) {
    line('warn', `${counts.partial} deal(s) were saved but their association failed; re-run to complete the association (the deal is not created again).`);
  }
  if (skippedAssociations > 0) {
    line('warn', `${skippedAssociations} association(s) skipped: contact not found in HubSpot. Run sync-contacts first, then re-run sync-deals.`);
  }
  return counts;
}

module.exports = { printSyncSummary };
