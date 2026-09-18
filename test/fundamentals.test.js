'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Writable } = require('stream');

const { sumArray } = require('../src/fundamentals/utils_module');
const { readDataWithCallback, readDataAsync } = require('../src/fundamentals/asyncOperation');
const { runUppercasePipeline, createUppercaseTransform, failingSource } = require('../src/utils/streams');

describe('utils_module.sumArray', () => {
  test('sums numbers', () => {
    assert.equal(sumArray([1, 2, 3.5]), 6.5);
  });
  test('returns 0 for an empty array', () => {
    assert.equal(sumArray([]), 0);
  });
  test('rejects non-array input', () => {
    assert.throws(() => sumArray('1,2,3'), TypeError);
  });
  test('rejects non-numeric elements', () => {
    assert.throws(() => sumArray([1, 'two']), /index 1/);
  });
});

describe('asyncOperation', () => {
  test('readDataWithCallback follows the error-first convention on success', (_, done) => {
    readDataWithCallback((error, data) => {
      assert.equal(error, null);
      assert.equal(data.file, 'sample.txt');
      assert.ok(data.lines.length >= 1);
      done();
    });
  });

  test('readDataWithCallback reports a missing file as the first argument', (_, done) => {
    readDataWithCallback(path.join(__dirname, 'missing.txt'), (error, data) => {
      assert.equal(error.code, 'ENOENT');
      assert.equal(data, undefined);
      done();
    });
  });

  test('readDataAsync resolves with the same data', async () => {
    const data = await readDataAsync();
    assert.equal(data.file, 'sample.txt');
  });

  test('readDataAsync rejects on a missing file', async () => {
    await assert.rejects(readDataAsync(path.join(__dirname, 'missing.txt')), { code: 'ENOENT' });
  });
});

describe('streams', () => {
  function collector() {
    const chunks = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    return { writable, output: () => chunks.join('') };
  }

  test('runUppercasePipeline upper-cases every chunk', async () => {
    const { writable, output } = collector();
    await runUppercasePipeline(['hello ', 'world'], writable);
    assert.equal(output(), 'HELLO WORLD');
  });

  test('runUppercasePipeline accepts a single string and ends a regular destination', async () => {
    const { writable, output } = collector();
    await runUppercasePipeline('abc', writable);
    assert.equal(output(), 'ABC');
    assert.equal(writable.writableEnded, true);
  });

  test('runUppercasePipeline rejects when the source fails and keeps what was written before', async () => {
    const { writable, output } = collector();
    await assert.rejects(runUppercasePipeline(failingSource(), writable), /source failed/);
    assert.equal(output(), 'FIRST CHUNK ARRIVES FINE\n');
    assert.equal(writable.destroyed, true); // pipeline cleaned up the destination
  });

  test('createUppercaseTransform is a Transform stream', () => {
    const transform = createUppercaseTransform();
    assert.equal(typeof transform.pipe, 'function');
    assert.equal(typeof transform._transform, 'function');
  });
});
