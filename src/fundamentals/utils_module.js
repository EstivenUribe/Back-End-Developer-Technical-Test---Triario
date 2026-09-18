'use strict';

/**
 * Section 1.3 — CommonJS module that exports a utility function.
 */

/**
 * Sums an array of numbers.
 *
 * @param {number[]} numbers
 * @returns {number}
 * @throws {TypeError} when the input is not an array of finite numbers
 */
function sumArray(numbers) {
  if (!Array.isArray(numbers)) {
    throw new TypeError('sumArray expects an array of numbers');
  }
  return numbers.reduce((total, value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`sumArray: element at index ${index} is not a finite number`);
    }
    return total + value;
  }, 0);
}

module.exports = { sumArray };
