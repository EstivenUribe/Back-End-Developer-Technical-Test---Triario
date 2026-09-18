'use strict';

/**
 * Section 1.1 — consuming an asynchronous operation with callbacks.
 * Run: node src/fundamentals/callbacks.js
 */

const path = require('path');
const { readDataWithCallback } = require('./asyncOperation');

console.log('1) Requesting sample.txt (callback style)...');

readDataWithCallback((error, data) => {
  if (error) {
    console.error('   Failed to read the sample file:', error.message);
    return;
  }
  console.log(`   Read ${data.lines.length} line(s) from ${data.file}:`);
  data.lines.forEach((line, index) => console.log(`   ${index + 1}. ${line}`));

  // Error path: a file that does not exist. The error-first convention lets the
  // caller decide what to do; here we just report it and continue.
  const missingFile = path.join(__dirname, 'does-not-exist.txt');
  console.log('\n2) Requesting a missing file to show error handling...');
  readDataWithCallback(missingFile, (missingError) => {
    if (missingError) {
      console.error(`   Handled error [${missingError.code}]: ${missingError.message}`);
      return;
    }
    console.log('   Unexpected: the missing file was read.');
  });
});

// This line runs before either callback: fs.readFile does not block the event loop.
console.log('   (this message prints first because the read is asynchronous)');
