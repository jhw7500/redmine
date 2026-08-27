const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./lib/config");
const { buildFactCatalog } = require("./lib/fact-catalog");
const {
  validateAnnotatedReport,
  validateNonFactRules,
  validateReport,
} = require("./lib/fact-validator");
const { publishNotes } = require("./lib/notion-issue-publisher");
const { selectPresentationNotes } = require("./lib/presentation-note-classifier");
const {
  buildCandidatesPath,
  buildGenerationStatePath,
  buildPublishedPath,
  buildValidationPath,
  sha256,
  writeJsonAtomic,
} = require("./lib/report-artifact");
const { collectSnapshot, loadSnapshot } = require("./lib/report-snapshot");
const {
  blockingWarnings,
  isPublishable,
} = require("./lib/report-publishability");
const {
  appendValidationRevision,
  assertGenerationStateOwned,
  assertRunInputs,
  buildRunPaths,
  initializeReportRun,
  loadReportRun,
  loadResolvedReportRun,
  promoteRunReport,
  resolveReportRunPaths,
  updateRunState,
  withGenerationStateLock,
  withRunValidationLock,
  writeImmutableArtifact,
} = require("./lib/report-run");
const {
  buildOutputPath,
  buildWikiUrl,
  buildAiPrompt,
  extractTitleFromUrl,
  formatDate,
  generate,
  generateContent,
  parseMeetingDateFromTitle,
  resolveMeetingDate,
  targetWednesday,
  update,
} = require("./lib/publisher");

function resolveRunMeetingDate(config, now = new Date()) {
  let meetingDate = resolveMeetingDate(config);
  let wikiUrl = config.env.wikiUrl;

  if (!wikiUrl) {
    if (!meetingDate) meetingDate = targetWednesday(now);
    wikiUrl = buildWikiUrl(meetingDate, config);
  }

  if (!meetingDate) {
    const title = extractTitleFromUrl(wikiUrl);
    meetingDate = parseMeetingDateFromTitle(title) || targetWednesday(now);
  }

  if (!meetingDate || Number.isNaN(meetingDate.getTime())) {
    throw new Error("Could not determine meeting date. Set MEETING_DATE=YYYY-MM-DD.");
  }
  return meetingDate;
}

function writeCandidates(snapshot, snapshotPath, meetingDate, config) {
  const candidatesPath = buildCandidatesPath(meetingDate, config);
  writeJsonAtomic(candidatesPath, {
    schemaVersion: 1,
    meetingDate: snapshot.meetingDate,
    snapshotPath,
    snapshotHash: snapshot.contentHash,
    mode: config.env.presentationNoteMode,
    candidates: snapshot.presentationCandidates || [],
  });
  console.log(`[presentation] 후보 저장: ${candidatesPath}`);
  return candidatesPath;
}

function validateDraft(snapshot, snapshotPath, reportPath, meetingDate, config, options = {}) {
  const reportContent = Object.prototype.hasOwnProperty.call(options, "reportContent")
    ? String(options.reportContent)
    : fs.readFileSync(reportPath, "utf8");
  const validation = validateReport(snapshot.rawContent, reportContent, {
    meetingDate: formatDate(meetingDate),
    reportDepth: config.env.reportDepth,
    sectionHeader: config.env.sectionHeader,
    snapshotHash: snapshot.contentHash,
    snapshotPath,
    repos: config.repos,
  });
  const validationPath = buildValidationPath(reportPath);
  writeJsonAtomic(validationPath, validation);
  console.log(`[validation] ${validation.status}: ${validationPath}`);
  for (const issue of validation.issues) {
    console.warn(`[validation] ${issue.severity} ${issue.code}: ${issue.message}`);
  }
  return { validation, validationPath };
}

const NON_OVERRIDABLE_V2_CODES = new Set([
  "malformed_fact_marker",
  "unknown_fact_id",
  "fact_value_mismatch",
  "fact_subject_mismatch",
  "unmarked_protected_fact",
  "snapshot_hash_mismatch",
  "catalog_hash_mismatch",
  "annotated_draft_hash_mismatch",
  "clean_report_hash_mismatch",
  "validation_path_mismatch",
  "attempt_ownership_mismatch",
  "run_path_mismatch",
  "prompt_input_hash_mismatch",
  "raw_ai_draft_hash_mismatch",
]);

function hasNonOverridableV2Issue(validation) {
  return Boolean(
    validation
    && validation.schemaVersion === 2
    && (validation.issues || []).some(
      (issue) => NON_OVERRIDABLE_V2_CODES.has(issue.code)
    )
  );
}

function assertPublishable(validation, config) {
  if (hasNonOverridableV2Issue(validation)) {
    const issue = validation.issues.find(
      (candidate) => NON_OVERRIDABLE_V2_CODES.has(candidate.code)
    );
    const error = new Error(
      `schema v2 validation issue cannot be overridden: ${issue.code}`
    );
    error.code = issue.code;
    throw error;
  }
  if (isPublishable(validation)) {
    if (validation.status === "WARNING") {
      // 어떤 경고를 수동 확인해야 하는지 cron 로그만 보고 알 수 있어야 한다.
      const codes = (validation.issues || [])
        .filter((issue) => issue.severity === "warning")
        .map((issue) => issue.code)
        .join(", ");
      console.warn(
        `[validation] WARNING${codes ? `(${codes})` : ""} — 게시를 막는 항목은 없습니다. 경고는 수동 확인이 필요합니다.`
      );
    }
    return;
  }
  if (config.env.validationOverride) {
    console.warn(`[validation] VALIDATION_OVERRIDE=1 — ${validation.status} 결과를 수동 우회합니다.`);
    return;
  }
  if (config.env.validationMode === "block") {
    throw new Error(`보고서 검증 ${validation.status}: Redmine 반영을 중단합니다.`);
  }
  console.warn(`[validation] VALIDATION_MODE=warn — ${validation.status} 상태로 계속합니다.`);
}

async function runCollect(config, meetingDate) {
  const result = await collectSnapshot(config, meetingDate);
  writeCandidates(result.snapshot, result.snapshotPath, meetingDate, config);
  if (result.snapshot.status !== "sealed" && !config.env.allowPartialSnapshot) {
    throw new Error(
      `수집 snapshot이 ${result.snapshot.status} 상태입니다: ${result.snapshot.failures.join("; ")}`
    );
  }
  return result;
}

function writeGenerationStateIfOwned(statePath, attemptId, patch) {
  try {
    return withGenerationStateLock(statePath, () => {
      if (!fs.existsSync(statePath)) return false;
      let current;
      try {
        current = JSON.parse(fs.readFileSync(statePath, "utf8"));
      } catch (error) {
        return false;
      }
      if (current.attemptId !== attemptId) return false;
      writeJsonAtomic(statePath, { ...current, ...patch });
      return true;
    });
  } catch (error) {
    if (error && error.code === "GENERATION_STATE_LOCKED") return false;
    throw error;
  }
}

async function runGenerateV1(config, meetingDate) {
  const { snapshot, snapshotPath } = loadSnapshot(config, meetingDate);
  const expectedReportPath = buildOutputPath(meetingDate, config);
  const generationStatePath = buildGenerationStatePath(expectedReportPath);
  const startedAt = new Date().toISOString();
  const stateBase = {
    schemaVersion: 1,
    meetingDate: formatDate(meetingDate),
    reportDepth: Number(config.env.reportDepth),
    snapshotHash: snapshot.contentHash,
    attemptId: crypto.randomUUID(),
    startedAt,
  };
  withGenerationStateLock(generationStatePath, () => {
    writeJsonAtomic(generationStatePath, { ...stateBase, status: "running" });
  });

  try {
    writeCandidates(snapshot, snapshotPath, meetingDate, config);
    const reportPath = await generate(
      config,
      meetingDate,
      snapshot.autoContent,
      [],
      { rawContent: snapshot.rawContent }
    );
    const validationResult = validateDraft(
      snapshot,
      snapshotPath,
      reportPath,
      meetingDate,
      config
    );
    const completed = writeGenerationStateIfOwned(generationStatePath, stateBase.attemptId, {
      status: "complete",
      completedAt: new Date().toISOString(),
      validationStatus: validationResult.validation.status,
    });
    if (!completed) {
      const error = new Error("새 generate 시도가 이 실행을 대체했습니다.");
      error.code = "GENERATION_SUPERSEDED";
      throw error;
    }
    return { snapshot, snapshotPath, reportPath, generationStatePath, ...validationResult };
  } catch (error) {
    writeGenerationStateIfOwned(generationStatePath, stateBase.attemptId, {
      status: "failed",
      failedAt: new Date().toISOString(),
      errorCode: error && error.code ? error.code : "GENERATE_FAILED",
    });
    throw error;
  }
}

function generationSupersededError() {
  const error = new Error("새 generate 시도가 이 실행을 대체했습니다.");
  error.code = "GENERATION_SUPERSEDED";
  return error;
}

function writeOwnedOrThrow(statePath, attemptId, patch) {
  if (!writeGenerationStateIfOwned(statePath, attemptId, patch)) {
    throw generationSupersededError();
  }
}

function markRecoverableRunFailure(runPaths, generationStatePath, attemptId, error) {
  const failedAt = new Date().toISOString();
  const errorCode = error && error.code ? error.code : "GENERATE_FAILED";
  try {
    updateRunState(runPaths, attemptId, {
      status: "validation_failed",
      failedAt,
      errorCode,
    });
  } catch (stateError) {
    error.recoveryStateError = stateError;
  }
  writeGenerationStateIfOwned(generationStatePath, attemptId, {
    status: "failed",
    failedAt,
    errorCode,
  });
}

async function runGenerateV2(config, meetingDate) {
  const { snapshot, snapshotPath } = loadSnapshot(config, meetingDate);
  const reportPath = buildOutputPath(meetingDate, config);
  const generationStatePath = buildGenerationStatePath(reportPath);
  const meetingDateText = formatDate(meetingDate);
  const attemptId = crypto.randomUUID();
  const runPaths = buildRunPaths(config.env.outputDir, meetingDateText, attemptId);
  const startedAt = new Date().toISOString();
  const generationStateBase = {
    schemaVersion: 2,
    meetingDate: meetingDateText,
    reportDepth: Number(config.env.reportDepth),
    snapshotHash: snapshot.contentHash,
    attemptId,
    runDir: runPaths.runDir,
    startedAt,
  };
  let runInitialized = false;
  let aiStarted = false;
  let aiComplete = false;
  let promptInputHash = null;
  let rawAiDraftHash = null;

  withGenerationStateLock(generationStatePath, () => {
    writeJsonAtomic(generationStatePath, { ...generationStateBase, status: "running" });
  });

  try {
    initializeReportRun(runPaths, { ...generationStateBase, status: "running" });
    runInitialized = true;
    writeCandidates(snapshot, snapshotPath, meetingDate, config);

    const catalog = buildFactCatalog(snapshot.rawContent, [{
      type: "meeting_date",
      raw: meetingDateText,
      subject: "meeting date",
    }]);
    writeImmutableArtifact(
      runPaths.catalogPath,
      JSON.stringify(catalog, null, 2) + "\n"
    );
    updateRunState(runPaths, attemptId, { catalogHash: catalog.catalogHash });
    writeOwnedOrThrow(generationStatePath, attemptId, { catalogHash: catalog.catalogHash });

    const prompt = buildAiPrompt(snapshot.rawContent, config, meetingDate, { factCatalog: catalog });
    const serializedPromptInput = JSON.stringify({
      snapshotPath,
      snapshotHash: snapshot.contentHash,
      catalogHash: catalog.catalogHash,
      promptHash: sha256(prompt),
      model: config.env.aiModel,
      effort: config.env.aiEffort,
      promptLength: prompt.length,
      timeoutMs: config.env.aiTimeoutMs,
    }, null, 2) + "\n";
    promptInputHash = sha256(serializedPromptInput);
    writeImmutableArtifact(runPaths.promptInputPath, serializedPromptInput);
    updateRunState(runPaths, attemptId, { promptInputHash });
    writeOwnedOrThrow(generationStatePath, attemptId, { promptInputHash });

    aiStarted = true;
    const generated = await generateContent(config, meetingDate, snapshot.rawContent, {
      factCatalog: catalog,
      prompt,
      onRawAiOutput: (rawAiOutput) => {
        writeImmutableArtifact(runPaths.aiDraftPath, rawAiOutput);
        rawAiDraftHash = sha256(rawAiOutput);
        updateRunState(runPaths, attemptId, { rawAiDraftHash });
        writeOwnedOrThrow(generationStatePath, attemptId, { rawAiDraftHash });
      },
    });
    writeImmutableArtifact(runPaths.workingDraftPath, generated.content);
    updateRunState(runPaths, attemptId, {
      status: "ai_complete",
      sanitizer: {
        inputHash: sha256(generated.rawAiOutput),
        outputHash: sha256(generated.content),
      },
      aiCompletedAt: new Date().toISOString(),
    });
    aiComplete = true;

    const result = validateAnnotatedReport(
      snapshot.rawContent,
      generated.content,
      catalog,
      {
        attemptId,
        meetingDate: meetingDateText,
        reportDepth: Number(config.env.reportDepth),
        snapshotHash: snapshot.contentHash,
        snapshotPath,
        sectionHeader: config.env.sectionHeader,
        repos: config.repos,
        openIssueVerifierOptions: config.openIssueVerifierOptions,
      }
    );
    result.validation.publishable = isPublishable(result.validation);
    if (result.validation.publishable) {
      result.validation.cleanReportHash = sha256(result.cleanContent);
    }
    return withRunValidationLock(runPaths, () => {
      const revision = appendValidationRevision(runPaths, attemptId, result.validation);
      result.validation = revision.validation;
      const latestValidationPath = path.basename(revision.validationPath);

      if (!result.validation.publishable) {
        updateRunState(runPaths, attemptId, { status: "validation_failed" });
        writeOwnedOrThrow(generationStatePath, attemptId, {
          status: "failed",
          failedAt: new Date().toISOString(),
          validationStatus: result.validation.status,
          latestValidationPath,
          latestValidationHash: revision.validationHash,
          validationRevision: revision.revision,
        });
        return {
          snapshot,
          snapshotPath,
          reportPath,
          generationStatePath,
          runPaths,
          validation: result.validation,
        };
      }

      promoteRunReport({
        paths: runPaths,
        reportPath,
        generationStatePath,
        cleanContent: result.cleanContent,
        validation: result.validation,
        generationState: {
          ...generationStateBase,
          status: "complete",
          completedAt: new Date().toISOString(),
          catalogHash: catalog.catalogHash,
          validationStatus: result.validation.status,
          latestValidationPath,
          latestValidationHash: revision.validationHash,
          validationRevision: revision.revision,
          cleanReportHash: result.validation.cleanReportHash,
          promptInputHash,
          rawAiDraftHash,
        },
      });
      return {
        snapshot,
        snapshotPath,
        reportPath,
        generationStatePath,
        runPaths,
        validation: result.validation,
      };
    });
  } catch (error) {
    if (runInitialized && aiComplete) {
      markRecoverableRunFailure(runPaths, generationStatePath, attemptId, error);
    } else if (runInitialized && aiStarted) {
      try {
        updateRunState(runPaths, attemptId, {
          status: "ai_failed",
          failedAt: new Date().toISOString(),
          errorCode: error && error.code ? error.code : "GENERATE_FAILED",
        });
      } catch (stateError) {
        if (!/transition|attempt/i.test(stateError.message)) throw stateError;
      }
    }
    writeGenerationStateIfOwned(generationStatePath, attemptId, {
      status: "failed",
      failedAt: new Date().toISOString(),
      errorCode: error && error.code ? error.code : "GENERATE_FAILED",
    });
    throw error;
  }
}

async function runGenerate(config, meetingDate) {
  return config.env.aiSummarize
    ? runGenerateV2(config, meetingDate)
    : runGenerateV1(config, meetingDate);
}

async function runRevalidate(config, meetingDate) {
  const meetingDateText = formatDate(meetingDate);
  const runPaths = resolveReportRunPaths(
    config.env.outputDir,
    meetingDateText,
    config.env.runId
  );
  const reportPath = buildOutputPath(meetingDate, config);
  const generationStatePath = buildGenerationStatePath(reportPath);

  return withRunValidationLock(runPaths, () => {
    const run = loadResolvedReportRun(runPaths, config.env.runId);
    const { snapshot, snapshotPath } = loadSnapshot(config, meetingDate);
    assertGenerationStateOwned(generationStatePath, run.state.attemptId);
    assertRunInputs(run.state, snapshot, run.catalog, {
      attemptId: config.env.runId,
      meetingDate: meetingDateText,
      reportDepth: Number(config.env.reportDepth),
    });
    if (run.state.status !== "validation_failed") {
      throw new Error(`revalidate requires validation_failed state, got ${run.state.status}`);
    }

    const annotated = fs.readFileSync(run.paths.workingDraftPath, "utf8");
    const result = validateAnnotatedReport(snapshot.rawContent, annotated, run.catalog, {
      attemptId: run.state.attemptId,
      meetingDate: meetingDateText,
      reportDepth: Number(config.env.reportDepth),
      snapshotHash: snapshot.contentHash,
      snapshotPath,
      sectionHeader: config.env.sectionHeader,
      repos: config.repos,
      openIssueVerifierOptions: config.openIssueVerifierOptions,
    });
    const publishable = isPublishable(result.validation);
    if (publishable) {
      result.validation.cleanReportHash = sha256(result.cleanContent);
    }
    const revision = appendValidationRevision(
      run.paths,
      run.state.attemptId,
      result.validation
    );
    result.validation = revision.validation;
    const latestValidationPath = path.basename(revision.validationPath);

    if (!publishable) {
      updateRunState(run.paths, run.state.attemptId, { status: "validation_failed" });
      writeOwnedOrThrow(generationStatePath, run.state.attemptId, {
        status: "failed",
        validationStatus: result.validation.status,
        latestValidationPath,
        latestValidationHash: revision.validationHash,
        validationRevision: revision.revision,
      });
      return { ...result, runPaths: run.paths, reportPath };
    }

    promoteRunReport({
      paths: run.paths,
      reportPath,
      generationStatePath,
      cleanContent: result.cleanContent,
      validation: result.validation,
      generationState: {
        ...revision.state,
        status: "complete",
        cleanReportHash: result.validation.cleanReportHash,
        latestValidationPath,
      },
    });
    return { ...result, runPaths: run.paths, reportPath };
  });
}

function assertGenerationComplete(
  reportPath,
  snapshot,
  meetingDate,
  config,
  expectedAttemptId = null
) {
  const statePath = buildGenerationStatePath(reportPath);
  if (!fs.existsSync(statePath)) {
    throw new Error(`generation state is not complete: missing ${statePath}`);
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new Error(`generation state is not complete: unreadable ${statePath}`);
  }

  const expectedDate = formatDate(meetingDate);
  const expectedDepth = Number(config.env.reportDepth);
  if (state.schemaVersion === 1) {
    const v2OwnershipFields = [
      "runDir",
      "catalogHash",
      "latestValidationPath",
      "latestValidationHash",
      "validationRevision",
      "cleanReportHash",
      "promptInputHash",
      "rawAiDraftHash",
    ];
    const hasV2Ownership = v2OwnershipFields.some((field) => Object.hasOwn(state, field));
    let matchingV2RunExists = false;
    try {
      matchingV2RunExists = fs.existsSync(
        buildRunPaths(config.env.outputDir, expectedDate, state.attemptId).runDir
      );
    } catch (error) {
      matchingV2RunExists = false;
    }
    if (hasV2Ownership || matchingV2RunExists) {
      throw new Error("schema v2 downgrade detected in generation state");
    }
  }
  if (state.schemaVersion === 2 && state.snapshotHash !== snapshot.contentHash) {
    throw evidenceError("snapshot_hash_mismatch", "generation snapshot hash mismatch");
  }
  if (
    state.schemaVersion === 2
    && expectedAttemptId !== null
    && state.attemptId !== expectedAttemptId
  ) {
    throw evidenceError("attempt_ownership_mismatch", "generation attempt ownership mismatch");
  }
  if (
    ![1, 2].includes(state.schemaVersion) ||
    state.status !== "complete" ||
    state.snapshotHash !== snapshot.contentHash ||
    state.meetingDate !== expectedDate ||
    state.reportDepth !== expectedDepth ||
    (expectedAttemptId !== null && state.attemptId !== expectedAttemptId)
  ) {
    throw new Error(
      `generation state is not complete for snapshot/date/depth: ${statePath}`
    );
  }
  return { state, statePath };
}

function evidenceError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function mapRunEvidenceError(error) {
  const message = String(error && error.message);
  if (/snapshot hash/i.test(message)) {
    return evidenceError("snapshot_hash_mismatch", message, error);
  }
  if (/catalog hash/i.test(message)) {
    return evidenceError("catalog_hash_mismatch", message, error);
  }
  if (/attempt|ownership/i.test(message)) {
    return evidenceError("attempt_ownership_mismatch", message, error);
  }
  return evidenceError("run_path_mismatch", message, error);
}

function assertV2PublishEvidence({ state, reportContent, snapshot, meetingDate, config }) {
  const reportPath = buildOutputPath(meetingDate, config);
  let current;
  try {
    current = assertGenerationComplete(
      reportPath,
      snapshot,
      meetingDate,
      config,
      state && state.attemptId
    ).state;
  } catch (error) {
    if (NON_OVERRIDABLE_V2_CODES.has(error && error.code)) throw error;
    if (state && state.snapshotHash !== snapshot.contentHash) {
      throw evidenceError("snapshot_hash_mismatch", "snapshot hash mismatch", error);
    }
    throw evidenceError("attempt_ownership_mismatch", error.message, error);
  }
  if (current.schemaVersion !== 2 || !state || state.schemaVersion !== 2) {
    throw evidenceError("attempt_ownership_mismatch", "schema v2 publish evidence is required");
  }
  if (current.attemptId !== state.attemptId) {
    throw evidenceError("attempt_ownership_mismatch", "attempt ownership mismatch");
  }

  let run;
  try {
    run = loadReportRun(
      config.env.outputDir,
      formatDate(meetingDate),
      current.attemptId
    );
    assertRunInputs(run.state, snapshot, run.catalog, {
      attemptId: current.attemptId,
      meetingDate: formatDate(meetingDate),
      reportDepth: Number(config.env.reportDepth),
    });
  } catch (error) {
    throw mapRunEvidenceError(error);
  }

  if (
    current.runDir !== run.paths.runDir
    || run.state.status !== "complete"
  ) {
    throw evidenceError("run_path_mismatch", "run path or completion state mismatch");
  }
  if (current.catalogHash !== run.state.catalogHash) {
    throw evidenceError("catalog_hash_mismatch", "catalog hash mismatch");
  }
  const pinnedArtifacts = [
    {
      code: "prompt_input_hash_mismatch",
      label: "prompt input",
      filePath: run.paths.promptInputPath,
      globalHash: current.promptInputHash,
      runHash: run.state.promptInputHash,
    },
    {
      code: "raw_ai_draft_hash_mismatch",
      label: "raw AI draft",
      filePath: run.paths.aiDraftPath,
      globalHash: current.rawAiDraftHash,
      runHash: run.state.rawAiDraftHash,
    },
  ];
  for (const artifact of pinnedArtifacts) {
    let content;
    try {
      content = fs.readFileSync(artifact.filePath, "utf8");
    } catch (error) {
      throw evidenceError(
        artifact.code,
        `${artifact.label} artifact is missing or unreadable`,
        error
      );
    }
    if (
      !artifact.globalHash
      || artifact.globalHash !== artifact.runHash
      || sha256(content) !== artifact.runHash
    ) {
      throw evidenceError(artifact.code, `${artifact.label} artifact hash mismatch`);
    }
  }

  const latestValidationPath = current.latestValidationPath;
  const expectedValidationPath = Number.isInteger(run.state.validationRevision)
    ? `validation.${String(run.state.validationRevision).padStart(3, "0")}.json`
    : null;
  if (
    typeof latestValidationPath !== "string"
    || path.basename(latestValidationPath) !== latestValidationPath
    || !/^validation\.\d{3}\.json$/.test(latestValidationPath)
    || run.state.latestValidationPath !== latestValidationPath
    || expectedValidationPath !== latestValidationPath
    || current.validationRevision !== run.state.validationRevision
    || current.latestValidationHash !== run.state.latestValidationHash
  ) {
    throw evidenceError("validation_path_mismatch", "validation path ownership mismatch");
  }
  const validationPath = path.join(run.paths.runDir, latestValidationPath);
  let realValidationPath;
  try {
    realValidationPath = fs.realpathSync(validationPath);
  } catch (error) {
    throw evidenceError(
      "validation_path_mismatch",
      `validation path is missing: ${validationPath}`,
      error
    );
  }
  if (path.dirname(realValidationPath) !== run.paths.runDir) {
    throw evidenceError("validation_path_mismatch", "validation path escapes run directory");
  }
  let validationText;
  let validation;
  try {
    validationText = fs.readFileSync(realValidationPath, "utf8");
    validation = JSON.parse(validationText);
  } catch (error) {
    throw evidenceError(
      "validation_path_mismatch",
      `validation evidence is missing or unreadable: ${realValidationPath}`,
      error
    );
  }
  if (
    validation.revision !== run.state.validationRevision
    || !run.state.latestValidationHash
    || sha256(validationText) !== run.state.latestValidationHash
  ) {
    throw evidenceError(
      "validation_path_mismatch",
      "validation artifact hash mismatch or intrinsic revision mismatch"
    );
  }
  if (
    validation.schemaVersion !== 2
    || validation.attemptId !== current.attemptId
    || run.state.attemptId !== current.attemptId
  ) {
    throw evidenceError("attempt_ownership_mismatch", "validation attempt ownership mismatch");
  }
  if (validation.snapshotHash !== current.snapshotHash) {
    throw evidenceError("snapshot_hash_mismatch", "validation snapshot hash mismatch");
  }
  if (
    validation.catalogHash !== current.catalogHash
    || validation.catalogHash !== run.catalog.catalogHash
  ) {
    throw evidenceError("catalog_hash_mismatch", "validation catalog hash mismatch");
  }
  if (hasNonOverridableV2Issue(validation)) {
    assertPublishable(validation, config);
  }
  if (!isPublishable(validation)) {
    throw evidenceError("clean_report_hash_mismatch", "validation evidence is not publishable");
  }

  let annotatedContent;
  let runCleanContent;
  let canonicalContent;
  try {
    annotatedContent = fs.readFileSync(run.paths.workingDraftPath, "utf8");
    runCleanContent = fs.readFileSync(run.paths.cleanReportPath, "utf8");
    canonicalContent = fs.readFileSync(reportPath, "utf8");
  } catch (error) {
    throw evidenceError("clean_report_hash_mismatch", "run draft or clean report is missing", error);
  }
  if (sha256(annotatedContent) !== validation.annotatedDraftHash) {
    throw evidenceError("annotated_draft_hash_mismatch", "annotated draft hash mismatch");
  }
  const expectedCleanHash = validation.cleanReportHash;
  if (
    !expectedCleanHash
    || current.cleanReportHash !== expectedCleanHash
    || sha256(runCleanContent) !== expectedCleanHash
    || sha256(canonicalContent) !== expectedCleanHash
    || canonicalContent !== reportContent
    || sha256(reportContent) !== expectedCleanHash
  ) {
    throw evidenceError("clean_report_hash_mismatch", "clean report hash mismatch");
  }

  return { validation, run };
}

function buildPublishTimeValidation(evidenceValidation, publishTime) {
  const issues = [...(publishTime.issues || [])];
  const status = issues.some((issue) => issue.severity === "error")
    ? "FAIL"
    : issues.some((issue) => issue.severity === "warning")
      ? "WARNING"
      : "PASS";
  return {
    ...evidenceValidation,
    status,
    checkedAt: new Date().toISOString(),
    facts: {
      ...(evidenceValidation.facts || {}),
      openIssueChecks: [...(publishTime.openIssueChecks || [])],
    },
    issues,
  };
}

function buildIssueEnv(config) {
  return {
    redmineBase: config.env.baseUrl,
    redmineKey: config.env.apiKey,
    notionKey: process.env.NOTION_API_KEY,
    projectIdentifier: config.env.projectId,
  };
}

async function runUpdate(config, meetingDate) {
  const { snapshot, snapshotPath } = loadSnapshot(config, meetingDate);
  const reportPath = buildOutputPath(meetingDate, config);
  if (!fs.existsSync(reportPath)) {
    throw new Error(`초안 파일이 없습니다: ${reportPath}`);
  }
  const generation = assertGenerationComplete(reportPath, snapshot, meetingDate, config);
  const reportContent = fs.readFileSync(reportPath, "utf8");

  const validateV2Ready = () => {
    const evidence = assertV2PublishEvidence({
      state: generation.state,
      reportContent,
      snapshot,
      meetingDate,
      config,
    });
    const publishTime = validateNonFactRules(reportContent, {
      meetingDate: formatDate(meetingDate),
      reportDepth: Number(config.env.reportDepth),
      snapshotHash: snapshot.contentHash,
      sectionHeader: config.env.sectionHeader,
      repos: config.repos,
      openIssueVerifierOptions: config.openIssueVerifierOptions,
    });
    const freshValidation = buildPublishTimeValidation(evidence.validation, publishTime);
    assertPublishable(freshValidation, config);
    return { evidence, validation: freshValidation };
  };

  let validation;
  let validationPath;
  if (generation.state.schemaVersion === 2) {
    const ready = validateV2Ready();
    const { evidence } = ready;
    validation = ready.validation;
    validationPath = path.join(
      evidence.run.paths.runDir,
      generation.state.latestValidationPath
    );
  } else {
    const legacy = validateDraft(
      snapshot,
      snapshotPath,
      reportPath,
      meetingDate,
      config,
      { reportContent }
    );
    validation = legacy.validation;
    validationPath = legacy.validationPath;
  }
  if (generation.state.schemaVersion !== 2) assertPublishable(validation, config);
  writeCandidates(snapshot, snapshotPath, meetingDate, config);

  const validateV1Ready = () => {
    const evidence = assertGenerationComplete(
      reportPath,
      snapshot,
      meetingDate,
      config,
      generation.state.attemptId
    );
    const fresh = validateDraft(
      snapshot,
      snapshotPath,
      reportPath,
      meetingDate,
      config,
      { reportContent }
    );
    assertPublishable(fresh.validation, config);
    return evidence;
  };
  const assertReady = () => generation.state.schemaVersion === 2
    ? validateV2Ready().evidence
    : validateV1Ready();

  // 발표노트 자동 등록은 프로젝트 정책상 운영 프로필인 depth3 update에서만 수행한다.
  const candidates = Number(config.env.reportDepth) === 3
    ? selectPresentationNotes(
      snapshot.presentationCandidates || [],
      config.env.presentationNoteMode
    )
    : [];
  const loadNoteRefs = candidates.length
    ? async () => {
      if (!process.env.NOTION_API_KEY) {
        throw new Error("발표노트 Issue 생성에 NOTION_API_KEY가 필요합니다.");
      }
      const refs = await publishNotes(buildIssueEnv(config), candidates, { assertReady });
      console.log(`[issue] presentation notes: ${refs.length}`);
      return refs;
    }
    : null;

  const publishedPath = buildPublishedPath(reportPath);
  const result = await update(config, meetingDate, {
    assertReady,
    draftContent: reportContent,
    loadNoteRefs,
    publishedPath,
  });
  return {
    snapshot,
    snapshotPath,
    reportPath,
    validation,
    validationPath,
    publishedPath: result && result.publishedPath,
  };
}

async function main() {
  const config = loadConfig();
  const meetingDate = resolveRunMeetingDate(config);
  console.log(`Meeting date: ${formatDate(meetingDate)}`);
  console.log(`Mode: ${config.env.mode}`);

  switch (config.env.mode) {
    case "collect":
      return runCollect(config, meetingDate);
    case "generate": {
      const result = await runGenerate(config, meetingDate);
      // update의 게시 게이트와 같은 기준을 쓴다. 다르면 게시 가능한 WARNING이
      // generate에서 실패 종료코드가 되어 cron이 매주 헛알림을 낸다.
      if (!isPublishable(result.validation) && config.env.validationMode === "block") {
        process.exitCode = 2;
      }
      return result;
    }
    case "update":
      return runUpdate(config, meetingDate);
    case "revalidate":
      return runRevalidate(config, meetingDate);
    default:
      throw new Error(`Unknown MODE: ${config.env.mode}. Use collect, generate, update, or revalidate.`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  assertGenerationComplete,
  assertPublishable,
  assertV2PublishEvidence,
  buildPublishTimeValidation,
  hasNonOverridableV2Issue,
  isPublishable,
  main,
  resolveRunMeetingDate,
  runCollect,
  runGenerate,
  runGenerateV2,
  runRevalidate,
  runUpdate,
  validateDraft,
  writeCandidates,
  writeGenerationStateIfOwned,
};
