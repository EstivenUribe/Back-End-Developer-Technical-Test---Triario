'use strict';

/**
 * Section 1.2 — consuming the Promise-based version with async/await.
 * Run: node src/fundamentals/asyncAwait.js
 */

const path = require('path');
const { readDataAsync } = require('./asyncOperation');

async function main() {
  console.log('1) Awaiting sample.txt (async/await style)...');
  try {
    const data = await readDataAsync();
    console.log(`   Read ${data.lines.length} line(s) from ${data.file}:`);
    data.lines.forEach((line, index) => console.log(`   ${index + 1}. ${line}`));
  } catch (error) {
    console.error('   Failed to read the sample file:', error.message);
  }

  console.log('\n2) Awaiting a missing file to show try/catch...');
  try {
    await readDataAsync(path.join(__dirname, 'does-not-exist.txt'));
    console.log('   Unexpected: the missing file was read.');
  } catch (error) {
    console.error(`   Handled error [${error.code}]: ${error.message}`);
  }

  console.log('\n3) Running two reads concurrently with Promise.all...');
  const [first, second] = await Promise.all([readDataAsync(), readDataAsync()]);
  console.log(`   Both finished: ${first.lines.length} and ${second.lines.length} line(s).`);
}

main().catch((error) => {
  console.error('Unhandled failure:', error);
  process.exitCode = 1;
});
