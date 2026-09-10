// runner.cjs — recipe.json 을 executor 에 따라 실행하는 공통 러너.
// 모든 executor 는 같은 계약을 돌려준다: { rows, files, meta }.
// 자격증명(session)은 메모리에만 두고 어느 executor 도 디스크에 쓰지 않는다.
'use strict';
const crypto = require('crypto');

// ── 동적값 생성기 ──────────────────────────────────────────────
const GEN = {
  unixSeconds: () => String(Math.floor(Date.now() / 1000)),
  uuid4hex: () => crypto.randomUUID().replace(/-/g, ''),
};

// ── 완전성 규칙 평가 (executor 와 무관하게 적용) ────────────────
// rule 은 작은 표현식 언어. 지원: rows.length, sum(rows.field), between, ==, <=, >=, all(...)
function evalCompleteness(rules, ctx) {
  const passed = [];
  for (const r of rules || []) {
    const rule = r.rule || JSON.stringify(r);
    let ok = false;
    try { ok = evalRule(r, ctx); } catch (e) { ok = false; }
    if (!ok) throw new Error(`완전성 규칙 실패: ${rule}`);
    passed.push(rule);
  }
  return passed;
}
function num(v) { return typeof v === 'number' ? v : parseFloat(String(v).replace(/[,\s]/g, '')) || 0; }
function evalRule(r, ctx) {
  const { rows, raw } = ctx;
  if (r.field && r.equals) {
    const left = num(jsonPathValue(raw, r.field)); // 원시 응답에서 $.total 등을 읽는다
    if (r.equals.startsWith('uniqueCount(')) {
      const keys = r.equals.slice('uniqueCount('.length, -1).split(',').map(s => s.trim());
      const set = new Set(rows.map(row => keys.map(k => row[k]).join('|')));
      return left === set.size;
    }
    return left === num(r.equals);
  }
  const rule = r.rule;
  if (!rule) return true;
  let m;
  if ((m = rule.match(/^rows\.length\s*(==|>=|<=|>|<)\s*(\d+)$/))) return cmp(rows.length, m[1], +m[2]);
  if ((m = rule.match(/^rows\.length\s+between\s+(\d+)\s+and\s+(\d+)$/))) return rows.length >= +m[1] && rows.length <= +m[2];
  if ((m = rule.match(/^rows\.length\s*>\s*0$/))) return rows.length > 0;
  if ((m = rule.match(/^sum\(rows\.(\w+)\)\s*==\s*sum\(rows\.(\w+)\)$/)))
    return Math.abs(rows.reduce((s, x) => s + num(x[m[1]]), 0) - rows.reduce((s, x) => s + num(x[m[2]]), 0)) < 1e-6;
  if ((m = rule.match(/^all\(rows,\s*r\s*=>\s*r\.(\w+)\s*>=\s*params\.(\w+)\s*&&\s*r\.(\w+)\s*<=\s*params\.(\w+)\)$/)))
    return rows.every(row => String(row[m[1]]) >= String(ctx.params[m[2]]) && String(row[m[3]]) <= String(ctx.params[m[4]]));
  if (rule === 'schemaValid(rows)') return ctx.schemaValid !== false;
  // 알 수 없는 규칙은 통과시키지 않는다 (조용한 오탐 방지)
  throw new Error(`알 수 없는 완전성 규칙: ${rule}`);
}
function cmp(a, op, b) { return op === '==' ? a === b : op === '>=' ? a >= b : op === '<=' ? a <= b : op === '>' ? a > b : a < b; }
function jsonPathValue(obj, path) { // "$.total" / "$.a.b"
  const parts = String(path).replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cur = obj; for (const p of parts) cur = cur?.[p]; return cur;
}

// ── 파라미터/자격증명/동적값으로 요청 조립 ─────────────────────
function resolveCredentials(recipe, session) {
  const out = {};
  for (const c of recipe.credentials || []) {
    const v = c.from === 'cookie' ? session.cookies?.[c.key] : session[c.name];
    if (!v) throw new Error(`자격증명 누락: ${c.name} (${c.from}:${c.key || c.name})`);
    out[c.name] = v;
  }
  return out;
}
function buildHttp(recipe, session, params, signImpl) {
  const creds = resolveCredentials(recipe, session);
  const dyn = Object.fromEntries((recipe.dynamic || []).map(d => [d.name, GEN[d.gen]()]));
  const headers = { ...(recipe.headers || {}) };
  const body = {};
  for (const p of recipe.params || []) {
    if (p.role === 'userParam') {
      if (p.required && params[p.name] == null) throw new Error(`필수 파라미터: ${p.name}`);
      if (params[p.name] != null) body[p.name] = params[p.name];
    } else if (p.role === 'omitIfUnused') {
      if (params[p.name]) body[p.name] = params[p.name];
    } else if (p.role === 'ignored') {
      /* 보내도 되고 안 보내도 됨 — 생략 */
    } else if (p.from) {
      const [ns, key] = p.from.split('.');
      body[p.name] = params[p.from] ?? session[p.from] ?? session[ns]?.[key];
    }
  }
  for (const c of recipe.credentials || []) {
    const [where, key, prefix = ''] = c.use.split(':');
    if (where === 'header') headers[key] = prefix + creds[c.name];
    if (where === 'body') body[key] = creds[c.name];
  }
  for (const d of recipe.dynamic || []) {
    const [where, key] = d.use.split(':');
    if (where === 'header') headers[key] = dyn[d.name];
    if (where === 'body') body[key] = dyn[d.name];
  }
  if (recipe.sign) {
    const url = new URL(recipe.url);
    headers[recipe.sign.header] = signImpl({ ...dyn, ...creds, pathname: url.pathname, search: url.search });
  }
  return { method: recipe.method, url: recipe.url, headers, body, dyn };
}
function pluck(obj, jsonPathStar) {
  // 아주 작은 JSONPath: "$.data[*]" 또는 "$.a.b[*]"
  const parts = jsonPathStar.replace(/^\$\.?/, '').replace(/\[\*\]$/, '').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) cur = cur?.[p];
  return Array.isArray(cur) ? cur : [];
}

// ── executor 구현 ──────────────────────────────────────────────
const EXECUTORS = {
  async 'http-replay'(recipe, session, params, opt) {
    const req = buildHttp(recipe, session, params, opt.signImpl || defaultSign);
    const res = await fetch(req.url, {
      method: req.method,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...req.headers },
      body: req.method === 'GET' ? undefined : new URLSearchParams(req.body).toString(),
      signal: AbortSignal.timeout(opt.timeoutMs || 30000),
    });
    const text = await res.text();
    if (!res.ok) {
      if ([403, 429].includes(res.status)) { const e = new Error(`HTTP ${res.status} — 차단/제한, 강등 필요`); e.demote = true; throw e; }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text);
    const rows = recipe.response?.rows ? pluck(json, recipe.response.rows) : (Array.isArray(json) ? json : []);
    return { rows, files: [], raw: json };
  },

  async file(recipe, session, params, opt) {
    const buf = opt.fileBuffer || require('fs').readFileSync(params._file || recipe._file);
    const p = recipe.parser || recipe.then?.parser;
    if (p?.type === 'xlsx') return parseXlsx(buf, p);
    if (p?.type === 'csv') return parseCsv(buf.toString('utf8'), p);
    throw new Error(`지원하지 않는 파서: ${p?.type}`);
  },

  async 'ui-automation'(recipe, session, params, opt) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const ctx = await browser.newContext({ storageState: opt.storageState });
    const page = await ctx.newPage();
    page.setDefaultTimeout(opt.timeoutMs || 15000);
    const rows = [];
    try {
      for (const step of recipe.steps) {
        if (step.goto) await page.goto(subst(step.goto, params), { waitUntil: 'domcontentloaded' });
        else if (step.fill) await page.fill(step.fill[0], subst(step.fill[1], params));
        else if (step.click) await page.click(step.click);
        else if (step.waitFor) await page.waitForSelector(step.waitFor);
        else if (step.extractTable) {
          let more = true, pages = 0;
          while (more) {
            const pageRows = await page.$$eval(step.extractTable.selector + ' tbody tr', (trs, cols) =>
              trs.map(tr => { const td = tr.querySelectorAll('td'); const o = {};
                for (const [k, i] of Object.entries(cols)) o[k] = td[i]?.innerText.trim(); return o; }), step.extractTable.columns);
            rows.push(...pageRows);
            const pg = recipe.steps.find(s => s.paginate)?.paginate;
            if (pg && pages < pg.max) { const nx = page.locator(pg.next); more = await nx.count() > 0 && await nx.first().isVisible().catch(() => false); if (more) { await nx.first().click(); await page.waitForTimeout(400); pages++; } }
            else more = false;
          }
        }
      }
    } finally { await browser.close().catch(() => {}); }
    return { rows, files: [] };
  },

  // 아래는 계약만 지키는 명시적 미구현 — 조용히 통과시키지 않고 무엇이 필요한지 알린다
  async 'browser-fetch'() { const e = new Error('browser-fetch: 미구현. ego-lite browserFetch()/Playwright page.evaluate(fetch) 로 페이지 컨텍스트에서 호출하도록 채울 것'); e.notImplemented = true; throw e; },
  async agent() { const e = new Error('agent: 미구현. ego-lite/Aside/Claude 브라우저에 task+outputSchema 를 주고 결과를 스키마로 검증하도록 채울 것'); e.notImplemented = true; throw e; },
  async mail() { const e = new Error('mail: 미구현. IMAP/Graph/Gmail 검색 → 첨부 → file executor 로 연결'); e.notImplemented = true; throw e; },
  async desktop() { const e = new Error('desktop: 미구현. Windows UIA / macOS AX 접근성 트리 조작'); e.notImplemented = true; throw e; },
  async human() { const e = new Error('human: 작업 큐에 사람 과업 생성 (비동기). 큐 백엔드 연결 필요'); e.notImplemented = true; throw e; },
};

function defaultSign({ secret, wehagoS, ts, timestamp, nonce, pathname, search }) {
  const s = secret ?? wehagoS ?? ''; const t = String(ts ?? timestamp ?? '');
  const dk = crypto.createHash('sha256').update(s + t).digest('base64');
  return crypto.createHmac('sha256', Buffer.from(dk)).update((pathname || '') + (search || '') + t + (nonce || '')).digest('base64');
}
function subst(s, params) { return String(s).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? ''); }

function parseXlsx(buf, p) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  return wb.xlsx.load(buf).then(() => {
    const ws = wb.worksheets[typeof p.sheet === 'number' ? p.sheet : 0];
    const grid = [];
    ws.eachRow(r => grid.push(r.values.slice(1).map(c => (c && c.text) ? c.text : c)));
    let hi = 0;
    if (p.headerRowContains) hi = grid.findIndex(row => p.headerRowContains.every(h => row.some(c => String(c ?? '').includes(h))));
    const headers = grid[hi].map(c => String(c ?? '').trim());
    const idx = {}; for (const [k, name] of Object.entries(p.columns)) idx[k] = headers.indexOf(name);
    const rows = grid.slice(hi + 1).filter(r => r.some(c => c != null && c !== ''))
      .map(r => Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, i >= 0 ? r[i] : null])));
    return { rows, files: [] };
  });
}
function parseCsv(text, p) {
  const lines = text.trim().split(/\r?\n/).map(l => l.split(','));
  const headers = lines[0].map(s => s.trim());
  const idx = {}; for (const [k, name] of Object.entries(p.columns)) idx[k] = headers.indexOf(name);
  const rows = lines.slice(1).map(r => Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, r[i]])));
  return { rows, files: [] };
}

// ── 공개 API ───────────────────────────────────────────────────
const LADDER = ['http-replay', 'browser-fetch', 'ui-automation', 'agent', 'file', 'mail', 'desktop', 'human'];

async function runRecipe(recipe, session = {}, params = {}, opt = {}) {
  const t0 = Date.now();
  const start = recipe.executor || 'http-replay';
  let ex = start, demotedFrom;
  for (;;) {
    const fn = EXECUTORS[ex];
    if (!fn) throw new Error(`알 수 없는 executor: ${ex}`);
    try {
      const out = await fn(recipe, session, params, opt);
      const verified = evalCompleteness(recipe.response?.completeness, { rows: out.rows, raw: out.raw, params, schemaValid: out.schemaValid });
      return { rows: out.rows, files: out.files || [], meta: { executor: ex, demotedFrom, verified, durationMs: Date.now() - t0 } };
    } catch (e) {
      if (opt.noDemote || !e.demote) throw e;         // 강등은 명시적으로 강등 가능한 오류에서만
      const next = LADDER[LADDER.indexOf(ex) + 1];
      if (!next) throw e;
      demotedFrom = demotedFrom || ex; ex = next;      // 한 단 아래로
    }
  }
}

module.exports = { runRecipe, buildHttp, defaultSign, evalCompleteness, LADDER, EXECUTORS };
