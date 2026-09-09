const { aiSummarize } = require('./publisher');
const { parseSourceSelection, buildFallbackSelection, renderSourceSelection } = require('./source-selection');

const RECOVERABLE = new Set(['AI_SPAWN','AI_STDIN','AI_TIMEOUT','AI_QUOTA','AI_BUDGET','AI_EXIT','AI_EMPTY_OUTPUT']);

function assertSourceSelectionConfig(config) {
  if (!config.env.aiSummarize) {
    throw Object.assign(new Error('source_selection requires AI_SUMMARIZE=1'), {code:'AI_SELECTION_REQUIRES_AI'});
  }
  if ((config.env.aiGenerationScope || 'whole') !== 'whole') {
    throw Object.assign(new Error('source_selection requires AI_GENERATION_SCOPE=whole'), {code:'AI_SELECTION_SCOPE'});
  }
}

async function generateSourceSelection(records, config, meetingDate, options) {
  assertSourceSelectionConfig(config);
  let rawAiOutput = '';
  let content = '';
  let errorCode = null;
  let providerError = null;
  const fallbackAllowed = config.env.sourceSelectionFallback !== false;
  try {
    const result = await aiSummarize('', config, meetingDate, {prompt:options.prompt,includeRawOutput:true});
    rawAiOutput = result.rawAiOutput;
    content = result.content;
  } catch (error) {
    if (!Object.hasOwn(error,'rawAiOutput')) throw error;
    rawAiOutput = error.rawAiOutput;
    providerError = error;
    errorCode = error.code;
  }
  // Artifact failures must never be converted into successful fallbacks.
  options.onRawAiOutput(rawAiOutput);
  if (providerError && (!fallbackAllowed || !RECOVERABLE.has(errorCode))) throw providerError;
  let selection;
  if (!errorCode) {
    try { selection = parseSourceSelection(content, records); }
    catch (error) {
      if (!fallbackAllowed || error.code !== 'SOURCE_SELECTION_INVALID') throw error;
      errorCode = error.code;
    }
  }
  if (errorCode) {
    selection = buildFallbackSelection(records);
    console.warn(`[selection] deterministic fallback reason=${errorCode}; no additional AI call`);
  }
  const evidence = {
    schemaVersion:1, origin:errorCode ? 'deterministic_fallback' : 'ai',
    errorCode, aiResponseReceived:rawAiOutput.length > 0, selection,
  };
  return {
    content:renderSourceSelection(records, selection, {fallback:Boolean(errorCode)}),
    rawAiOutput, evidence,
  };
}

module.exports = {generateSourceSelection, assertSourceSelectionConfig};
