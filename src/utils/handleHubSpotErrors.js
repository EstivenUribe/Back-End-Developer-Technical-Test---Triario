'use strict';

/**
 * Error normalization, logging and retry policy for HubSpot calls.
 *
 * Official references (see docs/design.md section 6):
 * - Error body shape: { status, message, category, correlationId, errors[] } (fields optional).
 * - 401 invalid auth, 403 missing scopes, 429 rate limit (back off), 5xx retry with
 *   exponential backoff and delays of at least 2 seconds, honour Retry-After when present.
 *
 * Retry policy in one place:
 * - Only `hubSpotClient.request` calls `withRetry`. Repositories and services never
 *   retry on their own, and `withRetry` refuses to retry an error that already went
 *   through a retry layer (`error.attempts` is set), so requests are never multiplied.
 * - Retryable: 429, 5xx, timeouts and network failures. Never retried: 400/401/403/404/409
 *   and any other 4xx (repeating the same request cannot fix them).
 * - Non-idempotent requests (POST that creates data) are retried only when the request
 *   certainly never reached HubSpot (429, connection refused / DNS failure). A timeout,
 *   a reset or a 5xx after a POST leaves the outcome unknown: the error is thrown with
 *   `outcomeUncertain: true` and the caller must look the record up before creating again.
 */

const { setTimeout: sleep } = require('timers/promises');
const logger = require('./logger');

const ERROR_CODES = Object.freeze({
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR: 'AUTHORIZATION_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMIT: 'RATE_LIMIT',
  SERVER_ERROR: 'SERVER_ERROR',
  CLIENT_ERROR: 'CLIENT_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
});

const MIN_SERVER_ERROR_DELAY_MS = 2000; // HubSpot docs: "at least 2 seconds" for 5xx
const DEFAULT_MAX_DELAY_MS = 30000;

/** Connection failures that happen before any byte reaches HubSpot: safe to retry even for POST. */
const NETWORK_CODES_SAFE_FOR_POST = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * Normalized error. It deliberately does NOT keep the original axios error
 * (which carries the request config and therefore the Authorization header),
 * so printing or serializing it can never leak the token.
 */
class HubSpotError extends Error {
  constructor({
    code = ERROR_CODES.UNKNOWN_ERROR,
    status = null,
    message = 'Unknown HubSpot error',
    category = null,
    correlationId = null,
    details = [],
    retryable = false,
    retryAfterMs = null,
    method = null,
    url = null,
    networkCode = null,
  } = {}) {
    super(message);
    this.name = 'HubSpotError';
    this.code = code;
    this.status = status;
    this.category = category;
    this.correlationId = correlationId;
    this.details = details;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.method = method;
    this.url = url;
    this.networkCode = networkCode;
    this.attempts = null; // set by withRetry: HTTP attempts made before giving up
    this.outcomeUncertain = false; // set by withRetry for non-idempotent requests
    this.retryWaitExceeded = false; // set by withRetry when Retry-After exceeds the operational maximum
    this.logged = false; // set by handleHubSpotErrors so the error is logged once
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      message: this.message,
      category: this.category,
      correlationId: this.correlationId,
      details: this.details,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      method: this.method,
      url: this.url,
      networkCode: this.networkCode,
      attempts: this.attempts,
      outcomeUncertain: this.outcomeUncertain,
      retryWaitExceeded: this.retryWaitExceeded,
    };
  }
}

/**
 * Parses a Retry-After header (seconds or HTTP date) into milliseconds.
 * @returns {number|null}
 */
function parseRetryAfter(headerValue) {
  if (headerValue === undefined || headerValue === null || headerValue === '') return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(String(headerValue));
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

function describeRequest(error) {
  const config = error && error.config ? error.config : {};
  const method = config.method ? String(config.method).toUpperCase() : null;
  // Keep only the path (masked: it may carry an e-mail as identifier); never headers or body.
  const url = config.url ? logger.maskPersonalData(String(config.url)) : null;
  return { method, url };
}

function mapStatusToCode(status) {
  if (status === 401) return ERROR_CODES.AUTHENTICATION_ERROR;
  if (status === 403) return ERROR_CODES.AUTHORIZATION_ERROR;
  if (status === 400) return ERROR_CODES.VALIDATION_ERROR;
  if (status === 404) return ERROR_CODES.NOT_FOUND;
  if (status === 409) return ERROR_CODES.CONFLICT;
  if (status === 429) return ERROR_CODES.RATE_LIMIT;
  if (status >= 500) return ERROR_CODES.SERVER_ERROR;
  if (status >= 400) return ERROR_CODES.CLIENT_ERROR;
  return ERROR_CODES.UNKNOWN_ERROR;
}

function hintFor(code, body) {
  switch (code) {
    case ERROR_CODES.AUTHENTICATION_ERROR:
      return 'Check HUBSPOT_ACCESS_TOKEN (Private App > Auth tab).';
    case ERROR_CODES.AUTHORIZATION_ERROR:
      return 'The Private App is missing a scope. Add it in the app Scopes tab.';
    case ERROR_CODES.RATE_LIMIT:
      return body && body.policyName ? `Rate limit policy: ${body.policyName}.` : 'Rate limit reached.';
    default:
      return null;
  }
}

/** True for errors produced by the HTTP layer (axios): they carry a request config or a response. */
function isTransportError(error) {
  return Boolean(error && typeof error === 'object' && (error.isAxiosError || error.response || error.config));
}

/**
 * Converts an error thrown by the HTTP layer into a HubSpotError.
 * - A HubSpotError is returned as-is.
 * - Errors that did not come from the transport (ConfigError, PayloadValidationError,
 *   programming errors) are returned untouched: they are not HubSpot errors, must never
 *   be retried, and must keep their own type so callers can recognise them.
 */
function normalizeHubSpotError(error) {
  if (error instanceof HubSpotError) return error;
  if (!isTransportError(error)) return error;

  const { method, url } = describeRequest(error);

  // No HTTP response: DNS failure, connection refused/reset, timeout, aborted request...
  if (!error || !error.response) {
    const networkCode = error && error.code ? String(error.code) : null;
    const isTimeout = networkCode === 'ECONNABORTED' || networkCode === 'ETIMEDOUT';
    return new HubSpotError({
      code: isTimeout ? ERROR_CODES.TIMEOUT : ERROR_CODES.NETWORK_ERROR,
      status: null,
      message: isTimeout
        ? `Request timed out${url ? ` (${method} ${url})` : ''}`
        : `Network error${networkCode ? ` [${networkCode}]` : ''}: ${
            error && error.message ? logger.maskPersonalData(error.message) : 'unknown'
          }`,
      retryable: true,
      method,
      url,
      networkCode,
    });
  }

  const { status, data, headers } = error.response;
  const body = data && typeof data === 'object' ? data : {};
  const code = mapStatusToCode(status);
  const retryable = code === ERROR_CODES.RATE_LIMIT || code === ERROR_CODES.SERVER_ERROR;
  const hint = hintFor(code, body);
  // Some gateway errors come back as HTML pages; never use those as messages.
  const textBody =
    typeof data === 'string' && data.trim() !== '' && !data.trim().startsWith('<') ? data.trim().slice(0, 200) : null;
  const baseMessage = logger.maskPersonalData(body.message || textBody || `HTTP ${status}`);

  return new HubSpotError({
    code,
    status,
    message: hint ? `${baseMessage} ${hint}` : baseMessage,
    category: body.category || body.errorType || null,
    correlationId: body.correlationId || null,
    details: Array.isArray(body.errors) ? body.errors : [],
    retryable,
    retryAfterMs: parseRetryAfter(headers && (headers['retry-after'] || headers['Retry-After'])),
    method,
    url,
  });
}

function isRetryable(error) {
  return Boolean(error && error.retryable);
}

/** True when HubSpot may have processed the request even though we got no usable answer. */
function isOutcomeUncertain(error) {
  if (!error) return false;
  if (error.code === ERROR_CODES.TIMEOUT || error.code === ERROR_CODES.SERVER_ERROR) return true;
  return error.code === ERROR_CODES.NETWORK_ERROR && !NETWORK_CODES_SAFE_FOR_POST.has(error.networkCode);
}

/**
 * Decides whether a normalized error should be retried.
 * @param {HubSpotError} error
 * @param {object} [options]
 * @param {boolean} [options.idempotent=true]  false for requests that create data (POST)
 */
function shouldRetry(error, { idempotent = true } = {}) {
  if (!isRetryable(error)) return false;
  if (idempotent) return true;
  // Non-idempotent: retry only when the request certainly never reached HubSpot.
  return !isOutcomeUncertain(error);
}

/**
 * Exponential backoff with jitter.
 *
 * A server-provided `Retry-After` is honoured in full: `maxDelayMs` bounds only the
 * locally computed formula and never shortens the wait the server asked for
 * (retrying earlier than instructed would just produce another 429).
 *
 * @param {number} attempt          1-based retry attempt number.
 * @param {object} [options]
 * @param {number} [options.baseDelayMs=1000]
 * @param {number} [options.maxDelayMs=30000]  cap for the local formula only
 * @param {number} [options.minDelayMs=0]      e.g. 2000 for 5xx per HubSpot guidance.
 * @param {number|null} [options.retryAfterMs] Server-provided wait; wins over the formula.
 * @param {() => number} [options.random]      Injectable for deterministic tests.
 */
function computeBackoffDelay(
  attempt,
  { baseDelayMs = 1000, maxDelayMs = DEFAULT_MAX_DELAY_MS, minDelayMs = 0, retryAfterMs = null, random = Math.random } = {}
) {
  if (retryAfterMs !== null && retryAfterMs !== undefined) {
    return Math.max(retryAfterMs, minDelayMs);
  }
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = random() * exponential * 0.2; // up to +20 % to spread concurrent retries
  return Math.min(Math.max(Math.round(exponential + jitter), minDelayMs), maxDelayMs);
}

/**
 * Runs `fn` and retries it according to `shouldRetry`.
 *
 * @param {() => Promise<any>} fn
 * @param {object} [options]
 * @param {number} [options.maxRetries=3]
 * @param {number} [options.baseDelayMs=1000]
 * @param {number} [options.maxDelayMs=30000]
 * @param {boolean} [options.idempotent=true]
 * @param {number|null} [options.maxWaitMs=null]  Operational maximum for a single wait. When the
 *        server's Retry-After exceeds it, the request is NOT retried (never earlier than asked):
 *        the error is thrown with `retryWaitExceeded: true` and the wait in `retryAfterMs`.
 * @param {(ms:number)=>Promise<void>} [options.sleep]  Injectable for tests.
 * @param {(error:HubSpotError, attempt:number, delayMs:number)=>void} [options.onRetry]
 */
async function withRetry(
  fn,
  {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    idempotent = true,
    maxWaitMs = null,
    sleep: wait = sleep,
    onRetry,
  } = {}
) {
  let attempts = 0;
  for (;;) {
    try {
      return await fn();
    } catch (rawError) {
      const error = normalizeHubSpotError(rawError);

      // Not a transport error (config, validation, bug): nothing to retry.
      if (!(error instanceof HubSpotError)) throw error;
      // Already went through a retry layer (nested withRetry): never multiply requests.
      if (error.attempts !== null) throw error;

      attempts += 1;
      if (!idempotent && isOutcomeUncertain(error)) {
        error.outcomeUncertain = true;
        error.message += ' The request may have been processed by HubSpot: look the record up before creating it again.';
      }

      if (!shouldRetry(error, { idempotent }) || attempts > maxRetries) {
        error.attempts = attempts;
        throw error;
      }

      const delayMs = computeBackoffDelay(attempts, {
        baseDelayMs,
        maxDelayMs,
        retryAfterMs: error.retryAfterMs,
        minDelayMs: error.code === ERROR_CODES.SERVER_ERROR ? MIN_SERVER_ERROR_DELAY_MS : 0,
      });

      if (maxWaitMs !== null && maxWaitMs !== undefined && delayMs > maxWaitMs) {
        // Waiting longer than the operational maximum is not useful for a script; stop and
        // report instead of retrying earlier than the server asked.
        error.attempts = attempts;
        error.retryWaitExceeded = true;
        error.message += ` HubSpot asked to wait ${delayMs} ms before retrying (Retry-After), above the operational maximum of ${maxWaitMs} ms (HUBSPOT_MAX_RETRY_WAIT_MS); not retried.`;
        throw error;
      }

      if (onRetry) onRetry(error, attempts, delayMs);
      await wait(delayMs);
    }
  }
}

/**
 * The utility the test brief names: normalize + log once, then hand the error back
 * so the caller can `throw handleHubSpotErrors(error, { operation })`.
 * Logging goes through the redacting logger. `context` must not carry personal data
 * (ids are fine, e-mails are masked anyway).
 */
function handleHubSpotErrors(error, context = {}) {
  const normalized = normalizeHubSpotError(error);
  if (normalized && normalized.logged) return normalized; // a lower layer already logged it

  const { operation, ...rest } = context;
  const label = operation || 'HubSpot operation';

  if (!(normalized instanceof HubSpotError)) {
    // Configuration, validation or programming error: log once, keep the original type.
    const name = normalized && normalized.name ? normalized.name : 'Error';
    const message = normalized && normalized.message ? normalized.message : String(normalized);
    logger.error(`${label} failed: ${name} ${message}`, rest);
    if (normalized && typeof normalized === 'object') normalized.logged = true;
    return normalized;
  }

  const status = normalized.status ? `HTTP ${normalized.status}` : 'no HTTP response';
  logger.error(`${label} failed: ${normalized.code} (${status}) ${normalized.message}`, {
    ...rest,
    category: normalized.category,
    correlationId: normalized.correlationId,
    request: normalized.method && normalized.url ? `${normalized.method} ${normalized.url}` : undefined,
    attempts: normalized.attempts,
    outcomeUncertain: normalized.outcomeUncertain || undefined,
    retryWaitExceeded: normalized.retryWaitExceeded || undefined,
    retryAfterMs: normalized.retryWaitExceeded ? normalized.retryAfterMs : undefined,
  });
  normalized.logged = true;
  return normalized;
}

module.exports = {
  HubSpotError,
  ERROR_CODES,
  isTransportError,
  normalizeHubSpotError,
  isRetryable,
  isOutcomeUncertain,
  shouldRetry,
  computeBackoffDelay,
  parseRetryAfter,
  withRetry,
  handleHubSpotErrors,
  MIN_SERVER_ERROR_DELAY_MS,
  NETWORK_CODES_SAFE_FOR_POST,
};
