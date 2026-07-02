// Notion blocks → Markdown 직렬화 (순수 함수, I/O 없음).
// children이 필요한 블록(table 등)은 호출측이 block.__children 에 주입해 전달한다.

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

function tableRowMd(cells) {
  return "| " + cells.map((c) => richToMd(c).replace(/\|/g, "\\|")).join(" | ") + " |";
}

function blocksToMd(blocks) {
  const out = [];
  let numberCounter = 0;
  for (const b of blocks || []) {
    const t = b.type;
    const data = b[t] || {};
    if (t !== "numbered_list_item") numberCounter = 0;
    switch (t) {
      case "heading_1": out.push("# " + richToMd(data.rich_text)); break;
      case "heading_2": out.push("## " + richToMd(data.rich_text)); break;
      case "heading_3": out.push("### " + richToMd(data.rich_text)); break;
      case "paragraph": out.push(richToMd(data.rich_text)); break;
      case "bulleted_list_item": out.push("- " + richToMd(data.rich_text)); break;
      case "numbered_list_item": out.push(++numberCounter + ". " + richToMd(data.rich_text)); break;
      case "quote": out.push("> " + richToMd(data.rich_text)); break;
      case "code":
        out.push("```" + (data.language || "") + "\n" + richToMd(data.rich_text) + "\n```");
        break;
      case "divider": out.push("---"); break;
      case "table": {
        const rows = (b.__children || []).filter((c) => c.type === "table_row");
        if (rows.length) {
          const cellsOf = (r) => (r.table_row.cells || []);
          out.push(tableRowMd(cellsOf(rows[0])));
          out.push("| " + cellsOf(rows[0]).map(() => "---").join(" | ") + " |");
          for (const r of rows.slice(1)) out.push(tableRowMd(cellsOf(r)));
        }
        break;
      }
      default:
        out.push("<!-- unsupported: " + t + " -->" + (data.rich_text ? "\n" + richToMd(data.rich_text) : ""));
    }
  }
  return out.join("\n\n") + "\n";
}

module.exports = { richToMd, blocksToMd };
