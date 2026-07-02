const { test } = require("node:test");
const assert = require("node:assert");
const { richToMd, blocksToMd } = require("../notion-blocks-to-md");

test("richToMd: plain/bold/code/link", () => {
  const rich = [
    { plain_text: "a ", annotations: {}, href: null },
    { plain_text: "bold", annotations: { bold: true }, href: null },
    { plain_text: " ", annotations: {}, href: null },
    { plain_text: "code", annotations: { code: true }, href: null },
    { plain_text: " ", annotations: {}, href: null },
    { plain_text: "link", annotations: {}, href: "http://x" },
  ];
  assert.strictEqual(richToMd(rich), "a **bold** `code` [link](http://x)");
});

test("blocksToMd: heading/para/list/code", () => {
  const blocks = [
    { type: "heading_2", heading_2: { rich_text: [{ plain_text: "제목", annotations: {} }] } },
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "본문", annotations: {} }] } },
    { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "항목", annotations: {} }] } },
    { type: "code", code: { language: "bash", rich_text: [{ plain_text: "iw reg get", annotations: {} }] } },
    { type: "divider", divider: {} },
  ];
  const md = blocksToMd(blocks);
  assert.match(md, /## 제목/);
  assert.match(md, /\n본문\n/);
  assert.match(md, /- 항목/);
  assert.match(md, /```bash\niw reg get\n```/);
  assert.match(md, /\n---\n/);
});

test("blocksToMd: table with header row", () => {
  const row = (a, b) => ({ type: "table_row", table_row: { cells: [[{ plain_text: a, annotations: {} }], [{ plain_text: b, annotations: {} }]] } });
  const blocks = [{ type: "table", table: {}, __children: [row("k", "v"), row("1", "2")] }];
  const md = blocksToMd(blocks);
  assert.match(md, /\| k \| v \|/);
  assert.match(md, /\| --- \| --- \|/);
  assert.match(md, /\| 1 \| 2 \|/);
});

test("blocksToMd: unsupported fallback", () => {
  const md = blocksToMd([{ type: "callout", callout: { rich_text: [{ plain_text: "hi", annotations: {} }] } }]);
  assert.match(md, /<!-- unsupported: callout -->/);
});
