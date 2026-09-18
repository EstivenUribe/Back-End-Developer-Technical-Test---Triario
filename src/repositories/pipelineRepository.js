'use strict';

/**
 * pipelineRepository — Pipelines API (read operations).
 *
 * Official endpoints:
 *   GET /crm/v3/pipelines/{objectType}                        -> { results: [pipeline] }
 *   GET /crm/v3/pipelines/{objectType}/{pipelineId}           -> pipeline
 *   GET /crm/v3/pipelines/{objectType}/{pipelineId}/stages    -> { results: [stage] }
 * pipeline: { id, label, displayOrder, stages: [{ id, label, displayOrder, metadata }] }
 */

const { getHubSpotClient } = require('../clients/hubSpotClient');
const { API_PATHS } = require('../config');

function listPipelines(objectType = 'deals', { client = getHubSpotClient() } = {}) {
  return client.get(`${API_PATHS.pipelines}/${objectType}`);
}

function getPipeline(objectType, pipelineId, { client = getHubSpotClient() } = {}) {
  return client.get(`${API_PATHS.pipelines}/${objectType}/${encodeURIComponent(pipelineId)}`);
}

function listStages(objectType, pipelineId, { client = getHubSpotClient() } = {}) {
  return client.get(`${API_PATHS.pipelines}/${objectType}/${encodeURIComponent(pipelineId)}/stages`);
}

module.exports = { listPipelines, getPipeline, listStages };
