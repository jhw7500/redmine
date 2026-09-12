// Presentation only. The original depth3 report and its evidence are never edited.
const {referenceLines,referenceLabel,safeReferenceUrl}=require('./report-references');
function chunks(text, limit = 2400) {
  const result=[];
  let current='';
  for(const character of text) {
    if(current.length+character.length>limit){result.push(current);current='';}
    current+=character;
  }
  if(current) result.push(current);
  return result;
}

function message(title, body) {
  return {text:title+'\n\n'+body,mrkdwn:false,parse:'none',link_names:false,
    unfurl_links:false,unfurl_media:false,reply_broadcast:false,
    blocks:[{type:'header',text:{type:'plain_text',text:title,emoji:false}},
      {type:'section',text:{type:'plain_text',text:body,emoji:false}}]};
}

function buildSlackBriefing({meetingDate,reportHash,records,selection}) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(meetingDate)||!/^[a-f0-9]{64}$/.test(reportHash)) {
    throw new Error('Mobile briefing requires a dated, hash-bound depth3 report');
  }
  const byId=new Map(records.records.map(record=>[record.id,record]));
  const selectedSections=new Map();
  for(const section of selection.sections) {
    if(selectedSections.has(section.id)||!records.sections.some(source=>source.id===section.id)) {
      throw new Error('Unknown or duplicate briefing section');
    }
    selectedSections.set(section.id,section);
  }
  const replies=[];
  const seen=new Set();
  let index=0;
  // The report renderer uses source-catalog section order, not model-returned section order.
  for(const sourceSection of records.sections) {
    const section=selectedSections.get(sourceSection.id);
    if(!section) continue;
    for(const group of section.groups) for(const item of group.items) {
      const record=byId.get(item.id);
      if(!record||record.sectionId!==section.id||seen.has(item.id)) throw new Error('Invalid briefing source item');
      seen.add(item.id);
      index++;
      const context=(record.context||[]).flatMap(parent=>[parent,...(parent.continuations||[])]);
      const details=[...context,...(record.continuations||[])];
      const linkRows=[];
      for(const line of details.filter(line=>line.kind==='report_reference')) {
        if(!Array.isArray(line.references)||!line.references.length||line.references.length>2
          ||referenceLines({reportReferences:line.references},'')[0]!==line.text) {
          throw new Error('Mobile reference metadata differs from its source continuation');
        }
        linkRows.push({text:line.text,elements:[{type:'text',text:'자료: '},
          ...line.references.flatMap((reference,index)=>[
            ...(index?[{type:'text',text:' · '}]:[]),
            {type:'link',text:referenceLabel(reference),
              url:safeReferenceUrl(reference.url)},
          ])]});
      }
      const body=[record.text,...details.filter(line=>line.kind!=='report_reference').map(line=>line.text)].join('\n\n');
      const parts=chunks(body);
      // At most two links per row; split large reference sets without hiding any.
      const partCount=Math.max(parts.length,Math.ceil(linkRows.length/8));
      // Only the section navigation is bounded; the full record title remains in body.
      const label=sourceSection.path.join(' / ');
      const navigation=Array.from(label).slice(0,45).join('');
      for(let part=0;part<partCount;part++) {
        const title=`${String(index).padStart(2,'0')}. ${navigation}${partCount>1?` (${part+1}/${partCount})`:''}`;
        const reply=message(title,parts[part]||'관련 상세자료');
        const rows=linkRows.slice(part*8,part*8+8);
        if(rows.length) {
          reply.blocks.push({type:'rich_text',elements:rows.map(row=>({type:'rich_text_section',elements:row.elements}))});
          reply.text+='\n\n'+rows.map(row=>row.text).join('\n');
        }
        replies.push(reply);
      }
    }
  }
  if(!replies.length) throw new Error('Mobile briefing has no source items');
  return {schemaVersion:1,sourceDepth:3,meetingDate,reportHash,itemCount:index,
    root:message(`${meetingDate} 주간보고 · 개인 상세본`,
      `${index}개 항목의 원문 상세를 스레드에 같은 순서로 모았습니다.\n수치·조건·검증 한계를 함께 확인하세요.\n원본 depth3 보고서는 별도로 보관됩니다.`),replies};
}

module.exports={buildSlackBriefing};
