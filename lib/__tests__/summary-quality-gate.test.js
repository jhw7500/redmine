const {test} = require('node:test');
const assert = require('node:assert/strict');
const {evaluateSummaryQuality} = require('../summary-quality-gate');

const header = '#### <span style="color:blue">조현우</span>';
const categories = {
  pimApp:{parent:'PIM',label:'Application',templateKey:'A'},
  pimTest:{parent:'PIM',label:'Test/Analysis',templateKey:'B'},
  wlanApp:{parent:'Wireless Lan',label:'Application',templateKey:'C'},
  etc:{parent:'ETC',label:null,templateKey:'D'},
};
const config = (extra = {}) => ({categories, depthProfiles:{3:{advisoryMaxBullets:38}},
  env:{sectionHeader:header, reportDepth:3}, ...extra});
const codes = result => result.blocking.map(issue => issue.code);

const koreanSummary = [
  header,
  '',
  '- PIM',
  '  - Application',
  '    - <u>edgeconf 배열 검증 강화</u>',
  '      - malformed 배열은 시작 시 거부하고 활성 슬롯으로 제어를 라우팅',
  '    - VPU 핸드오프 deb를 reproducible 빌드로 정비',
  '  - Test/Analysis',
  '    - `pim-check` 하드웨어 게이트 신뢰 경계 보강',
  '- Wireless Lan',
  '  - Application',
  '    - wifi_checker handshake 정체 시 `wifi connect` 재연결 요청',
  '- ETC',
  '  - Redmine 주간 보고 자동화',
  '    - 요약본 게시와 depth2 대체 경로 추가',
  '',
  '*작성: 조현우 2026-10-14 06:05 | 승인: 없음*',
  '---',
].join('\n') + '\n';

test('a Korean themed depth3 summary passes and records volume only as advisory', () => {
  const result = evaluateSummaryQuality(koreanSummary, config());
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.advisory, {totalBullets:13, contentBullets:7, advisoryMaxBullets:38,
    exceedsAdvisoryMax:false, maxBulletsPerSubcategory:{subcategory:'PIM > Application', bullets:3}});
});

test('English-only content blocks, including a continuation whose only Korean is its label', () => {
  const selection = [
    header,
    '- ETC',
    '  - Redmine 주간 보고 자동화',
    '    - 0.7.0 릴리스 정리',
    '      ↳ 목적: Finalize the 0.7.0 release checklist and tag the package',
    '      ↳ 검증: `node --test lib/__tests__/*.test.js`: PASS',
    '    - omit unavailable PR evidence',
    '      ↳ 변경: 근거 값이 없으면 continuation line을 만들지 않는다',
  ].join('\n') + '\n';
  const result = evaluateSummaryQuality(selection, config());
  assert.deepEqual(result.blocking, [
    {code:'non_korean_line', line:5},
    {code:'non_korean_line', line:6},
    {code:'non_korean_line', line:7},
  ]);
});

test('a short Korean label on an ordinary bullet does not make its English content Korean', () => {
  const labelled = [
    header,
    '- ETC',
    '  - Redmine 주간 보고 자동화',
    '    - 변경: Finalize the release checklist',
    '    - 검증： PASS',
    '    - 평택 P3 방문 : 10/22(목) 10시',
  ].join('\n') + '\n';
  assert.deepEqual(evaluateSummaryQuality(labelled, config()).blocking, [
    {code:'non_korean_line', line:4},
    {code:'non_korean_line', line:5},
  ]);
});

test('Hangul that Redmine does not render never makes an English line Korean', () => {
  const hidden = [
    header,
    '- ETC',
    '  - Redmine 주간 보고 자동화',
    '    - Finalize the release checklist <!-- 한국어 -->',
    '    - <span title="한국어">Finalize</span> the checklist',
    '    - [Release notes](https://example.com/한국어)',
    '    - ![한국어 그림](chart.png) Finalize the chart',
    '    - [[한국어_페이지|Release page]]',
    '    - <u>밑줄 친 한국어 내용</u>',
    '    - Finalize the checklist <!-- 여러 줄',
    '      주석 속 한국어 -->',
  ].join('\n') + '\n';
  assert.deepEqual(evaluateSummaryQuality(hidden, config()).blocking, [4, 5, 6, 7, 8, 10]
    .map(line => ({code:'non_korean_line', line})));
});

test('canonical headings come from configured categories, not a fixed English list', () => {
  const unconfigured = `${header}\n- Misc\n  - 설정 정리\n`;
  assert.deepEqual(codes(evaluateSummaryQuality(unconfigured, config())), ['non_korean_line', 'missing_canonical_heading']);
  const unknownHeadings = codes(evaluateSummaryQuality(koreanSummary, config({categories:{}})));
  assert.deepEqual(unknownHeadings.slice(0, 2), ['non_korean_line', 'non_korean_line']);
  assert.equal(unknownHeadings.at(-1), 'missing_canonical_heading');
});

test('a Korean summary without any configured category heading blocks', () => {
  const headless = `${header}\n- 설정 안정화\n  - 잘못된 배열은 시작 시 거부\n`;
  assert.deepEqual(evaluateSummaryQuality(headless, config()).blocking, [{code:'missing_canonical_heading'}]);
});

test('bullets deeper than four levels and a summary without content bullets block', () => {
  const fourLevels = `${header}\n- PIM\n  - Application\n    - 설정 안정화\n      - 잘못된 배열 거부\n`;
  assert.deepEqual(evaluateSummaryQuality(fourLevels, config()).blocking, []);
  const fiveLevels = fourLevels + '        - 활성 슬롯 라우팅\n';
  assert.deepEqual(evaluateSummaryQuality(fiveLevels, config()).blocking, [{code:'bullet_too_deep', line:6}]);
  assert.deepEqual(codes(evaluateSummaryQuality(`${header}\n- PIM\n  - Application\n- ETC\n`, config())),
    ['no_content_bullets']);
});

test('exceeding the depth3 advisory bullet budget never blocks', () => {
  const result = evaluateSummaryQuality(koreanSummary, config({depthProfiles:{3:{advisoryMaxBullets:5}}}));
  assert.deepEqual(result.blocking, []);
  assert.equal(result.advisory.exceedsAdvisoryMax, true);
  assert.equal(result.advisory.advisoryMaxBullets, 5);
});
