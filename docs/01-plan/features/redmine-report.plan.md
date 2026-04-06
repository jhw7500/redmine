# Plan: redmine-report 리팩토링

> 생성일: 2026-04-06
> 상태: Draft
> 작성: Claude Code | 승인 대기

## Executive Summary

| 항목 | 내용 |
|------|------|
| Feature | Redmine 주간 보고 자동화 — 설정 기반 구조로 리팩토링 |
| 기간 | 2026-04-06 ~ |
| 예상 규모 | 중간 (기존 500줄+ 단일 파일 → 모듈 분리 + 설정 외부화) |

| 관점 | 내용 |
|------|------|
| Problem | 신규 저장소 추가 시 .env, repo-config.json, JS 코드 내 번역 규칙 3곳을 수동 수정해야 함. 번역 규칙 ~50개가 코드에 하드코딩되어 유지보수 어려움 |
| Solution | 저장소/카테고리/번역 규칙을 단일 설정 파일로 통합하고, 메인 스크립트를 기능 단위 모듈로 분리 |
| Function UX Effect | 새 저장소 추가 = 설정 파일 1곳 수정만으로 완료. 번역 규칙도 JSON/YAML로 관리 |
| Core Value | 비개발자도 설정만으로 보고 대상 저장소와 번역 규칙을 관리할 수 있는 구조 |

## Context Anchor

| 축 | 내용 |
|----|------|
| WHY | 매주 반복되는 주간 보고 자동화 유지보수 비용 절감. 현재 3곳 수정 → 1곳으로 |
| WHO | 조현우 (1인 사용, 향후 다른 팀원 확장 가능성) |
| RISK | 기존 cron 동작 깨짐, Redmine API 호환성, AI 요약 파이프라인 손상 |
| SUCCESS | 신규 repo 추가 시 설정 파일 1곳만 수정, 기존 출력 결과와 동일 |
| SCOPE | 코드 구조 리팩토링 + 설정 외부화. Redmine API/AI 요약 로직 자체는 변경 최소화 |

---

## 1. 현황 분석

### 1.1 현재 파일 구조

```
projects/redmine/
├── update-jo-hyunwoo.api.js    # 메인 스크립트 (500줄+, 모든 로직 포함)
├── update-jo-hyunwoo.js        # 레거시 Playwright 버전 (사용 안 함)
├── repo-config.json            # 저장소→카테고리 매핑 + 표시명
├── .env                        # API키, REPO_LIST, 경로 설정
├── templates/
│   ├── jo-hyunwoo.md           # 위키 섹션 템플릿
│   ├── ai-en.md                # AI 요약용 영문 노트
│   └── ai-ko.md                # AI 요약용 한글 노트
├── run-generate-env.sh         # .env 로드 + generate 모드 실행
├── run-update-env.sh           # .env 로드 + update 모드 실행
├── run-generate.sh             # 레거시 경로 사용 (codex/)
├── run-update.sh               # 레거시 경로 사용 (codex/)
└── out/                        # 생성 결과물
```

### 1.2 현재 문제점

| # | 문제 | 영향 | 심각도 |
|---|------|------|--------|
| P1 | **번역 규칙 하드코딩** — ~50개 regex가 `translateLine()` 함수 안에 있음 | 새 규칙 추가 시 JS 코드 수정 필요 | High |
| P2 | **저장소 등록 3곳 분산** — `.env` REPO_LIST + `repo-config.json` repoMap + displayNames | 신규 repo 추가 시 3곳 동기화 필요, 누락 위험 | High |
| P3 | **단일 파일 500줄+** — Git 수집, 번역, PR 조회, AI 요약, Redmine API 모두 한 파일 | 가독성/테스트 어려움 | Medium |
| P4 | **레거시 파일 잔존** — `update-jo-hyunwoo.js` (Playwright), `run-generate.sh`, `run-update.sh`가 구 경로(`codex/`) 참조 | 혼란 유발 | Low |
| P5 | **커밋 타입 분류 규칙 하드코딩** — `detectCommitType()`, `isTrivialCommit()` 규칙이 코드 내장 | 분류 기준 변경 시 코드 수정 필요 | Medium |

### 1.3 잘 동작하는 부분 (유지 대상)

- Redmine REST API 기반 섹션 교체 로직 (안정적)
- GitHub PR 제목/리뷰 자동 보강
- Claude CLI headless AI 요약 파이프라인
- `repo-config.json`의 repoMap/displayNames 개념 (확장하면 됨)
- generate → 확인 → update 2단계 워크플로
- cron 호환 실행 스크립트

---

## 2. 요구사항

### 2.1 필수 요구사항 (Must)

| ID | 요구사항 | 검증 방법 |
|----|----------|-----------|
| R1 | 신규 저장소 추가 시 **설정 파일 1곳만 수정**하면 동작 | 테스트 repo 추가 후 정상 분류 확인 |
| R2 | 번역 규칙을 **외부 설정 파일**(JSON)로 분리 | 규칙 추가/삭제 후 코드 무수정 확인 |
| R3 | 기존 **출력 결과 동일성** 유지 (카테고리 구조, 마크다운 형식) | 리팩토링 전후 동일 기간 출력 diff |
| R4 | `MODE=generate` / `MODE=update` **기존 워크플로 유지** | run-generate-env.sh, run-update-env.sh 정상 동작 |
| R5 | **cron 환경 호환** 유지 (.env 로드, PATH 설정) | cron 시뮬레이션 테스트 |

### 2.2 선택 요구사항 (Should)

| ID | 요구사항 | 검증 방법 |
|----|----------|-----------|
| S1 | 메인 스크립트를 **기능 단위 모듈**로 분리 | 각 모듈 독립 실행/테스트 가능 |
| S2 | **레거시 파일 정리** (Playwright 버전, 구 경로 스크립트) | 제거 후 기존 기능 영향 없음 |
| S3 | 커밋 타입 분류(`detectCommitType`) 규칙도 설정으로 분리 | 규칙 변경 후 코드 무수정 |
| S4 | 사소한 커밋 필터(`isTrivialCommit`) 패턴도 설정화 | 패턴 추가 후 코드 무수정 |

### 2.3 제외 범위 (Won't)

- Redmine API 인증 방식 변경 (현재 API Key 유지)
- 다른 팀원 섹션 자동화 (향후 확장 가능하도록 구조만 고려)
- AI 요약 프롬프트 로직 변경
- GitHub PR 조회 로직 변경

---

## 3. 성공 기준

| # | 기준 | 측정 방법 |
|---|------|-----------|
| SC1 | 신규 repo 추가: **설정 파일 1곳 수정**만으로 완료 | 실제 테스트 repo 추가 시연 |
| SC2 | 번역 규칙 추가: **JSON 파일 수정**만으로 반영 | 새 규칙 추가 후 출력 확인 |
| SC3 | 리팩토링 전후 **동일 기간 출력 결과 diff = 0** | 2026-04-01 기준 출력 비교 |
| SC4 | `run-generate-env.sh` / `run-update-env.sh` **기존대로 동작** | 스크립트 실행 성공 |
| SC5 | 메인 로직 파일이 **200줄 이하**로 분리 | wc -l 확인 |

---

## 4. 설계 방향 (High-Level)

### 4.1 통합 설정 파일 구조 (repo-config.json 확장)

```jsonc
{
  // 현재 repoMap, displayNames 유지 + 확장
  "repos": {
    "max9296": {
      "path": "/home/jhw/ai/opencode/projects/max9296",
      "category": "pimDriver",
      "display": "PIM Driver"
    },
    "gstApp": {
      "path": "/home/jhw/ai/opencode/projects/gstApp",
      "category": "pimApp",
      "display": "PIM Application"
    }
    // ... 신규 repo 추가 = 여기 1곳만
  },
  "categories": {
    "pimApp":  { "label": "Application", "parent": "PIM" },
    "pimDriver": { "label": "Driver", "parent": "PIM" },
    "wlanNxp": { "label": "NXP", "parent": "Wireless Lan" },
    "etc":     { "label": null, "parent": "ETC" }
  },
  "displayNames": { ... },  // ETC 하위 표시명 (기존 유지)
  "translation": {
    "rules": "translation-rules.json"  // 번역 규칙 외부 참조
  },
  "trivialPatterns": [
    "^(log|gitignore|chore|merge branch).*",
    "^코드\\s*리뷰\\s*(반영|추가\\s*수정).*",
    "^release:\\s*v?\\d.*"
  ],
  "commitTypes": {
    "feat": { "match": ["^(add|추가|신규|implement|create)"], "label": "추가" },
    "fix":  { "match": ["^(fix|수정|버그|bug|patch)"], "label": "수정" },
    "improve": { "match": ["^(improve|개선|enhance|optimize)"], "label": "개선" }
  }
}
```

### 4.2 모듈 분리 구조

```
projects/redmine/
├── index.js                    # 엔트리포인트 (워크플로 오케스트레이션)
├── lib/
│   ├── config.js               # 설정 로드 (repo-config.json + .env)
│   ├── git-collector.js        # Git 커밋 수집 + 필터링
│   ├── commit-classifier.js    # 커밋 분류 (타입, 카테고리)
│   ├── translator.js           # 영한 번역 (외부 규칙 기반)
│   ├── github-enricher.js      # GitHub PR 제목/리뷰 보강
│   ├── ai-summarizer.js        # Claude CLI AI 요약
│   ├── template-renderer.js    # 템플릿 렌더링
│   └── redmine-api.js          # Redmine Wiki API 호출
├── repo-config.json            # 통합 설정 (확장)
├── translation-rules.json      # 번역 규칙 (NEW)
├── templates/                  # 기존 유지
├── .env                        # 시크릿만 (API키, 토큰)
├── run-generate-env.sh         # 기존 유지
├── run-update-env.sh           # 기존 유지
└── out/                        # 기존 유지
```

### 4.3 .env 역할 축소

```bash
# .env — 시크릿과 환경별 오버라이드만
REDMINE_API_KEY="..."
GITHUB_TOKEN="..."
AI_SUMMARIZE=1

# 선택적 오버라이드 (없으면 repo-config.json 기본값 사용)
# MEETING_DATE=YYYY-MM-DD
# MODE=generate
```

저장소 목록(`REPO_LIST`)은 더 이상 `.env`에 두지 않고, `repo-config.json`의 `repos` 섹션에서 관리합니다.

---

## 5. 리스크

| # | 리스크 | 영향 | 대응 |
|---|--------|------|------|
| RK1 | 리팩토링 중 기존 출력 형식 깨짐 | cron 보고서 이상 | SC3 검증: 전후 출력 diff 비교 |
| RK2 | 모듈 분리 시 의존성 순서 오류 | 런타임 에러 | 각 모듈 독립 테스트 |
| RK3 | 번역 규칙 외부화 시 regex 이스케이핑 문제 | 번역 누락 | JSON 로드 후 regex 컴파일 테스트 |
| RK4 | cron 환경에서 모듈 경로 resolve 실패 | 자동 실행 실패 | 절대 경로 + __dirname 기반 |

---

## 6. 구현 순서

| 단계 | 내용 | 의존성 |
|------|------|--------|
| 1 | 현재 출력 스냅샷 저장 (SC3 기준선) | 없음 |
| 2 | `repo-config.json` 확장 설계 + 마이그레이션 | 없음 |
| 3 | `translation-rules.json` 추출 | 없음 |
| 4 | `lib/` 모듈 분리 (config → git-collector → classifier → translator → enricher → summarizer → renderer → api) | 2, 3 |
| 5 | `index.js` 엔트리포인트 작성 | 4 |
| 6 | `run-*-env.sh` 업데이트 (index.js 호출로 변경) | 5 |
| 7 | 출력 비교 검증 (SC3) | 6 |
| 8 | 레거시 정리 (Playwright 버전, 구 경로 스크립트) | 7 |
