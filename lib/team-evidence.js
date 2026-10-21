// Whole source clauses keep a measurement's target, qualifiers and ordered values together.
// The aliases apply only before the first value; the measured suffix stays byte-for-byte intact.
const {findOpenStatusOccurrences}=require('./open-status-clauses');
const RELEASE = /\bv?\d+(?:\.\d+){1,3}(?:[A-Za-z][A-Za-z0-9]*)?(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?\b/g;
const METRIC = /시간|지연|온도|전력|용량|크기|처리량|속도|최고|최대|최소|평균|정지|기동|측정|전송|감소|단축|부하|접수|동작|관찰/;

function fail(message) { throw Object.assign(new Error(message), {code:'FACT_EVIDENCE_MISMATCH'}); }
function inside(child,parent) { return child.start>=parent.start&&child.end<=parent.end; }
function samePath(a,b) { return JSON.stringify(a)===JSON.stringify(b); }
function isEvidence(fact) { return /^M\d{4}$/.test(fact.id); }
function aliasesForDisplay(aliases) {
  const entries=Object.entries(aliases||{});
  for(const [from,to] of entries) {
    if(!from||typeof to!=='string'||!to||/[\d\r\n\[\]<>`]/.test(from+to)) fail('Invalid measurement label alias');
  }
  return entries.sort((a,b)=>b[0].length-a[0].length||a[0].localeCompare(b[0]));
}
function renderMeasurement(raw,firstValue,aliases) {
  let prefix=raw.slice(0,firstValue);
  for(const [from,to] of aliasesForDisplay(aliases)) {
    const escaped=from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    prefix=prefix.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,'gu'),()=>to);
  }
  return prefix+raw.slice(firstValue);
}
function readableMeasurement(display,children) {
  return METRIC.test(display)
    && children.some(f=>f.type==='measured_quantity'&&!/(?:개|건|회|가지|번|차례)$/.test(f.raw))
    && !/[`\r\n]|\[\[|#\d|(?:\b[\w.-]+\/|\b[\w.-]+\.(?:md|js|py|sh|c|h)\b)|\b\w+[_-]\w+|\b\w+\(\)/.test(display)
    && !/\b(?:sha(?:256)?|hash|srcversion|commit)\b|커밋|\b(?=[0-9a-f]{7,64}\b)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/i.test(display)
    && !/^(?:jq|git|node|python3?|bash|bitbake)\s|결정|전제|조항|모순|가설|예정|[가-힣][.!?]\s*\S/.test(display)
    && findOpenStatusOccurrences(display).length===0
    && !/(?:습니다|입니다|했다|하였다|되었다|한다|된다|이다|있다|없다)[.!?]?\s*$|…/.test(display);
}
function location(source,start,end) {
  const before=source.slice(0,start).split('\n');
  return {start,end,line:before.length,column:before.at(-1).length+1};
}
function lineSpan(line) {
  const prefix=line.match(/^\s*(?:[-*+]\s+)?(?:\[Notion\]\s*)?(?:#\d+\s+)?(?:(?:↳\s*(?:목적|변경|검증|출처 요약)|(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]*\))?!?)\s*:\s*)?/i)[0];
  let start=prefix.length,end=line.trimEnd().length;
  const trailing=line.slice(start,end).match(/\s*\(([^()]*)\)$/);
  if(trailing) {
    const metadata=trailing[1].replace(/보드\s+[a-f\d]{7,40}\b|#\d+|\bPR\b|[\s~·,/–—-]+/gi,'');
    if(!metadata) end-=trailing[0].length;
  }
  while(start<end&&/\s/.test(line[start])) start++;
  return {start,end};
}
function clauseSpans(line) {
  const spans=[lineSpan(line)];
  const stack=[];
  for(let i=0;i<line.length;i++) {
    if(line[i]==='(') stack.push(i);
    if(line[i]===')'&&stack.length) {
      const open=stack.pop();
      const prefix=line.slice(0,open);
      const head=prefix.match(/[^,;:\n]+$/)?.[0];
      if(head) {
        let start=open-head.length;
        while(start<open&&/\s/.test(line[start])) start++;
        spans.push({start,end:i+1});
      }
    }
  }
  return spans;
}
function sourceChildren(facts,span) {
  return facts.filter(f=>f.sourceLocation&&!isEvidence(f)&&inside(f.sourceLocation,span))
    .sort((a,b)=>a.sourceLocation.start-b.sourceLocation.start);
}
function releaseCandidate(line,match) {
  const raw=match[0],prefix=line.slice(0,match.index),suffix=line.slice(match.index+raw.length);
  if(/[\\/]\s*$/.test(prefix)||/^[\\/]/.test(suffix)
    ||/\.(?:md|json|ya?ml|toml|js|py|sh|c|h|deb|so|gz|zip|tar|ko)$/i.test(raw)) return false;
  const metadata=raw.replace(/^v?\d+(?:\.\d+){1,3}/,'');
  if(/(?:sha(?:256)?|hash|srcversion)/i.test(metadata)
    ||/(?:^|[.+-])g?[a-f\d]{7,64}(?=$|[.+-])/i.test(metadata)) return false;
  if(/\b(?:bash|jq|codex-cli|pytest)\b/i.test(line)
    ||/검증 도구|테스트 (?:도구|환경|파일)|단위시험/.test(line)) return false;
  return /릴리(?:스|즈)|\brelease\b|\bVersion\s*:|버전을|버전\s*:/i.test(line)
    ||(/버전\s*`?\s*$/.test(prefix)&&/장비|설치|적용|배포/.test(line));
}

function buildTeamEvidenceFacts(source,facts,{termAliases={}}={}) {
  aliasesForDisplay(termAliases);
  const candidates=[];
  let offset=0;
  for(const line of source.split('\n')) {
    for(const span of clauseSpans(line)) {
      if(span.end<=span.start) continue;
      const absolute={start:offset+span.start,end:offset+span.end};
      const children=sourceChildren(facts,absolute);
      if(!children.length) continue;
      const raw=line.slice(span.start,span.end);
      const display=renderMeasurement(raw,children[0].sourceLocation.start-absolute.start,termAliases);
      if(readableMeasurement(display,children)) candidates.push({...absolute,type:'measurement_claim',raw,display,termAliases:{...termAliases},children});
    }
    for(const match of line.matchAll(RELEASE)) {
      const raw=match[0];
      if(!releaseCandidate(line,match)) continue;
      const absolute={start:offset+match.index,end:offset+match.index+raw.length};
      const children=sourceChildren(facts,absolute);
      if(!children.length||children.some(f=>f.type==='named_version')) continue;
      candidates.push({...absolute,type:'release_version',raw,display:`릴리즈 버전 ${raw}`,children});
    }
    offset+=line.length+1;
  }
  const selected=[];
  for(const candidate of candidates.sort((a,b)=>a.start-b.start||b.end-a.end)) {
    if(selected.some(s=>candidate.start<s.end&&candidate.end>s.start)) continue;
    if(candidate.children.some(f=>!samePath(f.sourceSectionPath,candidate.children[0].sourceSectionPath))) continue;
    selected.push(candidate);
  }
  return selected.map((c,index)=>({
    id:`M${String(index+1).padStart(4,'0')}`,type:c.type,raw:c.raw,display:c.display,
    ...(c.type==='measurement_claim'?{termAliases:c.termAliases}:{}),
    evidenceFactIds:c.children.map(f=>f.id),
    sourceLocation:location(source,c.start,c.end),
    sourceExcerpt:source.slice(source.lastIndexOf('\n',c.start-1)+1,source.indexOf('\n',c.end)===-1?source.length:source.indexOf('\n',c.end)).trim(),
    ...(c.children[0].sourceSectionPath===undefined?{}:{sourceSectionPath:c.children[0].sourceSectionPath}),
    allowedNormalizations:[],
  }));
}

function assertTeamEvidenceFacts(source,catalog) {
  const evidence=catalog.facts.filter(isEvidence);
  const owned=[];
  for(const fact of evidence) {
    const span=fact.sourceLocation;
    if(!['measurement_claim','release_version'].includes(fact.type)||!span
      ||!Number.isInteger(span.start)||!Number.isInteger(span.end)||span.start<0||span.end<=span.start
      ||source.slice(span.start,span.end)!==fact.raw) fail('Whole evidence source span mismatch');
    if(owned.some(s=>span.start<s.end&&span.end>s.start)) fail('Overlapping whole evidence claims');
    owned.push(span);
    const children=sourceChildren(catalog.facts,span);
    if(!children.length||JSON.stringify(fact.evidenceFactIds)!==JSON.stringify(children.map(f=>f.id))) fail('Whole evidence child order mismatch');
    for(const child of children) {
      if(source.slice(child.sourceLocation.start,child.sourceLocation.end)!==child.raw
        ||!samePath(child.sourceSectionPath,fact.sourceSectionPath)) fail('Whole evidence child source or project mismatch');
    }
    if(catalog.facts.some(f=>!isEvidence(f)&&f.sourceLocation&&f.sourceLocation.start<span.end
      &&f.sourceLocation.end>span.start&&!inside(f.sourceLocation,span))) fail('Partial whole evidence overlap');
    const expected=fact.type==='measurement_claim'
      ? renderMeasurement(fact.raw,children[0].sourceLocation.start-span.start,fact.termAliases)
      : `릴리즈 버전 ${fact.raw}`;
    if(fact.display!==expected||(fact.type==='measurement_claim'&&!readableMeasurement(expected,children))) fail('Whole evidence display changed');
    if(fact.type==='release_version') {
      const start=source.lastIndexOf('\n',span.start-1)+1;
      const end=source.indexOf('\n',span.end);
      const line=source.slice(start,end===-1?source.length:end);
      if(![...fact.raw.matchAll(RELEASE)].some(m=>m.index===0&&m[0]===fact.raw)
        ||!releaseCandidate(line,{0:fact.raw,index:span.start-start})) fail('Invalid whole release version');
    }
  }
  return evidence;
}

function annotationOwners(source,catalog) {
  const evidence=assertTeamEvidenceFacts(source,catalog);
  return catalog.facts.filter(f=>f.sourceLocation&&(isEvidence(f)
    ||!evidence.some(parent=>inside(f.sourceLocation,parent.sourceLocation))));
}

module.exports={buildTeamEvidenceFacts,assertTeamEvidenceFacts,annotationOwners};
