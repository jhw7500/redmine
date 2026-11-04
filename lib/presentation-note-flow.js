"use strict";

const {
  COMPLETED_TAG,
  closePresentedNotes,
  publishNotes,
  queryCompletedNotes,
} = require("./notion-issue-publisher");
const { describeEmptySelection, selectPresentationNotes } = require("./presentation-note-classifier");
const { appendNotesBlock } = require("./publisher");
const { stripAstralChars } = require("./text-normalization");

function buildIssueEnv(config) {
  return {
    redmineBase: config.env.baseUrl,
    redmineKey: config.env.apiKey,
    notionKey: process.env.NOTION_API_KEY,
    projectIdentifier: config.env.projectId,
  };
}

// 주간 게시의 발표노트 흐름. ready 게시(runUpdate)와 거부 보고서 게시(runWeeklyPublishRejected, #138)가 함께 쓴다.
// assertReady는 호출자의 게시 게이트(ready는 READY 재검증, 거부 보고서는 해시 결합)이고 이 흐름은 검증을 더하지 않는다.
// loadNoteRefs는 update()가 Wiki 반영 직전에 부르고, closeCompleted는 게시가 끝난 뒤에만 부른다.
function createPresentationNoteFlow({ config, snapshot, reportContent, assertReady, queryCompleted, closePresented }) {
  // Publication policy is independent of the report's display depth.
  const candidates = selectPresentationNotes(
      snapshot.presentationCandidates || [],
      config.env.presentationNoteMode
    );
  if (!candidates.length) {
    const notice = describeEmptySelection(
      snapshot.presentationCandidates || [],
      config.env.presentationNoteMode
    );
    if (notice) console.warn(notice);
  }
  let presentationNotesWritten = false;
  const loadNoteRefs = candidates.length
    ? async () => {
      const previewRefs = candidates.map((candidate, index) => ({
        id: `pending-${index + 1}`,
        title: stripAstralChars(String(candidate.title || "")),
      }));
      await assertReady(appendNotesBlock(reportContent, previewRefs));
      if (!process.env.NOTION_API_KEY) {
        throw new Error("발표노트 Issue 생성에 NOTION_API_KEY가 필요합니다.");
      }
      const refs = await publishNotes(buildIssueEnv(config), candidates, { assertReady, requireAll: true });
      presentationNotesWritten = refs.some((ref) => ref.reused === false);
      console.log(`[issue] presentation notes: ${refs.length}`);
      return refs;
    }
    : null;

  return {
    loadNoteRefs,
    // A later Wiki read or READY check can fail after note creation has returned.
    // Keep that write evidence even though no Wiki PUT has been attempted yet.
    markWriteEvidence(error) {
      if (presentationNotesWritten) error.serverState = "written_unverified";
      return error;
    },
    // 발표완료 태그가 붙은 노트의 이슈를 종료한다. 게시가 끝난 뒤에만 수행하고,
    // 종료 실패가 주간 게시를 되돌리지 않도록 여기서 삼킨다.
    async closeCompleted() {
      if (config.env.presentationNoteMode !== 'off' && process.env.NOTION_API_KEY) {
        try {
          const issueEnv = buildIssueEnv(config);
          const done = await (queryCompleted || queryCompletedNotes)(issueEnv);
          const closed = await (closePresented || closePresentedNotes)(issueEnv, done);
          console.log(`[issue] ${COMPLETED_TAG} 종료: ${closed.length}/${done.length}건`);
        } catch (err) {
          console.warn(`[issue] 자동 종료 건너뜀: ${err.message}`);
        }
      }
    },
  };
}

module.exports = { buildIssueEnv, createPresentationNoteFlow };
