# any-api

**어떤 원천이든 — 웹 화면·파일·메일·데스크톱 앱·사람 작업 — 검증된 하나의 API 계약으로 바꾼다.**
Turn any data source into one verified, reusable API recipe: `runRecipe(recipe, session, params) → { rows, files, meta }`.

브라우저가 버튼을 누를 때 하는 일은 결국 HTTP 요청 몇 개다. 그 요청을 재현하는 게 가장 빠른 길이지만,
그게 안 되는 원천도 있다. any-api 는 **실행 사다리(execution ladder)** 로 이 문제를 푼다: 가장 빠르고
안정적인 방법(요청 재현)부터 시도하고, 검증에 실패하면 더 범용적인 방법(브라우저 내 호출 → UI 자동화 →
에이전트 → 파일/메일/데스크톱 → 사람)으로 한 단씩 내려간다. **바닥에 사람이 있으므로 "이 레시피는 항상
결과를 준다"는 계약이 성립한다.** 호출자는 무엇을 어떻게 가져왔는지 몰라도 된다 — 결과 형태는 같다.

## 실행 사다리 — "어느 부분이든 API"의 실제 의미

| 단 | executor | 원천 | 상태 |
|---|---|---|---|
| 1 | `http-replay` | XHR/fetch, 다운로드 URL | ✅ 구현·테스트 |
| 2 | `browser-fetch` | 로그인 페이지 안에서 사이트 자체 함수 호출 (서명 못 풀 때) | 설계 |
| 3 | `ui-automation` | 서버 렌더 HTML, 표, 다단계 화면 | ✅ 구현·테스트 (Playwright) |
| 4 | `agent` | 화면이 자주 바뀌어 스크립트로 못 박는 흐름 | 설계 (ego-lite/Aside) |
| 5 | `file` | xlsx/csv/pdf 파싱 | ✅ 구현·테스트 (xlsx) |
| 6 | `mail` | 메일 검색 → 첨부 → file | 설계 |
| 7 | `desktop` | 설치형 앱 (Windows UIA / macOS AX) | 설계 |
| 8 | `human` | 자동화 불가·승인 필요 (비동기 작업 큐) | 설계 |

검증(`verify`)은 위에서부터 시도해 통과한 가장 높은 단을 레시피에 박고, 감시(`watch`)가 깨짐을 감지하면
자동으로 한 단 강등한다. 상세: [docs/executors.md](docs/executors.md).

## 아무 사이트나 되나? — 안 된다 (중요)

대형 소비자 플랫폼은 **기술적으로도 막히고, 약관으로도 금지**된다. any-api 는 차단을 뚫는 도구가 아니라
**허용된 원천을 하나의 계약으로 통일하는 도구**다. 검증된 현황(2026-09):

| 플랫폼 | 등급 | 막히는 이유 | 써야 할 것 |
|---|---|---|---|
| Instagram | T3 | TLS 지문으로 봇 식별, headless 탐지, 세션 단명, 스크래핑 금지 약관 | Instagram Graph API (공식) |
| YouTube | T3 | InnerTube 가 BotGuard attestation + PoToken(브라우저 챌린지) 요구 | YouTube Data API v3 (공식) |
| Naver | T3 | 로그인 CAPTCHA·기기 검사, 2026-09-07 약관이 봇·크롤러·차단 우회 금지 | Naver Developers 오픈 API (공식) |

차단을 지문 위조·프록시로 우회하는 것은 이 프로젝트가 **하지 않기로 한 것**이다(0단계 승인에서 "불가"로 분류).
대신 이들은 공식 API 를 `http-replay` 레시피로 감싸 같은 `runRecipe` 계약으로 노출한다. 근거·대안 상세:
[docs/case-studies.md](docs/case-studies.md).

**되는 것은** 봇 차단이 약하거나 없고 약관이 허용하는 원천 — 대개 사내/B2B/기관 시스템, 또는 공식 API 를 주는 서비스다.

## 빠른 시작

```bash
npm install          # exceljs (필수), playwright (ui-automation 쓸 때)
npm test             # 로컬 서버로 http-replay·ui-automation·file·강등 검증 (11 케이스)
```

```js
const { runRecipe } = require('any-api/runner.cjs');
const recipe = require('./recipes/example-erp/journal.recipe.json');
const { rows, files, meta } = await runRecipe(recipe, session, { start_date: '20250101', end_date: '20250930' });
// meta.executor 로 어느 단으로 가져왔는지, meta.verified 로 어떤 완전성 규칙을 통과했는지 알 수 있다
```

---

이 저장소는 레시피를 만드는 절차를 **기록 → 분석 → (서명 역공학) → 검증 → 레시피 → 검토 → 공유** 로
정리하고, 어디까지 자동화되는지와 어디서 사람이 검토해야 하는지를 적는다.

> 읽기 전용이 기본이다. 약관·계약상 허용된 서비스, 본인 또는 승인된 계정에만 쓴다. 봇 차단·CAPTCHA·지문
> 검사를 우회하지 않는다. 자세한 경계는 [docs/any-api.md §6](docs/any-api.md#6-하지-않는-것--먼저-확인할-것).

## 무엇을 할 수 있나 — 예시

아래는 파이프라인이 완성됐을 때의 사용 모습이다. 사이트 이름은 가상(`example-erp`)이다.
현재 상태는 [로드맵](docs/roadmap.md) 참고 — 설계와 레시피 형식은 확정, CLI 는 단계별 구현 중.

### 1. 회계 SaaS 의 "분개장 조회" 버튼을 API 로

```bash
# 격리된 Chrome 창이 뜸 → 사용자가 로그인하고 조회 버튼을 두 번 누름 → 요청·응답·쿠키·DOM 이 기록됨
any-api record https://erp.example.com/journal journal --repeat 2

# 두 기록을 diff → 매 요청 바뀌는 값(timestamp, nonce, signature)을 찾고 난이도 판정
any-api analyze captures/example-erp/journal
#   tier: T2  (요청 서명 있음: header "x-sign" — 페이지 어디에도 없는 값)

# 번들에서 "x-sign" 리터럴을 찾아 서명 함수 후보 추출 → 포팅 → 캡처값과 100% 일치할 때까지 검증
any-api sign-hunt captures/example-erp/journal

# 새 nonce 로 재생 + 파라미터를 하나씩 빼 보며 함정 자동 추출
any-api verify captures/example-erp/journal
#   start_date  userParam  required
#   fy          required   → 없거나 빈값이면 0건        ⚠️
#   filter      omitIfUnused → ""  이면 0건, 빼면 전체  ⚠️
#   dept_code   ignored    → 값이 틀려도 결과 동일

# recipe.json + 클라이언트 함수 + 문서 생성
any-api emit captures/example-erp/journal
#   recipes/example-erp/journal/{recipe.json, client.cjs, doc.md}
```

이후 어느 프로젝트에서든:

```js
const { runRecipe } = require('any-api/runner');
const recipe = require('./recipes/example-erp/journal/recipe.json');
const rows = await runRecipe(recipe, session, { start_date: '20250101', end_date: '20250930' });
// session 은 브라우저에서 방금 캡처한 자격증명(메모리에만) — 디스크에 저장하지 않는다
```

### 2. 엑셀 다운로드 버튼을 매일 자동으로

```bash
any-api record https://portal.example.com/reports export-xlsx
any-api analyze captures/example-portal/export-xlsx
#   tier: T0  (세션 쿠키만 있으면 재생됨)
any-api emit captures/example-portal/export-xlsx        # T0 는 여기까지 사람 손이 안 감
any-api run recipes/example-portal/export-xlsx --p month=202509 --out ./reports/
```

### 3. 서명이 없는데 CSRF 토큰이 있는 폼 조회

```bash
any-api analyze captures/example-crm/search
#   tier: T1  (동적 값 "csrf_token" 이 <meta name="csrf-token"> 에 있음)
# → recipe.json 의 tokenSources 에 { from: "dom", selector: "meta[name=csrf-token]" } 이 기록되고,
#   runner 가 호출 전에 페이지를 한 번 열어 토큰을 뽑아 넣는다
```

### 4. 봇 차단이 있는 사이트 — API 화를 포기하는 판정

```bash
any-api verify captures/example-public/list
#   replay → 403 + challenge page
#   tier: T3  → ui-fallback (브라우저 안에서 그대로 조작. 우회 시도하지 않음)
```

### 5. 사이트가 바뀌었는지 매일 확인

```bash
any-api watch recipes/example-erp/journal        # 최소 파라미터로 재생 → 응답 스키마 해시 비교
#   status: broken (response keys changed: +"page_token" -"tot") → record 부터 다시
```

### 6. 로그인 상태를 물려받아 방해 없이 기록 (macOS, ego-lite)

```bash
any-api record https://erp.example.com/journal journal --driver ego
# 사용자의 실제 로그인 상태를 물려받은 격리 Space 에서 에이전트가 화면을 누르고 CDP 로 요청을 회수.
# 사용자 탭은 건드리지 않는다.
```

## 난이도 등급 — 자동화 가능 여부를 가르는 기준

같은 버튼을 두 번 눌러 두 요청을 diff 한다. 값이 달라진 필드가:

| 등급 | 조건 | 자동화 |
|---|---|---|
| **T0** | 없음 (세션 쿠키/토큰만) | 기록 → 재생 → 검증 → 레시피 **완전 자동** |
| **T1** | 페이지·스토리지에 그대로 있음 (CSRF 등) | 자동. 토큰 출처만 레시피에 기록 |
| **T2** | 어디에도 없음 (프런트 JS 가 계산하는 서명) | **반자동.** 함수 후보 탐색·검증은 자동, 포팅은 LLM + 사람. 통과 기준은 캡처값과 100% 일치 |
| **T3** | 재생하면 403/챌린지 (봇 차단·지문) | **API 화 불가.** UI 자동화로 우회하지 않고 그대로 조작 |

## 파이프라인

```
[0 승인] 사이트·계정·범위(읽기 전용) ── 사람
[1 record]   로그인된 브라우저에서 동작 기록 ── Playwright(Win/Mac/Linux) / ego-lite(Mac) / Chrome CDP / HAR import
[2 analyze]  diff → 동적 필드 → 등급
[3 sign-hunt] (T2) 번들 리터럴 검색 → 후보 → 포팅 → 벡터 검증
[4 verify]   재생, 파라미터 민감도, 완전성 규칙
[5 emit]     recipe.json + client + doc
[6 review]   약관·보안·개인정보·읽기전용 체크리스트 ── 사람 (게이트)
[7 publish]  카탈로그 (+ 선택: 게이트웨이·마스터 캐시)
[8 watch]    스키마 drift 감시
```

상세: [docs/pipeline.md](docs/pipeline.md) · 레시피 예시: [recipes/example-erp/journal/recipe.json](recipes/example-erp/journal/recipe.json)

## 도구의 자리

| 도구 | 역할 | 비고 |
|---|---|---|
| Playwright + 로컬 Chrome | 기본 기록기. 격리 프로필에서 사용자가 직접 로그인 | 전 플랫폼, 오늘 가능 |
| [ego-lite](https://github.com/citrolabs/ego-lite) | 로그인 상태를 물려받은 격리 Space 에서 기록. `cdp()`·`drainEvents()`·`js()` | macOS (Windows 로드맵) |
| Chrome `--remote-debugging-port` | 사용자 Chrome 에 붙어 기록·번들 덤프 | 기록 전용 |
| [Aside](https://aside.com/) | 개발자 접점 미공개 → 스크립트 연결 불가. T3 사이트의 최후 실행기, 탐색 보조, 화면 변화 감시 | 선택 |
| Claude Code / Codex | 오케스트레이터. 단계별 명령 실행과 문서화 | |

## 문서

- [docs/any-api.md](docs/any-api.md) — 개념, 절차, 등급, 허브(카탈로그·게이트웨이), 하지 않는 것
- [docs/pipeline.md](docs/pipeline.md) — 단계별 설계, 드라이버 어댑터 인터페이스, recipe.json 스키마
- [docs/roadmap.md](docs/roadmap.md) — 단계별 완료 기준, 리스크

## 원칙

- 자격증명은 메모리에만. 레시피·문서·로그에는 자리표시자만. 실값 커밋은 CI 가 막는다.
- "확인됨"은 실제로 재현한 것에만 붙인다. 나머지는 "알 수 없음". "~로 추정" 을 쓰지 않는다.
- 파라미터 민감도 테스트는 읽기 전용 엔드포인트에서만, 요청 간격을 두고 돌린다.

## License

MIT
