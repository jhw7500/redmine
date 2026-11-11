const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildFactCatalog}=require('../fact-catalog');
const {expandFactReferences}=require('../fact-references');
const {validateAnnotatedReport}=require('../fact-validator');
const {
  createFactContextProjection,
  readFactContextProjection,
}=require('../fact-context-projection');

const header='#### <span style="color:blue">조현우</span>';
const sourceRecordsHash='a'.repeat(64);
const knownPaths=[['PIM'],['ETC']];

function projection(content,catalog) {
  return createFactContextProjection(content,{
    catalogHash:catalog.catalogHash,
    sourceRecordsHash,
    profile:'team_summary_v1',
  });
}

function validate(raw,content,catalog,options={}) {
  return validateAnnotatedReport(raw,content,catalog,options).validation;
}

test('fact context projection is opaque, immutable and exactly content-bound',()=>{
  const content=`${header}\n- 검증: [[fact:Q0001|4096]]\n`;
  const catalogHash='b'.repeat(64);
  const proof=createFactContextProjection(content,{catalogHash,sourceRecordsHash,profile:'team_summary_v1'});
  assert.equal(Object.isFrozen(proof),true);
  assert.deepEqual(Object.keys(proof),[]);

  const metadata=readFactContextProjection(proof,{content,catalogHash});
  assert.equal(Object.isFrozen(metadata),true);
  assert.equal(metadata.profile,'team_summary_v1');
  assert.equal(metadata.catalogHash,catalogHash);
  assert.equal(metadata.sourceRecordsHash,sourceRecordsHash);
  assert.match(metadata.contentHash,/^[0-9a-f]{64}$/);
  assert.equal(metadata.origin,undefined);
  assert.strictEqual(readFactContextProjection(proof,{content,catalogHash}),metadata);

  for(const fake of [{},JSON.parse(JSON.stringify(proof)),structuredClone(proof)]) {
    assert.throws(()=>readFactContextProjection(fake,{content,catalogHash}));
  }
  assert.throws(()=>readFactContextProjection(proof,{content:`${content} `,catalogHash}));
  assert.throws(()=>readFactContextProjection(proof,{content,catalogHash:'c'.repeat(64)}));
  assert.throws(()=>createFactContextProjection(content,{catalogHash:'short',sourceRecordsHash,profile:'team_summary_v1'}));
  assert.throws(()=>createFactContextProjection(content,{catalogHash,sourceRecordsHash:'short',profile:'team_summary_v1'}));
  assert.throws(()=>createFactContextProjection(content,{catalogHash,sourceRecordsHash,profile:'other'}));
  assert.throws(()=>createFactContextProjection(content,{catalogHash,sourceRecordsHash,profile:'team_summary_v1',origin:'code_owned'}));
  assert.throws(()=>createFactContextProjection(null,{catalogHash,sourceRecordsHash,profile:'team_summary_v1'}));
});

test('only a matching branded projection permits a code-owned subject prefix rewrite',()=>{
  const raw=`${header}\n- queue depth 4096\n`;
  const catalog=buildFactCatalog(raw);
  const content=`${header}\n- 운영 지표\n  ↳ 검증: [[fact:Q0001|4096]]\n`;

  const strict=validate(raw,content,catalog);
  assert.equal(strict.status,'FAIL');
  assert.ok(strict.issues.some(issue=>issue.code==='fact_subject_mismatch'));

  const trusted=validate(raw,content,catalog,{factContextProjection:projection(content,catalog)});
  assert.equal(trusted.status,'PASS',JSON.stringify(trusted.issues));

  for(const factContextProjection of [true,{},JSON.parse(JSON.stringify(projection(content,catalog)))]) {
    const rejected=validate(raw,content,catalog,{factContextProjection});
    assert.ok(rejected.issues.some(issue=>issue.code==='fact_context_projection_mismatch'));
    assert.ok(rejected.issues.some(issue=>issue.code==='fact_subject_mismatch'));
  }
  const mismatchedContent=validate(raw,`${content} `,catalog,{factContextProjection:projection(content,catalog)});
  assert.ok(mismatchedContent.issues.some(issue=>issue.code==='fact_context_projection_mismatch'));
  const otherCatalog={...catalog,catalogHash:'c'.repeat(64)};
  const mismatchedCatalog=validate(raw,content,otherCatalog,{factContextProjection:projection(content,catalog)});
  assert.ok(mismatchedCatalog.issues.some(issue=>issue.code==='fact_context_projection_mismatch'));
});

test('projection never relaxes values, units, attached targets or unmarked literals',()=>{
  for(const [rawLine,contentLine,code] of [
    ['queue depth 4096','↳ 검증: [[fact:Q0001|8192]]','fact_value_mismatch'],
    ['전송 용량 128MB','↳ 검증: [[fact:Q0001|128GB]]','fact_value_mismatch'],
    ['gstApp 2채널 녹화 검증','↳ 검증: [[fact:Q0001|2]]포트 녹화 검증','fact_subject_mismatch'],
    ['queue depth 4096','↳ 검증: 4096','unmarked_protected_fact'],
  ]) {
    const raw=`${header}\n- ${rawLine}\n`;
    const catalog=buildFactCatalog(raw);
    const content=`${header}\n- 운영 지표\n  ${contentLine}\n`;
    const result=validate(raw,content,catalog,{factContextProjection:projection(content,catalog)});
    assert.equal(result.status,'FAIL',`${rawLine}: ${JSON.stringify(result.issues)}`);
    assert.ok(result.issues.some(issue=>issue.code===code),rawLine);
  }
});

test('projection preserves measurement ownership, whole-bullet and deduplication checks',()=>{
  const raw=`${header}\n- PIM\n  - 저장 용량 128MB→64MB 감소\n`;
  const catalog=buildFactCatalog(raw,[],{teamReport:true,knownPaths});
  const claim=catalog.facts.find(fact=>fact.type==='measurement_claim');
  assert.ok(claim);

  const moved=expandFactReferences(`${header}\n- ETC\n  - [[fact:${claim.id}]]\n`,catalog);
  const movedResult=validate(raw,moved,catalog,{knownPaths,factContextProjection:projection(moved,catalog)});
  assert.ok(movedResult.issues.some(issue=>issue.code==='fact_section_mismatch'));

  const embedded=expandFactReferences(`${header}\n- PIM\n  - 결과 [[fact:${claim.id}]]\n`,catalog);
  const embeddedResult=validate(raw,embedded,catalog,{knownPaths,factContextProjection:projection(embedded,catalog)});
  assert.ok(embeddedResult.issues.some(issue=>issue.code==='measurement_claim_structure'));

  const duplicate=expandFactReferences(`${header}\n- PIM\n  - [[fact:${claim.id}]]\n  - [[fact:${claim.id}]]\n`,catalog);
  const duplicateResult=validate(raw,duplicate,catalog,{knownPaths,factContextProjection:projection(duplicate,catalog)});
  assert.ok(duplicateResult.issues.some(issue=>issue.code==='duplicate_fact_claim'));
  assert.equal(raw,`${header}\n- PIM\n  - 저장 용량 128MB→64MB 감소\n`);
});
