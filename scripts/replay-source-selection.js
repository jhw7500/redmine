// Offline only: no provider invocation, live git verification, or publish state.
const fs = require('node:fs');
const path = require('node:path');
const {readSnapshot, sha256} = require('../lib/report-artifact');
const {assertRunInputs, writeImmutableArtifact} = require('../lib/report-run');
const {buildFactCatalog} = require('../lib/fact-catalog');
const {annotateFactReferences, expandFactReferences} = require('../lib/fact-references');
const {buildSourceCoverageCatalog, annotateSourceCoverageReferences} = require('../lib/source-coverage');
const {buildSourceRecords, buildFallbackSelection, renderSourceSelection} = require('../lib/source-selection');
const {enforceSourceSelectionStatus} = require('../lib/source-selection-evidence');
const {validateV2ReportContract} = require('../lib/report-contract');

function summarize(validation) {
  const errors = {}, warnings = {};
  for (const issue of validation.issues) {
    const counts = issue.severity === 'error' ? errors : warnings;
    counts[issue.code] = (counts[issue.code] || 0) + 1;
  }
  return {status:validation.status,errors,warnings};
}

function replaySnapshot({snapshotPath, draftPath, categories, outputDir}) {
  const snapshot = readSnapshot(snapshotPath);
  categories ||= require('../repo-config.json').categories;
  const coverage = buildSourceCoverageCatalog(snapshot,categories);
  const catalog = buildFactCatalog(snapshot.rawContent,[{
    type:'meeting_date',raw:snapshot.meetingDate,subject:'meeting date',
  }],{knownPaths:coverage.knownPaths});
  const source = annotateSourceCoverageReferences(annotateFactReferences(snapshot.rawContent,catalog),coverage);
  const records = buildSourceRecords(snapshot,source,coverage);
  const selection = buildFallbackSelection(records);
  const annotatedContent = expandFactReferences(renderSourceSelection(records,selection,{fallback:true}),catalog);
  const options = {meetingDate:snapshot.meetingDate,reportDepth:3,snapshotHash:snapshot.contentHash,
    sectionHeader:records.heading,repos:{},knownPaths:coverage.knownPaths,
    sourceCoverageMode:'required_sections_notion_advisory_v2'};
  const result = validateV2ReportContract(snapshot.rawContent,annotatedContent,catalog,coverage,options);
  const validation = enforceSourceSelectionStatus(result.validation,'source_selection');
  let previous = null;
  if (draftPath) {
    const read = name => JSON.parse(fs.readFileSync(path.join(path.dirname(draftPath),name),'utf8'));
    const state = read('state.json');
    const oldCatalog = read('fact-catalog.json');
    const oldCoverage = state.sourceCoverageMode ? read('source-coverage.json') : null;
    // A historic draft owns its original IDs, not the freshly rebuilt catalog.
    assertRunInputs(state,snapshot,oldCatalog,{
      attemptId:state.attemptId,meetingDate:snapshot.meetingDate,reportDepth:state.reportDepth,
    },oldCoverage);
    previous = validateV2ReportContract(snapshot.rawContent,fs.readFileSync(draftPath,'utf8'),oldCatalog,oldCoverage,{
      ...options,knownPaths:oldCoverage?.knownPaths,sourceCoverageMode:state.sourceCoverageMode,
    }).validation;
  }
  const summary = {schemaVersion:1,offlineOnly:true,aiCalls:0,liveStatusVerified:false,
    meetingDate:snapshot.meetingDate,snapshotHash:snapshot.contentHash,
    sourceRecords:records.records.length,selectedRecords:selection.sections.reduce((total,section)=>
      total+section.groups.reduce((count,group)=>count+group.items.length,0),0),
    cleanReportHash:sha256(result.cleanContent),selection:summarize(validation),
    ...(previous ? {previousDraft:summarize(previous)} : {})};
  if (outputDir) {
    fs.mkdirSync(path.dirname(path.resolve(outputDir)),{recursive:true});
    fs.mkdirSync(outputDir); // Existing directories are never reused or overwritten.
    const artifacts = {'summary.json':summary,'source-records.json':records,'selection.json':selection,
      'validation.json':validation,...(previous ? {'previous-validation.json':previous} : {})};
    for (const [name,value] of Object.entries(artifacts)) writeImmutableArtifact(path.join(outputDir,name),JSON.stringify(value,null,2)+'\n');
    writeImmutableArtifact(path.join(outputDir,'report.md'),result.cleanContent);
    writeImmutableArtifact(path.join(outputDir,'report.annotated.md'),annotatedContent);
  }
  return {summary,validation,cleanContent:result.cleanContent};
}

function main(args) {
  const options = {};
  const flags = {'--snapshot':'snapshotPath','--draft':'draftPath','--output-dir':'outputDir'};
  for (let i=0;i<args.length;i+=2) {
    const key = flags[args[i]];
    if (!key || !args[i+1] || args[i+1].startsWith('--') || options[key]) throw new Error('Usage: node scripts/replay-source-selection.js --snapshot FILE [--draft ANNOTATED_DRAFT] [--output-dir NEW_DIR]');
    options[key] = path.resolve(args[i+1]);
  }
  if (!options.snapshotPath) throw new Error('--snapshot is required');
  const {summary} = replaySnapshot(options);
  process.stdout.write(JSON.stringify(summary,null,2)+'\n');
  if (summary.selection.status === 'FAIL') process.exitCode = 2;
}

if (require.main === module) {
  try {main(process.argv.slice(2));}
  catch (error) {process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
module.exports = {replaySnapshot};
