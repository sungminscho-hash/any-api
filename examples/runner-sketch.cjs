// runner-sketch.cjs — recipe.json 을 실행하는 공통 러너의 뼈대 (설계 확인용, 실제 서비스 호출 없음)
// 실제 구현은 로드맵 3단계에서 채운다. 여기서는 레시피가 어떤 정보를 담아야 하는지 보여 주는 게 목적이다.
'use strict';
const crypto = require('crypto');

const GEN = {
  unixSeconds: () => String(Math.floor(Date.now() / 1000)),
  uuid4hex: () => crypto.randomUUID().replace(/-/g, ''),
};

// session = 브라우저에서 방금 캡처한 자격증명 {cookies: {name: value}} — 메모리에만 둔다
function resolveCredentials(recipe, session) {
  const out = {};
  for (const c of recipe.credentials) {
    const v = c.from === 'cookie' ? session.cookies[c.key] : undefined;
    if (!v) throw new Error(`자격증명 누락: ${c.name} (${c.from}:${c.key})`);
    out[c.name] = v;
  }
  return out;
}

function buildRequest(recipe, session, userParams, signImpl) {
  const creds = resolveCredentials(recipe, session);
  const dyn = Object.fromEntries(recipe.dynamic.map(d => [d.name, GEN[d.gen]()]));
  const headers = { ...recipe.headers };
  const body = {};

  for (const p of recipe.params) {
    if (p.role === 'userParam') {
      if (p.required && userParams[p.name] == null) throw new Error(`필수 파라미터: ${p.name}`);
      if (userParams[p.name] != null) body[p.name] = userParams[p.name];
    } else if (p.role === 'omitIfUnused') {
      if (userParams[p.name]) body[p.name] = userParams[p.name]; // 빈값이면 키 자체를 뺀다
    } else if (p.from) {
      body[p.name] = userParams[p.from] ?? session[p.from];
    }
  }
  for (const c of recipe.credentials) {
    const [where, key, prefix = ''] = c.use.split(':');
    if (where === 'header') headers[key] = prefix + creds[c.name];
    if (where === 'body') body[key] = creds[c.name];
  }
  for (const d of recipe.dynamic) {
    const [where, key] = d.use.split(':');
    if (where === 'header') headers[key] = dyn[d.name];
    if (where === 'body') body[key] = dyn[d.name];
  }
  if (recipe.sign) {
    const url = new URL(recipe.url);
    headers[recipe.sign.header] = signImpl({ ...dyn, secret: creds.secret, pathname: url.pathname, search: url.search });
  }
  return { method: recipe.method, url: recipe.url, headers, body };
}

module.exports = { buildRequest };

if (require.main === module) {
  const recipe = require('../recipes/example-erp/journal.recipe.json');
  const fakeSession = { cookies: { '<AUTH_COOKIE_NAME>': 'demo-bearer', '<SESSION_SECRET_COOKIE>': 'demo-secret' }, 'org.id': 'ORG1', 'org.fy': '3' };
  const req = buildRequest(recipe, fakeSession, { start_date: '20250101', end_date: '20250930', filter: '' },
    ({ secret, ts, nonce, pathname, search }) => crypto.createHmac('sha256', secret + ts).update(pathname + search + ts + nonce).digest('base64'));
  console.log(JSON.stringify(req, null, 2)); // filter 는 빈값이라 body 에 없어야 한다 (omitIfUnused)
}
