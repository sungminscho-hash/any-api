# 실행 사다리 (Execution Ladder) — 무엇이든 같은 API 계약으로

`any-api` 의 약속은 하나다: **레시피 하나 = 호출 하나 = 구조화된 결과 하나.**

```js
const { rows, files, meta } = await runRecipe(recipe, session, params)
```

무엇을 어떻게 가져오는지는 레시피의 `executor` 가 정하고, 호출자는 알 필요가 없다. 원천이 XHR 이든,
서버가 그려 주는 HTML 이든, PDF 첨부 메일이든, 데스크톱 앱 화면이든, 결국 사람이 해야 하는 일이든
**같은 계약**으로 노출된다. 그래서 "무엇이든 API" 다.

## 사다리 — 위일수록 빠르고 안정적, 아래일수록 범용적

| 단 | executor | 원천 | 어떻게 | 언제 |
|---|---|---|---|---|
| 1 | `http-replay` | XHR/fetch, 파일 다운로드 URL | 캡처한 요청을 서명·토큰 포함해 그대로 재현 | T0~T2. 가장 먼저 시도 |
| 2 | `browser-fetch` | 같은 XHR 이지만 서명을 못 풀었거나 브라우저 검사가 있음 | 로그인된 페이지 **안에서** 그 사이트의 자체 함수/`fetch` 를 호출. 브라우저가 서명·쿠키·지문을 스스로 처리 | T2 역공학 실패, 일부 T3 |
| 3 | `ui-automation` | 서버 렌더 HTML, iframe, 레거시 화면, "조회 → 표 → 엑셀 저장" 같은 다단계 | Playwright/ego-lite 스크립트가 클릭·입력·대기 후 DOM 표를 읽거나 다운로드 파일을 받음. **결정적(deterministic)** 스크립트 | XHR 이 없거나 T3 |
| 4 | `agent` | 화면 구조가 자주 바뀌거나 스크립트로 못 박기 어려운 흐름 | ego-lite/Aside/Claude 같은 브라우저 에이전트에게 **자연어 과업 + 출력 JSON 스키마** 를 주고 결과를 스키마로 검증 | 3단 스크립트가 자주 깨질 때. 비결정적이므로 검증 필수 |
| 5 | `file` | xlsx/csv/pdf/hwp/이미지 | 파일 파서(+ 필요 시 OCR/LLM 추출)로 표 추출 | 원천이 애초에 파일일 때. 1~4단의 다운로드 결과에도 이어 붙음 |
| 6 | `mail` | 메일함(IMAP/Graph/Gmail API) | 조건으로 메일 검색 → 본문/첨부 → 5단으로 | 정기 리포트가 메일로만 올 때 |
| 7 | `desktop` | 웹이 아닌 설치형 앱(ERP 클라이언트, 은행 프로그램) | OS 접근성 트리(Windows UIA, macOS AX)로 조작·읽기. 마지막엔 화면 OCR | 브라우저가 아예 없을 때 |
| 8 | `human` | 자동화 불가·승인 필요·1회성 | 작업 큐에 사람 과업 생성 → 사람이 완료하면 결과 업로드 → API 는 그때 응답(비동기) | 나머지 전부. "API 가 항상 응답한다"는 약속을 지키는 바닥 |

각 단은 **독립된 실행기**이고, 레시피는 하나의 executor 를 명시한다. 여러 단을 이어 붙일 수도 있다
(예: `ui-automation` 으로 엑셀을 받고 `file` 로 파싱).

## 자동 강등 (auto-demotion)

`verify` 는 위에서부터 시도해 **검증을 통과한 가장 높은 단**을 레시피에 박는다.
`watch` 가 깨짐을 감지하면 한 단 아래로 자동 강등해 서비스는 유지하고, 사람에게 "다시 올려 보라"고 알린다.

```
http-replay ─실패→ browser-fetch ─실패→ ui-automation ─실패→ agent ─실패→ human
     ▲ watch 가 복구되면 다시 위로 (승격은 verify 통과 시에만)
```

강등은 항상 **더 느리고 더 비싸지만 더 범용적인** 쪽으로 간다. 서비스가 멈추지 않는 대신 응답 시간과
비용이 달라지므로 레시피 `meta.executor` 로 호출자가 알 수 있게 한다.

## 단별로 "record" 가 뜻하는 것

| executor | record 가 남기는 것 | emit 이 만드는 것 |
|---|---|---|
| `http-replay` | 요청·응답·쿠키·스토리지·DOM (pipeline.md §1) | recipe.json + sign 함수 |
| `browser-fetch` | 같은 캡처 + 페이지 안에서 그 요청을 만드는 **호출 지점**(스택 트레이스의 함수·모듈) | 페이지 컨텍스트에서 실행할 JS 조각. 예: 사이트의 `api.post(path, body)` 를 그대로 호출 |
| `ui-automation` | 사용자의 클릭·입력 트레이스(selector·텍스트·순서) + 각 단계 DOM/스크린샷 + 결과 표 또는 다운로드 파일 | 결정적 스크립트(steps 배열) + 결과 추출 규칙(테이블 selector 또는 파일 경로) |
| `agent` | 사람이 그 일을 하는 화면 녹화(스크린샷 시퀀스)와 최종 결과 예시 | 자연어 과업문 + 출력 JSON 스키마 + 검증 규칙 + 예시 결과 |
| `file` | 샘플 파일 2개 이상 | 파서 설정(시트/헤더 행/컬럼 매핑) 또는 LLM 추출 프롬프트 + 스키마 |
| `mail` | 검색 조건과 샘플 메일 | 검색 쿼리 + 첨부 처리 규칙 → `file` 레시피 연결 |
| `desktop` | 접근성 트리 스냅샷 + 조작 트레이스 | UIA/AX 셀렉터 기반 스크립트 |
| `human` | 작업 설명·필요 입력·결과 형식 | 과업 템플릿 + 결과 업로드 스키마 |

## 공통 계약

모든 executor 는 같은 것을 돌려준다.

```ts
interface RecipeResult {
  rows: object[]              // 표 형태 결과 (없으면 [])
  files: { name, bytes, mime }[]   // 다운로드·첨부
  meta: {
    executor: 'http-replay' | 'browser-fetch' | 'ui-automation' | 'agent' | 'file' | 'mail' | 'desktop' | 'human'
    demotedFrom?: string       // 강등됐다면 원래 단
    verified: string[]         // 이번 실행에서 통과한 완전성 규칙
    durationMs: number, cost?: number
  }
}
```

그리고 같은 것을 요구한다.

- **읽기 전용**이 기본. 쓰기는 executor 와 무관하게 별도 승인.
- **검증 규칙**(`response.completeness`)은 executor 와 무관하게 적용된다. `agent` 처럼 비결정적인 단일수록
  규칙이 더 엄격해야 한다(스키마 일치 + 건수 범위 + 합계 검산).
- **자격증명·세션**은 러너가 메모리에만 들고, 어느 executor 도 디스크에 쓰지 않는다.
- **속도 제한**과 **우회 금지**는 모든 단에 동일하다. `browser-fetch`·`ui-automation` 은 봇 차단을
  "우회"하는 게 아니라 사용자가 보는 브라우저 그대로 동작하는 것이다. CAPTCHA 가 뜨면 멈추고 사람에게 넘긴다(`human`).

## 왜 사다리인가

- **한 종류만 있으면 "안 되는 사이트"가 생긴다.** T3 판정이 곧 서비스 중단이 되면 안 된다.
- **바닥(`human`)이 있어야 API 계약이 성립한다.** "이 레시피는 항상 결과를 준다"고 말할 수 있는 건
  최후에 사람이 붙기 때문이다. 비동기 응답이지만 계약은 같다.
- **위로 올라갈수록 싸다.** 사다리는 비용 최적화이기도 하다. 자주 쓰는 레시피는 시간이 지나며
  `agent` → `ui-automation` → `http-replay` 로 승격시키는 것이 운영 목표다.

## 지금 있는 것과 없는 것

| executor | 상태 |
|---|---|
| `http-replay` | 설계·스키마 확정, 사내에서 한 사이트에 수동 검증 완료 |
| `browser-fetch` | ego-lite `browserFetch()`·Playwright `page.evaluate(fetch)` 로 바로 가능. 호출 지점 기록은 미구현 |
| `ui-automation` | Playwright plan.json 방식의 스크립트 러너가 사내에 있음. 트레이스 → 스크립트 생성은 미구현 |
| `agent` | ego-lite/Aside 로 수동 가능. 스키마 검증 래퍼 미구현 |
| `file` | xlsx 파서·컬럼 퍼지 매핑이 사내에 있음 |
| `mail`, `desktop`, `human` | 설계만 |
