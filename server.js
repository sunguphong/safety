// 안전보건 입찰 평가표 - 공동 편집 웹서버
//
// 사내 전용 실행 (기존과 동일, 비밀번호 없음):
//   node server.js
//
// 인터넷 공개 실행 (비밀번호 로그인 필요):
//   PowerShell:  $env:SAFETY_PASSWORD="비밀번호"; node server.js
//   또는 start-public.ps1 실행
//
// 데이터는 같은 폴더의 data.json 에 저장됩니다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const PASSWORD = process.env.SAFETY_PASSWORD || '';
const AUTH_ON = PASSWORD.length > 0;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');

// 브라우저로 절대 내려주면 안 되는 파일 (서버 소스 / 원본 데이터 / 설정)
const DENY_FILES = new Set([
  'server.js', 'server.js.bak', 'data.json',
  'package.json', 'package-lock.json', 'ngrok.yml',
  'start-public.ps1', 'start-public-cloudflare.ps1',
  'scenarios.json',
]);
// 내려줄 수 있는 확장자만 허용
const ALLOW_EXT = new Set(['.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico']);

let store = { version: 0, rows: null };
try { store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { /* 첫 실행 */ }

function saveStore() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 1), 'utf8');
}

// ---------- 저장된 시뮬레이션 ----------

const SCEN_FILE = path.join(ROOT, 'scenarios.json');
const MAX_SCENARIOS = 100;
const MAX_ROWS = 300;

let scenarios = { items: [] };
try {
  const parsed = JSON.parse(fs.readFileSync(SCEN_FILE, 'utf8'));
  if (Array.isArray(parsed.items)) scenarios = parsed;
} catch (e) { /* 첫 실행 */ }

function saveScenarios() {
  fs.writeFileSync(SCEN_FILE, JSON.stringify(scenarios, null, 1), 'utf8');
}

// 평가표 행을 알려진 6개 항목만 남기고 정리 (엉뚱한 데이터 저장 방지)
function cleanRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return null;
  return rows.map(r => {
    const o = r && typeof r === 'object' ? r : {};
    const s = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n);
    return {
      code: s(o.code, 50),
      name: s(o.name, 100),
      level: ['상', '중', '하'].includes(o.level) ? o.level : '',
      dsafe: s(o.dsafe, 20),
      hurdle: s(o.hurdle, 20),
      bid: s(o.bid, 30),
    };
  });
}

// ---------- 로그인 세션 ----------

const SESSION_MS = 12 * 60 * 60 * 1000;     // 로그인 유지 12시간
const sessions = new Map();                  // sid -> 만료시각

function newSession() {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, Date.now() + SESSION_MS);
  return sid;
}

function validSession(sid) {
  if (!sid) return false;
  const exp = sessions.get(sid);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(sid); return false; }
  return true;
}

// 비밀번호 비교 (길이 노출 방지를 위해 해시끼리 비교)
const PW_HASH = crypto.createHash('sha256').update(PASSWORD).digest();
function passwordOk(input) {
  const h = crypto.createHash('sha256').update(String(input)).digest();
  return crypto.timingSafeEqual(h, PW_HASH);
}

// 비밀번호 무차별 대입 차단: IP당 10회 실패 시 10분 잠금
const failures = new Map();                  // ip -> { count, until }
const MAX_FAILS = 10;
const LOCK_MS = 10 * 60 * 1000;

function isLocked(ip) {
  const f = failures.get(ip);
  return !!(f && f.until > Date.now());
}
function noteFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.count = 0; }
  failures.set(ip, f);
}

// ---------- 접속자 추적 ----------

const clients = new Map();                   // IP -> 마지막 요청 시각
const ACTIVE_MS = 10000;

function normIp(addr) {
  return String(addr || '').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
}

// 터널(ngrok 등)을 거치면 실제 접속자 IP는 X-Forwarded-For 에 담겨 옵니다.
function clientIpOf(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return normIp(String(xff).split(',')[0].trim());
  return normIp(req.socket.remoteAddress);
}

// 인터넷 공개 시 다른 사람의 IP는 뒤 두 자리를 가립니다.
function maskIp(ip) {
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.*.*` : ip;
}

// ---------- 유틸 ----------

function cookieOf(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function readBody(req, limit, cb) {
  let body = '';
  req.on('data', c => {
    body += c;
    if (body.length > limit) { req.destroy(); }
  });
  req.on('end', () => cb(body));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function loginPage(message) {
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>안전보건 입찰 평가 - 로그인</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#f4f6f8; font-family:"Malgun Gothic","맑은 고딕",system-ui,sans-serif; color:#222; }
  .box { background:#fff; padding:36px 32px; border-radius:10px; width:320px;
         box-shadow:0 2px 16px rgba(0,0,0,.09); text-align:center; }
  h1 { font-size:18px; margin:0 0 6px; }
  p.sub { font-size:13px; color:#666; margin:0 0 22px; }
  input { width:100%; box-sizing:border-box; padding:11px 12px; font-size:15px;
          border:1px solid #ccd2d8; border-radius:6px; margin-bottom:12px; }
  input:focus { outline:none; border-color:#2f6fed; }
  button { width:100%; padding:11px; font-size:15px; font-weight:600; color:#fff;
           background:#2f6fed; border:0; border-radius:6px; cursor:pointer; }
  button:hover { background:#255ccc; }
  .msg { color:#c0392b; font-size:13px; margin-bottom:12px; }
</style></head>
<body>
  <form class="box" method="POST" action="/login">
    <h1>안전보건 입찰 평가표</h1>
    <p class="sub">열람하려면 비밀번호를 입력하세요.</p>
    ${message ? `<div class="msg">${message}</div>` : ''}
    <input type="password" name="password" placeholder="비밀번호" autofocus autocomplete="current-password">
    <button type="submit">들어가기</button>
  </form>
</body></html>`;
}

function sendHtml(res, code, html, extraHeaders) {
  res.writeHead(code, Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }, extraHeaders || {}));
  res.end(html);
}

// ---------- 서버 ----------

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const clientIp = clientIpOf(req);

  // ----- 인증 (SAFETY_PASSWORD 가 설정된 경우에만 동작) -----
  if (AUTH_ON) {
    const loggedIn = validSession(cookieOf(req, 'sid'));

    if (urlPath === '/login') {
      if (loggedIn) { res.writeHead(302, { Location: '/' }); res.end(); return; }
      if (req.method === 'GET') { sendHtml(res, 200, loginPage('')); return; }
      if (req.method === 'POST') {
        if (isLocked(clientIp)) {
          sendHtml(res, 429, loginPage('시도 횟수를 초과했습니다. 10분 후 다시 시도하세요.'));
          return;
        }
        readBody(req, 4096, body => {
          const params = new URLSearchParams(body);
          if (passwordOk(params.get('password') || '')) {
            failures.delete(clientIp);
            const cookie = `sid=${newSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}` +
              (isHttps(req) ? '; Secure' : '');
            res.writeHead(302, { Location: '/', 'Set-Cookie': cookie, 'Cache-Control': 'no-store' });
            res.end();
          } else {
            noteFailure(clientIp);
            sendHtml(res, 401, loginPage('비밀번호가 올바르지 않습니다.'));
          }
        });
        return;
      }
      res.writeHead(405); res.end(); return;
    }

    if (urlPath === '/logout') {
      sessions.delete(cookieOf(req, 'sid'));
      res.writeHead(302, { Location: '/login', 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
      res.end();
      return;
    }

    if (!loggedIn) {
      if (urlPath.startsWith('/api/')) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"error":"login required"}');
      } else {
        res.writeHead(302, { Location: '/login' });
        res.end();
      }
      return;
    }
  }

  // 여기부터는 인증 통과(또는 사내 모드)
  clients.set(clientIp, Date.now());

  // ----- 접속자 정보 API -----
  if (urlPath === '/api/clients' && req.method === 'GET') {
    const now = Date.now();
    for (const [ip, t] of clients) if (now - t > 60000) clients.delete(ip);
    const active = [...clients.entries()]
      .filter(([, t]) => now - t < ACTIVE_MS)
      .map(([ip]) => ip)
      .sort()
      // 인터넷 공개 모드에서는 남의 IP를 가려서 보여줍니다.
      .map(ip => (AUTH_ON && ip !== clientIp ? maskIp(ip) : ip));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ you: clientIp, clients: active }));
    return;
  }

  // ----- 공유 데이터 API -----
  if (urlPath === '/api/data') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(store));
      return;
    }
    if (req.method === 'POST') {
      readBody(req, 1e6, body => {
        try {
          const rows = cleanRows(JSON.parse(body).rows);
          if (!rows) throw new Error('bad rows');
          store = { version: store.version + 1, rows };
          saveStore();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ version: store.version }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"bad request"}');
        }
      });
      return;
    }
    res.writeHead(405); res.end(); return;
  }

  // ----- 저장된 시뮬레이션 목록 / 새로 저장 -----
  if (urlPath === '/api/scenarios') {
    if (req.method === 'GET') {
      const items = scenarios.items.map(it => ({ id: it.id, name: it.name, savedAt: it.savedAt }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ items }));
      return;
    }
    if (req.method === 'POST') {
      readBody(req, 1e6, body => {
        try {
          const payload = JSON.parse(body);
          const name = String(payload.name || '').trim().slice(0, 60);
          const rows = cleanRows(payload.rows);
          if (!name) throw new Error('name required');
          if (!rows) throw new Error('bad rows');

          const savedAt = new Date().toISOString();
          const existing = scenarios.items.find(it => it.name === name);
          let id;
          if (existing) {
            // 같은 이름이면 덮어쓰기
            existing.rows = rows;
            existing.savedAt = savedAt;
            id = existing.id;
          } else {
            if (scenarios.items.length >= MAX_SCENARIOS) throw new Error('too many');
            id = crypto.randomBytes(8).toString('hex');
            scenarios.items.push({ id, name, savedAt, rows });
          }
          saveScenarios();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ id, name, savedAt, overwritten: !!existing }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(405); res.end(); return;
  }

  // ----- 저장된 시뮬레이션 하나 불러오기 / 삭제 -----
  if (urlPath.startsWith('/api/scenarios/')) {
    const id = urlPath.slice('/api/scenarios/'.length);
    const idx = scenarios.items.findIndex(it => it.id === id);
    if (idx === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    if (req.method === 'GET') {
      const it = scenarios.items[idx];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ id: it.id, name: it.name, savedAt: it.savedAt, rows: it.rows }));
      return;
    }
    if (req.method === 'DELETE') {
      scenarios.items.splice(idx, 1);
      saveScenarios();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(405); res.end(); return;
  }

  // ----- 정적 파일 -----
  const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(ROOT, safePath === '\\' || safePath === '/' ? 'index.html' : safePath);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'index.html')) {
    res.writeHead(403); res.end(); return;
  }

  const base = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (DENY_FILES.has(base) || base.startsWith('.') || !ALLOW_EXT.has(ext)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log(AUTH_ON
    ? '보호 모드: 비밀번호 로그인이 필요합니다. (인터넷 공개용)'
    : '사내 모드: 비밀번호 없음 — 같은 네트워크에서 누구나 접속/수정 가능합니다.');
});
