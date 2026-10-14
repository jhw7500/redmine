const {warnDepthShape}=require('./publisher');

const HANGUL=/[ᄀ-ᇿ㄰-㆏가-힣]/;
const MAX_BULLET_LEVEL=4;

// Language and structure block the summary (issue #130); volume is advisory only (issue #57).
function evaluateSummaryQuality(content,config) {
  const headings=new Map();
  for(const category of Object.values(config.categories||{})) {
    if(!headings.has(category.parent)) headings.set(category.parent,new Set());
    if(category.label) headings.get(category.parent).add(category.label);
  }
  const blocking=[];
  const perSubcategory={};
  const indents=[];
  let contentBullets=0;
  let canonicalHeadings=0;
  let parent=null;
  let subcategory=null;
  // HTML comments are never rendered; blank them out, keeping newlines so line numbers stay stable.
  const rendered=String(content).replace(/<!--[\s\S]*?-->/g,comment=>comment.replace(/[^\n]/g,''));
  rendered.split('\n').forEach((line,index)=>{
    const text=line.trim();
    if(!text||text===config.env.sectionHeader||/^\*작성:.*\*$/.test(text)||/^-{3,}$/.test(text)) return;
    const bullet=line.match(/^(\s*)[-*+]\s+(.*)$/);
    if(bullet) {
      while(indents.length&&indents.at(-1)>=bullet[1].length) indents.pop();
      indents.push(bullet[1].length);
      const item=bullet[2].trim();
      if(indents.length===1) {
        parent=headings.has(item)?item:null;
        subcategory=parent&&!headings.get(parent).size?parent:null;
        if(parent) {
          canonicalHeadings++;
          return;
        }
      }
      if(indents.length===2&&parent&&headings.get(parent).has(item)) {
        subcategory=`${parent} > ${item}`;
        return;
      }
      contentBullets++;
      if(subcategory) perSubcategory[subcategory]=(perSubcategory[subcategory]||0)+1;
      if(indents.length>MAX_BULLET_LEVEL) blocking.push({code:'bullet_too_deep',line:index+1});
    }
    // Only rendered text counts: tags and their attributes, image alt text, link targets and wiki-link
    // targets are hidden, and a short leading label such as "변경:" or "↳ 목적:" is Korean even when
    // its content is not.
    const body=text.replace(/^[-*+]\s+/,'')
      .replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\]\([^)]*\)/g,']')
      .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g,'$1').replace(/<[^>]*>/g,'')
      .replace(/^(?:↳\s*)?[^:：]{1,20}[:：]\s*/,'');
    if(!HANGUL.test(body)) blocking.push({code:'non_korean_line',line:index+1});
  });
  if(!canonicalHeadings) blocking.push({code:'missing_canonical_heading'});
  if(!contentBullets) blocking.push({code:'no_content_bullets'});
  const shape=warnDepthShape(content,config,()=>{});
  const busiest=Object.entries(perSubcategory).sort((left,right)=>right[1]-left[1])[0];
  return {blocking,advisory:{totalBullets:shape.bulletCount,contentBullets,
    advisoryMaxBullets:shape.advisoryMaxBullets,exceedsAdvisoryMax:shape.exceeded,
    maxBulletsPerSubcategory:busiest?{subcategory:busiest[0],bullets:busiest[1]}:null}};
}

module.exports={evaluateSummaryQuality};
