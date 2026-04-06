# Design: redmine-report 리팩토링

> 생성일: 2026-04-06
> 상태: Draft
> 선택 아키텍처: Option C — 실용적 균형 (3개 모듈)

## Context Anchor

| 축 | 내용 |
|----|------|
| WHY | 매주 반복되는 주간 보고 자동화 유지보수 비용 절감. 현재 3곳 수정 → 1곳으로 |
| WHO | 조현우 (1인 사용, 향후 다른 팀원 확장 가능성) |
| RISK | 기존 cron 동작 깨짐, Redmine API 호환성, AI 요약 파이프라인 손상 |
| SUCCESS | 신규 repo 추가 시 설정 파일 1곳만 수정, 기존 출력 결과와 동일 |
| SCOPE | 코드 구조 리팩토링 + 설정 외부화. Redmine API/AI 요약 로직 자체는 변경 최소화 |

---

## 1. Overview

기존 `update-jo-hyunwoo.api.js` (500줄+ 단일 파일)를 3개 모듈로 분리하고, 저장소/번역/분류 규칙을 외부 설정 파일로 추출한다.

### 1.1 선택된 아키텍처: Option C

```
index.js (엔트리포인트, ~100줄)
  ├── lib/config.js      (설정 통합 로드)
  ├── lib/collector.js   (Git 수집 + 분류 + 번역 + PR 보강)
  └── lib/publisher.js   (템플릿 렌더링 + AI 요약 + Redmine API)
```

**선택 근거**: 500줄 스크립트를 8개로 쪼개면 과도분리. 데이터 수집(collector)과 출력(publisher)이라는 자연스러운 경계로 2+1(config) 분리가 적절.

---

## 2. 파일 구조

### 2.1 최종 디렉토리 구조

```
projects/redmine/
├── index.js                    # 엔트리포인트 (워크플로 오케스트레이션)
├── lib/
│   ├── config.js               # 설정 통합 로드
│   ├── collector.js            # Git 수집 + 분류 + 번역 + PR 보강
│   └── publisher.js            # 템플릿 렌더링 + AI 요약 + Redmine API
├── repo-config.json            # 통합 설정 (확장)
├── translation-rules.json      # 번역 규칙 (NEW)
├── templates/
│   ├── jo-hyunwoo.md           # 기존 유지
│   ├── ai-en.md                # 기존 유지
│   └── ai-ko.md                # 기존 유지
├── .env                        # 시크릿만 (API키, 토큰)
├── run-generate-env.sh         # 수정 (index.js 호출)
├── run-update-env.sh           # 수정 (index.js 호출)
└── out/                        # 기존 유지
```

### 2.2 삭제 대상

| 파일 | 이유 |
|------|------|
| `update-jo-hyunwoo.js` | 레거시 Playwright 버전, 사용 안 함 |
| `update-jo-hyunwoo.api.js` | `index.js` + `lib/`로 대체 |
| `run-generate.sh` | 구 경로(codex/) 참조, `run-generate-env.sh`로 대체됨 |
| `run-update.sh` | 구 경로(codex/) 참조, `run-update-env.sh`로 대체됨 |

---

## 3. 설정 파일 설계

### 3.1 repo-config.json (확장)

기존 `repoMap` + `displayNames`를 유지하면서 `repos` 섹션 추가. 신규 저장소는 `repos`에만 추가하면 됨.

```json
{
  "repos": {
    "gstApp": {
      "path": "/home/jhw/ai/opencode/projects/gstApp",
      "category": "pimApp"
    },
    "streamApp": {
      "path": "/home/jhw/ai/opencode/projects/streamApp",
      "category": "pimApp"
    },
    "pim-package": {
      "path": "/home/jhw/ai/opencode/projects/pim-package",
      "category": "pimApp"
    },
    "ord": {
      "path": "/home/jhw/ai/opencode/projects/pim-package/ord",
      "category": "pimApp"
    },
    "vcm": {
      "path": "/home/jhw/ai/opencode/projects/pim-package/vcm",
      "category": "pimApp"
    },
    "vsd": {
      "path": "/home/jhw/ai/opencode/projects/pim-package/vsd",
      "category": "pimApp"
    },
    "max9296": {
      "path": "/home/jhw/ai/opencode/projects/max9296",
      "category": "pimDriver"
    },
    "sc16is7xx": {
      "path": "/home/jhw/ai/opencode/projects/sc16is7xx",
      "category": "pimDriver"
    },
    "wlan-package": {
      "path": "/home/jhw/ai/opencode/projects/wlan-package",
      "category": "wlanNxp"
    },
    "wlan-bridge": {
      "path": "/home/jhw/ai/opencode/projects/wlan-package/wlan-bridge",
      "category": "wlanNxp"
    },
    "wlan-driver": {
      "path": "/home/jhw/ai/opencode/projects/wlan-driver",
      "category": "wlanNxp"
    },
    "wpa-supplicant": {
      "path": "/home/jhw/ai/opencode/projects/wpa-supplicant",
      "category": "wlanNxp"
    },
    "automation": {
      "path": "/home/jhw/ai/opencode/projects/automation",
      "category": "etc",
      "displayName": "CI/CD 자동화"
    },
    "redmine": {
      "path": "/home/jhw/ai/opencode/projects/redmine",
      "category": "etc",
      "displayName": "Redmine 주간 보고 자동화"
    },
    "cts-ta-mcp-server": {
      "path": "/home/jhw/ai/opencode/projects/cts-ta-mcp-server",
      "category": "etc",
      "displayName": "HiWorks 근태 관리"
    },
    "cts-email-mcp-server": {
      "path": "/home/jhw/ai/opencode/projects/cts-email-mcp-server",
      "category": "etc",
      "displayName": "이메일 MCP 서버"
    }
  },
  "categories": {
    "pimApp": { "label": "Application", "parent": "PIM", "templateKey": "PIM_APPLICATION_KO" },
    "pimDriver": { "label": "Driver", "parent": "PIM", "templateKey": "PIM_DRIVER_KO" },
    "pimTest": { "label": "Test", "parent": "PIM", "templateKey": "PIM_TEST_KO" },
    "wlanNxp": { "label": "NXP", "parent": "Wireless Lan", "templateKey": "WIRELESS_NXP_KO" },
    "etc": { "label": null, "parent": "ETC", "templateKey": "ETC_KO" }
  },
  "commitTypes": {
    "feat": {
      "label": "추가",
      "conventionalPrefixes": ["feat"],
      "linePatterns": ["^(add|추가|신규|새로|implement|create)\\b"]
    },
    "fix": {
      "label": "수정",
      "conventionalPrefixes": ["fix"],
      "linePatterns": ["^(fix|수정|버그|bug|patch|hotfix)\\b"]
    },
    "improve": {
      "label": "개선",
      "conventionalPrefixes": ["improve", "perf"],
      "linePatterns": ["^(improve|개선|enhance|optimize|안정화|강화)\\b"]
    },
    "refactor": {
      "label": "리팩토링",
      "conventionalPrefixes": ["refactor"],
      "linePatterns": []
    },
    "docs": {
      "label": "문서",
      "conventionalPrefixes": ["docs"],
      "linePatterns": []
    }
  },
  "trivialPatterns": [
    "^(log|gitignore|__pycache__|chore|merge branch|Merge branch|docs\\/plans|\\.gitignore)",
    "^(Address\\s+)?PR\\s*#\\d+\\s*(코드\\s*리뷰\\s*(반영|피드백)|review\\s*feedback)\\s*$",
    "^코드\\s*리뷰\\s*(반영|추가\\s*수정|잔여\\s*항목|피드백)\\s*$",
    "^(code\\s*review\\s*(feedback|fix|update)|review\\s*feedback)\\s*$",
    "^fix\\([^)]*\\):\\s*코드\\s*리뷰",
    "^release:\\s*v?\\d",
    "^(update|bump)\\s+submodule"
  ],
  "defaults": {
    "baseUrl": "http://192.168.10.2:30002",
    "projectId": "team-4-weekly-meeting",
    "pageSuffix": "개발4팀_주간_회의",
    "sectionHeader": "#### <span style=\"color:blue\">조현우</span>",
    "outputDir": "out",
    "githubOwner": "jhw7500",
    "claudeCli": "claude"
  }
}
```

**설계 포인트**:
- `repos` 하나만 수정하면 저장소 추가 완료 (R1 충족)
- `categories`에 `templateKey`를 넣어 템플릿 플레이스홀더와 자동 연결
- `commitTypes`에 conventional prefix + 라인 패턴을 분리하여 `detectCommitType()` 외부화 (S3 충족)
- `trivialPatterns`로 `isTrivialCommit()` 외부화 (S4 충족)
- `defaults`에 기존 환경변수 기본값 통합 (`.env`에서 오버라이드 가능)

### 3.2 translation-rules.json

기존 `translateLine()` 함수의 ~50개 regex 규칙을 JSON 배열로 추출.

```json
[
  {
    "pattern": "Address code review feedback for PR #(\\d+)",
    "flags": "i",
    "replacement": "PR #$1 코드 리뷰 피드백 반영"
  },
  {
    "pattern": "Update (.+)",
    "flags": "i",
    "replacement": "$1 업데이트"
  },
  {
    "pattern": "\\bworkflow(s)?\\b",
    "flags": "i",
    "replacement": "workflow"
  }
]
```

**규칙**:
- 배열 순서가 우선순위 (먼저 매치된 규칙이 적용, 기존 코드와 동일)
- `pattern`은 JSON string으로 저장, 런타임에 `new RegExp(pattern, flags)`로 컴파일
- 규칙 추가/수정 = 이 파일만 편집 (R2 충족)

---

## 4. 모듈 설계

### 4.1 lib/config.js (~60줄)

**책임**: 설정 파일 로드 + 환경변수 머지 + 번역 규칙 컴파일

```
exports:
  loadConfig() → {
    repos: Map<name, {path, category, displayName?}>,
    categories: Map<key, {label, parent, templateKey}>,
    commitTypes: Map<type, {label, conventionalPrefixes, linePatterns: RegExp[]}>,
    trivialPatterns: RegExp[],
    translationRules: {pattern: RegExp, replacement: string}[],
    defaults: {...},
    // 환경변수 오버라이드 적용된 최종 설정
    env: {
      apiKey, githubToken, aiSummarize, mode, meetingDate,
      baseUrl, projectId, pageSuffix, sectionHeader, outputDir,
      githubOwner, claudeCli, autoApprove
    }
  }
```

**로직**:
1. `repo-config.json` 로드 (`__dirname` 기반 절대 경로)
2. `translation-rules.json` 로드 → `new RegExp()` 컴파일
3. `commitTypes[].linePatterns` → `new RegExp()` 컴파일
4. `trivialPatterns` → `new RegExp()` 컴파일
5. `process.env`로 `defaults` 오버라이드
6. 유효성 검사: `apiKey` 필수, `repos` 비어있지 않은지

**기존 함수 매핑**:
| 기존 (update-jo-hyunwoo.api.js) | config.js |
|---|---|
| `loadRepoConfig()` | `loadConfig()` 내부 |
| `loadRepoMap()` | `config.repos`에서 추출 |
| `loadDisplayNames()` | `config.repos`에서 `displayName` 추출 |
| 최상단 환경변수 선언 (~30줄) | `config.env` |

### 4.2 lib/collector.js (~180줄)

**책임**: Git 커밋 수집 → 필터링 → 분류 → 번역 → PR 보강 → 카테고리별 그룹 반환

```
exports:
  collectAll(config, startDate, endDate) → {
    // templateKey → 포맷된 마크다운 문자열
    "PIM_APPLICATION_KO": "    - 추가\n      - ...",
    "PIM_DRIVER_KO": "    - ...",
    "WIRELESS_NXP_KO": "    - ...",
    "ETC_KO": "  - CI/CD 자동화\n    - ..."
  }
```

**내부 함수 (기존 코드에서 이동)**:

| 기존 함수 | 변경 사항 |
|-----------|-----------|
| `getGitCommits(repoPath, since, until)` | 그대로 이동 |
| `isTrivialCommit(line)` | `config.trivialPatterns` 사용으로 변경 |
| `detectCommitType(line)` | `config.commitTypes` 사용으로 변경 |
| `normalizeForDedup(line)` | 그대로 이동 |
| `stripReferences(line)` | 그대로 이동 |
| `stripTypePrefix(line)` | 그대로 이동 |
| `translateLine(line)` | `config.translationRules` 사용으로 변경 |
| `groupByType(lines)` | 그대로 이동 |
| `formatGrouped(typeGroups, indent)` | 그대로 이동 |
| `groupByDisplayName(lines, displayNames)` | 그대로 이동 |
| `formatEtcGrouped(lines, displayNames)` | 그대로 이동 |
| `summarizeLines(lines)` | 그대로 이동 |
| `summarizeWorkflows(lines)` | 그대로 이동 |
| `fetchPrInfo(repo, number, cache)` | 그대로 이동 |
| `enrichPrSummaries(lines, repo, cache)` | 그대로 이동 |
| `koreanizePrLine(text)` | 그대로 이동 |
| `shortSentence()`, `summarizeKorean()` | 그대로 이동 |
| `firstBodyLine()`, `extractHighlightsLines()` 등 PR 파싱 | 그대로 이동 |
| `buildAutoContent(startDate, endDate)` | `collectAll()`로 리네임, config 주입 |

**핵심 변경**: `isTrivialCommit`, `detectCommitType`, `translateLine` 3개 함수만 하드코딩 → config 참조로 변경. 나머지는 그대로 이동.

### 4.3 lib/publisher.js (~150줄)

**책임**: 템플릿 렌더링 + AI 요약 + Redmine Wiki API CRUD

```
exports:
  generate(config, meetingDate, autoContent) → outputPath
  update(config, meetingDate, autoContent) → void
```

**내부 함수 (기존 코드에서 이동)**:

| 기존 함수 | 변경 사항 |
|-----------|-----------|
| `buildContent(meetingDate)` | `config.env` 사용, `autoContent` 인자로 받음 |
| `aiSummarize(rawContent)` | `config.env.claudeCli`, `config.env.aiSummarize` 사용 |
| `replaceSection(body, newSection)` | `config.env.sectionHeader` 사용 |
| `extractSection(body)` | `config.env.sectionHeader` 사용 |
| `fetchJson(url, options)` | `config.env.apiKey` 사용 |
| `buildWikiUrl(meetingDate)` | `config.env` 사용 |
| `buildOutputPath(meetingDate)` | `config.env.outputDir` 사용 |
| `formatDate(date)`, `targetWednesday(date)` | 그대로 이동 |
| `extractTitleFromUrl()`, `extractProjectIdFromUrl()` | 그대로 이동 |
| `parseMeetingDateFromTitle()` | 그대로 이동 |
| `ensureDir()` | 그대로 이동 |
| `promptYesNo(question)` | 그대로 이동 |
| `formatBulletsFromFile()` | 그대로 이동 |

### 4.4 index.js (~80줄)

**책임**: 워크플로 오케스트레이션만

```javascript
// index.js 의사코드
const { loadConfig } = require("./lib/config");
const { collectAll } = require("./lib/collector");
const { generate, update } = require("./lib/publisher");

async function main() {
  const config = loadConfig();
  const meetingDate = resolveMeetingDate(config);
  const { startDate, endDate } = dateRange(meetingDate);

  // 1. 커밋 수집 + 분류
  const autoContent = await collectAll(config, startDate, endDate);

  // 2. 모드별 실행
  if (config.env.mode === "generate") {
    const outputPath = await generate(config, meetingDate, autoContent);
    console.log(`Generated: ${outputPath}`);
  } else if (config.env.mode === "update") {
    await update(config, meetingDate, autoContent);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
```

---

## 5. 데이터 흐름

```
repo-config.json ─┐
translation-rules.json ─┤
.env ─────────────────┤
                      ▼
              [config.js: loadConfig()]
                      │
                      ▼ config 객체
              [index.js: main()]
                      │
          ┌───────────┼───────────┐
          ▼           │           ▼
   날짜 계산         │    모드 분기
          │           │    (generate/update)
          ▼           │           │
   [collector.js]     │           │
     Git log 수집     │           │
     필터/분류/번역   │           │
     PR 보강          │           │
          │           │           │
          ▼           │           ▼
   autoContent ───────┼──→ [publisher.js]
   (카테고리별        │    템플릿 렌더링
    마크다운)         │    AI 요약 (옵션)
                      │    파일 출력 or
                      │    Redmine API 업데이트
```

---

## 6. 마이그레이션 전략

### 6.1 단계별 전환 (안전 우선)

| 순서 | 작업 | 검증 |
|------|------|------|
| 0 | **기준 스냅샷** — 현재 코드로 `MODE=generate` 실행하여 `out/` 결과 백업 | `cp out/jo-hyunwoo-2026-04-01.md out/jo-hyunwoo-2026-04-01.baseline.md` |
| 1 | `repo-config.json` 확장 — `repos` 섹션 추가 (기존 repoMap/displayNames는 유지) | JSON 파싱 에러 없음 |
| 2 | `translation-rules.json` 추출 — 기존 코드의 rules 배열을 JSON으로 내보내기 | regex 컴파일 성공 |
| 3 | `lib/config.js` 작성 — 설정 로드 + 컴파일 | 단독 실행으로 config 객체 출력 확인 |
| 4 | `lib/collector.js` 작성 — 기존 함수 이동 + config 주입 | 동일 기간 collectAll() 결과 비교 |
| 5 | `lib/publisher.js` 작성 — 기존 함수 이동 + config 주입 | generate 모드 출력 비교 |
| 6 | `index.js` 작성 — 오케스트레이션 | **전체 출력 diff = 0** (SC3) |
| 7 | `run-*-env.sh` 수정 — `node index.js` 호출로 변경 | cron 시뮬레이션 성공 |
| 8 | 레거시 삭제 — `update-jo-hyunwoo.js`, `update-jo-hyunwoo.api.js`, `run-generate.sh`, `run-update.sh` | git rm |

### 6.2 롤백 계획

- 단계 6까지 기존 `update-jo-hyunwoo.api.js`를 삭제하지 않음 (병행 운영)
- 출력 diff 확인 전까지 레거시 파일 유지
- `run-*-env.sh`는 마지막에 변경 (가장 쉽게 롤백 가능)

---

## 7. .env 변경

### 7.1 before (현재)

```bash
REDMINE_API_KEY="..."
GITHUB_TOKEN="..."
AI_SUMMARIZE=1
REPO_LIST=/home/jhw/ai/opencode/projects/gstApp,/home/jhw/.../max9296,...(긴 목록)
OUTPUT_DIR=/home/jhw/ai/opencode/projects/redmine/out
TEMPLATE_PATH=/home/jhw/ai/opencode/projects/redmine/templates/jo-hyunwoo.md
AI_EN_PATH=/home/jhw/ai/opencode/projects/redmine/templates/ai-en.md
AI_KO_PATH=/home/jhw/ai/opencode/projects/redmine/templates/ai-ko.md
```

### 7.2 after (리팩토링 후)

```bash
REDMINE_API_KEY="..."
GITHUB_TOKEN="..."
AI_SUMMARIZE=1
# REPO_LIST 삭제 — repo-config.json의 repos 섹션에서 관리
# OUTPUT_DIR, TEMPLATE_PATH, AI_*_PATH 삭제 — repo-config.json defaults + __dirname 기반
# 필요 시 오버라이드 가능 (선택적):
# MEETING_DATE=2026-04-09
# MODE=update
```

---

## 8. 테스트 계획

| # | 테스트 | 방법 | 성공 기준 |
|---|--------|------|-----------|
| T1 | 설정 로드 | `node -e "const c = require('./lib/config'); console.log(c.loadConfig())"` | 에러 없이 config 객체 출력 |
| T2 | 번역 규칙 컴파일 | config 로드 시 모든 regex 컴파일 성공 | 예외 없음 |
| T3 | 커밋 수집 | `collectAll()` 호출 후 기존 `buildAutoContent()` 결과와 비교 | 동일 |
| T4 | 전체 출력 동일성 | `MODE=generate node index.js` → `diff out/jo-hyunwoo-*.md out/jo-hyunwoo-*.baseline.md` | diff = 0 (SC3) |
| T5 | cron 호환 | `env -i PATH=... bash run-generate-env.sh` (최소 환경) | 정상 실행 |
| T6 | 신규 repo 추가 | `repo-config.json`에 테스트 repo 추가 후 실행 | 해당 카테고리에 커밋 표시 (SC1) |
| T7 | 번역 규칙 추가 | `translation-rules.json`에 규칙 추가 후 실행 | 코드 무수정으로 반영 (SC2) |

---

## 9. 기존 함수 → 모듈 매핑 요약

| 기존 위치 (update-jo-hyunwoo.api.js) | 이동 대상 | 변경 수준 |
|------|------|------|
| 환경변수 선언 (L1-L34) | `lib/config.js` | 재작성 |
| `loadRepoConfig/Map/DisplayNames` (L36-L49) | `lib/config.js` | 통합 |
| `isTrivialCommit` (L229-L242) | `lib/collector.js` | config 참조로 변경 |
| `detectCommitType` (L254-L263) | `lib/collector.js` | config 참조로 변경 |
| `translateLine` (L345-L428) | `lib/collector.js` | config 참조로 변경 |
| `getGitCommits` (L204-L222) | `lib/collector.js` | 그대로 |
| `normalizeForDedup`, `stripReferences`, `stripTypePrefix` | `lib/collector.js` | 그대로 |
| `groupByType`, `formatGrouped`, `formatEtcGrouped` | `lib/collector.js` | 그대로 |
| `fetchPrInfo`, `enrichPrSummaries`, PR 파싱 함수들 | `lib/collector.js` | 그대로 |
| `summarizeLines`, `summarizeWorkflows`, `koreanizePrLine` | `lib/collector.js` | 그대로 |
| `buildAutoContent` (L780-L847) | `lib/collector.js` → `collectAll()` | config 주입 |
| `buildContent` (L146-L166) | `lib/publisher.js` | config 주입 |
| `aiSummarize` (L58-L103) | `lib/publisher.js` | config 주입 |
| `replaceSection`, `extractSection` (L849-L885) | `lib/publisher.js` | config 주입 |
| `fetchJson` (L887-L909) | `lib/publisher.js` | config 주입 |
| `buildWikiUrl`, `buildOutputPath` | `lib/publisher.js` | config 주입 |
| `formatDate`, `targetWednesday` | `lib/publisher.js` | 그대로 |
| URL 파싱, `promptYesNo`, `ensureDir` | `lib/publisher.js` | 그대로 |
| `main()` (L911-끝) | `index.js` | 재작성 (오케스트레이션만) |

---

## 10. 제약 사항

- Node 18+ 필수 (built-in fetch 사용, 기존과 동일)
- `__dirname` 기반 경로 해석 (ESM 전환 없음, CommonJS 유지)
- `spawnSync` 사용 (AI 요약의 Claude CLI 호출, 기존과 동일)

---

## 11. Implementation Guide

### 11.1 구현 순서

| # | 모듈 | 파일 | 의존성 | 예상 줄 수 |
|---|------|------|--------|-----------|
| 1 | 설정 파일 | `repo-config.json` 확장, `translation-rules.json` 생성 | 없음 | JSON |
| 2 | config | `lib/config.js` | 1 | ~60줄 |
| 3 | collector | `lib/collector.js` | 2 | ~180줄 |
| 4 | publisher | `lib/publisher.js` | 2 | ~150줄 |
| 5 | 엔트리포인트 | `index.js` | 2,3,4 | ~80줄 |
| 6 | 셸 스크립트 | `run-*-env.sh` 수정 | 5 | ~2줄 변경 |
| 7 | 검증 + 정리 | 출력 diff, 레거시 삭제 | 6 | - |

### 11.2 핵심 구현 주의사항

1. **`translateLine` 변환**: 기존 코드는 rules 배열을 순회하며 **첫 매치만 적용하는 것이 아니라 모든 규칙을 순차 적용** (line을 누적 변환). JSON 로드 시 이 동작을 정확히 보존해야 함.

2. **`isTrivialCommit` 변환**: 기존은 하나라도 매치되면 `true` 반환. `config.trivialPatterns.some(re => re.test(line))` 형태로 변환.

3. **`detectCommitType` 변환**: conventional commit prefix 매칭 → linePatterns 매칭 → 기본값 "etc" 순서를 유지.

4. **ETC 카테고리 특수 처리**: `etc` 카테고리는 `[repoName] commitMsg` 형식으로 저장되고, `formatEtcGrouped`에서 `displayName`별로 2차 그룹핑됨. 이 흐름 보존 필수.

5. **PR enrichment의 비동기 처리**: `fetchPrInfo`는 `async`이고 `enrichPrSummaries`에서 순차 호출됨. `collectAll`도 `async`로 유지.

### 11.3 Session Guide

| 세션 | 모듈 | scope key | 예상 작업 |
|------|------|-----------|-----------|
| 세션 1 | 설정 파일 + config | `module-1` | repo-config.json 확장, translation-rules.json 추출, lib/config.js |
| 세션 2 | collector | `module-2` | lib/collector.js (기존 함수 이동 + config 주입) |
| 세션 3 | publisher + index + 검증 | `module-3` | lib/publisher.js, index.js, 출력 diff, 셸 스크립트, 레거시 정리 |
