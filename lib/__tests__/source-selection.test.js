const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSourceCoverageCatalog } = require("../source-coverage");
const { annotateSourceCoverageReferences } = require("../source-coverage");
const { buildFactCatalog } = require("../fact-catalog");
const { annotateFactReferences, expandFactReferences } = require("../fact-references");
const { validateV2ReportContract } = require("../report-contract");
const { buildSourceRecords, parseSourceSelection, buildFallbackSelection, renderSourceSelection, buildSelectionPrompt } = require("../source-selection");

function fixture() {
  const rawContent = [
    '#### <span style="color:blue">조현우</span>', '',
    '- PIM', '  - Application', '    - 720p 모드에서만', '      - FPS 상한 30에서 60으로 변경',
    '    - [Notion] GLIBC 2.33 바이너리 차단',
    '- Wireless Lan', '  - Driver', '    - 오류 반환 경로 수정', '',
  ].join('\n');
  const snapshot = { rawContent, contentHash: 'snapshot', autoContent: { '{{APP}}': '- updated', '{{DRIVER}}': '- updated' } };
  const coverage = buildSourceCoverageCatalog(snapshot, {
    app: { parent: 'PIM', label: 'Application', templateKey: 'APP' },
    driver: { parent: 'Wireless Lan', label: 'Driver', templateKey: 'DRIVER' },
  });
  return { records: buildSourceRecords(snapshot, rawContent, coverage), rawContent };
}

const selection = () => ({sections:[
  { id:'C0001', groups:[{theme:'stability',items:[{id:'R0001',highlight:true}]}]},
  { id:'C0002', groups:[{theme:'stability',items:[{id:'R0003',highlight:false}]}]},
]});

test('record rendering preserves numeric conditions, source text, and parent scope', () => {
  const { records } = fixture();
  const selected = parseSourceSelection(JSON.stringify(selection()), records);
  const content = renderSourceSelection(records, selected);
  assert.match(content, /720p 모드에서만/);
  assert.match(content, /FPS 상한 30에서 60으로 변경/);
  assert.match(content, /<u>FPS 상한 30에서 60으로 변경<\/u>/);
  assert.match(content, /\n- Wireless Lan\n  - Driver/);
  assert.doesNotMatch(content, /GLIBC/);
});

test('configured commit-type headings do not become redundant semantic context', () => {
  const labels = [...Object.values(require('../../repo-config.json').commitTypes).map(type => type.label), '기타'];
  for (const label of labels) {
    const snapshot = {contentHash:'snapshot',autoContent:{'{{APP}}':'- updated'},rawContent:[
      '#### 조현우','- PIM','  - Application',`    - ${label}`,'      - 오류 반환 경로 개선','',
    ].join('\n')};
    const coverage = buildSourceCoverageCatalog(snapshot,{app:{parent:'PIM',label:'Application',templateKey:'APP'}});
    const records = buildSourceRecords(snapshot,snapshot.rawContent,coverage);
    assert.deepEqual(records.records[0].context,[],label);
    assert.match(renderSourceSelection(records,buildFallbackSelection(records)),/오류 반환 경로 개선/);
  }
});

test('mixed Markdown bullet markers preserve conditions, facts and source coverage', () => {
  const rawContent = [
    '#### 조현우','* PIM','  + Application','    * 720p 모드에서만',
    '      + [Notion] FPS 상한 30에서 60으로 변경','',
  ].join('\n');
  const snapshot = {contentHash:'snapshot',rawContent,autoContent:{'{{APP}}':'- updated'}};
  const coverage = buildSourceCoverageCatalog(snapshot,{app:{parent:'PIM',label:'Application',templateKey:'APP'}});
  const catalog = buildFactCatalog(rawContent,[],{knownPaths:coverage.knownPaths});
  const source = annotateSourceCoverageReferences(annotateFactReferences(rawContent,catalog),coverage);
  const records = buildSourceRecords(snapshot,source,coverage);
  assert.equal(records.records.length,1);
  const rendered = expandFactReferences(renderSourceSelection(records,buildFallbackSelection(records)),catalog);
  const result = validateV2ReportContract(rawContent,rendered,catalog,coverage,{
    sectionHeader:'#### 조현우',knownPaths:coverage.knownPaths,repos:{},
  });
  assert.equal(result.validation.status,'PASS',JSON.stringify(result.validation.issues));
  assert.match(result.cleanContent,/720p 모드에서만/);
  assert.match(result.cleanContent,/FPS 상한 30에서 60으로 변경/);
});

test('a populated category without source records is rejected instead of inventing a status', () => {
  const snapshot = {contentHash:'snapshot',autoContent:{'{{APP}}':'- updated'},rawContent:[
    '#### 조현우','- PIM','  - Application','',
  ].join('\n')};
  const coverage = buildSourceCoverageCatalog(snapshot,{app:{parent:'PIM',label:'Application',templateKey:'APP'}});
  assert.equal(coverage.sections.length,1);
  assert.throws(()=>buildSourceRecords(snapshot,snapshot.rawContent,coverage),{code:'SOURCE_RECORDS_INVALID'});
});

test('selection rejects rewrites, unknown IDs, cross-category moves, duplicate IDs, and omissions', () => {
  const { records } = fixture();
  const cases = [
    value => {value.text='FPS 상한은 120';},
    value => {value.sections[0].groups[0].items[0].text='rewritten';},
    value => {value.sections[0].groups[0].items[0].id='R9999';},
    value => {value.sections[0].groups[0].items[0].id='R0003';},
    value => {value.sections[0].groups[0].items.push({id:'R0001',highlight:false});},
    value => {value.sections.pop();},
    value => {value.sections[0].groups=[];},
    value => {value.sections[0].groups[0].theme='완료';},
    value => {value.sections[0].groups[0].theme=['stability'];},
    value => {value.sections[0].groups[0].theme={toString:null};},
    value => {value.sections[0].groups[0].items[0].highlight='true';},
    value => {value.sections.push(value.sections[0]);},
  ];
  for (const mutate of cases) {
    const value = selection(); mutate(value);
    assert.throws(() => parseSourceSelection(JSON.stringify(value), records), {code:'SOURCE_SELECTION_INVALID'});
  }
  assert.throws(() => parseSourceSelection('```json\n{}\n```', records), {code:'SOURCE_SELECTION_INVALID'});
});

test('parent and category continuation conditions remain in records, prompt, and report', () => {
  const snapshot = {contentHash:'snapshot', autoContent:{'{{APP}}':'- updated'}, rawContent:[
    '#### 조현우', '- PIM', '  - Application', '    승인된 장치에만 적용',
    '    - 펌웨어 변경', '      외부 전원 연결 시에만 적용', '      - 업데이트 완료', '',
  ].join('\n')};
  const coverage = buildSourceCoverageCatalog(snapshot, {app:{parent:'PIM',label:'Application',templateKey:'APP'}});
  const records = buildSourceRecords(snapshot, snapshot.rawContent, coverage);
  const content = renderSourceSelection(records, buildFallbackSelection(records));
  const prompt = buildSelectionPrompt(records, {env:{reportDepth:3}});
  for (const condition of ['외부 전원 연결 시에만 적용', '승인된 장치에만 적용']) {
    assert.ok(JSON.stringify(records).includes(condition));
    assert.ok(content.includes(condition));
    assert.ok(prompt.includes(condition));
  }
});

test('parent paragraphs before, between and after children qualify every selected descendant', () => {
  for (const position of [0,1,2]) {
    const children = ['      - 업데이트 완료', '      - 오류 반환 개선'];
    children.splice(position,0,'','      승인된 장치에만 적용','');
    const snapshot = {contentHash:'snapshot',autoContent:{'{{APP}}':'- updated'},rawContent:[
      '#### 조현우','- PIM','  - Application','    - 펌웨어 변경',...children,'',
    ].join('\n')};
    const coverage = buildSourceCoverageCatalog(snapshot,{app:{parent:'PIM',label:'Application',templateKey:'APP'}});
    const records = buildSourceRecords(snapshot,snapshot.rawContent,coverage);
    for (const record of records.records) {
      assert.ok(JSON.stringify(record.context).includes('승인된 장치에만 적용'),`position=${position}, record=${record.id}`);
      const selected = {sections:[{id:'C0001',groups:[{theme:'verification',items:[{id:record.id,highlight:false}]}]}]};
      assert.match(renderSourceSelection(records,selected),/승인된 장치에만 적용/);
    }
    assert.match(buildSelectionPrompt(records,{env:{reportDepth:3}}),/승인된 장치에만 적용/);
  }
});

test('leaf-only prose is not inherited by a sibling and ambiguous outdents fail closed', () => {
  const snapshot = {contentHash:'snapshot',autoContent:{'{{APP}}':'- updated'},rawContent:[
    '#### 조현우','- PIM','  - Application','    - 펌웨어 변경',
    '      - 업데이트 완료','        이 업데이트만 제한','      - 오류 반환 개선','',
  ].join('\n')};
  const coverage = buildSourceCoverageCatalog(snapshot,{app:{parent:'PIM',label:'Application',templateKey:'APP'}});
  const records = buildSourceRecords(snapshot,snapshot.rawContent,coverage);
  assert.match(JSON.stringify(records.records[0]),/이 업데이트만 제한/);
  assert.doesNotMatch(JSON.stringify(records.records[1]),/이 업데이트만 제한/);
  for (const replacement of ['      이 업데이트만 제한','이 업데이트만 제한']) {
    const ambiguous = {...snapshot,rawContent:snapshot.rawContent.replace('        이 업데이트만 제한',replacement)};
    assert.throws(()=>buildSourceRecords(ambiguous,ambiguous.rawContent,coverage),{code:'SOURCE_RECORDS_INVALID'});
  }
});

test('collector arrow continuations stay bound to their commit despite legacy indentation', () => {
  const snapshot = {contentHash:'snapshot',autoContent:{'{{APP}}':'- updated'},rawContent:[
    '#### 조현우','- PIM','  - Application','    - 수정',
    '      - fix(setup): readiness 변경','  ↳ cam_state는 부팅마다 초기화',
    '  ↳ 초기화 이후에만 점검','      - fix(plan): 중단 처리','',
  ].join('\n')};
  const coverage = buildSourceCoverageCatalog(snapshot,{app:{parent:'PIM',label:'Application',templateKey:'APP'}});
  const records = buildSourceRecords(snapshot,snapshot.rawContent,coverage);
  assert.match(JSON.stringify(records.records[0]),/cam_state는 부팅마다 초기화/);
  assert.match(JSON.stringify(records.records[0]),/초기화 이후에만 점검/);
  assert.doesNotMatch(JSON.stringify(records.records[1]),/cam_state|초기화 이후/);
  const selected = {sections:[{id:'C0001',groups:[{theme:'stability',items:[{id:'R0001',highlight:false}]}]}]};
  assert.match(renderSourceSelection(records,selected),/↳ cam_state는 부팅마다 초기화/);
});

test('fallback is bounded, deterministic, preserves all sections and labels the output', () => {
  const { records } = fixture();
  const selected = buildFallbackSelection(records);
  assert.equal(selected.sections.length, 2);
  assert.deepEqual(selected.sections[0].groups[0].items.map(i=>i.id), ['R0001','R0002']);
  const content = renderSourceSelection(records, selected, {fallback:true});
  assert.match(content, /원문 기반 대체 보고서/);
  assert.match(content, /- 원문 발췌/);
  assert.doesNotMatch(content, /- 구현·연동/);
  assert.match(content, /GLIBC 2.33 바이너리 차단/);
  assert.equal(content, renderSourceSelection(records, buildFallbackSelection(records), {fallback:true}));
});

test('selection prompt exposes full source meaning and restricts output to identifiers', () => {
  const { records } = fixture();
  const prompt = buildSelectionPrompt(records, {env:{reportDepth:3}});
  assert.match(prompt, /720p 모드에서만/);
  assert.match(prompt, /R0001/);
  assert.match(prompt, /JSON/);
  assert.match(prompt, /GLIBC 2.33/);
});

test('all five source lines behind the 2026-09-09 incident validate when selected with highlights', () => {
  const rawContent = [
    '#### 조현우', '- PIM', '  - Application',
    '    - feat(max9296): HD/FHD FPS 상한을 분리해 HD 60을 연다',
    '    - fix(build): GLIBC 2.33 바이너리 차단 및 부재 모듈 건너뛰기',
    '  - Camera Driver',
    '    - [Notion] 720p FPS 협상 상한을 30에서 60으로, 1080p는 30 유지',
    '    - [Notion] HD 1280x720@60 end-to-end 전달률 실측 — 59.3~59.6fps 달성 (4채널 동시)',
    '- Wireless Lan', '  - Application',
    '    - [Notion] ftpcmd 이관 완결 + wpa_supplicant 2.12 리베이스 (3저장소, 2026-09-03)', '',
  ].join('\n');
  const categories = {
    app:{parent:'PIM',label:'Application',templateKey:'APP'},
    camera:{parent:'PIM',label:'Camera Driver',templateKey:'CAMERA'},
    wlan:{parent:'Wireless Lan',label:'Application',templateKey:'WLAN'},
  };
  const snapshot = {contentHash:'snapshot',rawContent,autoContent:{'{{APP}}':'- updated','{{CAMERA}}':'- updated','{{WLAN}}':'- updated'}};
  const coverage = buildSourceCoverageCatalog(snapshot,categories);
  const catalog = buildFactCatalog(rawContent,[],{knownPaths:coverage.knownPaths});
  const source = annotateSourceCoverageReferences(annotateFactReferences(rawContent,catalog),coverage);
  const records = buildSourceRecords(snapshot,source,coverage);
  const selected = buildFallbackSelection(records);
  for (const section of selected.sections) for (const group of section.groups) for (const item of group.items) item.highlight=true;
  const rendered = expandFactReferences(renderSourceSelection(records,selected),catalog);
  const result = validateV2ReportContract(rawContent,rendered,catalog,coverage,{sectionHeader:'#### 조현우',knownPaths:coverage.knownPaths,repos:{}});
  assert.equal(records.records.length,5);
  assert.equal(result.validation.status,'PASS',JSON.stringify(result.validation.issues));
});
