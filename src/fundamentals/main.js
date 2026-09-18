'use strict';

/**
 * Section 1.3 — importing a CommonJS module.
 * Run: node src/fundamentals/main.js
 */

const { sumArray } = require('./utils_module');

const numbers = [10, 20, 30, 40];
console.log(`sumArray([${numbers.join(', ')}]) = ${sumArray(numbers)}`);
console.log(`sumArray([]) = ${sumArray([])}`);

try {
  sumArray([1, 'two', 3]);
} catch (error) {
  console.error(`Handled error: ${error.message}`);
}
