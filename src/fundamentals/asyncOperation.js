'use strict';

/**
 * Section 1.1 / 1.2 — one asynchronous operation, two consumption styles.
 *
 * `readDataWithCallback` uses fs.readFile, a real asynchronous I/O operation
 * handled by libuv's thread pool, and follows Node's error-first callback
 * convention: callback(error) on failure, callback(null, data) on success.
 *
 * `readDataAsync` wraps the same operation in a Promise so callers can use
 * `.then()` or `await` (Section 1.2).
 */

const fs = require('fs');
const path = require('path');

const SAMPLE_FILE = path.join(__dirname, 'sample.txt');

/**
 * Reads a text file and reports its non-empty lines.
 *
 * @param {string} [filePath]   Defaults to sample.txt next to this module.
 * @param {(error: Error|null, data?: {file:string, lines:string[]}) => void} callback
 */
function readDataWithCallback(filePath, callback) {
  // Allow readDataWithCallback(callback) with the default file.
  if (typeof filePath === 'function') {
    callback = filePath;
    filePath = SAMPLE_FILE;
  }
  if (typeof callback !== 'function') {
    throw new TypeError('callback must be a function');
  }

  fs.readFile(filePath, 'utf8', (error, content) => {
    if (error) {
      callback(error);
      return;
    }
    const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '');
    callback(null, { file: path.basename(filePath), lines });
  });
}

/**
 * Promise-based version of readDataWithCallback.
 *
 * @param {string} [filePath]
 * @returns {Promise<{file:string, lines:string[]}>}
 */
function readDataAsync(filePath = SAMPLE_FILE) {
  return new Promise((resolve, reject) => {
    readDataWithCallback(filePath, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

module.exports = { readDataWithCallback, readDataAsync, SAMPLE_FILE };
