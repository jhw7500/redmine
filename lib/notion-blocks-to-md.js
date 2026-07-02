// Notion blocks → Markdown 직렬화 (순수 함수, I/O 없음).
// children이 필요한 블록(table/중첩 list 등)은 호출측이 block.__children 에 주입해 전달한다.

function richToMd(richArr) {
  if (!Array.isArray(richArr)) return "";
  return richArr
    .map((t) => {
      let s = t.plain_text != null ? t.plain_text : "";
      const a = t.annotations || {};
      if (a.code) s = "`" + s + "`";
      if (a.bold) s = "**" + s + "**";
      if (a.italic) s = "*" + s + "*";
      if (t.href) s = "[" + s + "](" + t.href + ")";
      return s;
    })
    .join("");
}

// 표 셀 내부 개행은 표 레이아웃을 깨므로 공백으로 치환한다.
function tableRowMd(cells) {
  return "| " + cells.map((c) => richToMd(c).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ") + " |";
}

function blocksToMd(blocks, indent) {
  indent = indent || "";
  const out = [];
  let numberCounter = 0;
  for (const b of blocks || []) {
    if (!b || !b.type) continue;
    const t = b.type;
    const data = b[t] || {};
    if (t !== "numbered_list_item") numberCounter = 0;
    let line;
    switch (t) {
      case "heading_1": line = "# " + richToMd(data.rich_text); break;
      case "heading_2": line = "## " + richToMd(data.rich_text); break;
      case "heading_3": line = "### " + richToMd(data.rich_text); break;
      case "paragraph": line = richToMd(data.rich_text); break;
      case "bulleted_list_item": line = "- " + richToMd(data.rich_text); break;
      case "numbered_list_item": line = ++numberCounter + ". " + richToMd(data.rich_text); break;
      case "quote": line = "> " + richToMd(data.rich_text); break;
      case "code":
        line = "```" + (data.language || "") + "\n" + richToMd(data.rich_text) + "\n```";
        break;
      case "divider": line = "---"; break;
      case "table": {
        const rows = (b.__children || []).filter((c) => c && c.type === "table_row");
        const tl = [];
        if (rows.length) {
          const cellsOf = (r) => (r && r.table_row && r.table_row.cells) || [];
          const first = cellsOf(rows[0]);
          tl.push(tableRowMd(first));
          tl.push("| " + first.map(() => "---").join(" | ") + " |");
          for (const r of rows.slice(1)) tl.push(tableRowMd(cellsOf(r)));
        }
        line = tl.join("\n");
        break;
      }
      default:
        line = "<!-- unsupported: " + t + " -->" + (data.rich_text ? "\n" + richToMd(data.rich_text) : "");
    }
    out.push(line.split("\n").map((l) => (l ? indent + l : l)).join("\n"));
    // 중첩 children (list item 하위 등)을 들여쓰기로 렌더 — table은 위에서 __children을 이미 소비.
    if (t !== "table" && b.__children && b.__children.length) {
      const child = blocksToMd(b.__children, indent + "  ").replace(/\n+$/, "");
      if (child) out.push(child);
    }
  }
  return out.join("\n\n") + (indent ? "" : "\n");
}

module.exports = { richToMd, blocksToMd };
