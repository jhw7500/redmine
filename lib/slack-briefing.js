// Presentation only. The original depth3 report and its evidence are never edited.
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
      const context=(record.context||[]).flatMap(parent=>[parent.text,...(parent.continuations||[]).map(line=>line.text)]);
      const body=[record.text,...context,...(record.continuations||[]).map(line=>line.text)].join('\n\n');
      const parts=chunks(body);
      // Only the section navigation is bounded; the full record title remains in body.
      const label=sourceSection.path.join(' / ');
      const navigation=Array.from(label).slice(0,45).join('');
      for(let part=0;part<parts.length;part++) {
        const title=`${String(index).padStart(2,'0')}. ${navigation}${parts.length>1?` (${part+1}/${parts.length})`:''}`;
        replies.push(message(title,parts[part]));
      }
    }
  }
  if(!replies.length) throw new Error('Mobile briefing has no source items');
  return {schemaVersion:1,sourceDepth:3,meetingDate,reportHash,itemCount:index,
    root:message(`${meetingDate} 주간보고 · 개인 상세본`,
      `${index}개 항목의 원문 상세를 스레드에 같은 순서로 모았습니다.\n수치·조건·검증 한계를 함께 확인하세요.\n원본 depth3 보고서는 별도로 보관됩니다.`),replies};
}

module.exports={buildSlackBriefing};
