# AI provider / generation scope spike 결과

## 조건

- snapshot: `/home/jhw/ai/opencode/projects/redmine/out/report-2026-08-26.snapshot.json`
- snapshot SHA-256: `f190508e4f3ea869680417fc074abdc02aead2cf3bc8087cb60846947252fe35`
- depth: 3
- effort: medium
- 자동 재시도/provider fallback: 없음
- Redmine update: 없음
- 실제 모델 호출: 9회 (승인 상한 12회)

원본 실행 결과:

- 전체/초기 분할: `/home/jhw/ai/opencode/projects/redmine/out/spikes/ai-provider-scope-2026-09-01-v1/comparison.json`
- 분할 정규화 수정 후: `/home/jhw/ai/opencode/projects/redmine/out/spikes/ai-provider-scope-2026-09-01-v2-project-fix/comparison.json`

## whole 결과

| provider/model | 상태 | 게시 가능 | 시간 | 줄/불릿 | leaf 중복 | section coverage | Notion marker |
|---|---:|---:|---:|---:|---:|---:|---:|
| Claude Sonnet | WARNING | 예 | 98.517초 | 55/51 | 0 | 9/9 | 18/164 |
| Claude Opus | FAIL | 아니오 | 177.557초 | 55/51 | 0 | 9/9 | 52/164 |
| Codex gpt-5.6-sol | WARNING | 예 | 144.361초 | 39/37 | 0 | 9/9 | 13/164 |

- Sonnet과 Codex 경고는 요약에서 제외한 Notion item의 marker 누락이며 advisory다.
- Sonnet은 depth3 권고 상한 38불릿을 넘고 개인 자동화 항목 일부를 남겼다.
- Opus는 `fact_subject_mismatch` 4건 등으로 차단됐다. 숫자 표면은 marker로 보존했지만 숫자가 수식하는 대상을 재작성했다.
- Codex는 유일하게 depth3 불릿 권고 안에 들고 게시 가능했다. 다만 Notion marker coverage가 가장 낮고 단일 주 샘플이므로 운영 기본값으로 승격하지 않는다.

## project 결과

초기 project 검증은 whole 경로의 fact expansion/section normalization 전에 파트를 검사하는 구현 차이가 있어 무효였다. 경로를 동일하게 수정하고, 실패 파트 원문과 오류를 immutable artifact로 보존한 뒤 Sonnet과 Codex를 재실행했다.

| provider/model | 진행 | 결과 | 차단 근거 |
|---|---:|---:|---|
| Claude Sonnet | PIM 1/3 | ERROR | `fact_subject_mismatch` 2건. IMU 측정 대역의 두 Q reference를 새 화살표 범위로 합치며 원본 대상구를 변경 |
| Codex gpt-5.6-sol | Wireless Lan 2/3 | ERROR | `fact_subject_mismatch` 3건, fact/section mismatch와 canonical heading 밑줄로 인한 source section 오류 |
| Claude Opus | 재실행 안 함 | 미평가 | whole이 이미 blocking FAIL이고 호출 상한을 지키기 위해 제외 |

project 모드는 파트 실패 시 뒤 호출을 중단했고, Sonnet은 1회, Codex는 2회만 사용했다. 아직 실제 주간보고 전체를 끝까지 통과한 후보가 없으므로 큰 입력을 위한 파일럿 옵션으로 유지한다.

## 권장 운영값

```bash
AI_PROVIDER=claude
AI_MODEL=sonnet
AI_GENERATION_SCOPE=whole
```

- 평소 작업량: 기본 `whole` 유지.
- 작업량이 큰 주: `project`를 명시적으로 선택할 수 있으나 현재는 파일럿으로만 사용하고 generate 검증 결과를 확인한다.
- Codex: `whole` 품질이 가장 간결했으므로 추가 주차 A/B 후보로 유지한다. 한 번의 성공만으로 자동 기본값이나 fallback으로 설정하지 않는다.
- Opus: 이번 표본에서는 더 느리고 blocking validation failure가 있어 승격 근거가 없다.

## 후속 프롬프트 보강

- 같은 작업의 구현·리뷰 반영·후속 수정을 최종 결과 한 항목으로 통합한다.
- 같은 source 근거를 여러 문장에 반복하지 않는다.
- 줄 수를 맞추기 위해 서로 다른 기능을 합치지 않는다.
- 여러 Q reference를 새 범위·화살표·괄호로 재구성하지 않고 각 원본 대상구를 유지한다.
- canonical section/category/project heading에는 밑줄을 적용하지 않는다.
