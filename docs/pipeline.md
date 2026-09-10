# 파이프라인 설계 — 단계별 동작, 드라이버 어댑터, 레시피 스키마

목표 형태는 CLI `any-api` 하나와 그것이 만들어 내는 `recipes/` 폴더다.

```
any-api record    <url> <action-name> [--driver playwright|ego|chrome-cdp] [--by user|agent] [--repeat 2] [--import file.har]
any-api analyze   <capture-dir>
any-api sign-hunt <capture-dir>          # T2 만
any-api verify    <capture-dir|recipe.json>
any-api emit      <capture-dir>
any-api run       <recipe.json> [--p k=v ...] [--out dir]
any-api publish   <recipe-dir>           # review.json 필수
any-api watch     <recipe.json>
```

---

## 1. record

### 기록하는 것

| 파일 | 내용 | 용도 |
|---|---|---|
| `requests.jsonl` | 요청마다 method·url·headers·postData·응답 status·headers·body(텍스트/바이너리 해시)·타이밍·initiator | 재생·diff 의 원천 |
| `cookies.json` | 쿠키 이름·속성 (값은 해시만) | 자격증명 캐리어 판별 |
| `storage.json` | local/sessionStorage 키와 값의 해시·길이·모양 | T1 토큰 출처 판별 |
| `dom-before.html` / `dom-after.html` | 동작 전후 DOM | 버튼 ↔ 요청 매핑, 검색조건 파악 |
| `screenshot-*.png` | 동작 전후 화면 | 검토자용 |
| `trigger.json` | 누른 요소와 직후 N초 안에 나간 요청 ID | "이 버튼 = 이 요청들" |
| `bundles/` (선택) | 페이지가 로드한 JS | sign-hunt 재료 |

**같은 동작을 최소 두 번** 기록한다. 세 번째는 다른 조건(다른 기간·다른 조직)으로 기록해 파라미터 역할을 가른다.
자격증명 실값은 캡처 폴더에 남기지 않는다 — 재생에 필요한 값은 실행 시점에 브라우저에서 다시 받는다.

### 드라이버 인터페이스

```ts
interface RecorderDriver {
  open(url: string): Promise<Page>
  onRequest(cb): void; onResponse(cb): void      // 바디 포함
  cdp(method: string, params?: object): Promise<any>
  evaluate(js: string): Promise<any>
  cookies(): Promise<Cookie[]>
  screenshot(): Promise<Buffer>
}
```

| 드라이버 | 로그인 상태 | 플랫폼 | 메모 |
|---|---|---|---|
| `playwright` | 격리 프로필. 창을 띄워 사용자가 직접 로그인(비밀번호 미취급) | 전 플랫폼 | `context.newCDPSession(page)` → `Network.enable` → `responseReceived` 마다 `Network.getResponseBody` |
| `ego` | 사용자의 실제 로그인 상태를 물려받은 격리 Space | macOS | `ego-browser nodejs <<'EOF'` 로 실행. `useOrCreateTaskSpace()` → `cdp('Network.enable')` → 동작 → `drainEvents()` → 바디는 `cdp('Network.getResponseBody')`. 번들은 `js()` 로 `webpackChunk*` 순회 |
| `chrome-cdp` | 사용자 Chrome 을 `--remote-debugging-port` 로 띄워 붙음 | 전 플랫폼 | 기록 전용. 클릭은 사용자가 |
| `aside` | Aside 가 조작 | Mac 앱 | 스크립트 어댑터 없음. 사람이 DevTools 에서 HAR 을 내보내 `--import` |

`--import file.har` 는 어떤 브라우저에서든 되는 만능 폴백이다.

---

## 2. analyze

1. **트리거 요청 고르기.** XHR/fetch 이고 응답이 JSON/CSV/xlsx/HTML 조각인 것. 정적 자산·분석 비콘은 제외.
2. **정적/동적 분리.** 두 캡처의 같은 요청을 헤더·쿼리·바디 키 단위로 비교. 다른 값은 모양으로 1차 분류:
   unix 초 → `timestamp`, 32/36자 hex → `nonce`, base64 → `signature 후보`, JWT 모양 → 토큰.
3. **동적 값의 출처.** 쿠키·스토리지·DOM·다른 응답 바디에서 검색. 찾으면 T1(`tokenSources[]`), 못 찾으면 `unresolvedDynamic[]`.
4. **자격증명 캐리어.** `Authorization`·`Cookie`·바디 토큰류를 이름만 기록.
5. **파라미터 역할 라벨링.** 세 번째 캡처에서 바뀐 필드 → `userParam`. 나머지 `unverified`. 이 단계에서 "추정"을 문서에 쓰지 않는다.
6. **등급.** `unresolvedDynamic` 이 비면 T0/T1, 있으면 T2. T3 는 verify 에서 확정.

---

## 3. sign-hunt (T2)

1. **리터럴 검색.** 번들에서 unresolved 헤더/필드 이름 문자열을 찾아 포함 모듈 목록 작성. 번들이 없으면 `Debugger.getScriptSource`.
2. **후보 추출.** 리터럴 주변 함수를 잘라 내고 `Hmac`·`SHA`·`sign`·`crypto.subtle`·`btoa` 같은 원시 호출을 찾는다. LLM 이 입력과 계산식을 요약.
3. **포팅.** LLM 이 Node(`crypto`)로 구현. 참조 구현이 있으면 그대로 옮긴다.
4. **검증 루프 (100% 게이트).** 캡처의 (입력, 서명) 쌍 전부에 대해 비교. 하나라도 틀리면 2 로. 추가로 참조본이 있으면 무작위 벡터 수백 개로 교차검증.
5. **결과.** `signSpec`: 시크릿 출처(이름만)·입력·함수·검증 벡터(시크릿은 자리표시자).

---

## 4. verify

1. **재생.** 새 timestamp/nonce/서명으로 같은 요청. status·JSON 키 집합·배열 길이 비교. 403/429/챌린지면 **T3 확정** → `ui-fallback`.
2. **파라미터 민감도.** 파라미터마다 키 삭제 / 빈 문자열 / 다른 값 세 변형:
   - 삭제·빈값에 0건 → `required`
   - 빈값에 0건, 삭제는 정상 → `omitIfUnused`
   - 변화 없음 → `ignored`
   - 다른 값에 다른 데이터 → `selector`
   읽기 전용에서만, 간격 1초, 변형 수 상한.
3. **속도 제한 관측.** 429·지연을 `rateLimit` 초기값으로.
4. **완전성 규칙.** 응답의 `total`·`count` 류가 배열 길이인지 고유 키 수인지 자동 탐색해 규칙화.

---

## 5. emit — recipe.json

```jsonc
{
  "id": "example-erp/journal",
  "site": "example-erp", "title": "분개장 조회", "tier": "T2",
  "method": "POST", "url": "https://erp.example.com/api/journal/search",
  "headers": { "x-client": "web", "Origin": "https://erp.example.com" },
  "credentials": [
    { "name": "bearer", "from": "cookie", "key": "<AUTH_COOKIE_NAME>", "use": "header:Authorization:Bearer " },
    { "name": "secret", "from": "cookie", "key": "<SESSION_SECRET_COOKIE>", "use": "sign.secret" }
  ],
  "dynamic": [
    { "name": "ts",    "gen": "unixSeconds", "use": "header:x-ts" },
    { "name": "nonce", "gen": "uuid4hex",    "use": "header:x-nonce", "note": "1회용. 재사용 시 거부" }
  ],
  "sign": {
    "header": "x-sign",
    "algo": "b64(hmac-sha256(pathname + search + ts + nonce, key = derive(secret, ts)))",
    "impl": "client.cjs#computeSign",
    "vectors": [ { "secret": "<SECRET>", "ts": "1700000000", "nonce": "<32hex>", "pathname": "/api/journal/search", "search": "", "expect": "<base64>" } ]
  },
  "params": [
    { "name": "start_date", "role": "userParam",    "format": "YYYYMMDD", "required": true },
    { "name": "end_date",   "role": "userParam",    "format": "YYYYMMDD", "required": true },
    { "name": "org_id",     "role": "selector",     "from": "org.id",  "verified": "다른 값 → 다른 조직 데이터" },
    { "name": "fy",         "role": "required",     "from": "org.fy",  "pitfall": "없거나 빈값이면 0건" },
    { "name": "filter",     "role": "omitIfUnused", "pitfall": "\"\" 이면 0건, 키를 빼야 전체" },
    { "name": "dept_code",  "role": "ignored" }
  ],
  "response": { "type": "json", "rows": "$.data[*]",
                "completeness": [ { "field": "$.total", "equals": "uniqueCount(date,voucher_no)" } ] },
  "readOnly": true, "rateLimit": { "perMinute": 10 },
  "sensitivity": ["거래처명", "금액"],
  "unverified": ["page 파라미터 존재 여부"],
  "provenance": { "capturedAt": "2026-09-01", "verifiedAt": "2026-09-08", "reviewedBy": null }
}
```

생성물: `client.cjs`(공통 러너 `runRecipe(recipe, session, params)` 호출), `doc.md`(요청 → 응답 → 필드 → ⚠️ 함정 → 미확인.
"확인됨"은 verify 로그에 있는 항목에만 자동으로 붙는다).

---

## 6. review — 사람 게이트 (`review.json` 이 전부 true 여야 publish)

- [ ] 약관·계약상 자동화 허용 확인 (근거 링크)
- [ ] 계정 사용 동의
- [ ] `readOnly: true` 이거나 쓰기 승인 별도
- [ ] 자격증명 실값이 어디에도 없음 (스캐너 통과)
- [ ] 민감 필드 표시와 보존 정책
- [ ] `rateLimit` 합리성
- [ ] "추정" 문구 없음, 미확인 목록 있음
- [ ] 검토자·일자

---

## 7. publish — 허브

- **카탈로그:** `recipes/<site>/<id>/{recipe.json, client.cjs, doc.md, review.json}`. 패키지 또는 서브모듈로 배포.
  CI 자격증명 스캐너(JWT 모양·긴 hex·알려진 시크릿 키 이름).
- **게이트웨이(선택):** 레시피 id + 파라미터 + 세션 참조 → 정규화 JSON/xlsx. `cache.ttl` 있는 마스터만 캐시. 감사 로그(자격증명·본문 제외). 속도 제한 강제.

---

## 8. watch

스케줄로 최소 파라미터 재생 → 응답 키 집합 해시 비교, 서명 벡터 재검증. 401 은 재로그인 알림만.
스키마 변화·403·500 이면 `status: "broken"` + `record` 부터 다시. Aside 루틴은 화면 쪽 변화를 미리 알리는 용도.

---

## 9. ego-lite 어댑터 스케치

```bash
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('any-api record example-erp/journal')
await cdp('Network.enable', {})
const tab = await openOrReuseTab('https://erp.example.com/journal')
await gotoAndWait(tab.url)
await click('text=조회'); await waitForNetworkIdle()
const events = await drainEvents()
const out = []
for (const e of events.filter(e => e.method === 'Network.responseReceived')) {
  const body = await cdp('Network.getResponseBody', { requestId: e.params.requestId }).catch(() => null)
  out.push({ e, body })
}
cliLog(JSON.stringify({ count: out.length }))
EOF
```

미확인: `drainEvents()` 가 어떤 도메인 이벤트를 큐에 넣는지, 스크립트에서 파일 쓰기가 되는지, Windows 지원 시점.
첫 실행 때 확인하고 이 문서를 갱신한다.
