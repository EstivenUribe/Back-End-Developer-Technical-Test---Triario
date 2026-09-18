'use strict';

/**
 * accountRepository — read-only information about the Private App token.
 *
 * Official endpoint (Private apps guide):
 *   POST /oauth/v2/private-apps/get/access-token-info   body: { "tokenKey": "<token>" }
 *   -> { userId, hubId, appId, scopes[] }
 *
 * The token travels in the request body. Request bodies are never logged and
 * never attached to normalized errors, so it cannot leak through this module.
 */

const { getHubSpotClient } = require('../clients/hubSpotClient');
const { loadConfig } = require('../config');

/**
 * @param {object} [deps]  Injectable client/config (tests, custom setups).
 * @returns {Promise<{userId:number, hubId:number, appId:number, scopes:string[]}>}
 */
async function getAccessTokenInfo({ client = getHubSpotClient(), config = loadConfig() } = {}) {
  // A POST that only reads: safe to retry, hence idempotent: true.
  return client.post(config.hubspot.paths.accessTokenInfo, { tokenKey: config.hubspot.accessToken }, undefined, {
    idempotent: true,
  });
}

module.exports = { getAccessTokenInfo };
