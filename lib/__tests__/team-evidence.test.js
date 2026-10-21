const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildFactCatalog}=require('../fact-catalog');
const {annotateFactReferences,expandFactReferences}=require('../fact-references');
const {validateAnnotatedReport}=require('../fact-validator');
const {buildSourceCoverageCatalog}=require('../source-coverage');
const {validateV2ReportContract}=require('../report-contract');
const {hasNonOverridableV2Issue}=require('../../index');

const header='#### <span style="color:blue">조현우</span>';
const knownPaths=[['PIM'],['ETC']];
const options={teamReport:true,knownPaths,termAliases:{'접수→액션 시작':'요청 접수→동작 시작','cam-operate restart':'카메라 재시작'}};
function setup(line,root='PIM'){
  const raw=`${header}\n- ${root}\n  - ${line}\n`;
  const catalog=buildFactCatalog(raw,[],options);
  const claim=catalog.facts.find(f=>f.type==='measurement_claim');
  assert.ok(claim,'a readable measured outcome must have a whole evidence claim');
  return {raw,catalog,claim};
}
function output(claim,root='PIM',body=`[[fact:${claim.id}]]`){return `${header}\n- ${root}\n  - ${body}\n`;}
function validate(raw,catalog,content){return validateAnnotatedReport(raw,content,catalog,{sectionHeader:header,knownPaths}).validation;}

test('team evidence binds request latency and both original values as one readable claim',()=>{
  const {raw,catalog,claim}=setup('[Notion] #168 접수→액션 시작 추가 단축 완료 — 10→5.2초 (PR #169~#183)');
  assert.equal(claim.raw,'접수→액션 시작 추가 단축 완료 — 10→5.2초');
  assert.equal(claim.display,'요청 접수→동작 시작 추가 단축 완료 — 10→5.2초');
  assert.equal(raw.slice(claim.sourceLocation.start,claim.sourceLocation.end),claim.raw);
  assert.deepEqual(claim.evidenceFactIds.map(id=>catalog.facts.find(f=>f.id===id).raw),['10','5.2초']);
  const annotated=annotateFactReferences(raw,catalog);
  assert.ok(annotated.includes(`[[fact:${claim.id}]]`));
  for(const id of claim.evidenceFactIds)assert.ok(!annotated.includes(`[[fact:${id}]]`),'the whole claim owns annotation of its child values');
  const expanded=expandFactReferences(output(claim),catalog);
  assert.equal(validate(raw,catalog,expanded).status,'PASS');
  assert.ok(expanded.includes(claim.display));
});

test('team evidence preserves two restart groups and the resulting range',()=>{
  const {raw,catalog,claim}=setup('[Notion] cam-operate restart 정지 시간 단축 — 약 17초/35초 두 무리 → 9.6~9.8초 (#184~#187, 보드 a12b34c)');
  assert.equal(claim.display,'카메라 재시작 정지 시간 단축 — 약 17초/35초 두 무리 → 9.6~9.8초');
  assert.equal(validate(raw,catalog,expandFactReferences(output(claim),catalog)).status,'PASS');
});

test('team evidence extracts a balanced measurement clause without the document path',()=>{
  const {raw,catalog,claim}=setup('↳ 변경: `docs/host.md` 기록에 원인 근거(수정 전 36분 8건 → 수정 후 20분 0건), 같은 부하대 스로틀 비교(분당 153회 → 1회, 최고 93°C → 78°C), 실험 시작 시각 기록','ETC');
  assert.equal(claim.display,'같은 부하대 스로틀 비교(분당 153회 → 1회, 최고 93°C → 78°C)');
  assert.equal(validate(raw,catalog,expandFactReferences(output(claim,'ETC'),catalog)).status,'PASS');
});

test('team evidence preserves measured capacity and units',()=>{
  const {raw,catalog,claim}=setup('저장 용량 128MB→64MB 감소');
  assert.equal(claim.display,'저장 용량 128MB→64MB 감소');
  assert.equal(validate(raw,catalog,expandFactReferences(output(claim),catalog)).status,'PASS');
});

test('team evidence rejects changed targets, conditions, units, ranges and direction',()=>{
  for(const [source,changes] of [
    ['접수→액션 시작 시간 10→5.2초 단축',['총 복구 시간 10→5.2초 단축','접수→액션 시작 시간 5.2→10초 단축']],
    ['같은 부하대 최고 온도 93°C→78°C 감소',['최고 온도 93°C→78°C 감소','같은 부하대 평균 온도 93°C→78°C 감소','같은 부하대 최고 전력 93W→78W 감소']],
    ['정지 시간 약 17초/35초 두 무리 → 9.6~9.8초',['정지 시간 약 17~35초 → 9.6~9.8초']],
    ['설정 되돌림 20분 관찰에서 0건 확인',['재부팅 20분 관찰에서 0건 확인','설정 되돌림 장기 관찰에서 0건 확인']],
  ]){
    const {raw,catalog,claim}=setup(source);
    for(const changed of changes){
      const v=validate(raw,catalog,output(claim,'PIM',`[[fact:${claim.id}|${changed}]]`));
      assert.equal(v.status,'FAIL',changed);
      assert.ok(v.issues.some(i=>i.code==='fact_value_mismatch'));
      assert.equal(hasNonOverridableV2Issue(v),true);
    }
  }
});

test('measurement claims must occupy an entire bullet, with optional whole underline',()=>{
  const {raw,catalog,claim}=setup('설정 되돌림 20분 관찰에서 0건 확인');
  for(const body of [`장기 안정성 확인 [[fact:${claim.id}]]`,`[[fact:${claim.id}]] — 재부팅 해결`,`설정 <u>[[fact:${claim.id}]]</u>`]){
    const v=validate(raw,catalog,expandFactReferences(output(claim,'PIM',body),catalog));
    assert.ok(v.issues.some(i=>i.code==='measurement_claim_structure'),body);
    assert.equal(hasNonOverridableV2Issue(v),true);
  }
  assert.equal(validate(raw,catalog,expandFactReferences(output(claim,'PIM',`<u>[[fact:${claim.id}]]</u>`),catalog)).status,'PASS');
});

test('team evidence rejects duplicate selections and cross-project claims',()=>{
  const {raw,catalog,claim}=setup('저장 용량 128MB→64MB 감소');
  const duplicate=expandFactReferences(output(claim)+`  - [[fact:${claim.id}]]\n`,catalog);
  assert.ok(validate(raw,catalog,duplicate).issues.some(i=>i.code==='duplicate_fact_claim'));
  const moved=expandFactReferences(output(claim,'ETC'),catalog);
  const movedValidation=validate(raw,catalog,moved);
  assert.ok(movedValidation.issues.some(i=>i.code==='fact_section_mismatch'));
  assert.equal(hasNonOverridableV2Issue(movedValidation),true);
});

test('team evidence cannot disappear when measured outcomes are available',()=>{
  const {raw,catalog}=setup('저장 용량 128MB→64MB 감소');
  const v=validate(raw,catalog,`${header}\n- PIM\n  - 저장 효율 개선\n`);
  assert.ok(v.issues.some(i=>i.code==='measurement_claim_omitted'));
});

test('team evidence rejects forged displays, unordered children and foreign evidence',()=>{
  const {raw,catalog,claim}=setup('최고 온도 93°C→78°C 감소');
  const foreign=buildFactCatalog(`${header}\n- ETC\n  - 다른 장비의 최고 온도 93°C→78°C 감소\n`,[],{knownPaths}).facts[0];
  for(const mutate of [
    f=>{f.display='최고 온도 78°C→93°C 감소';},
    f=>{f.evidenceFactIds.reverse();},
    (f,c)=>{c.facts.find(x=>x.id===f.evidenceFactIds[0]).sourceSectionPath=['ETC'];},
    (f,c)=>{const child=c.facts.find(x=>x.id===f.evidenceFactIds[0]);child.sourceLocation=foreign.sourceLocation;child.raw=foreign.raw;},
  ]){
    const corrupted=structuredClone(catalog);const changed=corrupted.facts.find(f=>f.id===claim.id);mutate(changed,corrupted);
    assert.throws(()=>annotateFactReferences(raw,corrupted),{code:'FACT_EVIDENCE_MISMATCH'});
    const v=validate(raw,corrupted,output(changed,'PIM',`[[fact:${changed.id}|${changed.display}]]`));
    assert.ok(v.issues.some(i=>i.code==='fact_evidence_mismatch'));
  }
});

test('complete product release suffixes are selected and validated as one fact',()=>{
  const raw=`${header}\n- PIM\n  - 버전을 \`0.6.3+jhw.camera16\` 으로 올립니다\n`;
  const catalog=buildFactCatalog(raw,[],options);
  const release=catalog.facts.find(f=>f.type==='release_version');assert.ok(release);
  assert.equal(release.raw,'0.6.3+jhw.camera16');
  const expanded=expandFactReferences(output(release),catalog);
  assert.equal(validate(raw,catalog,expanded).status,'PASS');
  assert.ok(expanded.includes('릴리즈 버전 0.6.3+jhw.camera16'));
  const changed=expanded.replace('camera16','camera17');
  assert.ok(validate(raw,catalog,changed).issues.some(i=>i.code==='fact_value_mismatch'));
});

test('legacy catalogs retain their scalar grammar and source annotation',()=>{
  const raw=`${header}\n- PIM\n  - [Notion] 접수→액션 시작 시간 10→5.2초 단축\n`;
  const catalog=buildFactCatalog(raw,[],{knownPaths});
  assert.ok(catalog.facts.every(f=>!f.id.startsWith('M')));
  assert.equal(validate(raw,catalog,expandFactReferences(annotateFactReferences(raw,catalog),catalog)).status,'PASS');
});

test('test-tool versions and policy windows are not promoted to team outcome claims',()=>{
  const raw=[header,'- ETC',
    '  - 검증: Bash 5.1+jq 1.6 및 Bash 5.0.17+jq 1.7.1 결과 대조',
    '  - 중단 조건의 순환 조항을 "플래시 시작 전 24시간 안에 비정상 재부팅이 있었다"는 구체 조건으로 대체하고 결정 (B)',
    '  - UPS 결정의 전제(41시간 무사고) 문구 수정',
    '  - jq 메모 상한 — 항목 512 + 2MiB(바이트), 크기 상한은 불변식 테스트로 고정',''].join('\n');
  const catalog=buildFactCatalog(raw,[],options);
  assert.equal(catalog.facts.filter(f=>f.id.startsWith('M')).length,0);
});

test('implementation metadata cannot become an exact required measurement display',()=>{
  for(const line of ['최고 온도 93°C→78°C, 보드 a12b34c 확인',
    '처리 시간 10초→5초, srcversion abc1234 반영',
    '용량 128MB→64MB, 커밋 deadbee 적용']){
    const raw=`${header}\n- PIM\n  - ${line}\n`;
    const catalog=buildFactCatalog(raw,[],options);
    assert.ok(!catalog.facts.some(f=>f.type==='measurement_claim'),line);
  }
});

test('release references cannot attach an invented installation or delivery stage',()=>{
  for(const source of ['릴리즈 패키지 0.7.2+jhw.camera16 제작 완료','장비에 릴리즈 버전 0.7.1+jhw.camera16 설치 완료']){
    const raw=`${header}\n- PIM\n  - ${source}\n`;
    const catalog=buildFactCatalog(raw,[],options);
    const release=catalog.facts.find(f=>f.type==='release_version');assert.ok(release);
    for(const stage of ['장비 설치 완료','고객 전달 완료','릴리즈 패키지 제작 완료']){
      const changed=expandFactReferences(output(release,'PIM',`${stage} [[fact:${release.id}]]`),catalog);
      assert.ok(validate(raw,catalog,changed).issues.some(i=>i.code==='measurement_claim_structure'),changed);
    }
  }
});

test('open status clauses remain scalar so date normalization never nests inside M',()=>{
  for(const status of ['보류','미완료','미해결']){
    const raw=`${header}\n- PIM\n  - 최고 온도 93°C→78°C 개선은 ${status}\n`;
    const catalog=buildFactCatalog(raw,[],options);
    assert.ok(!catalog.facts.some(f=>f.id.startsWith('M')),status);
    assert.ok(catalog.facts.some(f=>f.raw==='93°C'));
  }
});

test('release candidates exclude revision hashes, file paths and test-tool versions',()=>{
  for(const line of ['릴리즈 버전 0.7.2+deadbee','릴리즈 버전 0.7.2+gdeadbee','릴리즈 버전 0.7.2+srcversion.abc1234',
    '문서 `docs/release/0.7.2+jhw.camera16.md` 갱신','release/0.7.2+jhw.camera16 패키지 경로 정리',
    '테스트 파일 Version:0.7.2+jhw.camera16.json 생성','테스트 Bash 버전을 5.1+jq1.6으로 변경',
    '검증 도구 릴리즈 버전 1.2.3+linux.x64 사용','jq Version: 1.7.1+test.fixture로 단위시험']){
    const raw=`${header}\n- PIM\n  - ${line}\n`;
    assert.ok(!buildFactCatalog(raw,[],options).facts.some(f=>f.type==='release_version'),line);
  }
});

test('installed product version labels preserve the complete release value',()=>{
  for(const line of ['장비에 버전 0.7.1 설치 완료','장비 설치 버전 0.7.1','릴리즈 버전 0.7.2+jhw.camera16 패키지 제작']){
    const raw=`${header}\n- PIM\n  - ${line}\n`;
    assert.ok(buildFactCatalog(raw,[],options).facts.some(f=>f.type==='release_version'),line);
  }
});

test('a repeated neutral release label is normalized without changing any stage wording',()=>{
  const raw=`${header}\n- PIM\n  - 버전을 \`0.6.3+jhw.camera16\` 으로 올립니다\n`;
  const catalog=buildFactCatalog(raw,[],options);const release=catalog.facts.find(f=>f.type==='release_version');
  const expanded=expandFactReferences(output(release,'PIM',`릴리즈 버전 [[fact:${release.id}]]`),catalog);
  assert.equal(expanded,`${header}\n- PIM\n  - [[fact:${release.id}|릴리즈 버전 0.6.3+jhw.camera16]]\n`);
  assert.equal(validate(raw,catalog,expanded).status,'PASS');
  const forged=expandFactReferences(output(release,'PIM',`설치 완료 릴리즈 버전 [[fact:${release.id}]]`),catalog);
  assert.ok(validate(raw,catalog,forged).issues.some(i=>i.code==='measurement_claim_structure'));
});

function releaseContract(lines,render) {
  const raw=`${header}\n- PIM\n${lines.map(line=>`  - ${line}`).join('\n')}\n`;
  const coverage=buildSourceCoverageCatalog({rawContent:raw,autoContent:{'{{PIM}}':'updated'}},
    {pim:{parent:'PIM',label:null,templateKey:'PIM'}},{projectOnly:true});
  const catalog=buildFactCatalog(raw,[],{teamReport:true,knownPaths:coverage.knownPaths});
  const releases=catalog.facts.filter(f=>f.type==='release_version');
  assert.ok(releases.length);
  const annotated=expandFactReferences(`${header}\n- PIM [[source:C0001]]\n${render(releases)}\n`,catalog);
  return {raw,catalog,releases,annotated,coverage,
    validation:validateV2ReportContract(raw,annotated,catalog,coverage,
      {sectionHeader:header,knownPaths:coverage.knownPaths}).validation};
}

test('the full report contract rejects an unsupported release stage on ancestors or siblings',()=>{
  for(const render of [
    f=>`  - 고객 전달 완료\n    - [[fact:${f[0].id}]]`,
    f=>`  - 고객 전달 완료\n    - 릴리즈 정보\n      - [[fact:${f[0].id}]]`,
    f=>`  - [[fact:${f[0].id}]]\n  - 고객 전달 완료`,
    f=>`  - <u>장비 설치 완료</u>\n  - [[fact:${f[0].id}]]`,
  ]) {
    const {validation}=releaseContract(['릴리즈 패키지 0.7.2+jhw.camera16 제작 완료'],render);
    assert.equal(validation.status,'FAIL');
    assert.ok(validation.issues.some(i=>i.code==='release_stage_mismatch'));
    assert.equal(hasNonOverridableV2Issue(validation),true);
  }
});

test('independently sourced release stages remain valid with their own version evidence',()=>{
  for(const [source,stage] of [
    ['릴리즈 패키지 0.7.2 제작 완료','패키지 제작 완료'],
    ['장비에 릴리즈 버전 0.7.1 설치 완료','장비 설치 완료'],
    ['릴리즈 버전 0.7.0 고객 전달 완료','고객 전달 완료'],
    ['릴리즈 버전 0.7.1 장비 설치 예정','장비 설치 예정'],
    ['릴리즈 버전 0.7.1 장비 설치 실패','장비 설치 실패'],
    ['릴리즈 버전 0.7.1 장비 설치 취소','장비 설치 취소'],
  ]) {
    const {validation}=releaseContract([source],f=>`  - ${stage}\n    - [[fact:${f[0].id}]]`);
    assert.equal(validation.status,'PASS',JSON.stringify(validation.issues));
  }
  const result=releaseContract(['릴리즈 패키지 0.7.2 제작 완료','릴리즈 버전 0.7.1 장비 설치 완료'],
    f=>`  - 전달본 관리\n    - 패키지 제작 완료\n      - [[fact:${f[0].id}]]\n    - 장비 설치 완료\n      - [[fact:${f[1].id}]]`);
  assert.equal(result.validation.status,'PASS',JSON.stringify(result.validation.issues));
});

test('release stages cannot borrow evidence from another version or a planned or negative clause',()=>{
  for(const source of [
    '릴리즈 버전 0.7.2 장비 설치 예정',
    '릴리즈 버전 0.7.2 장비 설치 미완료',
    '릴리즈 버전 0.7.2 장비 설치 실패',
    '장비 설치 전 릴리즈 패키지 0.7.2 제작 완료',
    '릴리즈 버전 0.7.2 설치 완료라고 보고하지 않음',
    '릴리즈 버전 0.7.2 `장비 설치 확인`',
    '릴리즈 버전 0.7.2 **장비 설치 확인**',
  ]) {
    const {validation}=releaseContract([source],f=>`  - 장비 설치 완료\n    - [[fact:${f[0].id}]]`);
    assert.ok(validation.issues.some(i=>i.code==='release_stage_mismatch'),source);
  }
  const result=releaseContract(['릴리즈 패키지 0.7.2 제작 완료','릴리즈 버전 0.7.1 장비 설치 완료'],
    f=>`  - 장비 설치 완료\n    - [[fact:${f[0].id}]]\n  - 릴리즈 정보\n    - [[fact:${f[1].id}]]`);
  assert.ok(result.validation.issues.some(i=>i.code==='release_stage_mismatch'));
  const delivery=releaseContract(['고객 전달용 릴리즈 패키지 0.7.2 제작 완료'],
    f=>`  - 고객 전달 완료\n    - [[fact:${f[0].id}]]`);
  assert.ok(delivery.validation.issues.some(i=>i.code==='release_stage_mismatch'));
  const future=releaseContract(['고객 전달할 릴리즈 패키지 0.7.2 제작 완료'],
    f=>`  - 고객 전달 완료\n    - [[fact:${f[0].id}]]`);
  assert.ok(future.validation.issues.some(i=>i.code==='release_stage_mismatch'));
});

test('release stage evidence keeps source clause boundaries and cannot be forged in a catalog',()=>{
  const result=releaseContract(['릴리즈 버전 0.7.1 장비 설치 완료, 릴리즈 패키지 0.7.2 제작 완료'],
    f=>`  - 패키지 제작 완료\n    - [[fact:${f[1].id}]]\n  - 장비 설치 완료\n    - [[fact:${f[0].id}]]`);
  assert.equal(result.validation.status,'PASS',JSON.stringify(result.validation.issues));
  const forged=structuredClone(result.catalog);
  forged.facts.find(f=>f.id===result.releases[1].id).releaseStageEvidence=[{stage:'delivery',state:'complete'}];
  assert.throws(()=>annotateFactReferences(result.raw,forged),{code:'FACT_EVIDENCE_MISMATCH'});
  const legacy=structuredClone(result.catalog);
  for(const fact of legacy.facts)delete fact.releaseStageEvidence;
  const neutral=expandFactReferences(output(result.releases[1]),legacy);
  assert.equal(validate(result.raw,legacy,neutral).status,'PASS');
});

test('release stage source states must be explicit and cannot merge a transition clause',()=>{
  for(const [source,stage] of [
    ['릴리즈 버전 0.7.1 장비 설치','장비 설치 완료'],
    ['릴리즈 버전 0.7.1 장비 설치 예정 후 장비 설치 완료','장비 설치 예정'],
    ['릴리즈 버전 0.7.1 장비 설치 실패 후 설치 완료','장비 설치 실패'],
  ]) {
    const {validation}=releaseContract([source],f=>`  - ${stage}\n    - [[fact:${f[0].id}]]`);
    assert.ok(validation.issues.some(i=>i.code==='release_stage_mismatch'),source);
  }
});

test('release output cancellation and unknown states cannot default to complete or planned',()=>{
  for(const [source,stage] of [
    ['릴리즈 버전 0.7.1 장비 설치 완료','장비 설치 취소'],
    ['릴리즈 버전 0.7.1 장비 설치 예정','장비 설치 계획 취소'],
    ['릴리즈 버전 0.7.1 고객 전달 완료','고객 전달 철회'],
    ['릴리즈 버전 0.7.1 장비 설치 미완료','장비 설치 중단'],
    ['릴리즈 버전 0.7.1 장비 설치 완료','장비 설치 검토'],
  ]) {
    const {validation}=releaseContract([source],f=>`  - ${stage}\n    - [[fact:${f[0].id}]]`);
    assert.ok(validation.issues.some(i=>i.code==='release_stage_mismatch'),stage);
  }
});

test('flat release-stage pairs bind only immediate unambiguous siblings',()=>{
  const source=['릴리즈 패키지 0.7.2 제작 완료','릴리즈 버전 0.7.1 장비 설치 완료'];
  for(const render of [
    f=>`  - 패키지 제작 완료\n  - [[fact:${f[0].id}]]\n  - 장비 설치 완료\n  - [[fact:${f[1].id}]]`,
    f=>`  - [[fact:${f[0].id}]]\n  - 패키지 제작 완료\n  - [[fact:${f[1].id}]]\n  - 장비 설치 완료`,
  ]) {
    const result=releaseContract(source,render);
    assert.equal(result.validation.status,'PASS',JSON.stringify(result.validation.issues));
  }
  for(const render of [
    f=>`  - 장비 설치 완료\n  - 무관한 항목\n  - 릴리즈 정보\n    - [[fact:${f[1].id}]]`,
    f=>`  - [[fact:${f[0].id}]]\n  - 장비 설치 완료\n  - [[fact:${f[1].id}]]`,
  ]) {
    const {validation}=releaseContract(source,render);
    assert.ok(validation.issues.some(i=>i.code==='release_stage_mismatch'));
  }
});

test('a sibling wrapper with multiple release versions is not a one-to-one stage pair',()=>{
  const source=['릴리즈 버전 0.7.1 장비 설치 완료','릴리즈 버전 0.7.2 장비 설치 완료'];
  const ambiguous=releaseContract(source,f=>`  - 장비 설치 완료\n  - 릴리즈 정보\n    - [[fact:${f[0].id}]]\n    - [[fact:${f[1].id}]]`);
  assert.ok(ambiguous.validation.issues.some(i=>i.code==='release_stage_mismatch'));
  const explicit=releaseContract(source,f=>`  - 장비 설치 완료\n    - [[fact:${f[0].id}]]\n    - [[fact:${f[1].id}]]`);
  assert.equal(explicit.validation.status,'PASS',JSON.stringify(explicit.validation.issues));
});

for(const [stage,positive,negatives] of [
  ['production','패키지 제작 확인',['미제작 확인','미 제작 확인','<u>미</u>제작 확인','미빌드 확인','미패키징 확인','미제작 현황','**미**제작 확인','`미`제작 확인','（미）제작 확인']],
  ['installation','장비 설치 확인',['미설치 확인','미 설치 확인','(미)설치 확인','장비 미적용 확인','보드 미배포 확인','미설치 현황','**미**설치 확인','`미`설치 확인','（미）설치 확인','“미”설치 확인','장비 （미）적용 확인']],
  ['delivery','고객 전달 확인',['미납품 확인','미 납품 확인','고객 미전달 확인','미고객 전달 확인','미납품 현황','**미**납품 확인','`미`납품 확인','（미）납품 확인','고객 **미**전달 확인']],
]) {
  test(`release ${stage} prefix negation cannot become positive evidence or output`,()=>{
    for(const negative of negatives) {
      for(const [sourceStage,outputStage] of [[positive,negative],[negative,positive]]) {
        const {validation}=releaseContract([`릴리즈 버전 0.7.1 ${sourceStage}`],
          f=>`  - ${outputStage}\n    - [[fact:${f[0].id}]]`);
        assert.equal(validation.status,'FAIL',`${sourceStage} -> ${outputStage}`);
        assert.ok(validation.issues.some(i=>i.code==='release_stage_mismatch'),`${sourceStage} -> ${outputStage}`);
        assert.equal(hasNonOverridableV2Issue(validation),true);
      }
      const neutral=releaseContract([`릴리즈 버전 0.7.1 ${negative}`],f=>`  - [[fact:${f[0].id}]]`);
      assert.equal(neutral.validation.status,'PASS',JSON.stringify(neutral.validation.issues));
      assert.ok(neutral.releases[0].releaseStageEvidence.every(e=>e.state!=='complete'));
    }
  });
}

test('release stage boundaries keep normal subjects containing negation syllables',()=>{
  for(const stage of ['미디어 패키지 제작 확인','장비 설치 확인','고객사에 전달 확인']) {
    const {validation}=releaseContract([`릴리즈 버전 0.7.1 ${stage}`],
      f=>`  - ${stage}\n    - [[fact:${f[0].id}]]`);
    assert.equal(validation.status,'PASS',JSON.stringify(validation.issues));
  }
});
