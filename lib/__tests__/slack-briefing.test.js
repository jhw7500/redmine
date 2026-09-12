const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildSlackBriefing}=require('../slack-briefing');

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
