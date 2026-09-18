'use strict';

/**
 * Section 1.4 — Streams.
 *
 *   Readable.from(...)  ->  Transform (uppercase)  ->  process.stdout
 *
 * `stream/promises.pipeline` connects the streams, forwards backpressure,
 * destroys every stream if one of them fails and rejects with that error,
 * so a single try/catch handles any failure in the flow.
 *
 * Run: node src/utils/streams.js
 */

const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

/** Transform stream that upper-cases every chunk passing through it. */
function createUppercaseTransform() {
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        callback(null, chunk.toString().toUpperCase());
      } catch (error) {
        callback(error); // reported through pipeline, never thrown synchronously
      }
    },
  });
}

/**
 * Pipes `source` through the uppercase transform into `destination`.
 *
 * @param {string|Iterable|AsyncIterable} source   Anything Readable.from accepts.
 * @param {NodeJS.WritableStream} [destination=process.stdout]
 * @returns {Promise<void>} resolves when everything was written, rejects on any stream error
 */
async function runUppercasePipeline(source, destination = process.stdout) {
  // process.stdout must stay open after the pipeline: do not end it.
  const end = destination !== process.stdout && destination !== process.stderr;
  await pipeline(Readable.from(source), createUppercaseTransform(), destination, { end });
}

/** Async generator that fails half-way, to demonstrate error propagation. */
async function* failingSource() {
  yield 'first chunk arrives fine\n';
  throw new Error('source failed while producing the second chunk');
}

async function main() {
  console.log('1) Readable.from(text) -> uppercase -> stdout');
  const text = 'hello from node streams\neach chunk is transformed to uppercase\nand piped to stdout\n';
  await runUppercasePipeline(text);

  console.log('\n2) Same flow with a source that fails mid-stream (error handling)');
  try {
    await runUppercasePipeline(failingSource());
    console.log('   Unexpected: the failing pipeline completed.');
  } catch (error) {
    console.error(`   Handled stream error: ${error.message}`);
  }

  console.log('\n3) stdout is still usable after the failed pipeline.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Unhandled failure:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { createUppercaseTransform, runUppercasePipeline, failingSource };
