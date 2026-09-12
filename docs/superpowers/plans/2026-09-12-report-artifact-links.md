# Report artifact links implementation plan

> Execute inline with test-driven-development. No operating-main, cron, Slack delivery, PR merge, or sharing changes.

**Goal:** Preserve explicitly associated detailed-material URLs below the corresponding selected depth2/depth3 weekly-report items.

**Architecture:** Resolve `sources.notion.reportReferences` by exact Notion source ID. Fetch only the explicitly associated saved Notion pages, including older pages, without adding them to weekly activity. Use the saved page's `url` property, or an explicitly configured URL for legacy body-only artifacts. Store resolved URL, label, version, page ID and last-edited time in the sealed source item. Emit deterministic continuation lines with the existing source-provenance mechanism; the source-selection evidence replay binds their content and owner. Do not ask the model to compose URLs.

**Tech Stack:** Existing CommonJS, Node built-in test runner, Notion read-only page API. No dependencies.

**Spec:** Approved additional review: relevant detailed-material links, compact depth2, preserved depth3, historical references distinct from current achievements. First scope is Notion source-item bindings, not keyword matching to Git commits or automatic artifact uploading. The stored metadata/report is immutable; this does not archive the remote document's bytes.

**Global Constraints:** Preserve pending `.review`; no secret/signed URLs; team-audience assertion required before rendering; reject private/excluded or inaccessible reference pages; no live send or publish. Old snapshots/configuration without mappings retain identical behavior. More than two links wrap in pairs, never silently disappear.

## Configuration contract

`sources.notion.reportReferences` is an optional array. Each entry has `sourceId` (`notion:<page UUID>`), `referencePageId`, a short plain-text `label`, `audience: "team"`, and optional `url` and `version`. An explicit URL is for a reviewed legacy artifact or immutable repository permalink. Otherwise the reference page's `url` property is required. Sharing is not automatically checked or changed: the audience field is the operator's assertion, not API evidence of viewer access. Body links are not scraped. Unknown fields, invalid identifiers, unsafe/credential-bearing URLs and duplicate bindings fail closed. An absent weekly source does not cause fetching or turn an old document into a new activity.

## Tasks

- [x] Add `lib/__tests__/report-references.test.js`: exact-ID association, historical page reuse/cache, no extra activity, missing URL, unsafe URL, excluded/private page, no network for absent source. Confirm failing assertions before implementation.
- [x] Add `lib/report-references.js` normalization/resolution/rendering and a read-only `fetchNotionPage` helper in `lib/collect-notion-api.js`. Resolve in `lib/report-snapshot.js` before sealing, outside recoverable collector error handling.
- [x] Add integration tests through `collectSnapshot`, `runGenerateV2` and `assertV2PublishEvidence` for both depths. The artifact UUID URL and caveat survive; fallback uses one selection invocation. A pair uses two successful fixture selections, retains both originals and rejects altered mobile-link metadata.
- [x] Extend `lib/merger.js`, `lib/summary-provenance.js` and `lib/source-selection.js` to preserve deterministic reference continuations and verify source hash, parent and exact URL. Check URL corruption, wrong-parent rebinding, duplicate titles and no-summary references. Keep references out of mandatory detail priority, measured-outcome scoring and model input. Non-selection generation fails before output.
- [x] Keep mobile Slack report prose plain text; add structured rich-text links from validated reference metadata, without arbitrary report Markdown or mentions. Test URL/label ownership, 35 links, Unicode long prose and original preservation. Use non-interactive links: Slack URL buttons require an interaction acknowledgement endpoint, outside this scope.
- [x] Run targeted tests, full suites on Node 24 and 22, diff checks, and a saved-September-9-data preview. Plan adjustment: two read-only Notion page requests verified historical page identity/last edit; report replay used zero AI calls and zero remote writes. Save separate outputs; never rewrite originals. Document usage/limitations and confirm pending review hashes unchanged.
- [x] Append final implementation evidence to the existing Notion project: `3d78a230-a04e-81e6-aa68-f9996f8a0e6e`, heading `2026-09-12 상세자료 URL 연결 — 1차 구현 및 9월 9일 비교 검증` (8 blocks appended).

## Verified result (2026-09-12)

- Node v24.12.0: 859/859 pass; Node v22.23.1: 859/859 pass. Baseline 831; 28 added tests.
- Full command: `rtk proxy bash -lc 'set -o pipefail; node --test lib/__tests__/*.test.js 2>&1 | tail -n 12'` (Node 24 uses its absolute binary path).
- Saved 2026-09-09 actual Codex selection reused: depth2 20 items, depth3 27 items. Three URLs on two relevant items; removing the two added reference lines reproduces each original report byte-for-byte. Notion source count stays 182.
- Offline validation has the identical pre-existing advisory `missing_source_id` warnings (depth2 159, depth3 157), zero new warnings/errors. This is a local replay, not new live-status verification or a publish-ready operating pair.
- Output: `/home/jhw/ai/opencode/projects/redmine/out/report-reference-preview-20260912-pbrb1U/`.
- Operating main/config/cron and both pending review verdicts unchanged. No commit, PR, merge, live report publication, Slack send or artifact sharing changes.
