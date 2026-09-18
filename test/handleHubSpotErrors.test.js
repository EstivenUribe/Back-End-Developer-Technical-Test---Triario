'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  HubSpotError,
  ERROR_CODES,
  normalizeHubSpotError,
  computeBackoffDelay,
  parseRetryAfter,
  shouldRetry,
  isOutcomeUncertain,
  withRetry,
  handleHubSpotErrors,
  MIN_SERVER_ERROR_DELAY_MS,
} = require('../src/utils/handleHubSpotErrors');
const logger = require('../src/utils/logger');

// Builds an object shaped like an axios error, including the request config with
// the Authorization header, to prove the token never leaks into normalized errors.
function axiosLikeError({ status, data, headers = {}, code, message = 'Request failed', url = '/crm/v3/objects/contacts' }) {
  const error = new Error(message);
  error.code = code;
  error.config = {
    method: 'get',
    url,
    headers: { Authorization: 'Bearer pat-na1-secret-token' },
    data: JSON.stringify({ properties: { email: 'private.person@example.com' } }),
  };
  if (status !== undefined) error.response = { status, data, headers };
  return error;
}

/** Captures stderr while `fn` runs. */
async function captureStderr(fn) {
  const originalWrite = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += chunk;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return captured;
}

describe('normalizeHubSpotError', () => {
  test('maps a timeout to TIMEOUT and marks it retryable', () => {
    const error = normalizeHubSpotError(axiosLikeError({ code: 'ECONNABORTED', message: 'timeout of 10000ms exceeded' }));
    assert.equal(error.code, ERROR_CODES.TIMEOUT);
    assert.equal(error.status, null);
    assert.equal(error.retryable, true);
    assert.equal(error.method, 'GET');
    assert.equal(error.networkCode, 'ECONNABORTED');
  });

  test('maps DNS / connection failures to NETWORK_ERROR and keeps the network code', () => {
    const error = normalizeHubSpotError(axiosLikeError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }));
    assert.equal(error.code, ERROR_CODES.NETWORK_ERROR);
    assert.equal(error.retryable, true);
    assert.equal(error.networkCode, 'ENOTFOUND');
  });

  test('maps 401 and 403 to auth errors that are not retryable', () => {
    const unauthenticated = normalizeHubSpotError(axiosLikeError({ status: 401, data: { message: 'Authentication credentials not found.' } }));
    assert.equal(unauthenticated.code, ERROR_CODES.AUTHENTICATION_ERROR);
    assert.equal(unauthenticated.retryable, false);
    assert.match(unauthenticated.message, /HUBSPOT_ACCESS_TOKEN/);

    const forbidden = normalizeHubSpotError(axiosLikeError({ status: 403, data: { category: 'MISSING_SCOPES', message: 'This app hasn\'t been granted all required scopes' } }));
    assert.equal(forbidden.code, ERROR_CODES.AUTHORIZATION_ERROR);
    assert.equal(forbidden.category, 'MISSING_SCOPES');
    assert.match(forbidden.message, /scope/i);
  });

  test('keeps HubSpot validation details for 400', () => {
    const error = normalizeHubSpotError(
      axiosLikeError({
        status: 400,
        data: {
          status: 'error',
          message: 'Property values were not valid',
          category: 'VALIDATION_ERROR',
          correlationId: 'abc-123',
          errors: [{ message: 'Property "foo" does not exist', code: 'PROPERTY_DOESNT_EXIST' }],
        },
      })
    );
    assert.equal(error.code, ERROR_CODES.VALIDATION_ERROR);
    assert.equal(error.status, 400);
    assert.equal(error.category, 'VALIDATION_ERROR');
    assert.equal(error.correlationId, 'abc-123');
    assert.equal(error.details.length, 1);
    assert.equal(error.retryable, false);
  });

  test('maps 404 and 409', () => {
    assert.equal(normalizeHubSpotError(axiosLikeError({ status: 404, data: {} })).code, ERROR_CODES.NOT_FOUND);
    assert.equal(normalizeHubSpotError(axiosLikeError({ status: 409, data: {} })).code, ERROR_CODES.CONFLICT);
  });

  test('ignores HTML bodies and keeps short text bodies as messages', () => {
    const html = normalizeHubSpotError(axiosLikeError({ status: 404, data: '<html><body>Error 404</body></html>' }));
    assert.equal(html.message, 'HTTP 404');
    const text = normalizeHubSpotError(axiosLikeError({ status: 400, data: 'Invalid request' }));
    assert.equal(text.message, 'Invalid request');
  });

  test('maps 429 to RATE_LIMIT, retryable, honouring Retry-After', () => {
    const error = normalizeHubSpotError(
      axiosLikeError({ status: 429, data: { errorType: 'RATE_LIMIT', policyName: 'TEN_SECONDLY' }, headers: { 'retry-after': '7' } })
    );
    assert.equal(error.code, ERROR_CODES.RATE_LIMIT);
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 7000);
    assert.match(error.message, /TEN_SECONDLY/);
  });

  test('maps 5xx to SERVER_ERROR, retryable', () => {
    const error = normalizeHubSpotError(axiosLikeError({ status: 503, data: 'Service Unavailable' }));
    assert.equal(error.code, ERROR_CODES.SERVER_ERROR);
    assert.equal(error.retryable, true);
  });

  test('is idempotent for HubSpotError instances', () => {
    const original = new HubSpotError({ code: ERROR_CODES.NOT_FOUND, status: 404 });
    assert.equal(normalizeHubSpotError(original), original);
  });

  test('never carries the token, headers or request body in its serialized form', () => {
    const error = normalizeHubSpotError(axiosLikeError({ status: 401, data: {} }));
    const serialized = JSON.stringify(error);
    assert.doesNotMatch(serialized, /pat-na1-secret-token/);
    assert.doesNotMatch(serialized, /Bearer/);
    assert.doesNotMatch(serialized, /private\.person/);
    assert.equal(error.cause, undefined);
  });

  test('passes non-transport errors through untouched (config, validation, bugs)', () => {
    const config = new Error('HUBSPOT_ACCESS_TOKEN is missing');
    config.name = 'ConfigError';
    assert.equal(normalizeHubSpotError(config), config);
    const bug = new TypeError('x is not a function');
    assert.equal(normalizeHubSpotError(bug), bug);
  });

  test('masks e-mails used as identifiers in the request path', () => {
    const error = normalizeHubSpotError(
      axiosLikeError({ status: 404, data: {}, url: '/crm/v3/objects/contacts/jane.doe@example.com' })
    );
    assert.equal(error.url, '/crm/v3/objects/contacts/j***@example.com');
  });
});

describe('parseRetryAfter / computeBackoffDelay', () => {
  test('parses seconds and HTTP dates', () => {
    assert.equal(parseRetryAfter('3'), 3000);
    assert.equal(parseRetryAfter(undefined), null);
    assert.equal(parseRetryAfter('not a date'), null);
    const future = new Date(Date.now() + 5000).toUTCString();
    const parsed = parseRetryAfter(future);
    assert.ok(parsed > 3000 && parsed <= 5000);
  });

  test('grows exponentially with jitter', () => {
    const random = () => 0; // no jitter
    assert.equal(computeBackoffDelay(1, { baseDelayMs: 1000, random }), 1000);
    assert.equal(computeBackoffDelay(2, { baseDelayMs: 1000, random }), 2000);
    assert.equal(computeBackoffDelay(3, { baseDelayMs: 1000, random }), 4000);
    const withJitter = computeBackoffDelay(1, { baseDelayMs: 1000, random: () => 1 });
    assert.equal(withJitter, 1200);
  });

  test('respects Retry-After, the minimum delay and the maximum delay', () => {
    assert.equal(computeBackoffDelay(1, { retryAfterMs: 7000, random: () => 0 }), 7000);
    assert.equal(computeBackoffDelay(1, { baseDelayMs: 100, minDelayMs: MIN_SERVER_ERROR_DELAY_MS, random: () => 0 }), 2000);
    assert.equal(computeBackoffDelay(10, { baseDelayMs: 1000, maxDelayMs: 30000, random: () => 0 }), 30000);
  });
});

describe('shouldRetry / isOutcomeUncertain', () => {
  const err = (opts) => normalizeHubSpotError(axiosLikeError(opts));

  test('idempotent requests retry every retryable error and no 4xx', () => {
    assert.equal(shouldRetry(err({ status: 429, data: {} })), true);
    assert.equal(shouldRetry(err({ status: 503, data: {} })), true);
    assert.equal(shouldRetry(err({ code: 'ECONNABORTED' })), true);
    assert.equal(shouldRetry(err({ code: 'ECONNRESET' })), true);
    for (const status of [400, 401, 403, 404, 409, 422]) {
      assert.equal(shouldRetry(err({ status, data: {} })), false, `status ${status}`);
    }
  });

  test('non-idempotent requests retry only when HubSpot certainly did not process them', () => {
    const nonIdempotent = { idempotent: false };
    assert.equal(shouldRetry(err({ status: 429, data: {} }), nonIdempotent), true);
    assert.equal(shouldRetry(err({ code: 'ECONNREFUSED' }), nonIdempotent), true);
    assert.equal(shouldRetry(err({ code: 'ENOTFOUND' }), nonIdempotent), true);
    assert.equal(shouldRetry(err({ status: 503, data: {} }), nonIdempotent), false);
    assert.equal(shouldRetry(err({ code: 'ECONNABORTED' }), nonIdempotent), false);
    assert.equal(shouldRetry(err({ code: 'ECONNRESET' }), nonIdempotent), false);
  });

  test('flags uncertain outcomes', () => {
    assert.equal(isOutcomeUncertain(err({ status: 502, data: {} })), true);
    assert.equal(isOutcomeUncertain(err({ code: 'ECONNABORTED' })), true);
    assert.equal(isOutcomeUncertain(err({ code: 'ECONNRESET' })), true);
    assert.equal(isOutcomeUncertain(err({ code: 'ECONNREFUSED' })), false);
    assert.equal(isOutcomeUncertain(err({ status: 429, data: {} })), false);
    assert.equal(isOutcomeUncertain(err({ status: 400, data: {} })), false);
  });
});

describe('withRetry', () => {
  const noSleep = async () => {};

  test('retries retryable errors and eventually succeeds', async () => {
    let calls = 0;
    const delays = [];
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw axiosLikeError({ status: 429, data: {}, headers: { 'retry-after': '1' } });
        return 'ok';
      },
      { maxRetries: 3, sleep: noSleep, onRetry: (_error, _attempt, delay) => delays.push(delay) }
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(delays, [1000, 1000]);
  });

  test('gives up after maxRetries and reports the attempts made', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw axiosLikeError({ status: 500, data: {} });
        },
        { maxRetries: 2, sleep: noSleep }
      ),
      (error) => error instanceof HubSpotError && error.code === ERROR_CODES.SERVER_ERROR && error.attempts === 3
    );
    assert.equal(calls, 3); // 1 initial + 2 retries
  });

  test('does not retry 4xx errors', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw axiosLikeError({ status: 400, data: {} });
        },
        { maxRetries: 3, sleep: noSleep }
      ),
      { code: ERROR_CODES.VALIDATION_ERROR, attempts: 1 }
    );
    assert.equal(calls, 1);
  });

  test('uses a minimum 2 second delay for 5xx', async () => {
    let calls = 0;
    const delays = [];
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw axiosLikeError({ status: 502, data: {} });
        return 'ok';
      },
      { maxRetries: 1, baseDelayMs: 100, sleep: noSleep, onRetry: (_e, _a, d) => delays.push(d) }
    );
    assert.equal(delays[0], MIN_SERVER_ERROR_DELAY_MS);
  });

  test('does not blindly repeat a non-idempotent request after an uncertain failure', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw axiosLikeError({ status: 503, data: {} });
        },
        { maxRetries: 3, idempotent: false, sleep: noSleep }
      ),
      (error) => {
        assert.equal(error.outcomeUncertain, true);
        assert.equal(error.attempts, 1);
        assert.match(error.message, /look the record up/i);
        return true;
      }
    );
    assert.equal(calls, 1);
  });

  test('still retries a non-idempotent request that was rejected by the rate limiter', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw axiosLikeError({ status: 429, data: {} });
        return 'created';
      },
      { maxRetries: 3, idempotent: false, sleep: noSleep }
    );
    assert.equal(result, 'created');
    assert.equal(calls, 2);
  });

  test('throws non-transport errors immediately without retrying', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          const error = new Error('HUBSPOT_ACCESS_TOKEN is missing');
          error.name = 'ConfigError';
          throw error;
        },
        { maxRetries: 3, sleep: noSleep }
      ),
      { name: 'ConfigError' }
    );
    assert.equal(calls, 1);
  });

  test('never multiplies requests when withRetry is nested', async () => {
    let calls = 0;
    const inner = () =>
      withRetry(
        async () => {
          calls += 1;
          throw axiosLikeError({ status: 503, data: {} });
        },
        { maxRetries: 2, sleep: noSleep }
      );
    await assert.rejects(withRetry(inner, { maxRetries: 5, sleep: noSleep }), { code: ERROR_CODES.SERVER_ERROR });
    assert.equal(calls, 3); // only the inner layer retried: 1 + 2, not (1 + 2) * 6
  });
});

describe('handleHubSpotErrors', () => {
  test('logs once through the redacting logger and returns the normalized error', async () => {
    const originalLevel = logger.getLevel();
    logger.setLevel('error');
    let returned;
    const captured = await captureStderr(async () => {
      const raw = axiosLikeError({ status: 401, data: { message: 'bad token' } });
      returned = handleHubSpotErrors(raw, { operation: 'createHubSpotContact', contactId: '42' });
      // A second layer handling the same error must not log it again.
      handleHubSpotErrors(returned, { operation: 'outerLayer' });
    });
    logger.setLevel(originalLevel);

    assert.ok(returned instanceof HubSpotError);
    assert.equal(returned.logged, true);
    assert.match(captured, /createHubSpotContact failed: AUTHENTICATION_ERROR \(HTTP 401\)/);
    assert.doesNotMatch(captured, /outerLayer/);
    assert.equal(captured.trim().split('\n').length, 1);
    assert.doesNotMatch(captured, /pat-na1-secret-token/);
    assert.doesNotMatch(captured, /private\.person/);
  });

  test('logs non-transport errors once and keeps their type', async () => {
    const originalLevel = logger.getLevel();
    logger.setLevel('error');
    const config = new Error('HUBSPOT_ACCESS_TOKEN is missing');
    config.name = 'ConfigError';
    let returned;
    const captured = await captureStderr(async () => {
      returned = handleHubSpotErrors(config, { operation: 'getHubSpotContactById' });
      handleHubSpotErrors(returned, { operation: 'again' });
    });
    logger.setLevel(originalLevel);
    assert.equal(returned, config);
    assert.equal(returned.logged, true);
    assert.match(captured, /getHubSpotContactById failed: ConfigError HUBSPOT_ACCESS_TOKEN is missing/);
    assert.equal(captured.trim().split('\n').length, 1);
  });
});
