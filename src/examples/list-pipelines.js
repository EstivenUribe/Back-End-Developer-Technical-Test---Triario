'use strict';

/**
 * Deal pipelines and stages — GET /crm/v3/pipelines/deals
 *
 *   node src/examples/list-pipelines.js
 *
 * Marks the pipeline / stage currently configured in .env.
 */

const hubSpotService = require('../services/hubSpotService');
const { loadConfig } = require('../config');
const { runExample, line } = require('./hubSpotApiHandler');

runExample(
  'getDealPipelines',
  async () => {
    const { pipelineId, stageId } = loadConfig().hubspot;
    const pipelines = await hubSpotService.getDealPipelines();
    for (const pipeline of pipelines) {
      const configured = pipeline.id === pipelineId;
      line(configured ? 'ok' : 'info', `${configured ? '[configured] ' : ''}"${pipeline.label}"  id: ${pipeline.id}`);
      for (const stage of pipeline.stages) {
        const mark = configured && stage.id === stageId ? '  <- HUBSPOT_STAGE_ID' : '';
        console.log(`        "${stage.label}"  id: ${stage.id}${mark}`);
      }
    }
    line('info', `HUBSPOT_PIPELINE_ID=${pipelineId || '(not set)'}  HUBSPOT_STAGE_ID=${stageId || '(not set)'}`);
    return undefined;
  },
  { printResult: false }
);
