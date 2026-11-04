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
입력의 symlink는 따라가지 않으며, INDEX.md는 원자적으로 갱신하는 mode 0600 파일이다.
기계용 INDEX.json은 만들지 않는다.

생성물은 Git에 추가하지 않는다. `/tmp` 대신 작업 폴더에 보관하고, 다른 문서가 가리키는
기존 백업·압축 파일은 제자리에 둔 채 색인한다. 2026-11-04 보존본은
`2026-11-04-staging/`에서 주제별 폴더로 복사한다. 원본과 캡처 저장소는 지우거나
변경하지 않는다. 남아 있지 않은 자료는 README에 `소실`로, 의도적인 제외는 그 이유를
기록한다. 이 스크립트는 보관본 이동·삭제나 run 자동 정리를 수행하지 않는다.
