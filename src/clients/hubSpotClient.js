'use strict';

/**
 * hubSpotClient — the single HTTP gateway to HubSpot.
 *
 * Responsibilities:
 * - Build an axios instance with base URL, bearer token and timeout from config.
 * - Wrap every request with the retry policy (the ONLY retry layer in the project).
 * - Convert transport errors into HubSpotError (no token, no headers, no body attached).
 * - Return `response.data` so repositories work with plain JSON.
 *
 * Idempotency: GET, PUT, PATCH and DELETE are treated as idempotent (repeating them
 * yields the same state). POST is not, unless the caller passes `{ idempotent: true }`
 * for read-only POSTs (search, token info, batch read). See handleHubSpotErrors.
 *
 * It knows nothing about contacts or deals; repositories own the endpoints.
 */

const axios = require('axios');
const { loadConfig } = require('../config');
const { withRetry, normalizeHubSpotError } = require('../utils/handleHubSpotErrors');
const logger = require('../utils/logger');

const IDEMPOTENT_METHODS = new Set(['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const RATE_LIMIT_WARN_THRESHOLD = 10;

function createHubSpotClient({ config } = {}) {
  const settings = (config || loadConfig()).hubspot;

  const instance = axios.create({
    baseURL: settings.baseUrl,
    timeout: settings.timeoutMs,
    headers: {
      Authorization: `Bearer ${settings.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  /**
   * Executes a request with retries.
   * @param {import('axios').AxiosRequestConfig & { idempotent?: boolean }} requestConfig
   * @returns {Promise<any>} response body (undefined for 204 No Content)
   */
  async function request(requestConfig) {
    const { idempotent, ...axiosConfig } = requestConfig;
    const method = String(axiosConfig.method || 'GET').toUpperCase();
    const safeUrl = logger.maskPersonalData(String(axiosConfig.url || ''));
    const isIdempotent = typeof idempotent === 'boolean' ? idempotent : IDEMPOTENT_METHODS.has(method);

    return withRetry(
      async () => {
        try {
          const response = await instance.request(axiosConfig);
          const remaining = response.headers['x-hubspot-ratelimit-remaining'];
          logger.debug(`${method} ${safeUrl} -> ${response.status}`, { rateLimitRemaining: remaining });
          if (remaining !== undefined && Number(remaining) < RATE_LIMIT_WARN_THRESHOLD) {
            logger.warn(`Approaching HubSpot rate limit: ${remaining} requests left in the current window`);
          }
          return response.status === 204 ? undefined : response.data;
        } catch (error) {
          throw normalizeHubSpotError(error);
        }
      },
      {
        maxRetries: settings.maxRetries,
        baseDelayMs: settings.retryBaseDelayMs,
        idempotent: isIdempotent,
        onRetry: (error, attempt, delayMs) =>
          logger.warn(`Retrying ${method} ${safeUrl} (attempt ${attempt}/${settings.maxRetries}) in ${delayMs} ms`, {
            code: error.code,
            status: error.status,
          }),
      }
    );
  }

  return {
    request,
    get: (url, params, options = {}) => request({ method: 'GET', url, params, ...options }),
    post: (url, data, params, options = {}) => request({ method: 'POST', url, data, params, ...options }),
    patch: (url, data, params, options = {}) => request({ method: 'PATCH', url, data, params, ...options }),
    put: (url, data, params, options = {}) => request({ method: 'PUT', url, data, params, ...options }),
    delete: (url, params, options = {}) => request({ method: 'DELETE', url, params, ...options }),
    /** Exposed for tests and diagnostics; never log it directly. */
    settings: Object.freeze({
      baseUrl: settings.baseUrl,
      timeoutMs: settings.timeoutMs,
      maxRetries: settings.maxRetries,
      paths: settings.paths,
    }),
  };
}

let defaultClient = null;

/** Lazily-created shared client (reads .env on first use). */
function getHubSpotClient() {
  if (!defaultClient) defaultClient = createHubSpotClient();
  return defaultClient;
}

module.exports = { createHubSpotClient, getHubSpotClient, IDEMPOTENT_METHODS };
