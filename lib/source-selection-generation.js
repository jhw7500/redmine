const { aiSummarize } = require('./publisher');
const { parseSourceSelection, buildFallbackSelection, renderSourceSelection } = require('./source-selection');
const {TEAM_SUMMARY_PROFILE,parseTeamSummarySelection,buildTeamSummaryFallbackSelection,
  renderTeamSummarySelection}=require('./team-summary-selection');

const RECOVERABLE = new Set(['AI_SPAWN','AI_STDIN','AI_TIMEOUT','AI_QUOTA','AI_BUDGET','AI_EXIT','AI_EMPTY_OUTPUT']);

function assertSourceSelectionConfig(config) {
  if (!config.env.aiSummarize) {
    throw Object.assign(new Error('source_selection requires AI_SUMMARIZE=1'), {code:'AI_SELECTION_REQUIRES_AI'});
  }
  if ((config.env.aiGenerationScope || 'whole') !== 'whole') {
    throw Object.assign(new Error('source_selection requires AI_GENERATION_SCOPE=whole'), {code:'AI_SELECTION_SCOPE'});
  }
  if (config.env.sourceSelectionProfile !== undefined
    && (config.env.sourceSelectionProfile !== TEAM_SUMMARY_PROFILE
      || config.env.reportAudience !== 'team' || Number(config.env.reportDepth) !== 3)) {
    throw Object.assign(new Error('Unsupported source selection profile/audience/depth'),{code:'AI_SELECTION_PROFILE'});
  }
}

async function generateSourceSelection(records, config, meetingDate, options) {
  assertSourceSelectionConfig(config);
  let rawAiOutput = '';
  let content = '';
  let errorCode = null;
  let errorReason = null;
  let providerError = null;
  const fallbackAllowed = config.env.sourceSelectionFallback !== false;
  const leaderHighlight = config.reportFilter?.leaderHighlight || {};
  const team=records.profile===TEAM_SUMMARY_PROFILE;
  const renderVersion = team?1:Number(config.env.reportDepth) === 2 ? 2 : 1;
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
    try { selection = team?parseTeamSummarySelection(content,records,leaderHighlight)
      :parseSourceSelection(content, records, leaderHighlight, config.env.reportDepth); }
    catch (error) {
      if (!fallbackAllowed || error.code !== (team?'TEAM_SUMMARY_SELECTION_INVALID':'SOURCE_SELECTION_INVALID')) throw error;
      errorCode = error.code;
      errorReason = error.message;
    }
  }
  if (errorCode) {
    selection = team?buildTeamSummaryFallbackSelection(records,leaderHighlight)
      :buildFallbackSelection(records, config.env.reportDepth, { renderVersion });
    console.warn(`[selection] deterministic fallback reason=${errorCode}${errorReason ? ` (${errorReason})` : ''}; no additional AI call`);
  }
  const evidence = {
    schemaVersion:1, origin:errorCode ? 'deterministic_fallback' : 'ai',
    errorCode, ...(errorReason ? {errorReason} : {}),
    aiResponseReceived:rawAiOutput.length > 0, selection,
    ...(renderVersion === 2 ? { renderVersion } : {}),
    ...(team?{profile:TEAM_SUMMARY_PROFILE,renderVersion}:{}),
  };
  return {
    content:(team?renderTeamSummarySelection:renderSourceSelection)(records, selection, {
      fallback:Boolean(errorCode),leaderHighlight,reportDepth:config.env.reportDepth,renderVersion,
    }),
    rawAiOutput, evidence,
  };
}

module.exports = {generateSourceSelection, assertSourceSelectionConfig};
