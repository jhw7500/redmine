const {test} = require('node:test');
const assert = require('node:assert/strict');
const raw = require('../../repo-config.json');
const {buildAiPrompt} = require('../publisher');
const {evaluateSummaryQuality} = require('../summary-quality-gate');

const header = '#### <span style="color:blue">조현우</span>';
const config = () => ({
  categories:{app:{parent:'PIM',label:'Application'}, etc:{parent:'ETC',label:null}},
  env:{sectionHeader:header,reportDepth:3,reportAudience:'team'},
  depthProfiles:raw.depthProfiles,
  reportFilter:{...raw.reportFilter,leaderHighlight:{enabled:true,maxLines:10}},
});
const report = `${header}\n- PIM\n  - 녹화 안정성\n    - <u>마지막 영상 누락 문제 수정</u>\n      - 문제 장비의 영상 저장 결과 확인\n- ETC\n  - 웹 GPT·MCP 터널링\n    - 승인 후 원격 명령 실행 접수 개선\n  - 빌드 서버 운영\n    - <u>전력 설정 유지와 발열 감소 확인</u>\n`;

test('team summary accepts content-dependent indentation and important ETC outcomes', () => {
  assert.deepEqual(evaluateSummaryQuality(report,config()).blocking,[]);
});

test('team summary rejects implementation identifiers in rendered content', () => {
  for (const detail of ['`camera_start()` 오류 수정','camera_start() 오류 수정','camera.c 수정','git status 실행','src/camera.c 수정','커밋 a12b34c 반영','srcversion 값 확인','srcversion: 한글 값 확인',
    'ChangeIpAddress 동작 수정','ChangeIp 복원 확인','Reset 결과 오분류 수정','journal 보존 확인','cts-wlan 설치 완료','KeepAlive 시각 정합',
    'JOURNAL 보존 확인','reset 동작 수정','CTS-WLAN 설치 확인','changeIp 복원 확인','ResetNotice 통지 수정','depth3 요약본 게시','freeform 요약본 생성']) {
    const result=evaluateSummaryQuality(report.replace('문제 장비의 영상 저장 결과 확인',detail),config());
    assert.ok(result.blocking.some(i=>i.code==='implementation_identifier'),detail);
  }
});

test('team summary accepts canonical algorithm and explicitly described CTS-WLAN business names', () => {
  for (const outcome of [
    '공통 Ed25519 키 사내 보관과 SoC UID 결합 방식 정리',
    '무선랜모듈 제품명 CTS-WLAN과 발주 코드 CTS-WLAN-aabc-dd-eeee-ffff 체계 정리',
    'wlan-opc 통신 사양서 R2에 DFK 회신과 요구·응답 통합표, 필드별 예제, 제품명 CTS-WLAN 반영',
  ]) {
    const summary=report.replace('문제 장비의 영상 저장 결과 확인',outcome);
    assert.deepEqual(evaluateSummaryQuality(summary,config()).blocking,[],outcome);
  }
});

test('team summary business-name exceptions stay token-scoped', () => {
  for (const outcome of [
    '제품명 CTS-WLAN 반영과 커밋 a12b34c 확인',
    'Ed25519 키 적용과 커밋 a12b34c 확인',
    'Ed25519() 오류 확인',
    'Ed25519.js 수정',
    '제품명 CTS-WLAN() 오류 확인',
    '제품명 CTS-WLAN.js 수정',
    '제품명 CTS-WLAN-extra 반영',
    '비제품명 CTS-WLAN 반영',
    '내부제품명 CTS-WLAN 반영',
    'foo-제품명 CTS-WLAN 반영',
    'foo_제품명 CTS-WLAN 반영',
    '제품명 CTS-WLAN내부도구 반영',
    '제품명 CTS-WLAN\u200b내부도구 반영',
    '제품명 CTS-WLAN\u0301 반영',
    '제품명\uFEFFCTS-WLAN 반영',
    '미발주 코드 CTS-WLAN 반영',
    'foo-발주 코드 CTS-WLAN-aabc-dd-eeee-ffff 반영',
    '발주\uFEFF코드 CTS-WLAN-aabc-dd-eeee-ffff 반영',
    '발주 코드 CTS-WLAN-extra 반영',
    '제품명 cts-wlan 반영',
    '내부 cts-wlan 설치 완료',
    'Ed25519abcdef 키 확인',
    'Ed25519-helper 키 확인',
    'Ed25519_key 키 확인',
    'ed25519 키 확인',
  ]) {
    const result=evaluateSummaryQuality(report.replace('문제 장비의 영상 저장 결과 확인',outcome),config());
    assert.ok(result.blocking.some(i=>i.code==='implementation_identifier'),outcome);
  }
});

test('team summary keeps release versions and meaningful numeric measurements', () => {
  for (const outcome of [
    '제품 릴리즈 0.6.3+jhw.camera16 설치 및 녹화 확인',
    '정식 릴리즈 0.7.1 시험 장비 설치 완료',
    '추가 배포본 0.7.2 제작 및 패키지 검증 완료',
    '복구 요청 접수부터 동작 시작까지 10→5.2초로 단축',
    '재시작 정지 구간 약 17초/35초에서 9.6~9.8초로 단축',
    '같은 부하대의 20분 관찰에서 최고 온도 93°C→78°C로 감소 확인',
    '전력 제한 150W 적용 및 유지 확인',
    '실측 저장량 1000000바이트 확인',
    '전송 용량 128MB 확인',
  ]) {
    const measured=report.replace('문제 장비의 영상 저장 결과 확인',outcome);
    assert.deepEqual(evaluateSummaryQuality(measured,config()).blocking,[],outcome);
  }
});

test('team summary rejects sentence-style endings and sentences joined on one line', () => {
  const cases=[['문제 장비의 저장 결과를 확인했습니다.','report_sentence_ending'],
    ['문제 장비의 저장 결과를 확인했다.','report_sentence_ending'],
    ['문제 확인.조치 완료','multiple_sentences_per_line'],
    ['문제 장비의 저장 결과 확인. 전달본 구성 수정','multiple_sentences_per_line']];
  for (const [detail,code] of cases) {
    const result=evaluateSummaryQuality(report.replace('문제 장비의 영상 저장 결과 확인',detail),config());
    assert.ok(result.blocking.some(i=>i.code===code),detail);
  }
});

test('team summary respects configured highlight maximum and disabled highlighting', () => {
  const exact=config();
  exact.reportFilter.leaderHighlight.maxLines=2;
  assert.deepEqual(evaluateSummaryQuality(report,exact).blocking,[]);

  const limited=config();
  limited.reportFilter.leaderHighlight.maxLines=1;
  assert.ok(evaluateSummaryQuality(report,limited).blocking.some(i=>i.code==='highlight_limit_exceeded'));
  limited.reportFilter.leaderHighlight.enabled=false;
  assert.ok(evaluateSummaryQuality(report,limited).blocking.some(i=>i.code==='highlight_disabled'));

  const hidden=config();
  hidden.reportFilter.leaderHighlight.enabled=false;
  const withoutVisibleHighlights=report.replace(/<u>([^<]+)<\/u>/g,'$1')
    .replace('영상 저장 결과 확인','영상 저장 결과 확인 <!-- <u>숨은 강조</u> -->');
  assert.deepEqual(evaluateSummaryQuality(withoutVisibleHighlights,hidden).blocking,[]);
});

test('legacy summaries keep their existing quality contract', () => {
  const legacy=config();
  delete legacy.env.reportAudience;
  const content=report.replace('문제 장비의 영상 저장 결과 확인','`camera_start()` 결과를 확인했습니다.');
  assert.deepEqual(evaluateSummaryQuality(content,legacy).blocking,[]);
});

test('a large team report source fits the existing AI input limit without truncation', () => {
  const source='장비의 녹화와 고객 통신 검증 기록\n'.repeat(4750);
  assert.ok(source.length>85000);
  const c=config();
  const prompt=buildAiPrompt(source,c,new Date('2026-10-21T00:00:00+09:00'));
  assert.ok(prompt.length<=100000,`prompt ${prompt.length} exceeds 100000`);
  assert.ok(prompt.includes(source));
});
