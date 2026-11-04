# 생성물 보관과 색인

출력 루트는 `OUTPUT_DIR`이며 기본값은 저장소의 `out/`이다. 상대경로는 실행한
디렉터리와 관계없이 저장소 루트를 기준으로 해석한다. 아래 경로는 모두 출력 루트 기준이다.

```text
pairs/YYYY-MM-DD/                 주간보고, manifest, 게시/Slack 영수증
runs/                            생성 실행 기록
artifacts/
  INDEX.md                       자동 생성하는 탐색용 색인
  YYYY-MM-DD-<slug>/
    README.md                    작업 제목, 참조, 설명, 파일 목록
    ...                          리허설, 검토, PR 본문 등 작업 산출물
archive/*.tar.gz                  압축 보관본
archive/*.README.md               같은 basename의 보관/복원 안내
wip-backup-*/                     기존 참조를 유지하는 백업
```

작업 폴더 이름은 날짜와 주제를 조합한다. 각 `README.md`의 첫 줄과 메타데이터 형식은
다음과 같이 고정한다. 참조가 없으면 `없음`으로 적고 파일 목록에 상대경로를 나열한다.

```markdown
# 제목

- 이슈: #144 또는 https://github.com/owner/repo/issues/144
- PR: 없음 또는 https://github.com/owner/repo/pull/145
- 설명: 이 폴더의 목적과 원본 위치, 복사/보관 경위

## 파일 목록

- `file.md`: 내용과 용도
```

수동 갱신:

```bash
node scripts/artifact-index.js
OUTPUT_DIR=/absolute/output node scripts/artifact-index.js
```

`run-report-env.sh`는 보고서 실행과 기존 알림 처리가 끝난 뒤 성공/실패와 관계없이
색인을 best-effort로 갱신한다. 색인 실패는 원래 exit status나 `[ALERT]`/`[REVIEW]`
문구를 바꾸지 않는다. cron도 같은 래퍼를 쓰므로 배포 후 다음 실행부터 적용된다.

색인은 주간보고, 작업 산출물, 보관의 세 섹션을 담는다. manifest가 없거나 손상된
pair는 실패/미완료로 표시한다. 구형 정상 게시 영수증은 status가 없어도 `published`로
표시하며 거부 보고서 게시의 `rejected_published`와 구분한다. Slack 건수는 숫자 이름의
`*.completed.json`과 `*.started.json` 파일 수다. 시작 건수는 완료된 시도도 포함한다.
README의 제목·이슈·PR만 모으고 설명·본문은 읽어 색인에 싣지 않는다. 검증 issue의
message/evidence, 보고서 본문, Slack 수신자·메시지와 자격증명은 색인 대상이 아니다.
제목·이슈·PR 줄과 링크 상대경로는 축약·참조 추출·URL 인코딩 전에 수집기의
`assertSafeCommitEvidence`로 검사한다. 자격증명 의심 표시값은 전체를 `[REDACTED]`로
바꾸고, 의심 경로의 링크/항목은 제외한다. 원본 파일은 변경하지 않는다.
입력의 symlink는 따라가지 않으며, INDEX.md는 원자적으로 갱신하는 mode 0600 파일이다.
기계용 INDEX.json은 만들지 않는다.

생성물은 Git에 추가하지 않는다. `/tmp` 대신 작업 폴더에 보관하고, 다른 문서가 가리키는
기존 백업·압축 파일은 제자리에 둔 채 색인한다. 2026-11-04 보존본은
`2026-11-04-staging/`에서 주제별 폴더로 복사한다. 원본과 캡처 저장소는 지우거나
변경하지 않는다. 남아 있지 않은 자료는 README에 `소실`로, 의도적인 제외는 그 이유를
기록한다. 이 스크립트는 보관본 이동·삭제나 run 자동 정리를 수행하지 않는다.

## 2026-11-04 보존본 분리 기록 (#144)

스테이징 7개 주제를 원래 checkout의 출력 루트 안에서 같은 이름의 날짜별 폴더로
복사했다. 아래 Source는 `artifacts/2026-11-04-staging/` 기준이고, Target은
`artifacts/` 기준이다. 스테이징·기존 백업·archive는 모두 제자리에 유지했다.
이 인벤토리는 이 문서를 포함한 #144 수정 커밋에 고정된다. 생성물 자체는 비추적이다.

| Source | Target | Files | Inventory SHA-256 |
|---|---|---:|---|
| `issue-138/` | `2026-11-04-issue-138/` | 28 | `d4e02c719654054285796897517fd7eeea54386d8eae427f93ffaa4e9522a7ab` |
| `issue-141/` | `2026-11-04-issue-141/` | 33 | `2f0714eee28a4a316c701b89a0d553d894819a3d5b9ad3c723fbca998a95aa84` |
| `issue-drafts/` | `2026-11-04-issue-drafts/` | 4 | `9c611051aa47c06492e1aeb6bacb15c089e2458326dc153df94f3b76f20e144e` |
| `out-cleanup/` | `2026-11-04-out-cleanup/` | 1 | `e94080782e7d8ebd816f4fc549f3cab63ede7a736df5af086f5b377e8cc12c1a` |
| `rehearsal-1111-v1/` | `2026-11-04-rehearsal-1111-v1/` | 59 | `6641e7b488743c9009f81012a77451fd96ade74d6d4e3815950f3ef0b923e32d` |
| `rehearsal-1111-v2/` | `2026-11-04-rehearsal-1111-v2/` | 60 | `0ac344d1fbb2a3a680e1780cf5501245e1847a3e21f6569f212e3743033253c7` |
| `tribunal/` | `2026-11-04-tribunal/` | 33 | `0aa25e052d9db98c71f042633ab0d0fb119306362eae9d98874b4d05a1b206de` |

총 218개 원본 파일의 SHA-256과 파일 권한을 복사본과 전수 대조했다. Files와
인벤토리 해시는 원본 파일만 센다. 각 Target에 새로 추가한 README는 별도이다.
해시는 원본 상대경로순으로 정렬한 `{path, mode, sha256}` 레코드 배열을
`JSON.stringify`와 같은 공백 없는 UTF-8 JSON(키 순서 mode, path, sha256)으로 만든 뒤
SHA-256을 계산한 값이다. mode는 4자리 8진수, path는 `/` 구분 상대경로다.

각 Target의 README에는 제목·이슈·PR·설명과 최상위 파일/폴더 목록을 기록했다.
소실된 보존 대상은 없다. `issue-141/mut/`는 최초 보존 단계에서 커밋으로 재생할 수
있는 41MB의 테스트 사본으로 의도적으로 제외됐으며, 그 사유를 README에 남겼다.
`issue-138/sdd-workspace/`는 복사본에 포함된다. `tribunal/`의 응답 원본·영수증·
컨텍스트와 캡처 저장소는 원래 바이트·권한을 유지한 복사본이다. 원본은 수정하지 않았다.

`out/wip-backup-2026-11-04/`와 `out/archive/out-cleanup-2026-11-04.tar.gz` 및
짝 README는 이전하지 않아 기존 문서·Handoff의 참조를 유지한다.
이 대조는 로컬 보존 자료에 대한 검사이며, 임시 fixture로 실행하는 색인 회귀
테스트나 외부 서버 상태 검증을 대신하지 않는다.
