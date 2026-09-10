// 실제로 도는 테스트. 외부 의존 없이 로컬 HTTP 서버를 띄워 세 executor 를 검증한다.
//   1) http-replay  — 서명 검증하는 가짜 API 에 재생 (T2 경로)
//   2) ui-automation — 서버가 그려 준 HTML 표를 Playwright 로 읽음 (T3/XHR 없음 경로)
//   3) file          — 실제 xlsx 를 생성해 file executor 로 파싱
//   4) 완전성 규칙 실패 시 에러, 403 시 강등까지 확인
'use strict';
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const { runRecipe, defaultSign } = require('../runner.cjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };

function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/journal/search' && req.method === 'POST') {
      // 서명 검증: x-sign 을 서버도 같은 방식으로 계산해 비교 (실제 사이트를 흉내)
      let body = ''; for await (const c of req) body += c;
      const ts = req.headers['x-ts'], nonce = req.headers['x-nonce'];
      const expect = defaultSign({ secret: 'SECRET123', ts, nonce, pathname: '/api/journal/search', search: '' });
      if (req.headers['x-sign'] !== expect) { res.writeHead(401).end('bad sign'); return; }
      const p = new URLSearchParams(body);
      if (!p.get('fy')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ total: 0, data: [] })); return; }
      const data = [
        { date: '20250103', voucher_no: 1, debit: 50000, credit: 0, memo: '점심' },
        { date: '20250103', voucher_no: 1, debit: 0, credit: 50000, memo: '점심' },
        { date: '20250105', voucher_no: 2, debit: 1100000, credit: 0, memo: '대금' },
        { date: '20250105', voucher_no: 2, debit: 0, credit: 1100000, memo: '대금' },
      ];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ total: 2, data }));
    } else if (url.pathname === '/blocked') {
      res.writeHead(403).end('blocked');
    } else if (url.pathname === '/notice') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><meta charset=utf8>
        <span class="total-count">2</span>
        <table class="result"><tbody>
          <tr><td>1</td><td>공지 A</td><td>2025-03-01</td><td>총무</td></tr>
          <tr><td>2</td><td>공지 B</td><td>2025-03-02</td><td>재무</td></tr>
        </tbody></table>`);
    } else { res.writeHead(404).end(); }
  });
  return new Promise(r => server.listen(0, () => r({ server, port: server.address().port })));
}

(async () => {
  const { server, port } = await startServer();
  const base = `http://localhost:${port}`;

  // 1) http-replay + 서명 + 완전성(전표수·차대변합)
  console.log('http-replay:');
  const httpRecipe = {
    id: 'local/journal', executor: 'http-replay', method: 'POST', url: `${base}/api/journal/search`,
    headers: {}, credentials: [{ name: 'secret', from: 'cookie', key: 'SID', use: 'sign.secret' }],
    dynamic: [{ name: 'ts', gen: 'unixSeconds', use: 'header:x-ts' }, { name: 'nonce', gen: 'uuid4hex', use: 'header:x-nonce' }],
    sign: { header: 'x-sign' },
    params: [{ name: 'start_date', role: 'userParam', required: true }, { name: 'end_date', role: 'userParam', required: true },
             { name: 'fy', role: 'required', from: 'org.fy' }, { name: 'dept', role: 'ignored' }],
    response: { rows: '$.data[*]', completeness: [{ field: '$.total', equals: 'uniqueCount(date,voucher_no)' }, { rule: 'sum(rows.debit)==sum(rows.credit)' }] },
  };
  const session = { cookies: { SID: 'SECRET123' }, org: { fy: '3' } };
  const r1 = await runRecipe(httpRecipe, session, { start_date: '20250101', end_date: '20250131' });
  ok('4행 반환', r1.rows.length === 4);
  ok('executor=http-replay', r1.meta.executor === 'http-replay');
  ok('완전성 2개 통과', r1.meta.verified.length === 2);

  // 1b) 서명 틀리면(시크릿 없음) 자격증명 누락으로 실패
  try { await runRecipe(httpRecipe, { cookies: {}, org: { fy: '3' } }, { start_date: '1', end_date: '2' }); ok('자격증명 누락 감지', false); }
  catch (e) { ok('자격증명 누락 감지', /자격증명 누락/.test(e.message)); }

  // 1c) fy 빠지면 0건 → 완전성 규칙(sum)은 0==0 통과하지만 total==uniqueCount(0)도 통과. 대신 required 파라미터 검증
  //     여기서는 fy 를 ignored 가 아닌 required+from 으로 두어 session 에서 채워지는지 확인됨(위 통과). 생략.

  // 2) ui-automation (Playwright, 로컬 HTML 표)
  console.log('ui-automation:');
  const uiRecipe = {
    id: 'local/notice', executor: 'ui-automation',
    steps: [{ goto: `${base}/notice` }, { waitFor: 'table.result tbody tr' },
            { extractTable: { selector: 'table.result', columns: { no: 0, title: 1, date: 2, dept: 3 } } }],
    params: [], response: { completeness: [{ rule: 'rows.length > 0' }] },
  };
  try {
    const r2 = await runRecipe(uiRecipe, {}, {});
    ok('표 2행 추출', r2.rows.length === 2);
    ok('컬럼 매핑', r2.rows[0].title === '공지 A' && r2.rows[1].dept === '재무');
    ok('executor=ui-automation', r2.meta.executor === 'ui-automation');
  } catch (e) { ok('ui-automation 실행', false); console.log('   ', e.message); }

  // 3) file executor — 실제 xlsx 생성 후 파싱
  console.log('file:');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('s');
  ws.addRow(['일자', '금액', '적요']); ws.addRow(['2025-09-01', 1000, 'a']); ws.addRow(['2025-09-02', 2000, 'b']);
  const buf = await wb.xlsx.writeBuffer();
  const fileRecipe = { id: 'local/file', executor: 'file',
    parser: { type: 'xlsx', sheet: 0, headerRowContains: ['일자', '금액'], columns: { date: '일자', amount: '금액', memo: '적요' } },
    response: { completeness: [{ rule: 'rows.length > 0' }] } };
  const r3 = await runRecipe(fileRecipe, {}, {}, { fileBuffer: Buffer.from(buf) });
  ok('xlsx 2행', r3.rows.length === 2);
  ok('헤더 매핑', r3.rows[0].date === '2025-09-01' && r3.rows[1].amount === 2000);

  // 4) 완전성 실패 → 에러
  console.log('completeness guard:');
  const badRecipe = { ...fileRecipe, response: { completeness: [{ rule: 'rows.length == 99' }] } };
  try { await runRecipe(badRecipe, {}, {}, { fileBuffer: Buffer.from(buf) }); ok('완전성 실패 감지', false); }
  catch (e) { ok('완전성 실패 감지', /완전성 규칙 실패/.test(e.message)); }

  // 5) 강등: 403 → (여기선 다음 단들이 미구현이라 마지막에 에러) demote 플래그 경로 확인
  console.log('auto-demotion:');
  const blockRecipe = { id: 'local/blocked', executor: 'http-replay', method: 'GET', url: `${base}/blocked`, headers: {}, response: { completeness: [] } };
  try { await runRecipe(blockRecipe, {}, {}); ok('403 강등 경로', false); }
  catch (e) { ok('403→강등 시도(미구현 단에서 멈춤)', /미구현|browser-fetch/.test(e.message)); }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
