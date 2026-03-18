const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");

const BASE_URL = process.env.REDMINE_BASE_URL || "http://192.168.10.2:30002";
const WIKI_INDEX_URL = `${BASE_URL}/projects/team-4-weekly-meeting/wiki`;
const USER = process.env.REDMINE_USER;
const PASS = process.env.REDMINE_PASS;
const TEMPLATE_PATH =
  process.env.TEMPLATE_PATH || path.join(__dirname, "templates", "jo-hyunwoo.md");
const SECTION_EDIT_URL = process.env.SECTION_EDIT_URL || "";
const MEETING_DATE_OVERRIDE = process.env.MEETING_DATE || ""; // YYYY-MM-DD

if (!USER || !PASS) {
  console.error("Missing REDMINE_USER or REDMINE_PASS.");
  process.exit(1);
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function nextWednesday(fromDate) {
  const day = fromDate.getDay(); // 0=Sun
  const target = 3; // Wed
  let diff = (target - day + 7) % 7;
  if (diff === 0) diff = 7; // "next" Wednesday
  const d = new Date(fromDate);
  d.setDate(d.getDate() + diff);
  return d;
}

async function promptYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function buildContent(meetingDate) {
  const start = new Date(meetingDate);
  start.setDate(start.getDate() - 7);
  const replacements = {
    "{{START_DATE}}": formatDate(start),
    "{{END_DATE}}": formatDate(meetingDate),
  };

  let content = fs.readFileSync(TEMPLATE_PATH, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    content = content.split(key).join(value);
  }
  return content.trimEnd() + "\n";
}

async function main() {
  const meetingDate = MEETING_DATE_OVERRIDE
    ? new Date(`${MEETING_DATE_OVERRIDE}T00:00:00`)
    : nextWednesday(new Date());
  const meetingDateStr = formatDate(meetingDate);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Login
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="username"]', USER);
  await page.fill('input[name="password"]', PASS);
  await page.click('input[name="login"]');
  await page.waitForLoadState("networkidle");

  let editUrl = SECTION_EDIT_URL;

  if (!editUrl) {
    // Open wiki list and find the meeting page for the target date
    await page.goto(WIKI_INDEX_URL, { waitUntil: "domcontentloaded" });

    const meetingLink = page.locator(`a:has-text("${meetingDateStr}")`).first();
    if ((await meetingLink.count()) > 0) {
      await meetingLink.click();
      await page.waitForLoadState("domcontentloaded");
    } else {
      const fallbackSlug = encodeURIComponent(`${meetingDateStr}_개발4팀_주간_회의`);
      await page.goto(`${WIKI_INDEX_URL}/${fallbackSlug}`, { waitUntil: "domcontentloaded" });
    }

    editUrl = await page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).find(
        (h) => h.textContent && h.textContent.includes("조현우")
      );
      if (!heading) return "";
      const direct = heading.querySelector('a[href*="edit?section="]');
      if (direct) return direct.href;
      const parent = heading.parentElement;
      if (parent) {
        const parentLink = parent.querySelector('a[href*="edit?section="]');
        if (parentLink) return parentLink.href;
      }
      return "";
    });
  }

  if (!editUrl) {
    console.error("Could not find edit URL for the 조현우 section.");
    await browser.close();
    process.exit(1);
  }

  // Go to section edit page
  await page.goto(editUrl, { waitUntil: "domcontentloaded" });

  const textarea = page.locator('textarea[name="content"]');
  const original = await textarea.inputValue();
  const updated = buildContent(meetingDate);

  console.log("--- current ---\n" + original);
  console.log("--- updated ---\n" + updated);

  if (original.trim() === updated.trim()) {
    console.log("No changes detected; skipping update.");
    await browser.close();
    return;
  }

  const ok = await promptYesNo("Apply update? (y/N) ");
  if (!ok) {
    console.log("Cancelled.");
    await browser.close();
    return;
  }

  await textarea.fill(updated);
  await page.fill('input[name="comments"]', "자동 업데이트");
  await page.click('input[name="commit"]');
  await page.waitForLoadState("networkidle");

  await browser.close();
  console.log("Update complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
