// Whole source clauses keep a measurement's target, qualifiers and ordered values together.
// The aliases apply only before the first value; the measured suffix stays byte-for-byte intact.
const {findOpenStatusOccurrences,splitOpenStatusClauseSpans}=require('./open-status-clauses');
const {projectBalancedMarkdownDestinations}=require('./collector');
const RELEASE = /\bv?\d+(?:\.\d+){1,3}(?:[A-Za-z][A-Za-z0-9]*)?(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?\b/g;
const METRIC = /시간|지연|온도|전력|용량|크기|처리량|속도|최고|최대|최소|평균|정지|기동|측정|전송|감소|단축|부하|접수|동작|관찰/;
const STAGE_SEPARATOR = /^[\p{Zs}\t\p{P}\p{S}\p{Cf}]*$/u;
// Keep known target labels attached to a state or negator, as in "장비미적용".
const STAGE_TARGET = '(?:(?:패키지|장비|보드)(?:에)?|고객(?:에게|사에|사|에)?)';
const STAGE_NEGATOR = new RegExp(`^(?:${STAGE_TARGET})?(?:미|비|불|안)$`,'u');
const STAGE_ACTION = /제작|빌드|패키징|설치|적용|배포|전달|납품/u;
const STAGE_FAMILY = {제작:'production',빌드:'production',패키징:'production',
  설치:'installation',적용:'installation',배포:'installation',전달:'delivery',납품:'delivery'};
const STAGE_STATES = {완료:'complete',확인:'complete',성공:'complete',통과:'complete',함:'complete',됨:'complete',
  예정:'planned',계획:'planned',미완료:'not_complete',미실행:'not_executed',실패:'failed',
  취소:'cancelled',철회:'withdrawn',중단:'stopped',보류:'deferred'};
const STAGE_STATUS_WORDS = Object.keys(STAGE_STATES).sort((a,b)=>b.length-a.length);
const STAGE_SUFFIX = new RegExp(`^(${STAGE_STATUS_WORDS.join('|')})\\s*[.!?]?\\s*$`,'u');
// Match a whole state phrase; 계획서/취소선/실패율 are ordinary nouns.
// 함/됨 are suffix endings, not prefix state words (e.g. 함께).
const STAGE_PREFIX_STATUS = new RegExp(`^(${STAGE_STATUS_WORDS.filter(word=>word.length>1).join('|')})(?:인|한|된)?(?:${STAGE_TARGET})?$`,'u');

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

// A release number proves no deployment milestone on its own. Keep stage
// evidence inside the same source clause and never share it between versions.
function releaseStagePrefixStates(visible) {
  const stages=new Map(),pending=new Set();
  let previousEnd=0;
  for(const word of visible.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    if(!STAGE_SEPARATOR.test(visible.slice(previousEnd,word.index))) pending.clear();
    const action=word[0].match(STAGE_ACTION);
    const prefix=action?word[0].slice(0,action.index):word[0];
    if(STAGE_NEGATOR.test(prefix)) pending.add('unknown');
    const status=prefix.match(STAGE_PREFIX_STATUS)?.[1];
    if(status) pending.add(STAGE_STATES[status]);
    if(action) {
      if(pending.size) {
        const stage=STAGE_FAMILY[action[0]],states=stages.get(stage)||new Set();
        for(const state of pending) states.add(state);
        stages.set(stage,states);
      }
      pending.clear();
    }
    previousEnd=word.index+word[0].length;
  }
  return stages;
}

function parseReleaseStageClaims(visible) {
  // Read prefix states before punctuation splits clauses. Never rewrite the
  // sentence: a quoted positive example must not become completion evidence.
  const prefixStates=releaseStagePrefixStates(visible);
  const stages=[];
  for(const clause of splitOpenStatusClauseSpans(visible)) {
    for(const [stage,pattern] of [
      ['production',/제작|빌드|패키징/g],
      ['installation',/설치|(?:장비|보드)(?:에)?\s*(?:적용|배포)/g],
      ['delivery',/고객(?:에게|사에|사|에)?\s*전달|납품/g],
    ]) {
      for(const match of clause.text.matchAll(pattern)) {
        const before=clause.text.slice(0,match.index);
        const after=clause.text.slice(match.index+match[0].length);
        const prefixed=prefixStates.get(stage);
        // Prefix negation and unknown compounds cannot disappear as metadata.
        const uncertainPrefix=/[\p{L}\p{N}\p{M}\p{Cf}_]$/u.test(before)
          || prefixed?.has('unknown');
        if(!uncertainPrefix&&!prefixed&&/^\s*(?:용|본|패키지|기준|규칙|절차|사양|정책|대상|과정|현황|관리|준비|서버|환경|도구|로그|설정|경로|캐시|의존성|전(?=\s|$)|후(?=\s|$)|중(?=\s|$)|시(?=\s|$)|때(?=\s|$))/.test(after)) continue;
        const tail=after.replace(/^\s*(?:까지|도)?\s*/,'')
          .replace(/^\(\d{4}-\d{2}-\d{2}\s*기준\s+([^()]+)\)\s*$/,'$1');
        // Match the whole status suffix: "예정 후 설치 완료" and "계획 취소"
        // cannot be licensed by whichever keyword happened to appear first.
        const suffixState=STAGE_STATES[tail.match(STAGE_SUFFIX)?.[1]]||'unknown';
        const conflicting=prefixed&&Array.from(prefixed).some(state=>state!==suffixState);
        const state=uncertainPrefix||conflicting?'unknown':suffixState;
        if(!stages.some(s=>s.stage===stage&&s.state===state)) stages.push({stage,state});
      }
    }
  }
  for(const stage of prefixStates.keys()) {
    if(!stages.some(claim=>claim.stage===stage)) stages.push({stage,state:'unknown'});
  }
  return stages;
}

function releaseStageClaims(text) {
  const visible=String(text).replace(/<[^>]*>/g,'');
  const stages=parseReleaseStageClaims(visible);
  const links=projectBalancedMarkdownDestinations(visible,false);
  if(links.limitExceeded) {
    for(const stage of new Set(Object.values(STAGE_FAMILY))) {
      if(!stages.some(claim=>claim.stage===stage&&claim.state==='unknown')) stages.push({stage,state:'unknown'});
    }
    return stages;
  }
  // This lossy projection can only expose ambiguity, never create evidence.
  const projected=links.text.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z][a-z0-9]+));?/gi,
    (entity,hexadecimal,decimal,named)=>{
      if(named) return '';
      const point=Number.parseInt(hexadecimal||decimal,hexadecimal?16:10);
      return point>0&&point<=0x10ffff&&!(point>=0xd800&&point<=0xdfff)?String.fromCodePoint(point):entity;
    }).normalize('NFKC')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g,'$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g,'$1')
    .replace(/[*_`~\[\]]|\p{Default_Ignorable_Code_Point}/gu,'').normalize('NFKC');
  if(projected!==visible) {
    for(const claim of parseReleaseStageClaims(projected)) {
      if(!stages.some(stage=>stage.stage===claim.stage&&(stage.state===claim.state||stage.state==='unknown'))) {
        stages.push({stage:claim.stage,state:'unknown'});
      }
    }
  }
  return stages;
}

function releaseStageEvidence(source,fact,facts) {
  const start=source.lastIndexOf('\n',fact.sourceLocation.start-1)+1;
  const next=source.indexOf('\n',fact.sourceLocation.end);
  const line=source.slice(start,next===-1?source.length:next);
  const clause=splitOpenStatusClauseSpans(line).find(c=>start+c.start<=fact.sourceLocation.start
    &&fact.sourceLocation.end<=start+c.end);
  if(!clause) return [];
  const span={start:start+clause.start,end:start+clause.end};
  const versions=new Set(facts.filter(f=>isEvidence(f)&&f.type==='release_version'&&f.sourceLocation&&inside(f.sourceLocation,span)).map(f=>f.raw));
  if(versions.size!==1||!versions.has(fact.raw)||/오인|오분류|표현|문구/.test(clause.text)) return [];
  const stages=releaseStageClaims(clause.text);
  if(stages.some(s=>s.state==='unknown')||new Set(stages.map(s=>s.stage)).size!==stages.length) return [];
  return stages.map(stage=>({...stage,
    sourceLocation:location(source,span.start,span.end),raw:source.slice(span.start,span.end)}));
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
  const result=selected.map((c,index)=>({
    id:`M${String(index+1).padStart(4,'0')}`,type:c.type,raw:c.raw,display:c.display,
    ...(c.type==='measurement_claim'?{termAliases:c.termAliases}:{}),
    evidenceFactIds:c.children.map(f=>f.id),
    sourceLocation:location(source,c.start,c.end),
    sourceExcerpt:source.slice(source.lastIndexOf('\n',c.start-1)+1,source.indexOf('\n',c.end)===-1?source.length:source.indexOf('\n',c.end)).trim(),
    ...(c.children[0].sourceSectionPath===undefined?{}:{sourceSectionPath:c.children[0].sourceSectionPath}),
    allowedNormalizations:[],
  }));
  for(const fact of result) {
    if(fact.type==='release_version') fact.releaseStageEvidence=releaseStageEvidence(source,fact,result);
  }
  return result;
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
      if(fact.releaseStageEvidence!==undefined
        &&JSON.stringify(fact.releaseStageEvidence)!==JSON.stringify(releaseStageEvidence(source,fact,catalog.facts))) {
        fail('Release stage evidence changed');
      }
    }
  }
  return evidence;
}

function annotationOwners(source,catalog) {
  const evidence=assertTeamEvidenceFacts(source,catalog);
  return catalog.facts.filter(f=>f.sourceLocation&&(isEvidence(f)
    ||!evidence.some(parent=>inside(f.sourceLocation,parent.sourceLocation))));
}

module.exports={buildTeamEvidenceFacts,assertTeamEvidenceFacts,annotationOwners,releaseStageClaims,releaseStageEvidence};
