const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildSlackBriefing}=require('../slack-briefing');
const {referenceLines}=require('../report-references');

test('mobile briefing keeps conditions and source prose while neutralizing Slack mentions',()=>{
  const record={id:'R0001',sectionId:'C0001',text:'[Notion] HD60 <@U123> <!channel>',
    context:[{text:'4채널 한정',continuations:[{text:'조건 변경 시 재검증'}]}],
    continuations:[{text:'↳ 검증: 59.6fps 실측'},{text:'↳ 주의: 효과는 통계적으로 미검증'}]};
  const records={sections:[{id:'C0001',path:['PIM','Application']}],records:[record]};
  const selection={sections:[{id:'C0001',groups:[{theme:'verification',items:[{id:'R0001',highlight:false}]}]}]};
  const preview=buildSlackBriefing({meetingDate:'2026-09-09',reportHash:'a'.repeat(64),records,selection});
  assert.equal(preview.sourceDepth,3);
  assert.equal(preview.replies.length,1);
  const reply=preview.replies[0];
  assert.match(reply.text,/4채널 한정[\s\S]*조건 변경 시 재검증/);
  assert.match(reply.text,/59.6fps 실측[\s\S]*통계적으로 미검증/);
  assert.ok(reply.blocks.every(block=>!block.fields));
  assert.ok(reply.blocks.every(block=>block.text.type==='plain_text'));
  assert.equal(reply.mrkdwn,false);
  assert.equal(reply.reply_broadcast,false);
  assert.equal(reply.unfurl_links,false);
});

test('long mobile detail is split without dropping text or breaking Unicode characters',()=>{
  const detail='주의: 특정 조건에만 적용. '.repeat(500)+'끝😀';
  const records={sections:[{id:'C1',path:['PIM']}],records:[{id:'R1',sectionId:'C1',text:'실측',context:[],continuations:[{text:detail}]}]};
  const selection={sections:[{id:'C1',groups:[{theme:'verification',items:[{id:'R1',highlight:false}]}]}]};
  const preview=buildSlackBriefing({meetingDate:'2026-09-09',reportHash:'a'.repeat(64),records,selection});
  assert.ok(preview.replies.length>1);
  const bodies=preview.replies.flatMap(message=>message.blocks.filter(block=>block.type==='section').map(block=>block.text.text));
  assert.equal(bodies.join(''),'실측\n\n'+detail);
  for(const message of preview.replies){
    assert.ok(message.text.length<=4000);
    for(const block of message.blocks) assert.ok(block.text.text.length<3000);
    assert.doesNotMatch(message.text,/[\uD800-\uDBFF]$/);
  }
});

test('mobile briefing follows the report renderer section order for a valid reversed selection',()=>{
  const records={
    sections:[{id:'C1',path:['First']},{id:'C2',path:['Second']}],
    records:[
      {id:'R1',sectionId:'C1',text:'first-item',context:[],continuations:[]},
      {id:'R2',sectionId:'C2',text:'second-item',context:[],continuations:[]},
    ],
  };
  const selection={sections:[
    {id:'C2',groups:[{theme:'implementation',items:[{id:'R2',highlight:false}]}]},
    {id:'C1',groups:[{theme:'implementation',items:[{id:'R1',highlight:false}]}]},
  ]};
  const preview=buildSlackBriefing({meetingDate:'2026-09-09',reportHash:'a'.repeat(64),records,selection});
  const bodies=preview.replies.map(entry=>entry.blocks[1].text.text);
  assert.deepEqual(bodies,['first-item','second-item']);
});

test('mobile references become explicit links on their own item, preserving source caveats and plain text',()=>{
  const references=[{label:'상세분석',url:'https://example.com/analysis',audience:'team'},
    {label:'운영안',url:'https://example.com/operations',audience:'team',version:'v3.5'}];
  const records={sections:[{id:'C1',path:['WLAN','Driver']}],records:[
    {id:'R1',sectionId:'C1',text:'Rate 제어 <@U123>',context:[],continuations:[
      {text:'↳ 조건: 수신 효과는 별도 검증 필요'},
      {kind:'report_reference',text:referenceLines({reportReferences:references},'')[0],references}]},
    {id:'R2',sectionId:'C1',text:'별도 작업',context:[],continuations:[]},
  ]};
  const before=JSON.stringify(records);
  const selection={sections:[{id:'C1',groups:[{theme:'verification',items:[{id:'R1',highlight:false},{id:'R2',highlight:false}]}]}]};
  const preview=buildSlackBriefing({meetingDate:'2026-09-09',reportHash:'a'.repeat(64),records,selection});
  assert.deepEqual(preview.replies[0].blocks.filter(b=>b.type==='rich_text').flatMap(b=>b.elements)
    .flatMap(section=>section.elements).filter(e=>e.type==='link').map(e=>[e.type,e.text,e.url]),[
    ['link','상세분석','https://example.com/analysis'],['link','운영안 (v3.5)','https://example.com/operations']]);
  assert.equal(preview.replies[1].blocks.some(b=>b.type==='rich_text'),false);
  assert.match(preview.replies[0].blocks[1].text.text,/수신 효과는 별도 검증 필요/);
  assert.doesNotMatch(preview.replies[0].blocks[1].text.text,/https:/,'phone body should not repeat long URLs');
  assert.match(preview.replies[0].text,/https:\/\/example.com\/analysis/,'notification fallback retains full links');
  assert.equal(preview.replies[0].mrkdwn,false);
  assert.equal(JSON.stringify(records),before);
});

test('mobile link metadata cannot disagree with its validated source continuation',()=>{
  const records={sections:[{id:'C1',path:['WLAN']}],records:[{id:'R1',sectionId:'C1',text:'Analysis',context:[],
    continuations:[{kind:'report_reference',text:'↳ 자료: [상세분석](https://example.com/original)',
      references:[{label:'상세분석',url:'https://example.com/changed',audience:'team'}]}]}]};
  assert.throws(()=>buildSlackBriefing({meetingDate:'2026-09-09',reportHash:'a'.repeat(64),records,
    selection:{sections:[{id:'C1',groups:[{items:[{id:'R1'}]}]}]}}),/reference/i);
});

test('many reference rows and a long explanation split without losing links or Unicode text',()=>{
  const references=Array.from({length:35},(_,i)=>({label:`상세자료 ${i}`,url:`https://example.com/doc/${i}`,audience:'team'}));
  const rows=referenceLines({reportReferences:references},'').map((text,i)=>({text,kind:'report_reference',references:references.slice(i*2,i*2+2)}));
  const detail='적용 조건과 한계를 보존한다. '.repeat(500)+'끝😀';
  const records={sections:[{id:'C1',path:['WLAN']}],records:[{id:'R1',sectionId:'C1',text:'분석',context:[],
    continuations:[{text:detail},...rows]}]};
  const preview=buildSlackBriefing({meetingDate:'2026-09-09',reportHash:'a'.repeat(64),records,
    selection:{sections:[{id:'C1',groups:[{items:[{id:'R1'}]}]}]}});
  const urls=preview.replies.flatMap(r=>r.blocks.filter(b=>b.type==='rich_text')).flatMap(b=>b.elements)
    .flatMap(s=>s.elements).filter(e=>e.type==='link').map(e=>e.url);
  assert.deepEqual(urls,references.map(r=>r.url));
  assert.equal(preview.replies.map(r=>r.blocks[1].text.text).join(''),'분석\n\n'+detail);
  assert.ok(preview.replies.every(r=>r.blocks.length<=3&&r.text.length<40000));
});
