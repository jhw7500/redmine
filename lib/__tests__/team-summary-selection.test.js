const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { hashObject } = require('../report-artifact');
const { buildFactCatalog } = require('../fact-catalog');
const { buildSourceCoverageCatalog } = require('../source-coverage');
const { bindSummaryProvenance } = require('../summary-provenance');
const {
  TEAM_SUMMARY_PROFILE, buildTeamSummaryRecords, buildTeamSummaryPrompt,
  parseTeamSummarySelection, buildTeamSummaryFallbackSelection, renderTeamSummarySelection,
} = require('../team-summary-selection');

const CATEGORIES = {
  pim: { parent: 'PIM', label: null, templateKey: 'PIM' },
  wlan: { parent: 'Wireless Lan', label: null, templateKey: 'WLAN' },
  etc: { parent: 'ETC', label: null, templateKey: 'ETC' },
};
const CONFIG = {
  categories: CATEGORIES,
  env: { reportAudience: 'team', sectionHeader: '#### 조현우' },
  reportFilter: {
    teamReport: { guidance: '고객 영향과 제품 검증 결과를 우선한다.' },
    leaderHighlight: {
      enabled: true,
      maxLines: 2,
      guidance: '출시와 중대한 일정 위험만 강조한다.',
    },
  },
};

function fixtureRaw(extraPim = []) {
  return [
    '#### 조현우', '- PIM',
    '  - [Notion] 기존 보드 배포의 복원 잠금은 독립 검증 후에만 해제한다',
    '    ↳ 출처 요약: 일반 점유 만료 뒤에도 복원 책임을 유지해 검증 전 다음 실행을 막는다.',
    '  - [Notion] pim-check 기존 보드 고정 패키지 배포·복원 실행기 준비 완료',
    '    ↳ 출처 요약: 기존 보드 고정 패키지 배포·백업·실패 복원 실행기와 빌드서버 인계 준비 완료. 실제 중앙 활성화 및 보드 배포·E2E는 승인 대기.',
    '  - [Notion] 배포 검증 순서 정리',
    '    ↳ 출처 요약: 복원과 다음 실행의 경계를 검증 순서로 정리했다.',
    '  - [Notion] blank 뒤 승인 조건 보존',
    '    ↳ 출처 요약: 실행기 준비 완료.',
    '',
    '    ↳ 출처 요약: 실제 배포는 승인 대기.',
    '  - 조건: 실기 미실행',
    '    - [Notion] 시험 결과',
    '      ↳ 출처 요약: 테스트 PASS.',
    ...extraPim,
    '- Wireless Lan',
    '  - [Notion] ax AP 연결 실패는 AP 문제로 판정 — 현장 대책 AP 20 MHz, NXP 문의 보류',
    '    ↳ 출처 요약: AP 옆에서 대역폭만 바꾼 A-B-A 결과는 15/15→0/15→15/15였다.',
    '  - [Notion] ax AP 40/80 MHz + 배치 의존 연결 실패',
    '    ↳ 출처 요약: AP가 40/80 MHz면 특정 배치 단말이 연결 못 함, AP 20 MHz면 정상.',
    '  - [Notion] 현장 연결 판별 순서 정리',
    '    ↳ 출처 요약: 연결 단계와 배치 조건을 함께 확인하도록 판별 순서를 정리했다.',
    '  - [Notion] HD60 실측',
    '    ↳ 검증: 59.6fps, 4채널 조건 한정',
    '  - 저온 챔버 -20°C에서 시험',
    '    - [Notion] 저온 HD60 실측',
    '      ↳ 검증: 58.8fps, 4채널 조건 한정',
    '  - 임시 안테나 장착 상태',
    '    - [Notion] 장착 상태 실측',
    '      ↳ 검증: 57.2fps, 4채널 조건 한정',
    '  - LAN 변경 주의 문서화',
    '    ↳ 목적: 새 주소의 응답 시점을 현장에서 예측하기 위함.',
    '    ↳ 변경: 새 주소가 응답하기까지 수 초 걸릴 수 있다는 문장(보드 실측 2~9초)을 추가했다.',
    '  - 검증 FAIL 조건',
    '    - 새 주소 응답 시간(보드 실측 3~7초)',
    '  - 위험 측정 기록',
    '    ↳ 변경: 문서 기록; 검증 FAIL; 새 주소 응답 시간(보드 실측 5~8초).',
    '  - [Notion] 무선 시험 결과 공유',
    '    ↳ 출처 요약: 실패 조건과 정상 조건을 같은 표에서 대조했다.',
    '  - [Notion] 88W9098 Ed25519 제품명 CTS-WLAN 검증',
    '    ↳ 출처 요약: 40/80 MHz 조건과 15/15 비율을 제품 검증표에 보존했다.',
    '  - [Notion] 출하 저장 점검 #241',
    '    ↳ 출처 요약: 고객 전달 전 저장 상태를 확인했다.',
    '  - [Notion] 출하 저장 내부 경로 점검',
    '    ↳ 출처 요약: uuu emmc_all과 soc0/serial_number 경로를 확인했다.',
    '  - [Notion] 내부 작업 위치 점검',
    '    ↳ 출처 요약: /workspace/team/private 경로의 상태를 확인했다.',
    '  - [Notion] CONTEC 문의 초안 — 내부 검토용',
    '    ↳ 출처 요약: 경로·언어 미정, 발송 전 내부 메모·랩 정보 제거. Claude 문서(비공개)',
    '  - [Notion] 조사 공유 문서',
    '    ↳ 출처 요약: 남은 일. claude.ai 문서(비공개, 팀 공유 필요)',
    '  - [Notion] 비공개 키 보관 원칙',
    '    ↳ 출처 요약: 서명용 비공개 키는 승인된 담당자만 보관한다.',
    '- ETC',
    '  - [Notion] 운영 절차와 책임 경계 정리',
    '    ↳ 출처 요약: 승인 주체와 실행 주체를 구분해 운영 절차로 정리했다.',
    '  - [Notion] 자동화 변경 증거 안내',
    '    ↳ 출처 요약: 변경 이유와 실제 검증을 함께 남기도록 안내했다.',
    '  - [Notion] 고객 안내 초안',
    '    ↳ 출처 요약: 고객 전달 문안을 초안으로 작성해 검토 중이다.',
    '  - [Notion] 고객 안내 검토 중',
    '    ↳ 출처 요약: 고객 전달 문안은 현재 초안이다.',
    '  - [Notion] 과거 고객 안내 수정 완료',
    '    ↳ 출처 요약: 검토 중 발견한 오류를 수정 완료했다.',
    '  - [Notion] 주간 보고 복구 절차 정리',
    '    ↳ 출처 요약: 실패 산출물을 보존하고 새 실행으로 복구하도록 정리했다.',
    '  - CI/CD 자동화',
    '    - 릴리즈 버전 v1.89',
    '  - Redmine 보고 자동화',
    '    - 릴리즈 버전 v2.4',
    '  - 개인 자동화 스크립트',
    '    - 공통 자동화 워크플로를 v1.90로 맞춘다',
    '    ↳ 변경: `workflow.yml`의 태그를 v1.90로 갱신한다.',
    '  - 장치 관리',
    '    - 설치 실패',
    '      - 장치 패키지 릴리즈 v3.1', '',
  ].join('\n');
}

function compile(rawContent = fixtureRaw(), mutateCatalog) {
  const snapshot = { contentHash: hashObject(rawContent), rawContent, autoContent: {
    '{{PIM}}': '- populated', '{{WLAN}}': '- populated', '{{ETC}}': '- populated',
  } };
  const coverage = buildSourceCoverageCatalog(snapshot, CATEGORIES, { projectOnly: true });
  let facts = buildFactCatalog(rawContent, [], { knownPaths: coverage.knownPaths, teamReport: false });
  if (mutateCatalog) {
    facts = mutateCatalog(facts, rawContent);
    facts = { ...facts, catalogHash: hashObject({ schemaVersion: facts.schemaVersion, facts: facts.facts }) };
  }
  return { records: buildTeamSummaryRecords(snapshot, facts, coverage, CONFIG), facts, coverage };
}

const selectedIds = selection => selection.sections.flatMap(section =>
  section.groups.flatMap(group => group.items.map(item => item.id)));
const projectionText = record => record.projection.map(line => line.text).join('\n');

let compiled;
before(() => { compiled = compile().records; });

test('portable sealed fixture compiles immutable readable claims for all roots', () => {
  assert.equal(TEAM_SUMMARY_PROFILE, 'team_summary_v1');
  assert.equal(compiled.schemaVersion, 2);
  assert.equal(compiled.profile, TEAM_SUMMARY_PROFILE);
  assert.deepEqual(compiled.sections.map(section => section.path), [['PIM'], ['Wireless Lan'], ['ETC']]);
  assert.ok(compiled.records.some(record => record.meaningfulMeasurement));
  assert.ok(compiled.records.some(record => record.release));
  for (const section of compiled.sections) {
    assert.ok(compiled.records.some(record => record.sectionId === section.id), section.path.join('/'));
  }
});

test('legacy Notion rows bind every owned child qualifier without sourceDetails', () => {
  const approval = compiled.records.find(record => projectionText(record).includes('pim-check'));
  assert.ok(approval);
  const raw = approval.sourceSpans.map(span => span.raw).join('\n');
  assert.match(raw, /배포·백업·실패 복원 실행기와 빌드서버 인계 준비 완료/);
  assert.match(raw, /실제 중앙 활성화 및 보드 배포·E2E는 승인 대기/);
  assert.equal(approval.projection.length, 3);
});

test('blank lines cannot detach a later approval qualifier from its Notion owner', () => {
  const record = compiled.records.find(candidate => candidate.sourceSpans
    .some(span => span.raw.includes('blank 뒤 승인 조건 보존')));
  assert.ok(record);
  const raw = record.sourceSpans.map(span => span.raw).join('\n');
  assert.match(raw, /실행기 준비 완료/);
  assert.match(raw, /실제 배포는 승인 대기/);
});

test('condition and verdict-bearing Notion ancestors cause conservative bundle exclusion', () => {
  assert.ok(!compiled.records.some(record => record.sourceSpans
    .some(span => span.raw === '시험 결과' || span.raw.includes('테스트 PASS'))));
});

test('every nonstructural Notion ancestor excludes the bundle instead of dropping its context', () => {
  const text = compiled.records.map(record => record.sourceSpans.map(span => span.raw).join('\n')).join('\n');
  assert.doesNotMatch(text, /저온 HD60 실측|58\.8fps|저온 챔버 -20°C/);
  assert.doesNotMatch(text, /장착 상태 실측|57\.2fps|임시 안테나 장착 상태/);
});

test('unverified hold excludes its whole bundle while independent AP conditions remain exact', () => {
  const text = compiled.records.map(projectionText).join('\n');
  assert.doesNotMatch(text, /NXP 문의 보류|15\/15→0\/15→15\/15/);
  const independent = compiled.records.find(record => record.sourceSpans.some(span => span.raw.includes('AP가 40/80 MHz면')));
  assert.ok(independent);
  const raw = independent.sourceSpans.map(span => span.raw).join('\n');
  assert.match(raw, /AP가 40\/80 MHz면 특정 배치 단말이 연결 못 함/);
  assert.match(raw, /AP 20 MHz면 정상/);
});

test('readability keeps product models, algorithms, and physical ratios but excludes internal identifiers', () => {
  const records = compiled.records.map(record => ({
    raw: record.sourceSpans.map(span => span.raw).join('\n'),
    text: projectionText(record),
  }));
  const positive = records.find(record => record.raw.includes('88W9098 Ed25519 제품명 CTS-WLAN'));
  assert.ok(positive);
  assert.match(positive.raw, /40\/80 MHz 조건과 15\/15 비율/);
  const all = records.map(record => `${record.raw}\n${record.text}`).join('\n');
  assert.doesNotMatch(all, /#241|emmc_all|serial_number|\/workspace\/team\/private/);
});

test('draft-only and unverified sharing notes are excluded without banning legitimate private-key facts', () => {
  const raw = compiled.records.flatMap(record => record.sourceSpans.map(span => span.raw)).join('\n');
  assert.doesNotMatch(raw, /내부 검토용|경로·언어 미정|남은 일|팀 공유 필요|Claude 문서|claude\.ai 문서/);
  assert.match(raw, /비공개 키 보관 원칙/);
  assert.match(raw, /서명용 비공개 키는 승인된 담당자만 보관/);
  assert.doesNotMatch(raw, /고객 안내 초안|고객 전달 문안을 초안으로 작성해 검토 중|고객 안내 검토 중|고객 전달 문안은 현재 초안/);
  assert.match(raw, /과거 고객 안내 수정 완료/);
  assert.match(raw, /검토 중 발견한 오류를 수정 완료/);
  const fallback = renderTeamSummarySelection(compiled, buildTeamSummaryFallbackSelection(compiled), { fallback: true });
  assert.doesNotMatch(fallback, /고객 안내 초안|고객 안내 검토 중|현재 초안/);
});

test('standalone measurement keeps its exact target, range, and unit', () => {
  const record = compiled.records.find(candidate => candidate.meaningfulMeasurement
    && candidate.sourceSpans.some(span => span.raw.includes('보드 실측 2~9초')));
  assert.ok(record);
  assert.match(record.sourceSpans[0].raw, /새 주소가 응답하기까지 수 초 걸릴 수 있다는 문장\(보드 실측 2~9초\)/);
});

test('measurement under a FAIL parent is not eligible as a standalone claim', () => {
  assert.ok(!compiled.records.some(record => record.meaningfulMeasurement
    && record.sourceSpans.some(span => span.raw.includes('보드 실측 3~7초'))));
  const unsafe = compiled.records.filter(record => record.meaningfulMeasurement
    && record.sourceSpans.some(span => span.raw.includes('보드 실측 5~8초')));
  assert.deepEqual(unsafe, []);
});

test('full Notion measurement bundle satisfies the quota with all conditions attached', () => {
  const record = compiled.records.find(candidate => candidate.sourceSpans.some(span => span.raw.includes('HD60 실측')));
  assert.ok(record?.meaningfulMeasurement);
  const raw = record.sourceSpans.map(span => span.raw).join('\n');
  assert.match(raw, /59\.6fps, 4채널 조건 한정/);
});

test('neutral release records retain distinct source-bound component context', () => {
  const releases = compiled.records.filter(record => record.release);
  const ci = releases.find(record => record.sourceSpans.some(span => span.raw === 'v1.89'));
  const report = releases.find(record => record.sourceSpans.some(span => span.raw === 'v2.4'));
  assert.match(projectionText(ci), /CI\/CD 자동화 릴리즈 정보/);
  assert.match(projectionText(report), /Redmine 보고 자동화 릴리즈 정보/);
  assert.ok(ci.sourceSpans.some(span => span.raw === 'CI/CD 자동화'));
  assert.ok(report.sourceSpans.some(span => span.raw === 'Redmine 보고 자동화'));
  assert.ok(!ci.conflictingIds.includes(report.id));
});

test('self-contained version clause keeps the workflow target instead of relabeling the receiving repo', () => {
  const records = compiled.records.filter(candidate => candidate.release
    && candidate.sourceSpans.some(span => span.raw.includes('v1.90')));
  assert.ok(records.length > 0);
  assert.ok(records.some(record => /공통 자동화 워크플로를 .*로 맞춘다/.test(projectionText(record))));
  assert.ok(records.every(record => !/개인 자동화 스크립트 릴리즈 정보/.test(projectionText(record))));
});

test('release below a failed installation ancestor remains neutral and uses clean component scope', () => {
  const record = compiled.records.find(candidate => candidate.release
    && candidate.sourceSpans.some(span => span.raw === 'v3.1'));
  assert.ok(record);
  assert.match(projectionText(record), /장치 관리 릴리즈 정보/);
  assert.doesNotMatch(projectionText(record), /설치|실패|완료|배포/);
  assert.ok(record.sourceSpans.some(span => span.raw === '장치 관리'));
});

test('sentence splitting rejects a candidate rather than cutting through a protected fact span', () => {
  const raw = fixtureRaw(['  - [Notion] 보호 구절 경계 검증', '    ↳ 출처 요약: 보호구절 앞. 뒤를 유지한다.']);
  const { records } = compile(raw, (catalog, source) => {
    const start = source.indexOf('앞. 뒤');
    return { ...catalog, facts: [...catalog.facts, {
      id: 'V9999', type: 'protected_token', raw: '앞. 뒤', semantic: null, subject: null,
      sourceLocation: { start, end: start + '앞. 뒤'.length, line: 10, column: 13 },
      sourceExcerpt: '↳ 출처 요약: 보호구절 앞. 뒤를 유지한다.', allowedNormalizations: [],
      sourceSectionPath: ['PIM'],
    }] };
  });
  assert.ok(!records.records.some(candidate => candidate.sourceSpans
    .some(span => span.raw.includes('보호구절 앞') || span.raw.includes('뒤를 유지'))));
  assert.ok(!records.records.some(candidate => projectionText(candidate).includes('V9999')));
});

test('prompt exposes protected projections while provider output remains strict IDs only', () => {
  const prompt = buildTeamSummaryPrompt(compiled, CONFIG);
  assert.match(prompt, /릴리즈 버전 \[\[fact:V\d{4}\]\]/);
  assert.doesNotMatch(prompt, /"sourceSpans"/);
  assert.match(prompt, /고객 영향과 제품 검증 결과를 우선한다/);
  assert.match(prompt, /출시와 중대한 일정 위험만 강조한다/);
  assert.match(prompt, /개인 AI 도구·비공개 운영 메모/);
  assert.match(prompt, /"conflictingIds":\[/);
  assert.match(prompt, /conflictingIds[^\n]*동시에 선택/);
  assert.match(prompt, /모든 project root ID/);
  assert.match(prompt, /theme.*중복/);
  const fallback = buildTeamSummaryFallbackSelection(compiled, CONFIG.reportFilter.leaderHighlight);
  assert.deepEqual(parseTeamSummarySelection(JSON.stringify(fallback), compiled,
    CONFIG.reportFilter.leaderHighlight), fallback);
  const withProse = structuredClone(fallback);
  withProse.explanation = 'provider prose';
  assert.throws(() => parseTeamSummarySelection(JSON.stringify(withProse), compiled),
    { code: 'TEAM_SUMMARY_SELECTION_INVALID' });
});

test('prompt removes ordinary Markdown destinations and bare URLs from every preview', () => {
  const records = structuredClone(compiled);
  records.records[0].projection.push(
    { depth: 1, text: '[내부 보고](https://example.com/private/report)에서 검증 결과를 확인했다.' },
    { depth: 1, text: '후속 기록은 https://private.example.test/run/42 에서 확인했다.' },
  );
  records.records[0].sourceSpans.push(
    { start: 0, end: 1, raw: 'https://raw.example.test/must-not-leak' },
  );
  const prompt = buildTeamSummaryPrompt(records, CONFIG);
  assert.match(prompt, /내부 보고에서 검증 결과를 확인/);
  assert.match(prompt, /후속 기록은 \[URL omitted\] 에서 확인/);
  assert.doesNotMatch(prompt, /https?:\/\//);
  assert.doesNotMatch(prompt, /"sourceSpans"/);
});

test('authenticated curated references render inline but their URLs never enter the AI prompt', () => {
  const reference = {
    label: '상세 분석', url: 'https://example.com/private/report', audience: 'on_request',
    pageLastEditedTime: '2026-11-10T00:00:00Z',
  };
  const notion = { title: '참조 자료 검증', summary: '공개 검증 결과를 정리했다.',
    items: ['참조 자료 검증'], reportReferences: [reference] };
  const pimBlock = [
    '  - [Notion] 참조 자료 검증',
    '    ↳ 출처 요약: 공개 검증 결과를 정리했다.',
    '    ↳ 자료: [상세 분석 · 요청 시 공유](https://example.com/private/report)',
  ].join('\n');
  const rawContent = [
    '#### 조현우', '- PIM', pimBlock,
    '- Wireless Lan', '  - WLAN 제품', '    - 무선 결과 정리', '      ↳ 목적: 연결 결과를 공유하기 위함.',
    '      ↳ 변경: 연결 조건과 정상 결과를 함께 정리했다.',
    '- ETC', '  - 보고 운영', '    - 운영 절차 정리', '      ↳ 목적: 운영 책임을 구분하기 위함.',
    '      ↳ 변경: 승인 절차와 실행 절차를 함께 정리했다.', '',
  ].join('\n');
  const autoContent = { '{{PIM}}': pimBlock,
    '{{WLAN}}': '- populated', '{{ETC}}': '- populated' };
  const sourceDetails = bindSummaryProvenance(autoContent, rawContent, [
    { templateKey: '{{PIM}}', kind: 'notion_summary', sourceIndex: 0, itemLineIndex: 0,
      parentLine: 1, startLine: 2, endLine: 2, parentText: '  - [Notion] 참조 자료 검증', sourceHash: hashObject(notion) },
    { templateKey: '{{PIM}}', kind: 'report_reference', sourceIndex: 0, itemLineIndex: 0,
      parentLine: 1, startLine: 3, endLine: 3, parentText: '  - [Notion] 참조 자료 검증', sourceHash: hashObject(notion) },
  ]);
  const snapshot = { contentHash: hashObject(rawContent), rawContent, autoContent, sourceDetails,
    sources: { notion: { data: [notion] }, git: { data: {} } } };
  const coverage = buildSourceCoverageCatalog(snapshot, CATEGORIES, { projectOnly: true });
  const facts = buildFactCatalog(rawContent, [], { knownPaths: coverage.knownPaths, teamReport: false });
  const records = buildTeamSummaryRecords(snapshot, facts, coverage, CONFIG);
  const record = records.records.find(candidate => candidate.sourceIds.includes('N0001'));
  const rendered = renderTeamSummarySelection(records, {
    sections: records.sections.map(section => ({ id: section.id, groups: [{ theme: 'verification',
      items: [{ id: records.records.find(candidate => candidate.sectionId === section.id).id, highlight: false }] }] })),
  });
  assert.match(rendered, /\[상세 분석 · 요청 시 공유\]\(https:\/\/example\.com\/private\/report\)/);
  const prompt = buildTeamSummaryPrompt(records, CONFIG);
  assert.doesNotMatch(prompt, /https:\/\/example\.com\/private\/report/);
  assert.match(prompt, /상세 분석 · 요청 시 공유/);
  assert.ok(record.referenceSpans.every(span => span.kind === 'report_reference'));
});

test('selection rejects unknown, duplicate, moved, and conflicting claims', () => {
  const fallback = buildTeamSummaryFallbackSelection(compiled);
  const cases = [
    value => { value.sections[0].groups[0].items[0].text = 'rewritten'; },
    value => { value.sections[0].groups[0].items[0].id = 'R9999'; },
    value => { value.sections[0].groups[0].items.push({ ...value.sections[0].groups[0].items[0] }); },
    value => { value.sections[0].groups[0].items[0].id = value.sections[1].groups[0].items[0].id; },
  ];
  for (const mutate of cases) {
    const value = structuredClone(fallback); mutate(value);
    assert.throws(() => parseTeamSummarySelection(JSON.stringify(value), compiled),
      { code: 'TEAM_SUMMARY_SELECTION_INVALID' });
  }
  const conflicting = structuredClone(compiled);
  const selected = new Set(selectedIds(fallback));
  const record = conflicting.records.find(candidate => selected.has(candidate.id)
    && conflicting.records.some(other => other.sectionId === candidate.sectionId && !selected.has(other.id)));
  const other = conflicting.records.find(candidate => candidate.sectionId === record.sectionId && !selected.has(candidate.id));
  record.conflictingIds.push(other.id); other.conflictingIds.push(record.id);
  const invalid = structuredClone(fallback);
  invalid.sections.find(section => section.id === record.sectionId).groups[0].items.push({ id: other.id, highlight: false });
  assert.throws(() => parseTeamSummarySelection(JSON.stringify(invalid), conflicting),
    { code: 'TEAM_SUMMARY_SELECTION_INVALID' });
});

test('fallback selects two to three useful bundles per root plus measurement and release', () => {
  const first = buildTeamSummaryFallbackSelection(compiled, CONFIG.reportFilter.leaderHighlight);
  assert.deepEqual(first, buildTeamSummaryFallbackSelection(compiled, CONFIG.reportFilter.leaderHighlight));
  const ids = selectedIds(first);
  assert.ok(ids.length <= 12);
  for (const section of first.sections) {
    const count = section.groups.flatMap(group => group.items).length;
    assert.ok(count >= 2 && count <= 3, `${section.id}: ${count}`);
  }
  assert.ok(ids.some(id => compiled.records.find(record => record.id === id).meaningfulMeasurement));
  assert.ok(ids.some(id => compiled.records.find(record => record.id === id).release));
  const rendered = renderTeamSummarySelection(compiled, first, {
    leaderHighlight: CONFIG.reportFilter.leaderHighlight, fallback: true,
  });
  assert.match(rendered, /\[\[source:C0001\]\]/);
  assert.match(rendered, /원문 기반 대체 보고서/);
});

test('selection enforces highlight limits', () => {
  const value = buildTeamSummaryFallbackSelection(compiled);
  value.sections.flatMap(section => section.groups).flatMap(group => group.items)
    .slice(0, 3).forEach(item => { item.highlight = true; });
  assert.throws(() => parseTeamSummarySelection(JSON.stringify(value), compiled,
    CONFIG.reportFilter.leaderHighlight), { code: 'TEAM_SUMMARY_SELECTION_INVALID' });
});

test('compiler fails when a populated root has no eligible claim instead of fabricating one', () => {
  const raw = fixtureRaw().replace(/  - \[Notion\] 기존 보드[\s\S]*?(?=- Wireless Lan)/,
    '  - [Notion] `git status` 실행...\n');
  assert.throws(() => compile(raw), { code: 'TEAM_SUMMARY_RECORDS_INVALID' });
});
