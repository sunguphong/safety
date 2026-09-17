// 안전보건 입찰 평가 — 설계도(설계도.PNG) 기준 자동 계산 + 서버 공동 편집
//  환산          = 20 × (D-Safe점수 / 100)
//  소계          = 환산 + 안전Hurdle(가감점)
//  가격점수      = 80 × 최저 입찰액 / 해당업체 입찰액
//  안전보건점수  = 20 × (D-Safe점수 / 100) + 안전Hurdle점수
//  종합평가결과  = 가격점수 + 안전보건점수 → 높은 순으로 입찰순위
//  D-Safe 미입력 업체: 업체수준 상=최고점 / 중=평균점 / 하=최하점 (미참여 업체 점수는 제외)
//
// 공동 편집: 수정하면 0.6초 뒤 서버(/api/data)에 자동 저장되고,
// 다른 접속자의 변경은 2.5초 주기 폴링으로 자동 반영됩니다.
// 서버가 없으면(GitHub Pages 등) 브라우저 저장 모드로 동작합니다 — 데이터는 이 브라우저(localStorage)에만 저장됩니다.

// 예시 데이터 목록 — 새 예시를 추가하려면 같은 형식의 json 파일을 만들고 여기에 한 줄 추가하면 됩니다.
const SAMPLES = [
  { label: '예시 데이터', file: 'sample.json' },
];

// 파일을 못 읽는 경우(file:// 등)를 대비한 기본값 (가상의 예시 업체)
const FALLBACK_ROWS = [
  { code: '900001', name: '가나건설(주)',     level: '',  dsafe: '79.6', hurdle: '1',  bid: '18500000' },
  { code: '900002', name: '(주)다라산업',     level: '',  dsafe: '77.6', hurdle: '0',  bid: '17900000' },
  { code: '900003', name: '(주)마바테크',     level: '',  dsafe: '75.9', hurdle: '-1', bid: '' },
  { code: '900004', name: '사아엔지니어링',   level: '하', dsafe: '',    hurdle: '-1', bid: '18700000' },
  { code: '900005', name: '자차플랜트(주)',   level: '중', dsafe: '',    hurdle: '0',  bid: '18200000' },
  { code: '900006', name: '(주)카타이엔에스', level: '상', dsafe: '',    hurdle: '1',  bid: '18000000' },
];

// ---------- 브라우저 저장 (서버가 없을 때) ----------

const LS_DATA = 'safety.data';
const LS_SCEN = 'safety.scenarios';

function lsGet(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch (e) { return fallback; }
}

function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}

async function fetchSampleRows(file) {
  try {
    const res = await fetch(file);
    if (!res.ok) return null;
    const d = await res.json();
    return Array.isArray(d.rows) && d.rows.length ? d.rows : null;
  } catch (e) { return null; }
}

async function loadSample(sample, save) {
  const rows = (await fetchSampleRows(sample.file)) || FALLBACK_ROWS;
  renderRows(rows);
  if (save) scheduleSave();
}

const tbody = document.getElementById('eval-body');
const statusEl = document.getElementById('sync-status');

let online = false;        // 서버 연결 여부 (서버가 없으면 false → 브라우저 저장 모드)
let serverVersion = 0;     // 마지막으로 반영한 서버 데이터 버전
let saveTimer = null;
let lastEditAt = 0;

function setStatus(text, kind) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = 'sync-status' + (kind ? ' ' + kind : '');
}

function onEdited() {
  recalc();
  scheduleSave();
}

function createRow(data = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="strike"><input class="code-input" value="${data.code || ''}" placeholder="코드"></td>
    <td class="strike"><input class="name-input" value="${data.name || ''}" placeholder="업체명"></td>
    <td>
      <select class="level-input">
        <option value=""></option>
        <option value="상">상</option>
        <option value="중">중</option>
        <option value="하">하</option>
      </select>
    </td>
    <td class="strike"><input class="dsafe-input" type="number" step="0.1" min="0" max="100" value="${data.dsafe || ''}" placeholder="-"></td>
    <td class="calc conv-cell"></td>
    <td><input class="hurdle-input" type="number" step="1" value="${data.hurdle || ''}" placeholder="0"></td>
    <td class="calc subtotal-cell"></td>
    <td class="bid-cell"><input class="bid-input" value="${data.bid ? Number(data.bid).toLocaleString() : ''}" placeholder="미참여"></td>
    <td class="calc price-cell"></td>
    <td class="calc safety-cell"></td>
    <td class="calc total-cell"></td>
    <td class="calc rank-cell"></td>
    <td><button class="del-btn" title="행 삭제">✕</button></td>
  `;
  tr.querySelector('.level-input').value = data.level || '';
  tr.querySelector('.del-btn').addEventListener('click', () => { tr.remove(); onEdited(); });
  tr.querySelectorAll('input, select').forEach(el => el.addEventListener('input', onEdited));
  // 입찰금액: 포커스 해제 시 천단위 콤마 정리
  const bidInput = tr.querySelector('.bid-input');
  bidInput.addEventListener('blur', () => {
    const n = parseBid(bidInput.value);
    bidInput.value = n !== null ? n.toLocaleString() : '';
    recalc();
  });
  return tr;
}

function renderRows(rows) {
  tbody.innerHTML = '';
  rows.forEach(d => tbody.appendChild(createRow(d)));
  recalc();
}

function getRowsData() {
  return [...tbody.querySelectorAll('tr')].map(tr => {
    const bid = parseBid(tr.querySelector('.bid-input').value);
    return {
      code: tr.querySelector('.code-input').value,
      name: tr.querySelector('.name-input').value,
      level: tr.querySelector('.level-input').value,
      dsafe: tr.querySelector('.dsafe-input').value,
      hurdle: tr.querySelector('.hurdle-input').value,
      bid: bid !== null ? String(bid) : '',
    };
  });
}

function parseBid(text) {
  const n = parseFloat(String(text).replace(/[^\d.]/g, ''));
  return isFinite(n) && n > 0 ? n : null;
}

function parseNum(text) {
  const n = parseFloat(text);
  return isFinite(n) ? n : null;
}

const fmt1 = n => (Math.round(n * 10) / 10).toFixed(1);

function recalc() {
  const rows = [...tbody.querySelectorAll('tr')].map(tr => {
    const dsafe = parseNum(tr.querySelector('.dsafe-input').value);
    return {
      tr,
      level: tr.querySelector('.level-input').value,
      dsafeInput: dsafe,
      hurdle: parseNum(tr.querySelector('.hurdle-input').value) || 0,
      bid: parseBid(tr.querySelector('.bid-input').value),
    };
  });

  // 자동 계산 풀: 직접 입력된 D-Safe점수 중 미참여(입찰금액 없음) 업체는 제외
  const pool = rows.filter(r => r.dsafeInput !== null && r.bid !== null).map(r => r.dsafeInput);

  rows.forEach(r => {
    r.auto = false;
    if (r.dsafeInput !== null) {
      r.dsafe = r.dsafeInput;
    } else if (r.level && pool.length > 0) {
      r.auto = true;
      if (r.level === '상') r.dsafe = Math.max(...pool);
      else if (r.level === '하') r.dsafe = Math.min(...pool);
      else r.dsafe = pool.reduce((a, b) => a + b, 0) / pool.length;
    } else {
      r.dsafe = null;
    }
  });

  const participants = rows.filter(r => r.bid !== null);
  const lowestBid = participants.length ? Math.min(...participants.map(r => r.bid)) : null;

  rows.forEach(r => {
    if (r.dsafe !== null) {
      r.conv = 20 * (r.dsafe / 100);            // 환산
      r.safety = r.conv + r.hurdle;             // 소계 = 안전보건점수
    } else {
      r.conv = r.safety = null;
    }
    if (r.bid !== null && lowestBid !== null) {
      r.price = 80 * lowestBid / r.bid;         // 가격점수
      r.total = r.safety !== null ? r.price + r.safety : null;
    } else {
      r.price = r.total = null;
    }
  });

  // 순위: 참여업체만, 종합평가결과 내림차순
  const ranked = participants.filter(r => r.total !== null)
    .slice().sort((a, b) => b.total - a.total);
  ranked.forEach((r, i) => { r.rank = i + 1; });

  rows.forEach(r => {
    const tr = r.tr;
    const absent = r.bid === null;
    tr.classList.toggle('absent', absent);

    const set = (sel, val, red) => {
      const td = tr.querySelector(sel);
      td.textContent = absent ? '' : (val !== null && val !== undefined ? val : '');
      td.classList.toggle('auto-calc', !absent && !!red);
    };

    set('.conv-cell',     r.conv   !== null ? fmt1(r.conv)   : '', r.auto);
    set('.subtotal-cell', r.safety !== null ? fmt1(r.safety) : '', r.auto);
    set('.price-cell',    r.price  !== null ? fmt1(r.price)  : '');
    set('.safety-cell',   r.safety !== null ? fmt1(r.safety) : '', r.auto);
    set('.total-cell',    r.total  !== null ? fmt1(r.total)  : '');
    set('.rank-cell',     r.rank ?? '');

    const bidTd = tr.querySelector('.bid-cell');
    bidTd.classList.toggle('lowest-bid', !absent && r.bid === lowestBid && participants.length > 1);
    bidTd.classList.toggle('absent-label', absent);
    tr.querySelector('.bid-input').placeholder = '미참여';

    tr.querySelector('.rank-cell').classList.toggle('rank-1', r.rank === 1);
    tr.querySelector('.total-cell').classList.toggle('top-total', r.rank === 1);
  });
}

// ---------- 서버 동기화 ----------

function scheduleSave() {
  lastEditAt = Date.now();
  setStatus('저장 중...', 'saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

async function saveNow() {
  if (!online) {
    if (lsSet(LS_DATA, { rows: getRowsData() })) {
      setStatus('이 브라우저에 저장됨 ' + new Date().toLocaleTimeString('ko-KR'), 'saved');
    } else {
      setStatus('저장 실패 — 브라우저 저장소를 사용할 수 없습니다', 'error');
    }
    return;
  }
  try {
    const res = await fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: getRowsData() }),
    });
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    serverVersion = d.version;
    setStatus('저장됨 ' + new Date().toLocaleTimeString('ko-KR'), 'saved');
  } catch (e) {
    setStatus('저장 실패 — 서버 연결을 확인하세요', 'error');
  }
}

async function poll() {
  if (!online) return;
  // 입력 중이거나 표 안에 커서가 있으면 덮어쓰지 않음 (내 편집이 곧 저장됨)
  const editing = Date.now() - lastEditAt < 1500 ||
    (document.activeElement && tbody.contains(document.activeElement));
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    if (d.version !== serverVersion && Array.isArray(d.rows)) {
      if (editing) return; // 다음 폴링 때 반영
      serverVersion = d.version;
      renderRows(d.rows);
      setStatus('다른 사용자의 변경 반영됨 ' + new Date().toLocaleTimeString('ko-KR'), 'saved');
    }
  } catch (e) {
    setStatus('서버 연결 끊김 — 재연결 시도 중...', 'error');
  }
}

// ---------- 접속 정보 ----------

async function pollClients() {
  const myIpEl = document.getElementById('my-ip');
  const listEl = document.getElementById('client-list');
  const countEl = document.getElementById('client-count');
  if (!online) {
    document.querySelector('.conn-info').style.display = 'none';  // 서버 없이는 접속자 정보가 없음
    return;
  }
  try {
    const res = await fetch('/api/clients');
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    myIpEl.textContent = d.you;
    countEl.textContent = d.clients.length;
    listEl.textContent = d.clients.length
      ? d.clients.map(ip => ip === d.you ? ip + ' (나)' : ip).join(', ')
      : '-';
  } catch (e) { /* 다음 주기에 재시도 */ }
}

// ---------- 접속 비밀번호 (브라우저 저장 모드 전용) ----------
// 서버 모드는 server.js 가 로그인을 처리합니다.
// 정적 사이트(GitHub Pages)는 코드가 공개되므로 우회 가능한 간이 잠금입니다.
// 비밀번호를 바꾸려면: node -e "console.log(require('crypto').createHash('sha256').update('새비밀번호').digest('hex'))"
// 로 나온 값을 아래에 넣으세요.
const PASSWORD_SHA256 = '0ffe1abd1a08215353c233d6e009613e95eec4253832a761af28ff37ac5a150c';
const SS_UNLOCK = 'safety.unlocked';

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function requirePassword() {
  try { if (sessionStorage.getItem(SS_UNLOCK) === PASSWORD_SHA256) return Promise.resolve(); } catch (e) { /* 저장소 사용 불가 */ }
  if (!window.crypto || !crypto.subtle) return Promise.resolve();  // https 가 아니면 해시 계산 불가

  const gate = document.getElementById('login-gate');
  const form = gate.querySelector('form');
  const input = gate.querySelector('input');
  const msg = gate.querySelector('.msg');
  gate.hidden = false;
  input.focus();

  return new Promise(resolve => {
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (await sha256Hex(input.value) === PASSWORD_SHA256) {
        try { sessionStorage.setItem(SS_UNLOCK, PASSWORD_SHA256); } catch (e) { /* 저장소 사용 불가 */ }
        gate.hidden = true;
        resolve();
      } else {
        msg.textContent = '비밀번호가 올바르지 않습니다.';
        input.select();
      }
    });
  });
}

async function init() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    online = true;
    if (Array.isArray(d.rows) && d.rows.length) {
      serverVersion = d.version;
      renderRows(d.rows);
    } else {
      await loadSample(SAMPLES[0], false);
      saveNow();
    }
    setStatus('공유 모드 — 연결됨', 'saved');
    await refreshScenarios();
    setInterval(poll, 2500);
    setInterval(refreshScenarios, 4000);
    pollClients();
    setInterval(pollClients, 3000);
  } catch (e) {
    // GitHub Pages / file:// 등 서버가 없는 경우: 브라우저 저장 모드
    online = false;
    await requirePassword();
    const saved = lsGet(LS_DATA, null);
    if (saved && Array.isArray(saved.rows)) renderRows(saved.rows);
    else await loadSample(SAMPLES[0], false);
    setStatus('브라우저 저장 모드 — 이 브라우저에만 저장됩니다', 'saved');
    await refreshScenarios();
    pollClients();
  }
  document.body.classList.remove('locked');
}

document.getElementById('add-row-btn').addEventListener('click', () => {
  tbody.appendChild(createRow());
  onEdited();
});

// ---------- 저장된 시뮬레이션 ----------

const sampleBox = document.getElementById('sample-buttons');

// 기본 예시 버튼
function makeSampleBtn(s) {
  const b = document.createElement('button');
  b.className = 'btn btn-ghost';
  b.textContent = s.label + ' 불러오기';
  b.addEventListener('click', () => {
    if (!confirm(`${whoseData()} "${s.label}" 데이터로 바뀝니다. 계속할까요?`)) return;
    loadSample(s, true);
  });
  return b;
}

function whoseData() {
  return online ? '모든 사용자의 데이터가' : '현재 데이터가';
}

// 저장된 시뮬레이션 버튼 (불러오기 + 삭제)
function makeSavedBtn(item) {
  const wrap = document.createElement('span');
  wrap.className = 'saved-item';

  const b = document.createElement('button');
  b.className = 'btn btn-saved';
  b.textContent = item.name + ' 불러오기';
  b.title = '저장 시각: ' + new Date(item.savedAt).toLocaleString('ko-KR');
  b.addEventListener('click', async () => {
    if (!confirm(`${whoseData()} "${item.name}" 으로 바뀝니다. 계속할까요?`)) return;
    try {
      let d;
      if (online) {
        const res = await fetch('/api/scenarios/' + item.id);
        if (!res.ok) throw new Error(res.status);
        d = await res.json();
      } else {
        d = lsGet(LS_SCEN, []).find(it => it.id === item.id);
        if (!d) throw new Error('not found');
      }
      renderRows(d.rows);
      scheduleSave();
      setStatus(`"${item.name}" 불러옴`, 'saved');
    } catch (e) {
      setStatus('불러오기 실패', 'error');
    }
  });

  const x = document.createElement('button');
  x.className = 'saved-del';
  x.textContent = '✕';
  x.title = '이 저장본 삭제';
  x.addEventListener('click', async () => {
    if (!confirm(`저장본 "${item.name}" 을 삭제할까요?`)) return;
    try {
      if (online) {
        const res = await fetch('/api/scenarios/' + item.id, { method: 'DELETE' });
        if (!res.ok) throw new Error(res.status);
      } else {
        lsSet(LS_SCEN, lsGet(LS_SCEN, []).filter(it => it.id !== item.id));
      }
      await refreshScenarios();
      setStatus(`"${item.name}" 삭제됨`, 'saved');
    } catch (e) {
      setStatus('삭제 실패', 'error');
    }
  });

  wrap.appendChild(b);
  wrap.appendChild(x);
  return wrap;
}

let savedSignature = '';
let renderSeq = 0;

// 버튼 목록을 한 번에 다시 그림 (지우기와 그리기 사이에 await 이 없어야 중복이 안 생김)
function renderScenarioButtons(items) {
  sampleBox.innerHTML = '';
  SAMPLES.forEach(s => sampleBox.appendChild(makeSampleBtn(s)));
  items.forEach(it => sampleBox.appendChild(makeSavedBtn(it)));
}

// 저장 직후 갱신과 주기적 갱신이 모두 이 함수를 사용합니다.
// 내용이 바뀌었을 때만 다시 그리고, 늦게 도착한 응답은 버립니다.
async function refreshScenarios() {
  if (!online) {
    savedSignature = '';
    renderScenarioButtons(lsGet(LS_SCEN, []));
    return;
  }
  const seq = ++renderSeq;
  try {
    const res = await fetch('/api/scenarios');
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    if (seq !== renderSeq) return;            // 더 최신 요청이 진행 중이면 무시
    const items = d.items || [];
    const sig = JSON.stringify(items.map(i => i.id + i.savedAt));
    if (sig === savedSignature) return;       // 변경 없으면 그대로 둠
    savedSignature = sig;
    renderScenarioButtons(items);
  } catch (e) { /* 다음 주기에 재시도 */ }
}

function defaultScenarioName() {
  const n = new Date();
  return `시뮬레이션 (${n.getMonth() + 1}/${n.getDate()})`;
}

async function saveScenario() {
  const name = (prompt('저장할 이름을 입력하세요', defaultScenarioName()) || '').trim();
  if (!name) return;

  const dup = [...sampleBox.querySelectorAll('.btn-saved')]
    .some(b => b.textContent === name + ' 불러오기');
  if (dup && !confirm(`"${name}" 이(가) 이미 있습니다. 덮어쓸까요?`)) return;

  if (!online) {
    const items = lsGet(LS_SCEN, []);
    const savedAt = new Date().toISOString();
    const existing = items.find(it => it.name === name);
    if (existing) {
      existing.rows = getRowsData();
      existing.savedAt = savedAt;
    } else {
      items.push({ id: Date.now().toString(36), name, savedAt, rows: getRowsData() });
    }
    if (!lsSet(LS_SCEN, items)) {
      setStatus('시뮬레이션 저장 실패 — 브라우저 저장소를 사용할 수 없습니다', 'error');
      return;
    }
    await refreshScenarios();
    setStatus(`"${name}" 저장됨`, 'saved');
    return;
  }

  try {
    const res = await fetch('/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rows: getRowsData() }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.status);
    }
    await refreshScenarios();
    setStatus(`"${name}" 저장됨`, 'saved');
  } catch (e) {
    setStatus('시뮬레이션 저장 실패 — ' + e.message, 'error');
  }
}

document.getElementById('save-scenario-btn').addEventListener('click', saveScenario);

init();
