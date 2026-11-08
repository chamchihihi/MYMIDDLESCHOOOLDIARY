/* ===== js/settings.js ===== */
/* 화면 환경 설정 (테마 · 화면 모드 · 글자 크기) — 브라우저 로컬 저장소에만 저장합니다. */
window.MMSD = window.MMSD || {};

MMSD.settings = (function () {
  /* 계정마다 설정 저장 이름이 달라요. 첫 계정(예전 설정)은 'mmsd.settings.v1' */
  let KEY = 'mmsd.settings.v1';
  const MODES = ['system', 'light', 'dark'];
  const SCALES = [90, 100, 112, 125];

  function load() {
    const s = { defaultTheme: 'pink', pageThemes: {}, mode: 'system', fontScale: 100 };
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return s;
      const p = JSON.parse(raw);
      if (typeof p.defaultTheme === 'string') s.defaultTheme = p.defaultTheme;
      if (p.pageThemes && typeof p.pageThemes === 'object') s.pageThemes = p.pageThemes;
      if (MODES.indexOf(p.mode) >= 0) s.mode = p.mode;
      if (SCALES.indexOf(p.fontScale) >= 0) s.fontScale = p.fontScale;
    } catch (e) { /* 기본값 사용 */ }
    return s;
  }

  let state = load();

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    MODES: MODES,
    SCALES: SCALES,
    get: function () { return state; },
    /* 로그인한 계정의 설정으로 바꾸기 */
    use: function (key) {
      KEY = key;
      state = load();
    },
    /* 계정 삭제용 */
    destroy: function (key) {
      try { localStorage.removeItem(key); } catch (e) { /* 무시 */ }
    },
    setDefaultTheme: function (id) {
      state.defaultTheme = id;
      return save();
    },
    /* id가 비어 있으면 '기본 테마 따르기'로 되돌립니다. */
    setPageTheme: function (page, id) {
      if (id) state.pageThemes[page] = id;
      else delete state.pageThemes[page];
      return save();
    },
    setMode: function (m) {
      if (MODES.indexOf(m) < 0) return false;
      state.mode = m;
      return save();
    },
    setFontScale: function (n) {
      if (SCALES.indexOf(n) < 0) return false;
      state.fontScale = n;
      return save();
    }
  };
})();

/* 화면 모드(다크 모드) · 글자 크기 적용 */
MMSD.display = (function () {
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function apply() {
    const s = MMSD.settings.get();
    const dark = s.mode === 'dark' || (s.mode === 'system' && mq && mq.matches);
    document.documentElement.setAttribute('data-mode', dark ? 'dark' : 'light');
    document.documentElement.style.fontSize = s.fontScale + '%';
  }
  if (mq) {
    const onChange = function () { if (MMSD.settings.get().mode === 'system') apply(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  apply();
  return { apply: apply };
})();

/* ===== js/db.js ===== */
/* =========================================================
   기록 저장소 (IndexedDB) — 이 기기 브라우저 안에만 저장
   ---------------------------------------------------------
   데이터 구조
   1) records  : 모든 글 기록 (일기·친구·선생님·덕질·성적 등)
      {
        id        : 고유 ID (문자열)
        type      : 기록 종류 (아래 TYPES 중 하나)
        date      : 기록 날짜 'YYYY-MM-DD' (선택)
        grade     : 학년 1~3 (선택)
        title     : 제목 (선택, 검색용)
        tags      : 태그 배열
        links     : 다른 기록과의 연결 [{type, id}] (인물↔작품, 추억↔친구 등)
        mediaIds  : 첨부한 사진·동영상 ID 배열 (media 저장소 참조)
        data      : 메뉴별 상세 항목 (자유 구조)
        createdAt : 최초 작성 시각 (ISO)
        updatedAt : 마지막 수정 시각 (ISO)
        trashed   : 0 = 보관 중, 1 = 휴지통
        trashedAt : 휴지통으로 옮긴 시각
      }
   2) media    : 사진·동영상 원본과 미리보기 (글과 분리 보관)
      { id, kind:'image'|'video', mime, name, size, hash, blob, thumb,
        width, height, duration, createdAt }
   3) meta     : 저장소 정보 (스키마 버전 등)
   ========================================================= */
window.MMSD = window.MMSD || {};

MMSD.AppError = function (code, message) {
  const e = new Error(message);
  e.code = code;
  e.isAppError = true;
  return e;
};

MMSD.db = (function () {
  /* 계정마다 저장소 이름이 달라요. 첫 계정(예전 기록)은 'mmsd-diary' */
  let NAME = 'mmsd-diary';
  const VERSION = 1;

  const TYPES = [
    // 프로필·성장
    'profile', 'growth',
    // 덕질노트
    'person', 'work', 'performance', 'goods', 'music', 'fandomDiary',
    // 학교생활 수첩
    'teacher', 'club', 'classInfo', 'timetable', 'schoolEvent', 'schedule', 'award', 'letter',
    // 친구·일기·추억
    'friend', 'friendMemory', 'diary', 'memory',
    // 학업
    'subject', 'exam', 'assessment', 'studyLog', 'book',
    // 꾸미기
    'page', 'sticker'
  ];

  let dbPromise = null;

  function close() {
    if (!dbPromise) return;
    const p = dbPromise;
    dbPromise = null;
    p.then(function (d) { d.close(); }).catch(function () {});
  }

  function friendly(e) {
    if (e && e.isAppError) return e;
    const name = (e && (e.name || e.message)) || '';
    if (name === 'QuotaExceededError') {
      return MMSD.AppError('QUOTA', '저장 공간이 부족해요. 큰 사진이나 동영상을 정리하거나, 백업한 뒤 지워 주세요.');
    }
    if (name === 'NO_IDB') {
      return MMSD.AppError('NO_IDB', '이 브라우저는 기록 저장소를 지원하지 않아요. 크롬·엣지·사파리 최신 버전을 사용해 주세요.');
    }
    if (name === 'BLOCKED') {
      return MMSD.AppError('BLOCKED', '다른 탭에 다이어리가 열려 있어서 저장소를 열 수 없어요. 다른 탭을 닫고 새로고침해 주세요.');
    }
    if (name === 'InvalidStateError' || name === 'SecurityError' || name === 'UnknownError') {
      return MMSD.AppError('UNAVAILABLE', '기록 저장소를 열 수 없어요. 시크릿(개인정보 보호) 모드이거나 브라우저 설정에서 사이트 데이터 저장이 막혀 있을 수 있어요.');
    }
    return MMSD.AppError('UNKNOWN', '기록을 저장하는 중 문제가 생겼어요. (' + name + ')');
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window) || !window.indexedDB) return reject(friendly({ name: 'NO_IDB' }));
      let req;
      try { req = indexedDB.open(NAME, VERSION); } catch (e) { return reject(friendly(e)); }

      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains('records')) {
          const s = db.createObjectStore('records', { keyPath: 'id' });
          s.createIndex('type', 'type');
          s.createIndex('type_date', ['type', 'date']);
          s.createIndex('trashed', 'trashed');
          s.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('media')) {
          const m = db.createObjectStore('media', { keyPath: 'id' });
          m.createIndex('hash', 'hash');
          m.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = function () {
        const db = req.result;
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { reject(friendly(req.error)); };
      req.onblocked = function () { reject(friendly({ name: 'BLOCKED' })); };
    });
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  function reqP(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  /* 트랜잭션 실행: 모든 작업이 끝까지 저장(complete)된 뒤에만 성공으로 처리 */
  async function run(stores, mode, fn) {
    const db = await open();
    return new Promise(function (resolve, reject) {
      let t, out;
      try { t = db.transaction(stores, mode); } catch (e) { return reject(friendly(e)); }
      t.oncomplete = function () { resolve(out); };
      t.onabort = function () { reject(friendly(t.error || { name: 'ABORT' })); };
      let p;
      try { p = Promise.resolve(fn(t)); } catch (e) { p = Promise.reject(e); }
      p.then(function (v) { out = v; }, function (e) {
        try { t.abort(); } catch (_) { /* 이미 끝남 */ }
        reject(friendly(e));
      });
    });
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  }
  function nowISO() { return new Date().toISOString(); }
  function uniq(a) { return Array.from(new Set((a || []).filter(Boolean))); }

  function sortRecords(list) {
    return list.sort(function (a, b) {
      const da = a.date || '', dbb = b.date || '';
      if (da !== dbb) return da < dbb ? 1 : -1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
  }

  /* ---------- 기록 ---------- */
  async function save(rec) {
    if (!rec || TYPES.indexOf(rec.type) < 0) {
      throw MMSD.AppError('BAD_TYPE', '알 수 없는 기록 종류예요: ' + (rec && rec.type));
    }
    return run(['records'], 'readwrite', async function (t) {
      const s = t.objectStore('records');
      const prev = rec.id ? await reqP(s.get(rec.id)) : null;
      const now = nowISO();
      const out = Object.assign({}, prev || {}, rec, {
        id: rec.id || uid(),
        createdAt: prev ? prev.createdAt : (rec.createdAt || now),
        updatedAt: now,
        trashed: prev ? prev.trashed : 0,
        tags: uniq(rec.tags || (prev && prev.tags)),
        links: rec.links || (prev && prev.links) || [],
        mediaIds: uniq(rec.mediaIds || (prev && prev.mediaIds)),
        data: rec.data || (prev && prev.data) || {}
      });
      await reqP(s.put(out));
      return out;
    });
  }

  function get(id) {
    return run(['records'], 'readonly', function (t) { return reqP(t.objectStore('records').get(id)); });
  }

  async function list(type, opts) {
    const wantTrashed = !!(opts && opts.trashed);
    const all = await run(['records'], 'readonly', function (t) {
      return reqP(t.objectStore('records').index('type').getAll(IDBKeyRange.only(type)));
    });
    return sortRecords(all.filter(function (r) { return !!r.trashed === wantTrashed; }));
  }

  async function listTrash() {
    const all = await run(['records'], 'readonly', function (t) {
      return reqP(t.objectStore('records').index('trashed').getAll(IDBKeyRange.only(1)));
    });
    return all.sort(function (a, b) { return a.trashedAt < b.trashedAt ? 1 : -1; });
  }

  function setTrashed(id, flag) {
    return run(['records'], 'readwrite', async function (t) {
      const s = t.objectStore('records');
      const r = await reqP(s.get(id));
      if (!r) throw MMSD.AppError('NOT_FOUND', '기록을 찾을 수 없어요.');
      r.trashed = flag ? 1 : 0;
      r.trashedAt = flag ? nowISO() : null;
      await reqP(s.put(r));
      return r;
    });
  }

  /* 휴지통에서 완전히 삭제: 다른 기록이 쓰지 않는 사진·동영상도 함께 삭제 */
  function purge(id) {
    return run(['records', 'media'], 'readwrite', async function (t) {
      const rs = t.objectStore('records'), ms = t.objectStore('media');
      const rec = await reqP(rs.get(id));
      if (!rec) return false;
      await reqP(rs.delete(id));
      const rest = await reqP(rs.getAll());
      const used = new Set();
      rest.forEach(function (r) { (r.mediaIds || []).forEach(function (m) { used.add(m); }); });
      for (const m of rec.mediaIds || []) {
        if (!used.has(m)) await reqP(ms.delete(m));
      }
      return true;
    });
  }

  /* ---------- 통계 ---------- */
  function stats() {
    return run(['records', 'media'], 'readonly', async function (t) {
      const records = await reqP(t.objectStore('records').getAll());
      const media = await reqP(t.objectStore('media').getAll());
      const out = { records: 0, trashed: 0, byType: {}, images: 0, videos: 0, mediaBytes: 0 };
      records.forEach(function (r) {
        if (r.trashed) out.trashed++;
        else { out.records++; out.byType[r.type] = (out.byType[r.type] || 0) + 1; }
      });
      media.forEach(function (m) {
        if (m.kind === 'video') out.videos++;
        else if (m.kind === 'file') out.files = (out.files || 0) + 1;
        else out.images++;
        out.mediaBytes += (m.size || 0) + (m.thumb ? m.thumb.size : 0);
      });
      return out;
    });
  }

  /* ---------- 메타 ---------- */
  function getMeta(key) {
    return run(['meta'], 'readonly', async function (t) {
      const r = await reqP(t.objectStore('meta').get(key));
      return r ? r.value : undefined;
    });
  }
  function setMeta(key, value) {
    return run(['meta'], 'readwrite', function (t) { return reqP(t.objectStore('meta').put({ key: key, value: value })); });
  }

  return {
    TYPES: TYPES,
    /* 사용할 저장소 바꾸기 (로그인한 계정) */
    use: function (name) {
      if (name === NAME) return;
      close();
      NAME = name;
    },
    name: function () { return NAME; },
    close: close,
    /* 계정 삭제용: 저장소 통째로 지우기 */
    destroy: function (name) {
      if (name === NAME) close();
      return new Promise(function (resolve, reject) {
        const r = indexedDB.deleteDatabase(name);
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { reject(friendly(r.error)); };
        r.onblocked = function () { resolve(false); };
      });
    },
    open: open,
    save: save,
    get: get,
    list: list,
    listTrash: listTrash,
    trash: function (id) { return setTrashed(id, true); },
    restore: function (id) { return setTrashed(id, false); },
    purge: purge,
    stats: stats,
    getMeta: getMeta,
    setMeta: setMeta,
    friendly: friendly,
    uid: uid,
    /* media.js 전용 */
    _run: run,
    _reqP: reqP
  };
})();

/* ===== js/accounts.js ===== */
/* =========================================================
   계정 (아이디 · 비밀번호) — 한 기기에서 여러 사람이 따로 쓰기
   - 계정마다 기록 저장소와 화면 설정이 완전히 따로예요.
   - 비밀번호와 복구 답은 그대로 저장하지 않고, 바꿔 쓴 값(해시)만 저장해요.
   - 인터넷 서버를 쓰지 않아요. 계정 정보도 이 기기 안에만 있어요.
   - 예전 기록(계정 기능 전)은 첫 계정을 만들 때 그 계정의 기록이 돼요.
   ========================================================= */
MMSD.accounts = (function () {
  const M = window.MMSD;
  const KEY = 'mmsd.accounts.v1';
  const LEGACY_LOCK = 'mmsd.lock.v1';
  const LEGACY_DB = 'mmsd-diary';
  const LEGACY_SETTINGS = 'mmsd.settings.v1';
  const ITER = 150000;
  const QUESTIONS = ['내가 처음 키운 반려동물 이름은?', '초등학교 때 가장 친한 친구 이름은?', '내가 가장 좋아하는 음식은?', '처음 좋아한 배우·가수는?', '직접 입력할게요'];
  const AVATARS = ['🐰', '🐻', '🐱', '🐶', '🦊', '🐼', '🐨', '🐧', '🦄', '🐹', '🐸', '🐥'];
  let current = null;

  /* ---------- 저장 ---------- */
  function readReg() {
    try { return JSON.parse(localStorage.getItem(KEY)) || { accounts: [], last: '' }; } catch (e) { return { accounts: [], last: '' }; }
  }
  function writeReg(r) {
    try { localStorage.setItem(KEY, JSON.stringify(r)); return true; } catch (e) { return false; }
  }
  function list() { return readReg().accounts; }
  function find(username) {
    const u = normId(username);
    return list().find(function (a) { return a.username === u; }) || null;
  }
  function save(acc) {
    const r = readReg();
    const i = r.accounts.findIndex(function (a) { return a.id === acc.id; });
    if (i >= 0) r.accounts[i] = acc; else r.accounts.push(acc);
    if (!writeReg(r)) throw MMSD.AppError('ACCOUNT', '계정 정보를 저장하지 못했어요.');
  }

  /* ---------- 암호 바꿔 쓰기 ---------- */
  function supported() { return !!(window.crypto && crypto.subtle && window.TextEncoder); }
  function hex(buf) { return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
  function randomSalt() { const a = new Uint8Array(16); crypto.getRandomValues(a); return hex(a.buffer); }
  async function derive(text, salt, iter) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(text), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: iter, hash: 'SHA-256' }, key, 256);
    return hex(bits);
  }
  function normAnswer(a) { return String(a || '').trim().toLowerCase().replace(/\s+/g, ''); }
  function normId(id) { return String(id || '').trim().toLowerCase(); }
  function checkId(id) {
    if (!/^[a-z0-9가-힣_]{2,20}$/.test(id)) throw MMSD.AppError('ID', '아이디는 2~20자의 한글·영어·숫자·밑줄(_)로 정해 주세요.');
    if (find(id)) throw MMSD.AppError('ID', '이미 있는 아이디예요. 다른 아이디를 정해 주세요.');
  }
  function checkPw(pw, pw2) {
    if (String(pw || '').length < 4) throw MMSD.AppError('PW', '비밀번호는 4자 이상으로 정해 주세요.');
    if (pw2 !== undefined && pw !== pw2) throw MMSD.AppError('PW', '두 비밀번호가 서로 달라요.');
  }

  /* ---------- 틀린 횟수 제한 (계정마다) ---------- */
  function failKey(acc) { return 'mmsd.acc.fail.' + acc.id; }
  function fails(acc) { try { return JSON.parse(localStorage.getItem(failKey(acc))) || { n: 0, until: 0 }; } catch (e) { return { n: 0, until: 0 }; } }
  function resetFails(acc) { try { localStorage.removeItem(failKey(acc)); } catch (e) { /* 무시 */ } }
  function addFail(acc) {
    const f = fails(acc);
    f.n += 1;
    if (f.n >= 5) f.until = Date.now() + Math.min(600, 30 * Math.pow(2, f.n - 5)) * 1000;
    try { localStorage.setItem(failKey(acc), JSON.stringify(f)); } catch (e) { /* 무시 */ }
    return f;
  }
  async function check(acc, kind, text) {
    const w = Math.max(0, Math.ceil((fails(acc).until - Date.now()) / 1000));
    if (w) throw MMSD.AppError('WAIT', '여러 번 틀려서 ' + w + '초 뒤에 다시 시도할 수 있어요.');
    const ok = kind === 'pw' ? (await derive(text, acc.salt, acc.iter)) === acc.hash
      : (await derive(normAnswer(text), acc.aSalt, acc.iter)) === acc.aHash;
    if (ok) { resetFails(acc); return true; }
    const f = addFail(acc);
    const left = 5 - f.n;
    throw MMSD.AppError('WRONG', (kind === 'pw' ? '비밀번호가 맞지 않아요.' : '답이 맞지 않아요.') +
      (left > 0 ? ' (' + left + '번 더 틀리면 잠시 기다려야 해요)' : ' 잠시 뒤에 다시 시도해 주세요.'));
  }

  /* ---------- 계정 만들기 · 바꾸기 ---------- */
  async function create(o) {
    if (!supported()) throw MMSD.AppError('ACCOUNT', '이 브라우저에서는 계정 기능을 쓸 수 없어요.');
    const username = normId(o.username);
    checkId(username);
    const name = String(o.name || '').trim() || username;
    const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const acc = {
      id: id, username: username, name: name, avatar: o.avatar || AVATARS[list().length % AVATARS.length],
      dbName: o.legacy ? LEGACY_DB : 'mmsd-diary-' + id,
      settingsKey: o.legacy ? LEGACY_SETTINGS : LEGACY_SETTINGS + '.' + id,
      iter: ITER, createdAt: new Date().toISOString()
    };
    if (o.legacyLock) {
      /* 예전 잠금 비밀번호와 복구 질문을 그대로 이어서 써요 */
      const L = o.legacyLock;
      Object.assign(acc, { iter: L.iter, salt: L.salt, hash: L.hash, q: L.q, aSalt: L.aSalt, aHash: L.aHash });
    } else {
      checkPw(o.pw, o.pw2);
      if (!String(o.q || '').trim()) throw MMSD.AppError('Q', '복구 질문을 적어 주세요.');
      if (!normAnswer(o.a)) throw MMSD.AppError('A', '복구 답을 적어 주세요.');
      acc.salt = randomSalt(); acc.hash = await derive(o.pw, acc.salt, ITER);
      acc.q = String(o.q).trim(); acc.aSalt = randomSalt(); acc.aHash = await derive(normAnswer(o.a), acc.aSalt, ITER);
    }
    save(acc);
    if (o.legacyLock) { try { localStorage.removeItem(LEGACY_LOCK); localStorage.removeItem('mmsd.lock.fail'); } catch (e) { /* 무시 */ } }
    return acc;
  }
  async function changePassword(acc, pw) {
    checkPw(pw);
    acc.salt = randomSalt();
    acc.hash = await derive(pw, acc.salt, acc.iter);
    save(acc);
    resetFails(acc);
  }
  async function changeQuestion(acc, q, a) {
    if (!String(q || '').trim() || !normAnswer(a)) throw MMSD.AppError('Q', '복구 질문과 답을 적어 주세요.');
    acc.q = String(q).trim();
    acc.aSalt = randomSalt();
    acc.aHash = await derive(normAnswer(a), acc.aSalt, acc.iter);
    save(acc);
  }
  function rename(acc, name, avatar) {
    acc.name = String(name || '').trim() || acc.username;
    if (avatar) acc.avatar = avatar;
    save(acc);
  }
  /* 계정과 그 계정의 기록 · 사진 · 설정을 이 기기에서 지워요 */
  async function remove(acc) {
    await M.db.destroy(acc.dbName);
    M.settings.destroy(acc.settingsKey);
    resetFails(acc);
    const r = readReg();
    r.accounts = r.accounts.filter(function (a) { return a.id !== acc.id; });
    if (r.last === acc.username) r.last = '';
    writeReg(r);
  }

  /* 로그인한 계정의 저장소 · 설정으로 바꾸기 */
  function enter(acc) {
    current = acc;
    const r = readReg();
    r.last = acc.username;
    writeReg(r);
    M.settings.use(acc.settingsKey);
    M.display.apply();
    M.db.use(acc.dbName);
    M.profile = null;
  }

  /* ---------- 예전 기록이 있는지 (계정 기능 전) ---------- */
  async function legacyInfo() {
    let lock = null;
    try { const v = JSON.parse(localStorage.getItem(LEGACY_LOCK)); if (v && v.hash) lock = v; } catch (e) { /* 없음 */ }
    let records = 0;
    try {
      let exists = true;
      if (indexedDB.databases) {
        const dbs = await indexedDB.databases();
        exists = dbs.some(function (d) { return d.name === LEGACY_DB; });
      }
      if (exists) {
        M.db.use(LEGACY_DB);
        const s = await M.db.stats();
        records = s.records + s.trashed;
        M.db.close();
      }
    } catch (e) { records = 0; }
    return { lock: lock, records: records };
  }

  /* =========================================================
     로그인 화면
     ========================================================= */
  function screen(done) {
    const esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
    const box = document.createElement('div');
    box.className = 'lock-screen';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', '다이어리 로그인');
    document.body.appendChild(box);
    document.body.classList.add('locked');
    let legacy = null;
    let forgotAcc = null;

    function qPicker() {
      return '<label class="flabel">복구 질문<select class="inp" data-n="q">' + QUESTIONS.map(function (q) { return '<option>' + q + '</option>'; }).join('') + '</select></label>' +
        '<input class="inp" data-n="qOwn" placeholder="나만의 질문을 적어 주세요" hidden>';
    }
    function field(n, label, type, extra) {
      return '<label class="flabel">' + label + '<input class="inp" data-n="' + n + '" type="' + (type || 'text') + '" ' + (extra || '') + '></label>';
    }

    function view(mode) {
      const accs = list();
      let inner;
      if (mode === 'create') {
        const mig = legacy && legacy.records && !accs.length;
        inner = (mig
          ? '<p class="lock-lead">✨ 이제 계정을 만들어 여러 사람이 따로 쓸 수 있어요.<br><b>지금까지 쓴 기록 ' + legacy.records + '개는 이 첫 계정의 기록이 돼요.</b></p>'
          : (accs.length ? '<p class="lock-lead">새 계정은 빈 다이어리에서 시작해요. 다른 사람의 기록은 볼 수 없어요.</p>'
            : '<p class="lock-lead">👋 환영해요! 내 다이어리 계정을 만들어 주세요.</p>')) +
          '<form data-f="create" class="lock-col">' +
            field('username', '아이디 (2~20자, 한글·영어·숫자)', 'text', 'autocomplete="username" required') +
            field('name', '이름 · 별명 (화면에 보여요)', 'text', 'autocomplete="nickname"') +
            (mig && legacy.lock
              ? field('oldpw', '지금 쓰던 잠금 비밀번호 (그대로 계정 비밀번호가 돼요)', 'password', 'autocomplete="current-password" required')
              : field('pw', '비밀번호 (4자 이상)', 'password', 'autocomplete="new-password" minlength="4" required') +
                field('pw2', '비밀번호 확인', 'password', 'autocomplete="new-password" minlength="4" required') +
                qPicker() + field('a', '복구 답 (비밀번호를 잊었을 때 써요)', 'text', 'autocomplete="off" required')) +
            '<button class="btn primary" type="submit">' + (mig ? '내 계정 만들고 기록 이어가기' : '계정 만들기') + '</button></form>' +
          (accs.length ? '<button type="button" class="link-btn" data-go="login">← 로그인으로</button>' : '');
      } else if (mode === 'forgot') {
        inner = forgotAcc
          ? '<p>복구 질문에 답해 주세요.</p><p class="lock-q">❓ ' + esc(forgotAcc.q) + '</p>' +
            '<form data-f="answer"><input class="inp" data-n="a" type="text" autocomplete="off" aria-label="복구 답" placeholder="답" required>' +
            '<button class="btn primary" type="submit">확인</button></form>' +
            '<button type="button" class="link-btn" data-go="login">← 로그인으로</button>'
          : '<p>비밀번호를 잊은 계정의 아이디를 적어 주세요.</p>' +
            '<form data-f="who"><input class="inp" data-n="username" type="text" autocomplete="username" aria-label="아이디" placeholder="아이디" required>' +
            '<button class="btn primary" type="submit">다음</button></form>' +
            '<button type="button" class="link-btn" data-go="login">← 로그인으로</button>';
      } else if (mode === 'reset') {
        inner = '<p><b>' + esc(forgotAcc.name) + '</b> 계정의 새 비밀번호를 정해 주세요.</p>' +
          '<form data-f="reset" class="lock-col">' +
            field('pw', '새 비밀번호 (4자 이상)', 'password', 'autocomplete="new-password" minlength="4" required') +
            field('pw2', '새 비밀번호 확인', 'password', 'autocomplete="new-password" minlength="4" required') +
            '<button class="btn primary" type="submit">저장하고 열기</button></form>';
      } else {
        const last = readReg().last;
        inner = '<p>누구의 다이어리를 열까요?</p>' +
          '<div class="acct-pick">' + accs.map(function (a) {
            return '<button type="button" class="acct-chip" data-pick="' + esc(a.username) + '" aria-pressed="' + (a.username === last) + '">' +
              '<span aria-hidden="true">' + esc(a.avatar) + '</span>' + esc(a.name) + '</button>';
          }).join('') + '</div>' +
          '<form data-f="login" class="lock-col">' +
            field('username', '아이디', 'text', 'autocomplete="username" required value="' + esc(last) + '"') +
            field('pw', '비밀번호', 'password', 'autocomplete="current-password" required') +
            '<button class="btn primary" type="submit">열기</button></form>' +
          '<div class="lock-links"><button type="button" class="link-btn" data-go="forgot">비밀번호를 잊었어요</button>' +
          '<button type="button" class="link-btn" data-go="create">+ 새 계정 만들기</button></div>';
      }
      box.innerHTML = '<div class="lock-card card tape"><div class="lock-emoji" aria-hidden="true">📒</div>' +
        '<h1>MY MIDDLE<br>SCHOOL DIARY</h1>' + inner + '<p class="lock-msg" role="alert"></p>' +
        '<p class="lock-note">🔒 계정과 기록은 이 기기 안에만 저장돼요.</p></div>';
      const first = box.querySelector(mode === 'login' && readReg().last ? '[data-n="pw"]' : 'input:not([hidden])');
      if (first) first.focus();
    }
    function msg(t) { box.querySelector('.lock-msg').textContent = t; }
    function v(n) { const e = box.querySelector('[data-n="' + n + '"]'); return e ? e.value : ''; }

    box.addEventListener('click', function (e) {
      const g = e.target.closest('[data-go]');
      if (g) { forgotAcc = null; view(g.dataset.go); return; }
      const p = e.target.closest('[data-pick]');
      if (p) {
        box.querySelector('[data-n="username"]').value = p.dataset.pick;
        box.querySelectorAll('[data-pick]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === p)); });
        box.querySelector('[data-n="pw"]').focus();
      }
    });
    box.addEventListener('change', function (e) {
      if (e.target.dataset.n === 'q') box.querySelector('[data-n="qOwn"]').hidden = e.target.value !== '직접 입력할게요';
    });
    box.addEventListener('submit', async function (e) {
      e.preventDefault();
      const f = e.target;
      const btn = f.querySelector('button[type="submit"]');
      btn.disabled = true;
      msg('');
      try {
        if (f.dataset.f === 'login') {
          const acc = find(v('username'));
          if (!acc) throw MMSD.AppError('ID', '그런 아이디가 없어요. 아이디를 확인하거나 새 계정을 만들어 주세요.');
          await check(acc, 'pw', v('pw'));
          return open(acc);
        }
        if (f.dataset.f === 'create') {
          const mig = legacy && legacy.records && !list().length;
          let legacyLock = null;
          if (mig && legacy.lock) {
            /* 예전 잠금 비밀번호 확인 */
            if ((await derive(v('oldpw'), legacy.lock.salt, legacy.lock.iter)) !== legacy.lock.hash) throw MMSD.AppError('WRONG', '지금 쓰던 잠금 비밀번호가 맞지 않아요.');
            legacyLock = legacy.lock;
          }
          const q = v('q') === '직접 입력할게요' ? v('qOwn') : v('q');
          const acc = await create({ username: v('username'), name: v('name'), pw: v('pw'), pw2: v('pw2'), q: q, a: v('a'), legacy: !!mig, legacyLock: legacyLock });
          return open(acc);
        }
        if (f.dataset.f === 'who') {
          const acc = find(v('username'));
          if (!acc) throw MMSD.AppError('ID', '그런 아이디가 없어요.');
          forgotAcc = acc;
          return view('forgot');
        }
        if (f.dataset.f === 'answer') {
          await check(forgotAcc, 'answer', v('a'));
          return view('reset');
        }
        if (f.dataset.f === 'reset') {
          checkPw(v('pw'), v('pw2'));
          await changePassword(forgotAcc, v('pw'));
          return open(forgotAcc);
        }
      } catch (err) {
        msg(err.message || '다시 시도해 주세요.');
        const pw = f.querySelector('input[type="password"]');
        if (pw && (err.code === 'WRONG' || err.code === 'WAIT')) { pw.value = ''; pw.focus(); }
      }
      btn.disabled = false;
    });

    function open(acc) {
      enter(acc);
      box.remove();
      document.body.classList.remove('locked');
      done(acc);
    }

    legacyInfo().then(function (info) {
      legacy = info;
      view(list().length ? 'login' : 'create');
    });
  }

  /* 로그인할 때까지 기다림 */
  function gate() {
    if (current) return Promise.resolve(current);
    return new Promise(function (resolve) { screen(resolve); });
  }

  /* 로그아웃: 남은 저장을 끝내고, 화면을 비우고, 로그인 화면으로 */
  async function logout() {
    await M.autosave.flushAll();
    current = null;
    const view = document.getElementById('view');
    if (view) view.innerHTML = '';
    M.media.releaseAll();
    M.db.close();
    M.profile = null;
    refreshUI();
    if (M.start) M.start();
  }

  /* 사이드바의 계정 표시 */
  function refreshUI() {
    const box = document.getElementById('acctBox');
    if (!box) return;
    box.hidden = !current;
    if (current) box.querySelector('#acctName').textContent = current.avatar + ' ' + current.name;
  }

  return {
    QUESTIONS: QUESTIONS, AVATARS: AVATARS,
    current: function () { return current; },
    isLocked: function () { return !current; },
    list: list, supported: supported, check: check,
    create: create, changePassword: changePassword, changeQuestion: changeQuestion, rename: rename, remove: remove,
    gate: gate, logout: logout, refreshUI: refreshUI
  };
})();

/* ===== js/media.js ===== */
/* =========================================================
   사진·동영상 저장 — 원본 + 미리보기(썸네일)를 media 저장소에 보관
   - 형식/용량 검사, 남은 저장 공간 확인
   - 같은 파일을 두 번 올리면 하나만 저장 (중복 방지)
   - 저장 후 다시 읽어서 제대로 저장됐는지 확인
   ========================================================= */
MMSD.media = (function () {
  const db = MMSD.db;
  const MB = 1024 * 1024;

  const RULES = {
    image: { types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], max: 30 * MB, label: '사진', ext: 'JPG·PNG·GIF·WEBP' },
    video: { types: ['video/mp4', 'video/webm', 'video/quicktime'], max: 100 * MB, label: '동영상', ext: 'MP4·WEBM·MOV' },
    /* 첨부 파일 (수행평가 등 첨부 파일 칸에서만 허용) */
    file: { types: [], exts: ['pdf', 'hwp', 'hwpx', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'zip'], max: 30 * MB, label: '파일', ext: 'PDF·HWP·워드·PPT·엑셀·TXT·ZIP' }
  };
  const THUMB_MAX = 480;

  function fmtSize(b) {
    if (!b) return '0B';
    if (b < 1024) return b + 'B';
    if (b < MB) return (b / 1024).toFixed(0) + 'KB';
    if (b < 1024 * MB) return (b / MB).toFixed(1).replace(/\.0$/, '') + 'MB';
    return (b / 1024 / MB).toFixed(2).replace(/\.?0+$/, '') + 'GB';
  }

  function kindOf(file, allowFiles) {
    if (RULES.image.types.indexOf(file.type) >= 0) return 'image';
    if (RULES.video.types.indexOf(file.type) >= 0) return 'video';
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (allowFiles && RULES.file.exts.indexOf(ext) >= 0) return 'file';
    return null;
  }

  async function checkSpace(bytes) {
    if (!navigator.storage || !navigator.storage.estimate) return;
    try {
      const est = await navigator.storage.estimate();
      const free = (est.quota || 0) - (est.usage || 0);
      if (est.quota && free < bytes * 1.3 + 5 * MB) {
        throw MMSD.AppError('QUOTA', '저장 공간이 부족해요. 남은 공간: ' + fmtSize(Math.max(free, 0)) + '. 필요한 공간: ' + fmtSize(bytes));
      }
    } catch (e) {
      if (e.isAppError) throw e;
    }
  }

  async function sha256(buf) {
    if (!(window.crypto && crypto.subtle)) return null;
    try {
      const h = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(h)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    } catch (e) { return null; }
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve) { canvas.toBlob(function (b) { resolve(b); }, 'image/jpeg', 0.82); });
  }
  function fit(w, h) {
    const r = Math.min(1, THUMB_MAX / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * r)), h: Math.max(1, Math.round(h * r)) };
  }

  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('IMG')); };
      img.src = url;
    });
  }

  async function imageThumb(blob) {
    const img = await loadImage(blob);
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = fit(w, h);
    const c = document.createElement('canvas');
    c.width = s.w; c.height = s.h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, s.w, s.h);
    ctx.drawImage(img, 0, 0, s.w, s.h);
    return { thumb: await canvasToBlob(c), width: w, height: h };
  }

  function videoThumb(blob) {
    return new Promise(function (resolve) {
      const url = URL.createObjectURL(blob);
      const v = document.createElement('video');
      let done = false;
      function finish(out) {
        if (done) return;
        done = true;
        URL.revokeObjectURL(url);
        v.removeAttribute('src');
        resolve(out || {});
      }
      const timer = setTimeout(function () { finish({}); }, 8000);
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.onerror = function () { clearTimeout(timer); finish({}); };
      const seekable = function () { return isFinite(v.duration) && v.duration > 0; };
      async function draw() {
        clearTimeout(timer);
        const duration = seekable() ? v.duration : null;
        try {
          const s = fit(v.videoWidth || 320, v.videoHeight || 240);
          const c = document.createElement('canvas');
          c.width = s.w; c.height = s.h;
          c.getContext('2d').drawImage(v, 0, 0, s.w, s.h);
          finish({ thumb: await canvasToBlob(c), width: v.videoWidth, height: v.videoHeight, duration: duration });
        } catch (e) {
          finish({ width: v.videoWidth, height: v.videoHeight, duration: duration });
        }
      }
      /* 길이를 알 수 있으면 0.5초 지점, 모르면 첫 화면을 미리보기로 사용 */
      v.onloadeddata = function () {
        if (seekable()) v.currentTime = Math.min(0.5, v.duration / 2);
        else draw();
      };
      v.onseeked = draw;
      v.src = url;
    });
  }

  function meta(rec) {
    return {
      id: rec.id, kind: rec.kind, mime: rec.mime, name: rec.name, size: rec.size,
      width: rec.width, height: rec.height, duration: rec.duration, createdAt: rec.createdAt,
      hasThumb: !!rec.thumb
    };
  }

  function getRaw(id) {
    return db._run(['media'], 'readonly', function (t) { return db._reqP(t.objectStore('media').get(id)); });
  }

  /* 파일 하나 저장 → 메타 정보 반환 (duplicate:true 이면 이미 있던 파일) */
  async function add(file, allowFiles) {
    const kind = kindOf(file, allowFiles);
    if (!kind) {
      throw MMSD.AppError('TYPE', '"' + file.name + '"은(는) 올릴 수 없는 형식이에요. 사진은 ' + RULES.image.ext + ', 동영상은 ' + RULES.video.ext +
        (allowFiles ? ', 파일은 ' + RULES.file.ext : '') + '만 저장할 수 있어요.');
    }
    const rule = RULES[kind];
    if (!file.size) throw MMSD.AppError('EMPTY', '"' + file.name + '" 파일이 비어 있어요.');
    if (file.size > rule.max) {
      throw MMSD.AppError('SIZE', '"' + file.name + '"이(가) 너무 커요 (' + fmtSize(file.size) + '). ' + rule.label + '은 한 개에 ' + fmtSize(rule.max) + '까지 저장할 수 있어요.');
    }
    await checkSpace(file.size);

    let buf;
    try { buf = await file.arrayBuffer(); } catch (e) {
      throw MMSD.AppError('READ', '"' + file.name + '" 파일을 읽지 못했어요. 다시 골라 주세요.');
    }

    const hash = await sha256(buf);
    if (hash) {
      const existing = await db._run(['media'], 'readonly', function (t) {
        return db._reqP(t.objectStore('media').index('hash').get(hash));
      });
      if (existing) return Object.assign(meta(existing), { duplicate: true });
    }

    const mime = file.type || 'application/octet-stream';
    const blob = new Blob([buf], { type: mime });
    let extra = {};
    try {
      if (kind === 'image') extra = await imageThumb(blob);
      else if (kind === 'video') extra = await videoThumb(blob);
    } catch (e) { extra = {}; }

    const rec = {
      id: db.uid(), kind: kind, mime: mime, name: file.name, size: file.size, hash: hash,
      blob: blob, thumb: extra.thumb || null,
      width: extra.width || null, height: extra.height || null, duration: extra.duration || null,
      createdAt: new Date().toISOString()
    };
    await db._run(['media'], 'readwrite', function (t) { return db._reqP(t.objectStore('media').put(rec)); });

    /* 저장 상태 확인: 다시 읽어서 크기가 같은지 */
    const back = await getRaw(rec.id);
    if (!back || !back.blob || back.blob.size !== rec.size) {
      throw MMSD.AppError('VERIFY', '"' + file.name + '"이(가) 제대로 저장되지 않았어요. 다시 시도해 주세요.');
    }
    return meta(rec);
  }

  /* 여러 파일을 차례로 저장. 실패한 파일은 error 에 이유를 담아 돌려줌 */
  async function addMany(files, onEach, allowFiles) {
    const results = [];
    for (const f of Array.from(files)) {
      let r;
      try { r = { file: f, ok: true, media: await add(f, allowFiles) }; }
      catch (e) { r = { file: f, ok: false, error: db.friendly(e) }; }
      results.push(r);
      if (onEach) onEach(r);
    }
    return results;
  }

  async function getMeta(id) {
    const r = await getRaw(id);
    return r ? meta(r) : null;
  }

  /* 화면에 보여줄 주소. variant: 'thumb'(미리보기) | 'full'(원본) */
  const urls = new Map();
  async function url(id, variant) {
    const key = id + ':' + (variant || 'thumb');
    if (urls.has(key)) return urls.get(key);
    const r = await getRaw(id);
    if (!r) return null;
    const blob = (variant !== 'full' && r.thumb) ? r.thumb : r.blob;
    const u = URL.createObjectURL(blob);
    urls.set(key, u);
    return u;
  }
  function releaseAll() {
    urls.forEach(function (u) { URL.revokeObjectURL(u); });
    urls.clear();
  }

  /* 어떤 기록에도 연결되지 않은 채 하루 이상 지난 파일 정리
     (사진을 올리다가 기록을 저장하지 않고 나간 경우) */
  function cleanupOrphans() {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    return db._run(['records', 'media'], 'readwrite', async function (t) {
      const records = await db._reqP(t.objectStore('records').getAll());
      const used = new Set();
      records.forEach(function (r) { (r.mediaIds || []).forEach(function (m) { used.add(m); }); });
      const ms = t.objectStore('media');
      const all = await db._reqP(ms.getAll());
      let removed = 0;
      for (const m of all) {
        if (!used.has(m.id) && m.createdAt < cutoff) { await db._reqP(ms.delete(m.id)); removed++; }
      }
      return removed;
    });
  }

  return {
    RULES: RULES,
    ACCEPT: RULES.image.types.concat(RULES.video.types).join(','),
    fmtSize: fmtSize,
    add: add,
    addMany: addMany,
    getMeta: getMeta,
    url: url,
    releaseAll: releaseAll,
    cleanupOrphans: cleanupOrphans
  };
})();


/* ===== js/picker.js ===== */
/* ---------------------------------------------------------
   사진·동영상(·첨부 파일) 첨부 칸
   MMSD.mediaPicker(container, { ids: [...], onChange(ids), files: true|false })
   - 사진을 누르면 원본을 새 창에서 보고, 파일은 내려받아요.
   --------------------------------------------------------- */
/* 사진·동영상 크게 보기 (새 창 대신 화면 위에 띄움 — 앱 안에서도 동작) */
MMSD.lightbox = function (kind, url, name) {
  const esc = MMSD.ui.esc;
  const prev = document.activeElement;
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', name || '크게 보기');
  box.innerHTML = '<button type="button" class="lb-close" aria-label="닫기">✕</button>' +
    (kind === 'video' ? '<video src="' + url + '" controls autoplay playsinline></video>' : '<img src="' + url + '" alt="' + esc(name || '') + '">');
  function close() {
    document.removeEventListener('keydown', onKey);
    box.remove();
    if (prev && prev.focus) prev.focus();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  box.addEventListener('click', function (e) { if (e.target === box || e.target.closest('.lb-close')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
  box.querySelector('.lb-close').focus();
};

MMSD.mediaPicker = function (container, opts) {
  const M = window.MMSD;
  const R = M.media.RULES;
  let ids = (opts.ids || []).slice();
  const allowFiles = !!opts.files;
  const accept = M.media.ACCEPT + (allowFiles ? ',' + R.file.exts.map(function (e) { return '.' + e; }).join(',') : '');

  container.classList.add('media-picker');
  container.innerHTML = '<ul class="mp-grid"></ul>' +
    '<label class="btn mp-add">' + (allowFiles ? '📎 사진·동영상·파일 추가' : '📷 사진·동영상 추가') +
    '<input type="file" multiple accept="' + accept + '" hidden></label>' +
    '<p class="mp-hint">사진 한 장 ' + M.media.fmtSize(R.image.max) + ', 동영상 한 개 ' + M.media.fmtSize(R.video.max) +
      (allowFiles ? ', 파일 한 개 ' + M.media.fmtSize(R.file.max) + ' (' + R.file.ext + ')' : '') + '까지 저장돼요. 사진을 누르면 크게 볼 수 있어요.</p>';
  const grid = container.querySelector('.mp-grid');
  const input = container.querySelector('input');

  function tile(id) {
    const li = document.createElement('li');
    li.className = 'mp-tile';
    li.dataset.id = id;
    li.innerHTML = '<span class="mp-loading">불러오는 중…</span>' +
      '<button type="button" class="mp-del" aria-label="첨부 빼기">✕</button>';
    li.querySelector('.mp-del').addEventListener('click', function () {
      ids = ids.filter(function (x) { return x !== id; });
      li.remove();
      opts.onChange && opts.onChange(ids.slice());
    });
    Promise.all([M.media.getMeta(id), M.media.url(id, 'thumb'), M.media.url(id, 'full')]).then(function (r) {
      const meta = r[0], thumbUrl = r[1], fullUrl = r[2];
      const box = li.querySelector('.mp-loading');
      if (!meta || !thumbUrl) { box.textContent = '파일 없음'; return; }
      const name = M.ui.esc(meta.name);
      let inner;
      if (meta.kind === 'file') inner = '<span class="mp-file"><span aria-hidden="true">📄</span><small>' + name + '</small></span>';
      else if (meta.kind === 'video' && !meta.hasThumb) inner = '<span class="mp-video-ph">🎬</span>';
      else inner = '<img alt="' + name + '" src="' + thumbUrl + '">';
      box.outerHTML = '<button type="button" class="mp-open" aria-label="' + name + (meta.kind === 'file' ? ' 내려받기' : ' 크게 보기') + '">' + inner + '</button>';
      li.querySelector('.mp-open').addEventListener('click', async function () {
        if (meta.kind === 'file') {
          try {
            await M.saveFile(await (await fetch(fullUrl)).blob(), meta.name);
            M.toast('📄 "' + meta.name + '" — ' + M.savedWhere());
          } catch (e) { M.toast(M.db.friendly(e).message, true); }
        } else {
          M.lightbox(meta.kind, fullUrl, meta.name);
        }
      });
      if (meta.kind === 'video') li.insertAdjacentHTML('beforeend', '<span class="mp-badge">▶</span>');
    }).catch(function () { li.querySelector('.mp-loading').textContent = '불러오기 실패'; });
    return li;
  }

  ids.forEach(function (id) { grid.appendChild(tile(id)); });

  input.addEventListener('change', async function (e) {
    e.stopPropagation();
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    const pending = files.map(function () {
      const li = document.createElement('li');
      li.className = 'mp-tile mp-saving';
      li.innerHTML = '<span class="mp-loading">저장 중…</span>';
      grid.appendChild(li);
      return li;
    });
    let i = 0;
    await M.media.addMany(files, function (res) {
      const li = pending[i++];
      if (res.ok) {
        if (ids.indexOf(res.media.id) >= 0) {
          li.remove();
          M.toast('"' + res.file.name + '"은(는) 이미 첨부되어 있어요.');
        } else {
          ids.push(res.media.id);
          li.replaceWith(tile(res.media.id));
          opts.onChange && opts.onChange(ids.slice());
        }
      } else {
        li.remove();
        M.toast(res.error.message, true);
      }
    }, allowFiles);
  });

  return { getIds: function () { return ids.slice(); } };
};

/* ===== js/autosave.js ===== */
/* =========================================================
   자동 저장
   - 입력이 멈추고 0.7초 뒤 자동 저장
   - 화면 오른쪽 위에 저장 상태 표시 (저장 중 / 저장됨 / 저장 실패)
   - 다른 메뉴로 이동하거나 창을 닫기 전에 남은 저장을 마무리
   사용법:
     const saver = MMSD.autosave.create(async (data) => MMSD.db.save(data));
     input 이벤트마다 saver.schedule(() => 지금 폼의 데이터);
   ========================================================= */
MMSD.autosave = (function () {
  const dirty = new Set();       // 저장을 기다리거나 실패한 저장기
  let statusEl = null;
  let hideTimer = null;

  function setStatus(state, err) {
    statusEl = statusEl || document.getElementById('saveStatus');
    if (!statusEl) return;
    clearTimeout(hideTimer);
    statusEl.dataset.state = state;
    const text = {
      waiting: '✏️ 입력 중…',
      saving: '💾 저장 중…',
      saved: '✔️ 저장됨',
      error: '⚠️ 저장 실패'
    }[state] || '';
    statusEl.textContent = text;
    statusEl.title = err ? err.message : '';
    statusEl.hidden = false;
    if (state === 'saved') hideTimer = setTimeout(function () { statusEl.hidden = true; }, 2500);
    if (state === 'error' && err && MMSD.toast) MMSD.toast(err.message + ' 입력한 내용은 화면에 남아 있어요. 잠시 후 다시 저장을 시도해요.', true);
  }

  function create(saveFn, delay) {
    delay = delay || 700;
    let timer = null;
    let latest = null;          // 아직 저장하지 않은 최신 데이터를 꺼내는 함수
    let chain = Promise.resolve();
    let retryTimer = null;
    const self = {};

    async function doRun() {
      clearTimeout(timer);
      if (!latest) return;
      const getData = latest;
      latest = null;
      setStatus('saving');
      try {
        await saveFn(getData());
        if (!latest) {
          dirty.delete(self);
          setStatus('saved');
        }
      } catch (e) {
        if (!latest) latest = getData;   // 실패한 내용은 다시 저장할 수 있게 보관
        setStatus('error', MMSD.db.friendly(e));
        clearTimeout(retryTimer);
        retryTimer = setTimeout(function () { self.flush().catch(function () {}); }, 5000);
        throw e;
      }
    }

    self.schedule = function (getData) {
      latest = getData;
      dirty.add(self);
      setStatus('waiting');
      clearTimeout(timer);
      timer = setTimeout(function () { self.flush().catch(function () {}); }, delay);
    };
    self.flush = function () {
      clearTimeout(timer);
      chain = chain.catch(function () {}).then(doRun);
      return chain;
    };
    self.isDirty = function () { return dirty.has(self); };
    return self;
  }

  /* 남은 저장을 모두 끝냄. 하나라도 실패하면 false */
  async function flushAll() {
    const list = Array.from(dirty);
    const results = await Promise.allSettled(list.map(function (s) { return s.flush(); }));
    return results.every(function (r) { return r.status === 'fulfilled'; }) && dirty.size === 0;
  }

  window.addEventListener('beforeunload', function (e) {
    if (dirty.size) {
      flushAll();
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && dirty.size) flushAll();
  });

  return {
    create: create,
    flushAll: flushAll,
    hasUnsaved: function () { return dirty.size > 0; }
  };
})();

/* ===== js/themes.js ===== */
/* 테마 시스템: 전체 기본 테마 + 페이지별 개별 테마 */
MMSD.themes = (function () {
  const LIST = [
    { id: 'pink',     name: '파스텔 핑크',      emoji: '🌸' },
    { id: 'blue',     name: '파스텔 블루',      emoji: '🫧' },
    { id: 'vintage',  name: '빈티지',           emoji: '📜' },
    { id: 'colorful', name: '알록달록 캐릭터',  emoji: '🧸' },
    { id: 'minimal',  name: '심플 미니멀',      emoji: '🤍' },
    { id: 'season',   name: '계절별 테마',      emoji: '🍀' }
  ];

  const SEASONS = {
    spring: { name: '봄', emoji: '🌸' },
    summer: { name: '여름', emoji: '🍉' },
    autumn: { name: '가을', emoji: '🍁' },
    winter: { name: '겨울', emoji: '⛄' }
  };

  /* 테마별 홈 장식 스티커 */
  const DECOR = {
    pink: ['🎀', '🌷', '💗'],
    blue: ['🫧', '🐳', '⭐'],
    vintage: ['📮', '🕰️', '🌾'],
    colorful: ['🧸', '🐥', '🍭'],
    minimal: ['✦', '·', '✧'],
    'season-spring': ['🌸', '🐝', '🌱'],
    'season-summer': ['🍉', '🐚', '☀️'],
    'season-autumn': ['🍁', '🌰', '🍂'],
    'season-winter': ['⛄', '❄️', '🧣']
  };

  function currentSeason(date) {
    const m = (date || new Date()).getMonth() + 1;
    if (m >= 3 && m <= 5) return 'spring';
    if (m >= 6 && m <= 8) return 'summer';
    if (m >= 9 && m <= 11) return 'autumn';
    return 'winter';
  }

  function exists(id) { return LIST.some(function (t) { return t.id === id; }); }

  function resolve(id) {
    if (!exists(id)) id = 'pink';
    return id === 'season' ? 'season-' + currentSeason() : id;
  }

  function byId(id) {
    return LIST.find(function (t) { return t.id === id; }) || LIST[0];
  }

  function effectiveFor(page) {
    const s = MMSD.settings.get();
    const own = s.pageThemes[page];
    return exists(own) ? own : (exists(s.defaultTheme) ? s.defaultTheme : 'pink');
  }

  function apply(id) {
    document.documentElement.setAttribute('data-theme', resolve(id));
  }

  function decor(id) { return DECOR[resolve(id)] || DECOR.pink; }

  return {
    list: LIST,
    seasons: SEASONS,
    currentSeason: currentSeason,
    resolve: resolve,
    byId: byId,
    effectiveFor: effectiveFor,
    apply: apply,
    decor: decor
  };
})();

/* ===== js/pages.js ===== */
/* 메뉴 정의와 각 페이지 화면 */
(function () {
  const M = window.MMSD;

  M.menu = [
    { id: 'home', icon: '🏠', title: '홈', sub: '오늘도 반가워! 나의 중학생활 스크랩북 ✨' },
    { id: 'profile', icon: '🙋', title: '나의 프로필', sub: '나를 소개하는 스크랩북 페이지', stage: 3,
      desc: '이름, 별명, 학년·반·번호 같은 기본 정보와 나만의 취향을 모아 프로필 카드를 만들어요.',
      items: ['기본 프로필 (이름·별명·생년월일·학년·반·번호·입학일·졸업 예정일)', 'MBTI·혈액형·키·신발 사이즈', '취미·특기·좋아하는/싫어하는 음식', '좋아하는 색깔·계절', '장래희망·좌우명·나를 표현하는 키워드', '요즘 관심사·TMI·자기소개 한마디', '캐릭터 아바타·프로필 사진'] },
    { id: 'growth', icon: '🌱', title: '성장 기록', sub: '1학년부터 3학년까지 달라진 나', stage: 3,
      desc: '몸과 마음이 어떻게 자랐는지 학년별로 기록하고 비교해요.',
      items: ['신체 성장 (키·몸무게·발 크기·옷 사이즈)', '외모 변화 (헤어·피부·패션·전신 사진)', '목소리와 능력', '내면의 성장 (성격·가치관·장래희망)', '1·2·3학년 비교', '입학 당시와 현재 비교', '전체 기간 그래프'] },
    { id: 'fandom', icon: '💖', title: '덕질노트', sub: '좋아하는 배우·작품·공연 기록', stage: 4,
      desc: '인물과 작품을 함께 관리하고, 배우마다 다른 테마로 꾸밀 수 있어요.',
      items: ['덕질노트 HOME', '인물 보관함 (인물별 테마·생일 카운트다운)', '작품 보관함 (작품별 테마)', '공연 관람 기록 (재관람 횟수 자동 계산)', '굿즈 및 소장품·위시리스트', '음악 보관함 (뮤지컬 넘버 구분)', '덕질 일기', '통계·검색·필터'] },
    { id: 'school', icon: '🏫', title: '학교생활 수첩', sub: '선생님·동아리·학교 행사 기록', stage: 3,
      desc: '선생님과 동아리, 시간표와 학교 행사까지 학교생활을 한곳에 모아요.',
      items: ['선생님 수첩 (학년별·과목별·담임 표시)', '선생님별 추억 타임라인·편지 보관', '동아리 기록장·변경 이력·사진첩', '반 정보 및 학급 구성', '시간표 보관', '학교 행사 기록', '수행평가 및 시험 일정', '상장 및 수상 기록', '학교에서 받은 특별한 편지'] },
    { id: 'friends', icon: '👭', title: '친구 수첩', sub: '3년 동안 함께한 친구들', stage: 3,
      desc: '친구 프로필과 함께한 추억, 관계의 변화를 기록해요.',
      items: ['학년별 친구 분류', '같은 반이었던 친구 모아보기', '즐겨찾는 친구', '친구별 프로필·사진첩', '친구 생일 달력', '관계 변화 기록', '친구별 추억 타임라인·메모·태그'] },
    { id: 'diary', icon: '📔', title: '일상 다이어리', sub: '오늘 하루를 기록해요', stage: 3,
      desc: '달력에서 날짜를 눌러 날씨·기분·사진과 함께 하루를 기록해요.',
      items: ['달력에서 날짜 눌러 쓰기', '하루에 여러 개 기록', '사진 여러 장 첨부', '날씨·기분 스티커', '오늘 만난 친구·선생님·먹은 음식·들은 노래', '태그 및 검색', '월별·학년별 모아보기', '비공개 메모'] },
    { id: 'memories', icon: '📸', title: '추억 보관함', sub: '특별한 날을 모아두는 앨범', stage: 3,
      desc: '일기와 따로, 오래 간직하고 싶은 특별한 순간을 스크랩북 앨범처럼 모아요.',
      items: ['카테고리 7종 (학교 행사·친구·선생님·문화생활 등)', '사진 갤러리·동영상 보관', '티켓·종이 자료 보관', '학년별·연도별 타임라인', '추억 장소 기록 (표시 방식은 확인 후 결정)', '즐겨찾기·태그·검색', '카드 꾸미기·표지 지정'] },
    { id: 'study', icon: '📚', title: '학업 기록', sub: '시험·수행평가·공부 시간 관리', stage: 4,
      desc: '시험 점수와 등급, 수행평가, 공부 시간을 기록하고 그래프로 봐요.',
      items: ['과목 추가·관리', '시험 기록 (점수·등급·성취도)', '평균 자동 계산', '학기별·학년별 성적 비교', '수행평가 관리 (마감일·진행 상태)', '공부 시간·범위·교재 기록', '주간·월간 통계 그래프'] },
    { id: 'decorate', icon: '🎀', title: '다이어리 꾸미기', sub: '스티커와 사진으로 페이지 꾸미기', stage: 5,
      desc: '모든 꾸미기 재료를 처음부터 자유롭게 쓸 수 있어요. 잠금이나 포인트는 없어요.',
      items: ['테마 6종', '꾸미기 재료 10종', '스티커 드래그·크기·회전', '사진 프레임·자르기·콜라주', '마스킹테이프·메모지 자유 배치', '페이지 복사 및 재사용', '나만의 스티커 등록', '꾸민 페이지 이미지로 저장'] },
    { id: 'settings', icon: '⚙️', title: '설정 및 데이터 관리', sub: '화면 · 백업 · 인쇄 · 휴지통 · 계정' },
    { id: 'search', icon: '🔍', title: '통합 검색', sub: '모든 메뉴의 기록을 한 번에 찾아요', hidden: true }
  ];

  M.findMenu = function (id) {
    return M.menu.find(function (m) { return m.id === id; });
  };

  /* ---------------- 공통 조각 ---------------- */
  function widget(o) {
    return '<section class="card ' + (o.tape || 'tape') + ' ' + (o.cls || '') + '">' +
      '<h2 class="w-head"><span class="w-icon" aria-hidden="true">' + o.icon + '</span>' + o.title + '</h2>' +
      '<div class="w-body">' + o.body + '</div>' +
      (o.link ? '<a class="btn" href="#/' + o.link + '">' + o.linkLabel + '</a>' : '') +
      '</section>';
  }
  function empty(text) { return '<p class="empty">' + text + '</p>'; }

  /* ---------------- 홈 ---------------- */
  M.pages = {};
  M.mods = M.mods || {};

  /* ---------------- 설정: 저장 공간 현황 ---------------- */
  M.pages.fillStorage = async function (el) {
    if (!el) return;
    const fmt = M.media.fmtSize;
    if (M.dbError) {
      el.innerHTML = '<p class="empty">⚠️ ' + M.dbError.message + '</p>';
      return;
    }
    let st, est = null, persisted = null;
    try {
      st = await M.db.stats();
    } catch (e) {
      el.innerHTML = '<p class="empty">⚠️ ' + M.db.friendly(e).message + '</p>';
      return;
    }
    try {
      if (navigator.storage && navigator.storage.estimate) est = await navigator.storage.estimate();
      if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted();
    } catch (e) { /* 지원하지 않는 브라우저 */ }
    if (!el.isConnected) return;

    const pct = est && est.quota ? Math.min(100, (est.usage / est.quota) * 100) : 0;
    const R = M.media.RULES;
    el.innerHTML =
      '<div class="stat-grid">' +
        '<div class="stat"><span class="n">' + st.records + '</span><span class="l">기록</span></div>' +
        '<div class="stat"><span class="n">' + st.images + '</span><span class="l">사진</span></div>' +
        '<div class="stat"><span class="n">' + st.videos + '</span><span class="l">동영상</span></div>' +
        '<div class="stat"><span class="n">' + fmt(st.mediaBytes) + '</span><span class="l">사진·동영상 용량</span></div>' +
      '</div>' +
      (est && est.quota
        ? '<div class="usage"><div class="usage-bar"><span style="width:' + Math.max(pct, 1).toFixed(1) + '%"></span></div>' +
          '<p class="desc">이 브라우저에서 쓸 수 있는 공간 ' + fmt(est.quota) + ' 중 ' + fmt(est.usage || 0) + ' 사용 중</p></div>'
        : '<p class="desc">이 브라우저는 남은 저장 공간을 알려주지 않아요.</p>') +
      '<ul class="todo-list">' +
        '<li>사진: 한 장에 <b>' + fmt(R.image.max) + '</b>까지 (' + R.image.ext + ')</li>' +
        '<li>동영상: 한 개에 <b>' + fmt(R.video.max) + '</b>까지 (' + R.video.ext + ')</li>' +
        '<li>같은 파일을 여러 번 올려도 한 번만 저장돼서 공간을 아껴요.</li>' +
      '</ul>' +
      (persisted === null ? '' :
        '<div class="persist-row">' +
          (persisted
            ? '<span class="chip">🛡️ 기록 보호 켜짐</span><span class="desc">저장 공간이 부족해도 브라우저가 기록을 자동으로 지우지 않아요.</span>'
            : '<button type="button" class="btn" id="persistBtn">🛡️ 기록 보호 요청하기</button>' +
              '<span class="desc">브라우저가 저장 공간이 부족할 때 기록을 자동으로 지우지 않도록 요청해요.</span>') +
        '</div>');

    const btn = document.getElementById('persistBtn');
    if (btn) btn.addEventListener('click', async function () {
      let ok = false;
      try { ok = await navigator.storage.persist(); } catch (e) { ok = false; }
      if (ok) M.toast('기록 보호가 켜졌어요 🛡️');
      else M.toast('브라우저가 요청을 받아들이지 않았어요. 즐겨찾기에 추가하거나 자주 열면 나중에 허용될 수 있어요. 백업 파일도 꼭 만들어 주세요.', true);
      M.pages.fillStorage(el);
    });
  };

  /* ---------------- 준비 중 메뉴 ---------------- */
  M.pages.placeholder = function (menu) {
    return '<section class="card tape plan-card">' +
      '<span class="stage-badge">' + menu.stage + '단계에서 만들어요</span>' +
      '<p>' + menu.desc + '</p>' +
      '<h3>이 메뉴에 들어갈 기능</h3>' +
      '<ul class="chip-list">' + menu.items.map(function (i) { return '<li>' + i + '</li>'; }).join('') + '</ul>' +
      '</section>';
  };

  /* ---------------- 설정 ---------------- */
  M.pages.settings = function (themeOnly) {
    const s = M.settings.get();
    const themes = M.themes.list;
    const season = M.themes.seasons[M.themes.currentSeason()];

    const themeCards = themes.map(function (t) {
      const selected = s.defaultTheme === t.id;
      return '<button type="button" class="theme-card" data-theme="' + M.themes.resolve(t.id) + '" data-pick-default="' + t.id + '" aria-pressed="' + selected + '">' +
        '<span class="check" aria-hidden="true">✔️</span>' +
        '<span class="mini" aria-hidden="true"></span>' +
        '<span class="name">' + t.emoji + ' ' + t.name + '</span>' +
        '</button>';
    }).join('');

    const defaultName = M.themes.byId(s.defaultTheme).name;
    const pageRows = M.menu.filter(function (m) { return !m.hidden; }).map(function (m) {
      const own = s.pageThemes[m.id] || '';
      const opts = '<option value="">기본 테마 따르기 (' + defaultName + ')</option>' +
        themes.map(function (t) {
          return '<option value="' + t.id + '"' + (own === t.id ? ' selected' : '') + '>' + t.emoji + ' ' + t.name + '</option>';
        }).join('');
      return '<li><span class="lbl">' + m.icon + ' ' + m.title + '</span>' +
        '<select class="select" data-page-theme="' + m.id + '" aria-label="' + m.title + ' 페이지 테마">' + opts + '</select></li>';
    }).join('');

    const themeSections =
      '<section class="card tape">' +
        '<h2>🎨 전체 기본 테마</h2>' +
        '<p class="desc">따로 테마를 정하지 않은 모든 페이지에 적용돼요. 계절별 테마는 지금 달에 맞춰 바뀌어요 (지금은 ' + season.emoji + ' ' + season.name + ').</p>' +
        '<div class="theme-grid">' + themeCards + '</div>' +
      '</section>' +

      '<section class="card tape-left">' +
        '<h2>📄 페이지별 테마</h2>' +
        '<p class="desc">페이지마다 다른 테마를 쓸 수 있어요. 각 페이지 위쪽의 "이 페이지 테마"에서도 바꿀 수 있어요. 덕질노트의 인물·작품은 각 기록에서 따로 테마를 고를 수 있어요.</p>' +
        '<ul class="page-theme-list">' + pageRows + '</ul>' +
      '</section>';
    if (themeOnly) return '<div class="settings-stack">' + themeSections + '</div>';

    return '<div class="settings-stack">' + themeSections +

      '<section class="card tape">' +
        '<h2>💾 저장 공간</h2>' +
        '<p class="desc">글 기록과 사진·동영상을 따로 나눠서 이 기기 안에 저장해요.</p>' +
        '<div id="storageInfo"><p class="empty">확인하는 중…</p></div>' +
      '</section>' +

      '<section class="card tape-corner">' +
        '<h2>🔒 개인정보 보호</h2>' +
        '<p class="desc">이 다이어리는 인터넷 서버를 쓰지 않아요. 모든 기록은 이 기기의 브라우저 안에만 저장되고, 외부로 보내지 않아요.</p>' +
        '<ul class="todo-list">' +
          '<li>브라우저의 "사이트 데이터 삭제"를 하거나 기기를 바꾸면 기록이 사라질 수 있어요. 그래서 7단계에서 <b>백업 파일 만들기</b>를 넣을 거예요.</li>' +
          '<li>잠금 화면은 가족이나 친구가 무심코 여는 것을 막아 줘요. 하지만 기기를 잘 아는 사람까지 완벽하게 막지는 못해요.</li>' +
        '</ul>' +
      '</section>' +

      '<section class="card tape">' +
        '<h2>🛠️ 앞으로 추가될 설정</h2>' +
        '<ul class="todo-list">' +
          '<li><b>잠금 화면 · 휴지통 · 다크 모드 · 글자 크기</b>: 6단계</li>' +
          '<li><b>백업 · 복원 (사진·동영상 포함) · PDF · 졸업 포토북</b>: 7단계</li>' +
        '</ul>' +
      '</section>' +
    '</div>';
  };
})();

/* ===== js/ui.js ===== */
/* 화면 공통 도우미: 날짜, 학년 계산, 사진 표시, 목록 카드 등 */
(function () {
  const M = window.MMSD;
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return ymd(new Date()); }
  function parse(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
    const p = s.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }
  function fmtDate(s, withWeek) {
    const d = parse(s);
    if (!d) return '';
    return d.getFullYear() + '. ' + (d.getMonth() + 1) + '. ' + d.getDate() + (withWeek === false ? '' : ' (' + WEEK[d.getDay()] + ')');
  }
  function fmtStamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* 프로필의 입학일을 기준으로 날짜의 학년 계산 (학년은 3월 1일에 바뀜) */
  function gradeFor(dateStr) {
    const p = M.profile;
    const entry = p && p.data && p.data.entryDate;
    const e = parse(entry), d = parse(dateStr);
    if (!e || !d) return null;
    const sy = function (x) { return x.getMonth() >= 2 ? x.getFullYear() : x.getFullYear() - 1; };
    const g = sy(d) - sy(e) + 1;
    return g >= 1 && g <= 3 ? g : null;
  }

  async function loadProfile() {
    try {
      const l = await M.db.list('profile');
      M.profile = l[0] || null;
    } catch (e) { M.profile = null; }
    return M.profile;
  }

  /* <img data-media="id"> 에 저장된 사진을 채움 */
  function hydrate(root) {
    root.querySelectorAll('img[data-media]').forEach(function (img) {
      M.media.url(img.dataset.media, img.dataset.variant || 'thumb').then(function (u) {
        if (u) img.src = u;
        else img.replaceWith(Object.assign(document.createElement('span'), { textContent: '🖼️' }));
      }).catch(function () {});
    });
  }

  function thumb(rec, emoji, cls) {
    const id = (rec.mediaIds || [])[0];
    return '<div class="thumb ' + (cls || '') + '">' +
      (id ? '<img data-media="' + esc(id) + '" alt="">' : '<span aria-hidden="true">' + emoji + '</span>') + '</div>';
  }

  function empty(emoji, text, href, label) {
    return '<div class="empty-state card"><div class="es-emoji" aria-hidden="true">' + emoji + '</div><p>' + text + '</p>' +
      (href ? '<a class="btn primary" href="' + href + '">' + label + '</a>' : '') + '</div>';
  }

  function tabs(base, items, active) {
    return '<nav class="tabs" aria-label="하위 메뉴">' + items.map(function (it) {
      return '<a href="#/' + base + '/' + it[0] + '"' + (it[0] === active ? ' aria-current="page"' : '') + '>' + it[1] + '</a>';
    }).join('') + '</nav>';
  }

  function match(rec, q) {
    if (!q) return true;
    return JSON.stringify([rec.title, rec.tags, rec.data, rec.date]).toLowerCase().indexOf(q.toLowerCase()) >= 0;
  }

  function daysToBirthday(dateStr) {
    const b = parse(dateStr);
    if (!b) return null;
    const t = parse(today());
    let n = new Date(t.getFullYear(), b.getMonth(), b.getDate());
    if (n < t) n = new Date(t.getFullYear() + 1, b.getMonth(), b.getDate());
    return Math.round((n - t) / 86400000);
  }
  function daysUntil(dateStr) {
    const d = parse(dateStr);
    if (!d) return null;
    return Math.round((d - parse(today())) / 86400000);
  }
  function dday(n) { return n === 0 ? 'D-DAY' : (n > 0 ? 'D-' + n : 'D+' + (-n)); }

  function gradeLabel(g) { return g ? g + '학년' : '학년 미정'; }

  /* 학년별 묶기: [[1, [...]], [2, [...]], [3, [...]], [null, [...]]] */
  function byGrade(list, getGrade) {
    const groups = { 1: [], 2: [], 3: [], x: [] };
    list.forEach(function (r) {
      const g = getGrade ? getGrade(r) : r.grade;
      (groups[g] || groups.x).push(r);
    });
    return [[1, groups[1]], [2, groups[2]], [3, groups[3]], [null, groups.x]].filter(function (g) { return g[1].length; });
  }

  async function nameMap(type) {
    const m = {};
    (await M.db.list(type)).forEach(function (r) { m[r.id] = r.title || '(이름 없음)'; });
    return m;
  }

  function snippet(s, n) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  /* 기록 종류별 화면 주소 */
  const ROUTES = {
    profile: '#/profile', growth: '#/growth/edit/', friend: '#/friends/edit/', friendMemory: '#/friends/memory/edit/',
    diary: '#/diary/edit/', memory: '#/memories/edit/',
    teacher: '#/school/teachers/edit/', club: '#/school/clubs/edit/', classInfo: '#/school/class/edit/', timetable: '#/school/timetable/edit/',
    schoolEvent: '#/school/events/edit/', schedule: '#/school/schedule/edit/', award: '#/school/awards/edit/', letter: '#/school/letters/edit/',
    person: '#/fandom/persons/edit/', work: '#/fandom/works/edit/', performance: '#/fandom/shows/edit/', goods: '#/fandom/goods/edit/',
    music: '#/fandom/music/edit/', fandomDiary: '#/fandom/diary/edit/',
    exam: '#/study/exams/edit/', assessment: '#/study/assess/edit/', studyLog: '#/study/study/edit/', book: '#/study/books/edit/', subject: '#/study/subjects/edit/',
    page: '#/decorate/edit/'
  };
  function hrefOf(rec) {
    const r = ROUTES[rec.type];
    if (!r) return null;
    return rec.type === 'profile' ? r : r + rec.id;
  }

  /* ---------- 파일 저장 (브라우저 · 안드로이드 앱 공용) ----------
     앱 안에서는 window.AndroidDiary 연결 장치로 휴대폰의 Download 폴더에 저장해요. */
  M.savedWhere = function () {
    return window.AndroidDiary ? '휴대폰의 Download/중학생활다이어리 폴더에 저장했어요.' : '다운로드 폴더를 확인해 주세요.';
  };
  M.saveFile = async function (blob, name) {
    if (window.AndroidDiary) {
      const A = window.AndroidDiary;
      const id = A.begin(name, blob.type || 'application/octet-stream');
      if (!id || id.indexOf('ERR:') === 0) throw MMSD.AppError('SAVE', '파일을 저장하지 못했어요. ' + String(id || '').slice(4));
      const CH = 3 * 131072; /* 3의 배수로 잘라야 조각마다 따로 바꿀 수 있어요 */
      for (let o = 0; o < blob.size; o += CH) {
        const buf = new Uint8Array(await blob.slice(o, o + CH).arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        const r = A.write(id, btoa(s));
        if (r !== 'OK') throw MMSD.AppError('SAVE', '파일을 저장하는 중 문제가 생겼어요. ' + String(r).slice(4));
      }
      const f = A.finish(id);
      if (f !== 'OK') throw MMSD.AppError('SAVE', '파일을 저장하지 못했어요. ' + String(f).slice(4));
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  };

  M.ui = {
    hrefOf: hrefOf,
    esc: esc, pad: pad, ymd: ymd, today: today, parse: parse, WEEK: WEEK,
    fmtDate: fmtDate, fmtStamp: fmtStamp, gradeFor: gradeFor, gradeLabel: gradeLabel,
    loadProfile: loadProfile, hydrate: hydrate, thumb: thumb, empty: empty, tabs: tabs,
    match: match, daysToBirthday: daysToBirthday, daysUntil: daysUntil, dday: dday,
    byGrade: byGrade, nameMap: nameMap, snippet: snippet
  };
})();

/* ===== js/forms.js ===== */
/* =========================================================
   공통 입력 양식 + 자동 저장 편집 화면
   필드 정의: { k, label, t, top?, opts?, of?, ph?, hint?, full?, unit?, rows?, cols? }
     t     : text | textarea | number | date | select | grade | choice | multi
             | link(다른 기록 연결) | tags | check | media | rows(여러 줄 목록)
             | timetable | secret(비공개 메모) | section(소제목)
     top   : 기록의 최상위 칸에 저장 (title | date | grade | tags | mediaIds)
             없으면 record.data[k] 에 저장
   ========================================================= */
(function () {
  const M = window.MMSD;

  const OPTS = {
    weather: ['☀️ 맑음', '⛅ 구름 조금', '☁️ 흐림', '🌧️ 비', '⛈️ 천둥번개', '❄️ 눈', '🌫️ 안개', '🌬️ 바람'],
    mood: ['😊 좋음', '🥰 설렘', '😆 신남', '😌 평온', '😐 그냥 그래', '😢 슬픔', '😠 화남', '😰 걱정', '😴 피곤'],
    avatar: ['🐣', '🐰', '🐻', '🐱', '🐶', '🦊', '🐼', '🐨', '🐧', '🦄', '🐹', '🐸']
  };
  const DAYS = ['월', '화', '수', '목', '금'];
  /* "🎀 꾸미기" 버튼을 보여줄 기록 종류 (인물·작품별 개별 꾸미기 포함) */
  const DECO_TYPES = ['profile', 'growth', 'friend', 'friendMemory', 'diary', 'memory', 'teacher', 'club', 'schoolEvent', 'letter',
    'person', 'work', 'performance', 'fandomDiary'];
  const PERIODS = 7;

  function labelOf(r) {
    if (r.type === 'diary') return M.ui.fmtDate(r.date, false) + ' ' + M.ui.snippet(r.title, 14);
    return r.title || '(이름 없음)';
  }

  async function prepare(fields) {
    const out = {};
    for (const f of fields) {
      if (f.t === 'link' && !out[f.of]) {
        out[f.of] = (await M.db.list(f.of)).map(function (r) { return { id: r.id, label: labelOf(r) }; });
      }
    }
    return out;
  }

  function val(f, rec) { return f.top ? rec[f.top] : (rec.data || {})[f.k]; }

  function rowHTML(f, r) {
    const esc = M.ui.esc;
    return '<div class="row">' + f.cols.map(function (c) {
      const cv = r ? (r[c.k] || '') : '';
      const st = c.w ? ' style="flex:' + c.w + '"' : '';
      if (c.t === 'select') {
        return '<select class="inp" data-col="' + c.k + '" aria-label="' + c.label + '"' + st + '><option value="">' + c.label + '</option>' +
          c.opts.map(function (o) { return '<option' + (o === cv ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
      }
      return '<input class="inp" type="' + (c.t || 'text') + '" data-col="' + c.k + '" value="' + esc(cv) + '" placeholder="' + c.label + '" aria-label="' + c.label + '"' + st + '>';
    }).join('') + '<button type="button" class="row-del" aria-label="이 줄 지우기">✕</button></div>';
  }

  function chipsHTML(key, items, selected) {
    selected = selected || [];
    return '<div class="choice">' + items.map(function (o) {
      const v = typeof o === 'string' ? o : o.id;
      const l = typeof o === 'string' ? o : o.label;
      return '<label class="chk"><input type="checkbox" data-multi="' + key + '" value="' + M.ui.esc(v) + '"' +
        (selected.indexOf(v) >= 0 ? ' checked' : '') + '><span>' + M.ui.esc(l) + '</span></label>';
    }).join('') + '</div>';
  }

  function fieldHTML(f, rec, opts) {
    const esc = M.ui.esc;
    if (f.t === 'section') return '<h3 class="fsection">' + esc(f.label) + '</h3>';
    const v = val(f, rec);
    const id = 'f_' + f.k;
    const ph = f.ph ? ' placeholder="' + esc(f.ph) + '"' : '';
    const dk = ' data-k="' + f.k + '"';
    let inner = '';
    switch (f.t) {
      case 'text':
        inner = '<input id="' + id + '" class="inp" type="text"' + dk + ' value="' + esc(v || '') + '"' + ph + '>';
        break;
      case 'number':
        inner = '<div class="unit-wrap"><input id="' + id + '" class="inp" type="number" step="any" inputmode="decimal"' + dk +
          ' value="' + (v == null ? '' : esc(v)) + '"' + ph + '>' + (f.unit ? '<span class="unit">' + f.unit + '</span>' : '') + '</div>';
        break;
      case 'date':
        inner = '<input id="' + id + '" class="inp" type="date"' + dk + ' value="' + esc(v || '') + '">';
        break;
      case 'textarea':
        inner = '<textarea id="' + id + '" class="inp" rows="' + (f.rows || 3) + '"' + dk + ph + '>' + esc(v || '') + '</textarea>';
        break;
      case 'select':
        inner = '<select id="' + id + '" class="inp"' + dk + '><option value="">선택 안 함</option>' +
          f.opts.map(function (o) { return '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
        break;
      case 'grade':
        inner = '<select id="' + id + '" class="inp"' + dk + '><option value="">선택 안 함</option>' +
          [1, 2, 3].map(function (g) { return '<option value="' + g + '"' + (Number(v) === g ? ' selected' : '') + '>' + g + '학년</option>'; }).join('') + '</select>';
        break;
      case 'choice':
        inner = '<input type="hidden"' + dk + ' value="' + esc(v || '') + '"><div class="choice" role="group" aria-label="' + esc(f.label) + '">' +
          f.opts.map(function (o) {
            return '<button type="button" class="chip-btn' + (f.big ? ' big' : '') + '" data-choice="' + f.k + '" data-val="' + esc(o) + '" aria-pressed="' + (o === v) + '">' + esc(o) + '</button>';
          }).join('') + '</div>';
        break;
      case 'multi':
        inner = chipsHTML(f.k, f.opts, v);
        break;
      case 'link': {
        const list = opts[f.of] || [];
        inner = list.length ? chipsHTML(f.k, list, v) : '<p class="fhint">' + esc(f.emptyText || '아직 등록된 기록이 없어요.') + '</p>';
        break;
      }
      case 'tags':
        inner = '<input id="' + id + '" class="inp" type="text"' + dk + ' value="' + esc((v || []).map(function (t) { return '#' + t; }).join(' ')) +
          '" placeholder="#태그 #띄어쓰기로_구분">';
        break;
      case 'check':
        inner = '<label class="switch"><input type="checkbox"' + dk + (v ? ' checked' : '') + '><span>' + esc(f.label) + '</span></label>';
        break;
      case 'media':
        inner = '<div class="media-slot" data-media-k="' + f.k + '"></div>';
        break;
      case 'rows':
        inner = '<div class="rows" data-rows="' + f.k + '"><div class="rows-list">' + (v || []).map(function (r) { return rowHTML(f, r); }).join('') +
          '</div><button type="button" class="btn small" data-add-row="' + f.k + '">+ ' + (f.addLabel || '추가') + '</button></div>';
        break;
      case 'timetable': {
        const t = v || {};
        inner = '<div class="tt-wrap"><table class="tt"><thead><tr><th></th>' + DAYS.map(function (d) { return '<th>' + d + '</th>'; }).join('') +
          '</tr></thead><tbody>';
        for (let p = 1; p <= PERIODS; p++) {
          inner += '<tr><th>' + p + '교시</th>' + DAYS.map(function (d, i) {
            const key = i + '-' + p;
            return '<td><input class="inp" data-tt="' + key + '" value="' + esc(t[key] || '') + '" aria-label="' + d + '요일 ' + p + '교시"></td>';
          }).join('') + '</tr>';
        }
        inner += '</tbody></table></div>';
        break;
      }
      case 'secret':
        inner = '<details class="secret"><summary>🔒 비공개 메모 (눌러서 열기)</summary><textarea class="inp" rows="3"' + dk + ' aria-label="비공개 메모">' + esc(v || '') + '</textarea></details>';
        break;
    }
    const forable = ['text', 'number', 'date', 'textarea', 'select', 'grade', 'tags'].indexOf(f.t) >= 0;
    const label = (f.t === 'check' || f.t === 'secret') ? '' :
      '<' + (forable ? 'label for="' + id + '"' : 'span') + ' class="flabel">' + esc(f.label) + '</' + (forable ? 'label' : 'span') + '>';
    return '<div class="field' + (f.full ? ' full' : '') + '">' + label + inner + (f.hint ? '<p class="fhint">' + esc(f.hint) + '</p>' : '') + '</div>';
  }

  function collect(root, fields, base) {
    const rec = Object.assign({}, base, { data: Object.assign({}, base.data || {}) });
    const links = [];
    fields.forEach(function (f) {
      if (f.t === 'section') return;
      const el = root.querySelector('[data-k="' + f.k + '"]');
      let v;
      switch (f.t) {
        case 'number': v = el.value === '' ? null : Number(el.value); break;
        case 'grade': v = el.value ? Number(el.value) : null; break;
        case 'tags':
          v = el.value.split(/[\s,]+/).map(function (t) { return t.replace(/^#+/, '').trim(); }).filter(Boolean);
          break;
        case 'check': v = el.checked; break;
        case 'multi':
        case 'link':
          v = Array.from(root.querySelectorAll('[data-multi="' + f.k + '"]:checked')).map(function (i) { return i.value; });
          if (f.t === 'link') {
            /* 화면에 안 보이는 연결(휴지통에 있는 친구 등)은 지우지 않고 그대로 둠 */
            const shown = Array.from(root.querySelectorAll('[data-multi="' + f.k + '"]')).map(function (i) { return i.value; });
            (val(f, base) || []).forEach(function (id) { if (shown.indexOf(id) < 0 && v.indexOf(id) < 0) v.push(id); });
            v.forEach(function (id) { links.push({ type: f.of, id: id }); });
          }
          break;
        case 'media': v = root._pickers && root._pickers[f.k] ? root._pickers[f.k].getIds() : (val(f, base) || []); break;
        case 'rows':
          v = Array.from(root.querySelectorAll('[data-rows="' + f.k + '"] .row')).map(function (row) {
            const o = {};
            row.querySelectorAll('[data-col]').forEach(function (i) { o[i.dataset.col] = i.value.trim(); });
            return o;
          }).filter(function (o) { return Object.keys(o).some(function (k) { return o[k]; }); });
          break;
        case 'timetable':
          v = {};
          root.querySelectorAll('[data-tt]').forEach(function (i) { if (i.value.trim()) v[i.dataset.tt] = i.value.trim(); });
          break;
        default: v = el ? el.value : '';
      }
      if (f.top) rec[f.top] = v; else rec.data[f.k] = v;
    });
    rec.links = links;
    return rec;
  }

  /* ---------------------------------------------------------
     편집 화면
     cfg: { type, fields, rec, back, backLabel, titleOf(rec), editHref(id),
            onSaved(saved), extra(rec) → html, before, noDelete, noBack }
     --------------------------------------------------------- */
  async function editor(container, cfg) {
    const esc = M.ui.esc;
    const opts = await prepare(cfg.fields);
    const state = { rec: Object.assign({ type: cfg.type, data: {} }, cfg.rec || {}) };
    const gradeField = cfg.fields.find(function (f) { return f.t === 'grade' && f.top === 'grade'; });
    let autoGrade = false;
    if (!state.rec.id && gradeField && state.rec.date && state.rec.grade == null) {
      state.rec.grade = M.ui.gradeFor(state.rec.date);
      autoGrade = state.rec.grade != null;
    }

    container.innerHTML = '<div class="editor">' +
      (cfg.before || '') +
      '<div class="editor-bar">' +
        (cfg.noBack ? '' : '<a class="btn" href="' + cfg.back + '">← ' + (cfg.backLabel || '목록으로') + '</a>') +
        '<span class="ed-meta" id="edMeta"></span>' +
        (DECO_TYPES.indexOf(cfg.type) >= 0 ? '<a class="btn" id="edDeco" hidden>🎀 꾸미기</a>' : '') +
        (cfg.noDelete ? '' : '<button type="button" class="btn danger" id="edDel">🗑️ 휴지통으로</button>') +
      '</div>' +
      '<form class="card tape form-grid" id="edForm" novalidate>' +
        cfg.fields.map(function (f) { return fieldHTML(f, state.rec, opts); }).join('') +
      '</form>' +
      '<div id="edExtra"></div></div>';

    const form = container.querySelector('#edForm');
    const metaEl = container.querySelector('#edMeta');
    const decoBtn = container.querySelector('#edDeco');
    function meta() {
      if (decoBtn && state.rec.id) {
        decoBtn.hidden = false;
        decoBtn.href = '#/decorate/for/' + state.rec.id;
        decoBtn.title = '이 기록만의 페이지를 스티커와 사진으로 꾸며요';
      }
      metaEl.textContent = state.rec.id
        ? '처음 작성 ' + M.ui.fmtStamp(state.rec.createdAt) + ' · 마지막 수정 ' + M.ui.fmtStamp(state.rec.updatedAt)
        : '✏️ 새 기록이에요. 입력하면 자동으로 저장돼요.';
    }
    meta();

    async function showExtra() {
      if (!cfg.extra || !state.rec.id) return;
      const box = container.querySelector('#edExtra');
      try {
        box.innerHTML = await cfg.extra(state.rec);
        M.ui.hydrate(box);
      } catch (e) { box.innerHTML = ''; }
    }

    const saver = M.autosave.create(async function (rec) {
      const isNew = !state.rec.id;
      const saved = await M.db.save(rec);
      state.rec = saved;
      meta();
      if (isNew && cfg.editHref) M.replaceHash(cfg.editHref(saved.id));
      if (cfg.onSaved) await cfg.onSaved(saved);
      if (isNew) showExtra();
    });
    function schedule() {
      saver.schedule(function () {
        const r = collect(form, cfg.fields, Object.assign({}, state.rec, { type: cfg.type }));
        if (cfg.titleOf) r.title = cfg.titleOf(r);
        return r;
      });
    }

    form.addEventListener('submit', function (e) { e.preventDefault(); });
    form.addEventListener('input', schedule);
    /* 학년 자동 채움: 직접 고른 학년은 바꾸지 않고, 자동으로 채운 학년은 날짜를 따라감 */
    const gradeSel = gradeField ? form.querySelector('[data-k="' + gradeField.k + '"]') : null;
    if (gradeSel && autoGrade) gradeSel.dataset.auto = '1';
    function syncGrade(dateVal) {
      if (!gradeSel || !(gradeSel.dataset.auto || !gradeSel.value)) return;
      const g = M.ui.gradeFor(dateVal);
      gradeSel.value = g ? String(g) : '';
      if (g) gradeSel.dataset.auto = '1'; else delete gradeSel.dataset.auto;
    }
    form.addEventListener('change', function (e) {
      if (e.target === gradeSel) delete gradeSel.dataset.auto;
      if (gradeSel && e.target.matches('input[type="date"][data-k="date"]')) syncGrade(e.target.value);
      schedule();
    });
    form.addEventListener('input', function (e) {
      if (gradeSel && e.target.matches('input[type="date"][data-k="date"]')) syncGrade(e.target.value);
    });
    form.addEventListener('click', function (e) {
      const b = e.target.closest('[data-choice]');
      if (b) {
        const k = b.dataset.choice;
        const hidden = form.querySelector('input[type="hidden"][data-k="' + k + '"]');
        const same = hidden.value === b.dataset.val;
        hidden.value = same ? '' : b.dataset.val;
        form.querySelectorAll('[data-choice="' + k + '"]').forEach(function (x) {
          x.setAttribute('aria-pressed', String(x === b && !same));
        });
        schedule();
        return;
      }
      const add = e.target.closest('[data-add-row]');
      if (add) {
        const f = cfg.fields.find(function (x) { return x.k === add.dataset.addRow; });
        const list = add.previousElementSibling;
        list.insertAdjacentHTML('beforeend', rowHTML(f, null));
        list.lastElementChild.querySelector('input,select').focus();
        return;
      }
      const del = e.target.closest('.row-del');
      if (del) { del.closest('.row').remove(); schedule(); }
    });

    form._pickers = {};
    cfg.fields.filter(function (f) { return f.t === 'media'; }).forEach(function (f) {
      form._pickers[f.k] = M.mediaPicker(form.querySelector('[data-media-k="' + f.k + '"]'), {
        ids: val(f, state.rec) || [],
        files: !!f.files,
        onChange: schedule
      });
    });

    const delBtn = container.querySelector('#edDel');
    if (delBtn) delBtn.addEventListener('click', async function () {
      try {
        /* 저장 대기 중인 내용을 먼저 마무리해야 그 기록까지 함께 휴지통으로 감 */
        await saver.flush();
        if (!state.rec.id) { location.hash = cfg.back; return; }
        const id = state.rec.id;
        await M.db.trash(id);
        M.toast('휴지통으로 옮겼어요.', false, {
          label: '되돌리기',
          fn: async function () {
            await M.db.restore(id);
            M.toast('되돌렸어요.');
            M.rerender();
          }
        });
        location.hash = cfg.back;
      } catch (e) {
        M.toast(M.db.friendly(e).message, true);
      }
    });

    showExtra();
    return { state: state, saver: saver, form: form, refreshExtra: showExtra };
  }

  M.forms = { OPTS: OPTS, editor: editor, fieldHTML: fieldHTML, collect: collect, prepare: prepare };
})();

/* ===== js/coll.js ===== */
/* =========================================================
   기록 묶음(컬렉션) 공통 화면: 목록(검색·필터) + 편집
   덕질노트 · 학업 기록에서 사용
   cfg: { type, label, emoji, add, fields | async fields(), titleOf, sub(r), badges(r),
          filters:[{key,label,opts}|{label,opts,test(r,v)}], sort(a,b), custom(list,base),
          before(all) → html, extra(rec) → html, onSaved, newRec(rest), theme(r) → 테마 id,
          round(썸네일 원형), noThumb }
   ========================================================= */
(function () {
  const M = window.MMSD;

  const STARS = ['★', '★★', '★★★', '★★★★', '★★★★★'];

  /* 테마 이름 ↔ id (인물·작품별 테마 선택용) */
  const THEME_NAMES = M.themes.list.map(function (t) { return t.name; });
  function themeIdByName(name) {
    const t = M.themes.list.find(function (x) { return x.name === name; });
    return t ? t.id : null;
  }

  function card(cfg, base, r) {
    const U = M.ui, esc = U.esc;
    const sub = cfg.sub ? cfg.sub(r) : '';
    const theme = cfg.theme ? cfg.theme(r) : null;
    return '<a class="item card' + (theme ? ' themed' : '') + '"' + (theme ? ' data-theme="' + M.themes.resolve(theme) + '"' : '') +
      ' href="#/' + base + '/edit/' + r.id + '">' +
      (cfg.noThumb ? '<div class="thumb"><span aria-hidden="true">' + cfg.emoji + '</span></div>' : U.thumb(r, cfg.emoji, cfg.round ? 'round' : '')) +
      '<div class="item-body"><p class="item-title">' + (r.data.fav ? '<span class="star">⭐</span>' : '') + esc(r.title || '(제목 없음)') + '</p>' +
      (sub ? '<p class="item-sub">' + esc(sub) + '</p>' : '') +
      '<div class="badges">' + (cfg.badges ? cfg.badges(r) : '') + '</div>' +
      '</div></a>';
  }
  function cards(cfg, base, list) {
    return '<div class="item-list">' + list.map(function (r) { return card(cfg, base, r); }).join('') + '</div>';
  }

  async function listPage(el, base, tabsHtml, cfg) {
    const U = M.ui;
    let all = await M.db.list(cfg.type);
    if (cfg.sort) all = all.sort(cfg.sort);
    const filters = cfg.filters || [];
    el.innerHTML = tabsHtml +
      '<div class="toolbar card">' +
        '<input type="search" class="inp" id="cq" placeholder="🔍 ' + cfg.label + ' 검색" aria-label="' + cfg.label + ' 검색">' +
        filters.map(function (f, i) {
          return '<select class="inp" data-cf="' + i + '" aria-label="' + f.label + '"><option value="">' + f.label + '</option>' +
            f.opts.map(function (o) { return '<option>' + U.esc(o) + '</option>'; }).join('') + '</select>';
        }).join('') +
        '<a class="btn primary" href="#/' + base + '/new">+ ' + cfg.add + '</a>' +
      '</div>' +
      '<div id="cbefore">' + (cfg.before ? await cfg.before(all) : '') + '</div>' +
      '<div id="cres"></div>';
    const q = el.querySelector('#cq'), res = el.querySelector('#cres');
    const sels = Array.from(el.querySelectorAll('[data-cf]'));
    function draw() {
      const list = all.filter(function (r) {
        if (!U.match(r, q.value.trim())) return false;
        return sels.every(function (s) {
          const f = filters[Number(s.dataset.cf)];
          if (!s.value) return true;
          return f.test ? f.test(r, s.value) : r.data[f.key] === s.value;
        });
      });
      if (!all.length) res.innerHTML = U.empty(cfg.emoji, '아직 기록이 없어요.', '#/' + base + '/new', '+ ' + cfg.add);
      else if (!list.length) res.innerHTML = '<p class="empty center">찾는 기록이 없어요.</p>';
      else res.innerHTML = cfg.custom ? cfg.custom(list, base) : cards(cfg, base, list);
      U.hydrate(res);
    }
    q.addEventListener('input', draw);
    sels.forEach(function (s) { s.addEventListener('change', draw); });
    draw();
  }

  async function editPage(el, base, cfg, sub, menuId) {
    const fields = typeof cfg.fields === 'function' ? await cfg.fields() : cfg.fields;
    let rec;
    if (sub[0] === 'edit') {
      rec = await M.db.get(sub[1]);
      if (!rec || rec.trashed || rec.type !== cfg.type) {
        el.innerHTML = M.ui.empty('🔍', '기록을 찾을 수 없어요. 휴지통으로 옮겨졌을 수 있어요.', '#/' + base, '목록으로');
        return;
      }
    } else {
      rec = Object.assign({ type: cfg.type, data: {} }, cfg.newRec ? await cfg.newRec(sub.slice(1)) : {});
    }
    function applyTheme(r) {
      if (!cfg.theme) return;
      M.themes.apply(cfg.theme(r) || M.themes.effectiveFor(menuId));
    }
    applyTheme(rec);
    await M.forms.editor(el, {
      type: cfg.type, fields: fields, rec: rec,
      back: '#/' + base, backLabel: cfg.label + ' 목록',
      titleOf: cfg.titleOf,
      editHref: function (id) { return '#/' + base + '/edit/' + id; },
      extra: cfg.extra,
      onSaved: async function (s) {
        applyTheme(s);
        if (cfg.onSaved) await cfg.onSaved(s);
      }
    });
  }

  /* 가로 막대 그래프 (값 목록) */
  function barList(items, unit, emptyText) {
    const esc = M.ui.esc;
    items = items.filter(function (i) { return i.value > 0; });
    if (!items.length) return '<p class="empty">' + (emptyText || '아직 기록이 없어요.') + '</p>';
    const max = Math.max.apply(null, items.map(function (i) { return i.value; }));
    return '<ul class="bars">' + items.map(function (i) {
      return '<li><span class="bar-label">' + esc(i.label) + '</span><span class="bar-track"><span class="bar-fill" style="width:' +
        Math.max(3, i.value / max * 100).toFixed(1) + '%"></span></span><span class="bar-val">' + esc(i.display || (i.value + (unit || ''))) + '</span></li>';
    }).join('') + '</ul>';
  }

  /* 최근 12개월 키 목록 ['2025-12', ... '2026-11'] */
  function last12Months() {
    const out = [];
    const d = new Date();
    for (let i = 11; i >= 0; i--) {
      const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
      out.push(x.getFullYear() + '-' + M.ui.pad(x.getMonth() + 1));
    }
    return out;
  }

  function won(n) { return (Number(n) || 0).toLocaleString('ko-KR') + '원'; }

  M.coll = {
    STARS: STARS, THEME_NAMES: THEME_NAMES, themeIdByName: themeIdByName,
    card: card, cards: cards, listPage: listPage, editPage: editPage,
    barList: barList, last12Months: last12Months, won: won
  };
})();

/* ===== js/deco.js ===== */
/* =========================================================
   다이어리 꾸미기: 재료 · 페이지 그리기(화면/이미지)
   페이지 = 800 × 1100 크기의 종이. 모든 재료는 이 좌표로 저장해요.
   item: { id, kind, x, y, w, h, rot, z, ... }
     sticker  : emoji | mediaId(나만의 스티커)
     tape     : style
     memo     : style, text, fs
     photo    : mediaId, frame, zoom, cx, cy
     collage  : mediaIds[], frame
     text     : text, fs, color, bold
   ========================================================= */
(function () {
  const M = window.MMSD;
  const W = 800, H = 1100;

  /* ---------- 재료 (모두 처음부터 사용 가능) ---------- */
  const STICKERS = [
    { id: 'char', name: '🐰 캐릭터·동물', list: ['🐶', '🐱', '🐰', '🐻', '🐼', '🐨', '🦊', '🐹', '🐸', '🐧', '🐥', '🦄', '🐳', '🐙', '🦋', '🐝', '🐞', '🐢', '🦖', '🐯', '🐮', '🐷'] },
    { id: 'food', name: '🍰 음식·디저트', list: ['🍓', '🍒', '🍑', '🍰', '🧁', '🍩', '🍪', '🍫', '🍬', '🍭', '🍦', '🍨', '🍮', '🥞', '🧇', '🍙', '🍣', '🍕', '🍔', '🧋', '🍉', '🥤'] },
    { id: 'flower', name: '🌷 꽃·식물', list: ['🌸', '🌷', '🌹', '🌻', '🌼', '💐', '🌺', '🪷', '🍀', '🌿', '🌱', '🌵', '🍃', '🌾', '🪴', '🍄', '🌳', '🥀'] },
    { id: 'star', name: '✨ 별·하트·반짝이', list: ['⭐', '🌟', '✨', '💫', '💖', '💗', '💕', '💞', '💓', '💝', '❤️', '🧡', '💛', '💚', '💙', '💜', '🤍', '🎀', '💎', '🔮', '🫧', '🪐'] },
    { id: 'school', name: '✏️ 학교생활', list: ['📚', '📖', '✏️', '🖍️', '📏', '📐', '📎', '📌', '🎒', '🏫', '🔔', '🏆', '🥇', '📝', '🎨', '🎵', '⚽', '🏀', '💯', '🖊️', '🧮', '🔬'] },
    { id: 'season', name: '🌈 계절·날씨', list: ['☀️', '🌤️', '⛅', '🌧️', '⛈️', '❄️', '☃️', '⛄', '🌈', '🌙', '🍂', '🍁', '🎃', '🎄', '🎆', '🌊', '🏖️', '☂️', '🧣', '🌨️'] }
  ];
  const TAPES = [
    { id: 'pink', name: '핑크 줄무늬', a: '#ffb6c9', b: '#ffe2ea', p: 'stripe' },
    { id: 'blue', name: '블루 줄무늬', a: '#a9d2f5', b: '#e6f2fd', p: 'stripe' },
    { id: 'mint', name: '민트 도트', a: '#8fd9c2', b: '#e3f8f1', p: 'dots' },
    { id: 'lemon', name: '레몬 체크', a: '#ffd75e', b: '#fff6c9', p: 'check' },
    { id: 'gingham', name: '빨강 깅엄', a: '#f29a9a', b: '#ffffff', p: 'check' },
    { id: 'lav', name: '라벤더', a: '#d6c8ff', b: '#d6c8ff', p: 'solid' },
    { id: 'kraft', name: '크라프트', a: '#d6b88a', b: '#d6b88a', p: 'solid' },
    { id: 'rainbow', name: '무지개', a: '', b: '', p: 'rainbow' }
  ];
  const MEMOS = [
    { id: 'yellow', name: '노랑 포스트잇', bg: '#fff3a3', line: 'none' },
    { id: 'pink', name: '핑크 포스트잇', bg: '#ffd6e2', line: 'none' },
    { id: 'lined', name: '줄 노트', bg: '#ffffff', line: 'lined', lc: '#c9dcf2' },
    { id: 'grid', name: '모눈 메모', bg: '#fbfdff', line: 'grid', lc: '#d5e5f5' },
    { id: 'letter', name: '꽃 편지지', bg: '#fff7fa', line: 'lined', lc: '#f5c6d6', border: '#f19bb7' },
    { id: 'kraft', name: '크라프트 메모', bg: '#e2c9a3', line: 'none' }
  ];
  const FRAMES = [['none', '틀 없음'], ['polaroid', '폴라로이드'], ['white', '흰 테두리'], ['round', '동그라미'], ['film', '필름'], ['stamp', '우표']];
  const BGS = [
    { id: 'theme', name: '테마 따라가기' },
    { id: 'cream', name: '크림 종이', c: '#fffaf0' },
    { id: 'pinkdot', name: '핑크 도트', c: '#fff0f5', p: 'dots', pc: '#f7c3d4' },
    { id: 'bluegrid', name: '블루 모눈', c: '#f3f8ff', p: 'grid', pc: '#cfe0f3' },
    { id: 'mintline', name: '민트 줄노트', c: '#f1fbf7', p: 'lines', pc: '#bfe6d6' },
    { id: 'lemoncheck', name: '레몬 체크', c: '#fffbe6', p: 'check', pc: 'rgba(255, 214, 90, .3)' },
    { id: 'kraft', name: '크라프트지', c: '#dcc29b', p: 'dots', pc: 'rgba(120, 85, 40, .16)' },
    { id: 'night', name: '밤하늘', c: '#2b3158', p: 'dots', pc: 'rgba(255, 255, 255, .5)' }
  ];
  const BORDERS = [['none', '테두리 없음'], ['dashed', '점선'], ['double', '이중선'], ['stitch', '스티치'], ['round', '둥근 테두리']];

  const find = function (list, id) { return list.find(function (x) { return x.id === id; }) || list[0]; };

  /* ---------- CSS 무늬 ---------- */
  function patternCSS(p, pc) {
    switch (p) {
      case 'dots': return { img: 'radial-gradient(' + pc + ' 2px, transparent 2.6px)', size: '24px 24px' };
      case 'grid': return { img: 'linear-gradient(' + pc + ' 1px, transparent 1px), linear-gradient(90deg, ' + pc + ' 1px, transparent 1px)', size: '28px 28px' };
      case 'lines': return { img: 'linear-gradient(transparent 33px, ' + pc + ' 33px, ' + pc + ' 34px)', size: '100% 34px' };
      case 'check': return { img: 'linear-gradient(90deg, ' + pc + ' 50%, transparent 50%), linear-gradient(' + pc + ' 50%, transparent 50%)', size: '40px 40px' };
      default: return null;
    }
  }
  function tapeCSS(t) {
    switch (t.p) {
      case 'stripe': return 'repeating-linear-gradient(45deg, ' + t.a + ' 0 9px, ' + t.b + ' 9px 18px)';
      case 'dots': return 'radial-gradient(' + t.a + ' 3px, transparent 3.6px) 0 0 / 14px 14px, ' + t.b;
      case 'check': return 'linear-gradient(90deg, ' + t.a + '88 50%, transparent 50%) 0 0 / 20px 20px, linear-gradient(' + t.a + '88 50%, transparent 50%) 0 0 / 20px 20px, ' + t.b;
      case 'rainbow': return 'linear-gradient(90deg, #ffb3ba, #ffdfba, #fff5ba, #baffc9, #bae1ff, #e0c3fc)';
      default: return t.a;
    }
  }
  function memoCSS(m) {
    let s = 'background-color:' + m.bg + ';';
    if (m.line === 'lined') s += 'background-image:linear-gradient(transparent 31px, ' + m.lc + ' 31px, ' + m.lc + ' 32px);background-size:100% 32px;background-position:0 14px;';
    if (m.line === 'grid') s += 'background-image:linear-gradient(' + m.lc + ' 1px, transparent 1px),linear-gradient(90deg, ' + m.lc + ' 1px, transparent 1px);background-size:22px 22px;';
    if (m.border) s += 'box-shadow:inset 0 0 0 6px ' + m.border + ', 0 4px 10px rgba(0,0,0,.12);';
    return s;
  }
  function pageBgStyle(page) {
    const bg = find(BGS, page.data.bg);
    if (bg.id === 'theme') return '';
    const pat = bg.p ? patternCSS(bg.p, bg.pc) : null;
    return 'background-color:' + bg.c + ';' + (pat ? 'background-image:' + pat.img + ';background-size:' + pat.size + ';' : 'background-image:none;');
  }

  /* ---------- 콜라주 칸 배치 (0~1 비율) ---------- */
  function collageCells(n) {
    const g = 0.025;
    if (n <= 1) return [[0, 0, 1, 1]];
    if (n === 2) return [[0, 0, 0.5 - g / 2, 1], [0.5 + g / 2, 0, 0.5 - g / 2, 1]];
    if (n === 3) return [[0, 0, 0.6 - g / 2, 1], [0.6 + g / 2, 0, 0.4 - g / 2, 0.5 - g / 2], [0.6 + g / 2, 0.5 + g / 2, 0.4 - g / 2, 0.5 - g / 2]];
    if (n === 4) return [[0, 0, 0.5 - g / 2, 0.5 - g / 2], [0.5 + g / 2, 0, 0.5 - g / 2, 0.5 - g / 2], [0, 0.5 + g / 2, 0.5 - g / 2, 0.5 - g / 2], [0.5 + g / 2, 0.5 + g / 2, 0.5 - g / 2, 0.5 - g / 2]];
    const cols = 3, rows = Math.ceil(Math.min(n, 6) / 3), cw = (1 - g * (cols - 1)) / cols, ch = (1 - g * (rows - 1)) / rows;
    const out = [];
    for (let i = 0; i < Math.min(n, 6); i++) out.push([(i % cols) * (cw + g), Math.floor(i / cols) * (ch + g), cw, ch]);
    return out;
  }

  /* ---------- 화면용 재료 그리기 ---------- */
  function cropImg(id, it) {
    const zoom = it.zoom || 1, cx = it.cx == null ? 50 : it.cx, cy = it.cy == null ? 50 : it.cy;
    return '<img data-media="' + M.ui.esc(id) + '" data-variant="full" alt="" draggable="false" style="object-position:' + cx + '% ' + cy + '%;transform:scale(' + zoom + ');transform-origin:' + cx + '% ' + cy + '%">';
  }
  function itemInner(it) {
    const esc = M.ui.esc;
    switch (it.kind) {
      case 'sticker':
        return it.mediaId ? '<img class="d-stk" data-media="' + esc(it.mediaId) + '" data-variant="full" alt="" draggable="false">'
          : '<span class="d-emoji">' + esc(it.emoji) + '</span>';
      case 'tape': return '<div class="d-tape" style="background:' + tapeCSS(find(TAPES, it.style)) + '"></div>';
      case 'memo': {
        const m = find(MEMOS, it.style);
        return '<div class="d-memo" style="' + memoCSS(m) + 'font-size:' + (it.fs || 24) + 'px">' + esc(it.text || '').replace(/\n/g, '<br>') + '</div>';
      }
      case 'text':
        return '<div class="d-text" style="font-size:' + (it.fs || 40) + 'px;color:' + esc(it.color || '#4a3540') + ';font-weight:' + (it.bold ? 800 : 500) + '">' + esc(it.text || '').replace(/\n/g, '<br>') + '</div>';
      case 'photo':
        return '<div class="d-photo fr-' + (it.frame || 'none') + '"><div class="d-crop">' + (it.mediaId ? cropImg(it.mediaId, it) : '<span class="d-ph">📷</span>') + '</div></div>';
      case 'collage': {
        const ids = it.mediaIds || [];
        return '<div class="d-collage"><div class="d-cin">' + collageCells(ids.length).map(function (c, i) {
          return '<div class="d-crop" style="left:' + c[0] * 100 + '%;top:' + c[1] * 100 + '%;width:' + c[2] * 100 + '%;height:' + c[3] * 100 + '%">' + cropImg(ids[i], {}) + '</div>';
        }).join('') + '</div></div>';
      }
    }
    return '';
  }
  function applyGeom(el, it) {
    el.style.left = it.x + 'px';
    el.style.top = it.y + 'px';
    el.style.width = it.w + 'px';
    el.style.height = it.h + 'px';
    el.style.transform = 'rotate(' + (it.rot || 0) + 'deg)';
    el.style.zIndex = String(it.z || 1);
    const em = el.querySelector('.d-emoji');
    if (em) em.style.fontSize = (Math.min(it.w, it.h) * 0.82) + 'px';
  }
  function makeItemEl(it) {
    const el = document.createElement('div');
    el.className = 'd-item k-' + it.kind;
    el.dataset.id = it.id;
    el.innerHTML = itemInner(it);
    applyGeom(el, it);
    return el;
  }

  /* 페이지를 화면에 그림 (목록 미리보기 · 편집기 공용) */
  function renderStage(stage, page) {
    const d = page.data;
    stage.className = 'd-stage bd-' + (d.border || 'none') + (d.bg === 'theme' || !d.bg ? ' bg-theme' : '');
    if (d.themeId) stage.setAttribute('data-theme', M.themes.resolve(d.themeId)); else stage.removeAttribute('data-theme');
    stage.setAttribute('style', pageBgStyle(page));
    stage.innerHTML = '';
    (d.items || []).slice().sort(function (a, b) { return (a.z || 0) - (b.z || 0); }).forEach(function (it) { stage.appendChild(makeItemEl(it)); });
    M.ui.hydrate(stage);
  }

  /* 작은 미리보기 (목록 카드용) */
  function previewHTML(page, width) {
    const s = width / W;
    return '<div class="d-preview" style="width:' + width + 'px;height:' + Math.round(H * s) + 'px"><div class="d-stage-holder" data-page-preview="' + page.id + '" style="transform:scale(' + s + ')"></div></div>';
  }
  function hydratePreviews(root, pages) {
    root.querySelectorAll('[data-page-preview]').forEach(function (h) {
      const p = pages.find(function (x) { return x.id === h.dataset.pagePreview; });
      if (!p) return;
      const st = document.createElement('div');
      h.appendChild(st);
      renderStage(st, p);
    });
  }

  /* ---------- 이미지(PNG)로 그리기 ---------- */
  function loadImage(id) {
    return M.media.url(id, 'full').then(function (u) {
      return new Promise(function (res) {
        if (!u) return res(null);
        const img = new Image();
        img.onload = function () { res(img); };
        img.onerror = function () { res(null); };
        img.src = u;
      });
    });
  }
  function drawPattern(ctx, w, h, p, pc) {
    ctx.save();
    ctx.fillStyle = pc; ctx.strokeStyle = pc; ctx.lineWidth = 1;
    if (p === 'dots') for (let y = 12; y < h; y += 24) for (let x = 12; x < w; x += 24) { ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill(); }
    if (p === 'grid') { for (let x = 0; x < w; x += 28) ctx.fillRect(x, 0, 1, h); for (let y = 0; y < h; y += 28) ctx.fillRect(0, y, w, 1); }
    if (p === 'lines') for (let y = 33; y < h; y += 34) ctx.fillRect(0, y, w, 1);
    if (p === 'check') { for (let x = 0; x < w; x += 40) ctx.fillRect(x, 0, 20, h); for (let y = 0; y < h; y += 40) ctx.fillRect(0, y, w, 20); }
    ctx.restore();
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function wrapText(ctx, text, maxW) {
    const out = [];
    String(text || '').split('\n').forEach(function (para) {
      let line = '';
      for (const ch of para) {
        if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; } else line += ch;
      }
      out.push(line);
    });
    return out;
  }
  function drawCover(ctx, img, ax, ay, aw, ah, it) {
    const zoom = it.zoom || 1, cx = (it.cx == null ? 50 : it.cx) / 100, cy = (it.cy == null ? 50 : it.cy) / 100;
    const s0 = Math.max(aw / img.naturalWidth, ah / img.naturalHeight);
    const dw0 = img.naturalWidth * s0, dh0 = img.naturalHeight * s0;
    const dx0 = (aw - dw0) * cx, dy0 = (ah - dh0) * cy;
    const ox = aw * cx, oy = ah * cy;
    ctx.save();
    ctx.beginPath(); ctx.rect(ax, ay, aw, ah); ctx.clip();
    ctx.drawImage(img, ax + ox + (dx0 - ox) * zoom, ay + oy + (dy0 - oy) * zoom, dw0 * zoom, dh0 * zoom);
    ctx.restore();
  }
  const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  const TEXT_FONT = '"Pretendard","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif';

  async function drawItem(ctx, it, imgs) {
    const w = it.w, h = it.h;
    ctx.save();
    ctx.translate(it.x + w / 2, it.y + h / 2);
    ctx.rotate((it.rot || 0) * Math.PI / 180);
    ctx.translate(-w / 2, -h / 2);
    switch (it.kind) {
      case 'sticker':
        if (it.mediaId) {
          const img = imgs[it.mediaId];
          if (img) {
            const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
            ctx.drawImage(img, (w - img.naturalWidth * s) / 2, (h - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
          }
        } else {
          ctx.font = (Math.min(w, h) * 0.82) + 'px ' + EMOJI_FONT;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(it.emoji, w / 2, h / 2 + Math.min(w, h) * 0.04);
        }
        break;
      case 'tape': {
        const t = find(TAPES, it.style);
        ctx.globalAlpha = 0.88;
        ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
        if (t.p === 'rainbow') {
          const g = ctx.createLinearGradient(0, 0, w, 0);
          ['#ffb3ba', '#ffdfba', '#fff5ba', '#baffc9', '#bae1ff', '#e0c3fc'].forEach(function (c, i, a) { g.addColorStop(i / (a.length - 1), c); });
          ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
        } else {
          ctx.fillStyle = t.p === 'stripe' ? t.a : t.b; ctx.fillRect(0, 0, w, h);
          if (t.p === 'stripe') {
            ctx.fillStyle = t.b;
            for (let i = -h; i < w + h; i += 25.5) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 12.7, 0); ctx.lineTo(i + 12.7 - h, h); ctx.lineTo(i - h, h); ctx.fill(); }
          }
          if (t.p === 'dots') { ctx.fillStyle = t.a; for (let y = 7; y < h; y += 14) for (let x = 7; x < w; x += 14) { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); } }
          if (t.p === 'check') { ctx.fillStyle = t.a + '88'; for (let x = 0; x < w; x += 20) ctx.fillRect(x, 0, 10, h); for (let y = 0; y < h; y += 20) ctx.fillRect(0, y, w, 10); }
        }
        break;
      }
      case 'memo': {
        const m = find(MEMOS, it.style);
        ctx.shadowColor = 'rgba(0,0,0,.14)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 4;
        ctx.fillStyle = m.bg; ctx.fillRect(0, 0, w, h);
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = m.lc || 'transparent';
        if (m.line === 'lined') for (let y = 45; y < h; y += 32) ctx.fillRect(0, y, w, 1);
        if (m.line === 'grid') { for (let x = 0; x < w; x += 22) ctx.fillRect(x, 0, 1, h); for (let y = 0; y < h; y += 22) ctx.fillRect(0, y, w, 1); }
        if (m.border) { ctx.strokeStyle = m.border; ctx.lineWidth = 6; ctx.strokeRect(3, 3, w - 6, h - 6); }
        const fs = it.fs || 24;
        ctx.fillStyle = '#3a3036'; ctx.font = fs + 'px ' + TEXT_FONT; ctx.textBaseline = 'top';
        wrapText(ctx, it.text, w - 36).forEach(function (l, i) { if (18 + i * fs * 1.45 < h - fs) ctx.fillText(l, 18, 18 + i * fs * 1.45); });
        break;
      }
      case 'text': {
        const fs = it.fs || 40;
        ctx.fillStyle = it.color || '#4a3540';
        ctx.font = (it.bold ? '800 ' : '500 ') + fs + 'px ' + TEXT_FONT; ctx.textBaseline = 'top';
        wrapText(ctx, it.text, w).forEach(function (l, i) { ctx.fillText(l, 0, i * fs * 1.3); });
        break;
      }
      case 'photo': {
        const f = it.frame || 'none';
        let ax = 0, ay = 0, aw = w, ah = h;
        ctx.shadowColor = 'rgba(0,0,0,.18)'; ctx.shadowBlur = f === 'none' ? 0 : 12; ctx.shadowOffsetY = 4;
        if (f === 'polaroid') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ax = w * 0.06; ay = w * 0.06; aw = w - ax * 2; ah = h - ay - h * 0.18; }
        if (f === 'white' || f === 'stamp') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ax = ay = Math.min(w, h) * 0.05; aw = w - ax * 2; ah = h - ay * 2; }
        if (f === 'film') { ctx.fillStyle = '#222'; ctx.fillRect(0, 0, w, h); ax = w * 0.04; ay = h * 0.1; aw = w - ax * 2; ah = h - ay * 2; }
        ctx.shadowColor = 'transparent';
        if (f === 'film') { ctx.fillStyle = '#eee'; for (let x = 10; x < w - 10; x += 26) { ctx.fillRect(x, h * 0.03, 12, h * 0.04); ctx.fillRect(x, h * 0.93, 12, h * 0.04); } }
        if (f === 'stamp') { ctx.strokeStyle = '#d9d9d9'; ctx.setLineDash([6, 6]); ctx.lineWidth = 3; ctx.strokeRect(2, 2, w - 4, h - 4); ctx.setLineDash([]); }
        const img = imgs[it.mediaId];
        if (f === 'round') { ctx.beginPath(); ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.clip(); }
        if (img) drawCover(ctx, img, ax, ay, aw, ah, it);
        break;
      }
      case 'collage': {
        ctx.shadowColor = 'rgba(0,0,0,.18)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 4;
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.shadowColor = 'transparent';
        const px = w * 0.04, py = h * 0.04, iw = w - px * 2, ih = h - py * 2;
        const ids = it.mediaIds || [];
        collageCells(ids.length).forEach(function (c, i) {
          const img = imgs[ids[i]];
          if (img) drawCover(ctx, img, px + c[0] * iw, py + c[1] * ih, c[2] * iw, c[3] * ih, {});
        });
        break;
      }
    }
    ctx.restore();
  }

  async function toCanvas(page, themeHost) {
    const scale = 1.5;
    const c = document.createElement('canvas');
    c.width = W * scale; c.height = H * scale;
    const ctx = c.getContext('2d');
    ctx.scale(scale, scale);
    const d = page.data;
    const cs = getComputedStyle(themeHost);
    const bg = find(BGS, d.bg);
    if (bg.id === 'theme') {
      ctx.fillStyle = cs.getPropertyValue('--bg').trim() || '#fff'; ctx.fillRect(0, 0, W, H);
      drawPattern(ctx, W, H, 'dots', cs.getPropertyValue('--line').trim() || '#eee');
    } else {
      ctx.fillStyle = bg.c; ctx.fillRect(0, 0, W, H);
      if (bg.p) drawPattern(ctx, W, H, bg.p, bg.pc);
    }
    const bc = cs.getPropertyValue('--accent').trim() || '#e8a0b8';
    ctx.strokeStyle = bc;
    if (d.border === 'dashed') { ctx.lineWidth = 5; ctx.setLineDash([16, 12]); ctx.strokeRect(22, 22, W - 44, H - 44); }
    if (d.border === 'double') { ctx.lineWidth = 4; ctx.strokeRect(18, 18, W - 36, H - 36); ctx.strokeRect(32, 32, W - 64, H - 64); }
    if (d.border === 'stitch') { ctx.lineWidth = 3; ctx.setLineDash([10, 8]); ctx.strokeRect(30, 30, W - 60, H - 60); }
    if (d.border === 'round') { ctx.lineWidth = 12; roundRect(ctx, 16, 16, W - 32, H - 32, 44); ctx.stroke(); }
    ctx.setLineDash([]);

    const ids = new Set();
    (d.items || []).forEach(function (it) {
      if (it.mediaId) ids.add(it.mediaId);
      (it.mediaIds || []).forEach(function (m) { ids.add(m); });
    });
    const imgs = {};
    await Promise.all(Array.from(ids).map(function (id) { return loadImage(id).then(function (img) { imgs[id] = img; }); }));
    const items = (d.items || []).slice().sort(function (a, b) { return (a.z || 0) - (b.z || 0); });
    for (const it of items) await drawItem(ctx, it, imgs);
    return c;
  }

  async function downloadPNG(page, themeHost) {
    const c = await toCanvas(page, themeHost);
    const blob = await new Promise(function (res) { c.toBlob(res, 'image/png'); });
    if (!blob) throw MMSD.AppError('IMAGE', '이미지를 만들지 못했어요.');
    await M.saveFile(blob, (page.title || '꾸민 페이지').replace(/[\\/:*?"<>|]/g, '_') + '.png');
  }

  M.deco = {
    W: W, H: H, STICKERS: STICKERS, TAPES: TAPES, MEMOS: MEMOS, FRAMES: FRAMES, BGS: BGS, BORDERS: BORDERS,
    find: find, tapeCSS: tapeCSS, memoCSS: memoCSS, patternCSS: patternCSS,
    itemInner: itemInner, applyGeom: applyGeom, makeItemEl: makeItemEl,
    renderStage: renderStage, previewHTML: previewHTML, hydratePreviews: hydratePreviews,
    toCanvas: toCanvas, downloadPNG: downloadPNG
  };
})();

/* ===== js/mods/home.js ===== */
/* 홈 대시보드 — 저장된 기록을 모아서 보여줌 */
(function () {
  const M = window.MMSD;

  function widget(o) {
    return '<section class="card ' + (o.tape || 'tape') + ' ' + (o.cls || '') + '">' +
      '<h2 class="w-head"><span class="w-icon" aria-hidden="true">' + o.icon + '</span>' + o.title + '</h2>' +
      '<div class="w-body">' + o.body + '</div>' +
      (o.link ? '<a class="btn" href="#/' + o.link + '">' + o.linkLabel + '</a>' : '') +
      '</section>';
  }
  function emptyP(t) { return '<p class="empty">' + t + '</p>'; }

  M.mods.home = async function (el, sub, themeId) {
    const U = M.ui, esc = U.esc;
    const now = new Date();
    const today = U.today();
    const season = M.themes.seasons[M.themes.currentSeason(now)];
    const decor = M.themes.decor(themeId);

    const [profile, diaries, schedules, memories, friends, assess, fdiary, shows, exams, logs] = await Promise.all([
      U.loadProfile(), M.db.list('diary'), M.db.list('schedule'), M.db.list('memory'), M.db.list('friend'),
      M.db.list('assessment'), M.db.list('fandomDiary'), M.db.list('performance'), M.db.list('exam'), M.db.list('studyLog')
    ]);

    const todays = diaries.filter(function (d) { return d.date === today; })
      .sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; });
    const pick = function (k) {
      for (let i = todays.length - 1; i >= 0; i--) if (todays[i].data[k]) return todays[i];
      return null;
    };
    const wRec = pick('weather'), mRec = pick('mood'), oRec = pick('oneLine');

    const upcoming = schedules.filter(function (s) { return !s.data.done && s.date && s.date >= today; })
      .map(function (s) { return { r: s, href: '#/school/schedule/edit/' + s.id }; })
      .concat(assess.filter(function (a) { return !a.data.done && a.date && a.date >= today; })
        .map(function (a) { return { r: a, href: '#/study/assess/edit/' + a.id, pre: '📋 ' }; }))
      .sort(function (a, b) { return a.r.date < b.r.date ? -1 : 1; }).slice(0, 5);

    /* 최근 덕질: 덕질 일기 + 공연 관람 */
    const fan = fdiary.map(function (d) { return { date: d.date, icon: '💖', title: d.title, href: '#/fandom/diary/edit/' + d.id }; })
      .concat(shows.map(function (s) { return { date: s.date, icon: '🎫', title: s.title, href: '#/fandom/shows/edit/' + s.id }; }))
      .sort(function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; }).slice(0, 4);

    /* 학업: 최근 시험 평균 · 이번 주 공부 시간 · 남은 수행평가 */
    const lastExam = exams.filter(function (e) { return M.study.avgOf(e) != null; }).sort(function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; })[0];
    const t0 = U.parse(today);
    const mon = new Date(t0); mon.setDate(t0.getDate() - ((t0.getDay() + 6) % 7));
    const weekMin = logs.filter(function (l) { const d = U.parse(l.date); return d && d >= mon && d <= t0; })
      .reduce(function (s, l) { return s + (Number(l.data.minutes) || 0); }, 0);
    const assessLeft = assess.filter(function (a) { return !a.data.done; }).length;
    const recentMem = memories.slice().sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; }).slice(0, 3);
    const bdays = friends.filter(function (f) { return f.data.birthday; })
      .map(function (f) { return { f: f, n: U.daysToBirthday(f.data.birthday) }; })
      .filter(function (x) { return x.n <= 30; })
      .sort(function (a, b) { return a.n - b.n; }).slice(0, 4);

    /* 프로필 카드 */
    let profileCard;
    if (profile && profile.title) {
      profileCard = '<section class="card tape span-2 profile-card home-profile">' +
        '<span class="sticker" style="top:-16px;right:14px" aria-hidden="true">' + decor[0] + '</span>' +
        M.profilePreview(profile) +
        '<a class="btn small pv-edit" href="#/profile">✏️ 수정</a></section>';
    } else {
      profileCard = '<section class="card tape span-2 profile-card">' +
        '<span class="sticker" style="top:-16px;right:14px" aria-hidden="true">' + decor[0] + '</span>' +
        '<div class="polaroid" aria-hidden="true"><div class="ph">🐣</div><div class="cap">my photo</div></div>' +
        '<div class="profile-text"><h2>나의 프로필 카드</h2>' +
        '<p>아직 프로필이 비어 있어요. 이름, 별명, MBTI, 장래희망을 적어서 나만의 프로필 카드를 만들어 보세요.</p>' +
        '<a class="btn primary" href="#/profile">프로필 꾸미러 가기</a></div></section>';
    }

    const diaryBody = todays.length
      ? '<ul class="mini-list">' + todays.map(function (d) {
          return '<li><a href="#/diary/edit/' + d.id + '">' + esc((d.data.mood || '📝').split(' ')[0]) + ' ' + esc(U.snippet(d.title, 26)) + '</a></li>';
        }).join('') + '</ul>'
      : emptyP('오늘 쓴 일기가 아직 없어요.');

    const schedBody = upcoming.length
      ? '<ul class="mini-list">' + upcoming.map(function (x) {
          return '<li><a href="' + x.href + '"><b class="dday">' + U.dday(U.daysUntil(x.r.date)) + '</b> ' + (x.pre || '') +
            esc(x.r.title) + ' <small>' + esc(U.fmtDate(x.r.date, false)) + '</small></a></li>';
        }).join('') + '</ul>'
      : emptyP('등록된 시험이나 수행평가 일정이 없어요.');

    const memBody = recentMem.length
      ? '<div class="mini-thumbs">' + recentMem.map(function (m) {
          return '<a href="#/memories/edit/' + m.id + '" class="mini-thumb">' + U.thumb(m, '📸') + '<span>' + esc(U.snippet(m.title, 12)) + '</span></a>';
        }).join('') + '</div>'
      : emptyP('아직 보관한 추억이 없어요. 특별한 순간을 사진과 함께 남겨 보세요.');

    const bdayBody = bdays.length
      ? '<ul class="mini-list">' + bdays.map(function (x) {
          return '<li><a href="#/friends/edit/' + x.f.id + '"><b class="dday">' + (x.n === 0 ? '🎉 오늘' : 'D-' + x.n) + '</b> ' + esc(x.f.title) + '</a></li>';
        }).join('') + '</ul>'
      : emptyP('30일 안에 생일인 친구가 없어요. 친구 수첩에 생일을 등록하면 알려 줘요.');

    el.innerHTML = '<div class="home-grid tilt-grid">' +
      profileCard +
      '<section class="card tape-left date-card">' +
        '<div class="date-month">' + now.getFullYear() + '. ' + (now.getMonth() + 1) + '월</div>' +
        '<div class="date-day">' + now.getDate() + '</div>' +
        '<div class="date-week">' + U.WEEK[now.getDay()] + '요일</div>' +
        '<span class="chip">' + season.emoji + ' ' + season.name + '</span>' +
      '</section>' +
      widget({ icon: '🌤️', title: '오늘의 날씨',
        body: wRec ? '<p class="big-emoji">' + esc(wRec.data.weather) + '</p>' : emptyP('오늘의 날씨를 아직 기록하지 않았어요. 일기에서 날씨를 골라 주세요.'),
        link: 'diary/new/' + today, linkLabel: wRec ? '일기 더 쓰기' : '일기에서 기록하기' }) +
      widget({ icon: '😊', title: '오늘의 기분', tape: 'tape-corner',
        body: mRec ? '<p class="big-emoji">' + esc(mRec.data.mood) + '</p>' : emptyP('오늘 기분은 어때요? 일기를 쓰면 여기에 기분 스티커가 붙어요.'),
        link: 'diary/new/' + today, linkLabel: '기분 기록하기' }) +
      widget({ icon: '💬', title: '오늘의 한마디', cls: 'note',
        body: oRec ? '<p class="one-line">“' + esc(oRec.data.oneLine) + '”</p>' : emptyP('오늘 나에게 해주고 싶은 한마디를 적어 보세요.'),
        link: oRec ? 'diary/edit/' + oRec.id : 'diary/new/' + today, linkLabel: oRec ? '일기 보기' : '한마디 쓰기' }) +
      widget({ icon: '📔', title: '오늘 작성한 일기', body: diaryBody, link: 'diary/new/' + today, linkLabel: '+ 일기 쓰기' }) +
      widget({ icon: '🗓️', title: '다가오는 일정', tape: 'tape-left', body: schedBody, link: 'school/schedule', linkLabel: '일정 확인하기' }) +
      widget({ icon: '📸', title: '최근 추억', body: memBody, link: 'memories', linkLabel: '추억 보관함 열기' }) +
      widget({ icon: '💖', title: '최근 덕질 기록', tape: 'tape-corner',
        body: fan.length ? '<ul class="mini-list">' + fan.map(function (f) {
          return '<li><a href="' + f.href + '">' + f.icon + ' ' + esc(U.snippet(f.title, 22)) + ' <small>' + esc(U.fmtDate(f.date, false)) + '</small></a></li>';
        }).join('') + '</ul>' : emptyP('덕질 일기나 공연 관람을 기록하면 여기에 보여요.'),
        link: 'fandom', linkLabel: '덕질노트 열기' }) +
      widget({ icon: '📚', title: '학업 진행 상황',
        body: '<div class="stat-grid mini-stats">' +
          '<div class="stat"><span class="n">' + (lastExam ? M.study.avgOf(lastExam) + '점' : '-') + '</span><span class="l">' + (lastExam ? esc(U.snippet(lastExam.title, 10)) + ' 평균' : '최근 시험') + '</span></div>' +
          '<div class="stat"><span class="n">' + M.study.fmtMin(weekMin) + '</span><span class="l">이번 주 공부</span></div>' +
          '<div class="stat"><span class="n">' + assessLeft + '</span><span class="l">남은 수행평가</span></div></div>',
        link: 'study', linkLabel: '학업 기록 열기' }) +
      widget({ icon: '🎂', title: '친구 생일 알림', tape: 'tape-left', body: bdayBody, link: 'friends/birthday', linkLabel: '생일 달력 보기' }) +
    '</div>' +
    '<p class="privacy-note">🔒 이 다이어리의 모든 기록은 지금 쓰는 기기의 브라우저 안에만 저장돼요. 인터넷으로 다른 곳에 보내지 않아요.</p>';
  };
})();

/* ===== js/mods/profile.js ===== */
/* 나의 프로필 */
(function () {
  const M = window.MMSD;

  const FIELDS = [
    { t: 'section', label: '🪪 기본 정보' },
    { k: 'name', label: '이름', t: 'text', top: 'title' },
    { k: 'nickname', label: '별명 / 애칭', t: 'text' },
    { k: 'birth', label: '생년월일', t: 'date' },
    { k: 'grade', label: '학년', t: 'grade', top: 'grade' },
    { k: 'classNo', label: '반', t: 'text', ph: '예: 3' },
    { k: 'number', label: '번호', t: 'text', ph: '예: 12' },
    { k: 'entryDate', label: '입학일', t: 'date', hint: '입력하면 일기·추억을 쓸 때 날짜에 맞춰 학년이 자동으로 정해져요.' },
    { k: 'gradDate', label: '졸업 예정일', t: 'date' },

    { t: 'section', label: '🎨 캐릭터 아바타와 사진' },
    { k: 'avatar', label: '캐릭터 아바타', t: 'choice', opts: M.forms.OPTS.avatar, full: true, big: true },
    { k: 'photos', label: '프로필 사진', t: 'media', top: 'mediaIds', full: true, hint: '사진을 넣으면 첫 번째 사진이 폴라로이드에 붙어요. 없으면 캐릭터 아바타가 보여요.' },

    { t: 'section', label: '💡 나에 대해' },
    { k: 'mbti', label: 'MBTI', t: 'text', ph: '예: ENFP' },
    { k: 'blood', label: '혈액형', t: 'select', opts: ['A형', 'B형', 'O형', 'AB형', '모름'] },
    { k: 'height', label: '키', t: 'number', unit: 'cm' },
    { k: 'shoe', label: '신발 사이즈', t: 'number', unit: 'mm' },
    { k: 'hobby', label: '취미', t: 'text' },
    { k: 'talent', label: '특기', t: 'text' },
    { k: 'likeFood', label: '좋아하는 음식', t: 'text' },
    { k: 'dislikeFood', label: '싫어하는 음식', t: 'text' },
    { k: 'color', label: '좋아하는 색깔', t: 'text' },
    { k: 'season', label: '좋아하는 계절', t: 'select', opts: ['봄', '여름', '가을', '겨울'] },
    { k: 'interests', label: '요즘 관심사', t: 'text', full: true },
    { k: 'keywords', label: '나를 표현하는 키워드', t: 'tags', top: 'tags', full: true },

    { t: 'section', label: '🌟 나의 꿈과 이야기' },
    { k: 'dream', label: '장래희망', t: 'text' },
    { k: 'motto', label: '나의 좌우명', t: 'text' },
    { k: 'tmi', label: '나의 TMI', t: 'textarea', full: true },
    { k: 'intro', label: '자기소개 한마디', t: 'textarea', full: true, rows: 2 }
  ];

  function previewHTML(rec) {
    const esc = M.ui.esc;
    const d = (rec && rec.data) || {};
    const photo = rec && (rec.mediaIds || [])[0];
    const cls = [rec && rec.grade ? rec.grade + '학년' : '', d.classNo ? d.classNo + '반' : '', d.number ? d.number + '번' : ''].filter(Boolean).join(' ');
    const tags = (rec && rec.tags) || [];
    return '<div class="polaroid big" aria-hidden="true"><div class="ph">' +
        (photo ? '<img data-media="' + esc(photo) + '" alt="">' : (d.avatar || '🐣')) +
      '</div><div class="cap">' + esc(d.nickname || 'my photo') + '</div></div>' +
      '<div class="pv-text">' +
        '<h2>' + esc((rec && rec.title) || '이름을 적어 주세요') + '</h2>' +
        (cls ? '<p class="pv-class">' + esc(cls) + '</p>' : '') +
        (d.intro ? '<p class="pv-intro">“' + esc(d.intro) + '”</p>' : '') +
        (tags.length ? '<ul class="tag-list">' + tags.map(function (t) { return '<li>#' + esc(t) + '</li>'; }).join('') + '</ul>' : '') +
        '<dl class="pv-facts">' +
          [['MBTI', d.mbti], ['장래희망', d.dream], ['좌우명', d.motto], ['좋아하는 계절', d.season]].filter(function (x) { return x[1]; })
            .map(function (x) { return '<div><dt>' + x[0] + '</dt><dd>' + esc(x[1]) + '</dd></div>'; }).join('') +
        '</dl>' +
      '</div>';
  }

  M.mods.profile = async function (el) {
    const rec = await M.ui.loadProfile();
    const ed = await M.forms.editor(el, {
      type: 'profile',
      fields: FIELDS,
      rec: rec || { type: 'profile', data: { avatar: '🐣' } },
      noBack: true,
      noDelete: true,
      before: '<section class="card tape profile-preview" id="pv">' + previewHTML(rec) + '</section>',
      onSaved: function (saved) {
        M.profile = saved;
        const pv = document.getElementById('pv');
        if (pv) { pv.innerHTML = previewHTML(saved); M.ui.hydrate(pv); }
      }
    });
    return ed;
  };

  M.profilePreview = previewHTML;
})();

/* ===== js/mods/growth.js ===== */
/* 성장 기록: 기록 목록 · 학년 비교 · 입학 vs 지금 · 그래프 */
(function () {
  const M = window.MMSD;

  const NUMS = [['height', '키', 'cm'], ['weight', '몸무게', 'kg'], ['shoe', '신발 사이즈', 'mm'], ['foot', '발 크기', 'mm']];
  const TEXTS = [
    ['clothes', '옷 사이즈'], ['bodyEtc', '기타 신체 변화'],
    ['face', '얼굴 변화'], ['hair', '헤어스타일'], ['skin', '피부 변화'], ['fashion', '패션 스타일'],
    ['voice', '목소리 변화'], ['range', '음역대'], ['singing', '노래 실력'], ['sports', '운동 능력'], ['newSkill', '새롭게 배운 기술'],
    ['personality', '성격 변화'], ['interests', '관심사 변화'], ['hobby', '새로운 취미'], ['confidence', '자신감 변화'], ['values', '가치관 변화'], ['dream', '장래희망 변화']
  ];
  const T = {};
  TEXTS.forEach(function (t) { T[t[0]] = t[1]; });

  const FIELDS = [
    { k: 'date', label: '날짜', t: 'date', top: 'date' },
    { k: 'grade', label: '학년', t: 'grade', top: 'grade' },
    { k: 'title', label: '한 줄 제목', t: 'text', top: 'title', full: true, ph: '예: 2학년 신체검사, 여름방학 끝' },
    { t: 'section', label: '📏 신체 성장' },
    { k: 'height', label: '키', t: 'number', unit: 'cm' },
    { k: 'weight', label: '몸무게', t: 'number', unit: 'kg' },
    { k: 'shoe', label: '신발 사이즈', t: 'number', unit: 'mm' },
    { k: 'foot', label: '발 크기', t: 'number', unit: 'mm' },
    { k: 'clothes', label: '옷 사이즈', t: 'text', ph: '예: 상의 M, 하의 26' },
    { k: 'bodyEtc', label: '기타 신체 변화', t: 'textarea' },
    { t: 'section', label: '💇 외모 변화' },
    { k: 'face', label: '얼굴 변화', t: 'textarea' },
    { k: 'hair', label: '헤어스타일 변화', t: 'textarea' },
    { k: 'skin', label: '피부 변화', t: 'textarea' },
    { k: 'fashion', label: '패션 스타일 변화', t: 'textarea' },
    { k: 'photos', label: '사진 (얼굴·전신 사진)', t: 'media', top: 'mediaIds', full: true },
    { t: 'section', label: '🎤 목소리와 능력' },
    { k: 'voice', label: '목소리 변화', t: 'textarea' },
    { k: 'range', label: '음역대 변화', t: 'text', ph: '예: 낮은 솔 ~ 높은 라' },
    { k: 'singing', label: '노래 실력', t: 'textarea' },
    { k: 'sports', label: '운동 능력', t: 'textarea' },
    { k: 'newSkill', label: '새롭게 배운 기술', t: 'textarea', full: true },
    { t: 'section', label: '💗 내면의 성장' },
    { k: 'personality', label: '성격 변화', t: 'textarea' },
    { k: 'interests', label: '관심사 변화', t: 'textarea' },
    { k: 'hobby', label: '새로운 취미', t: 'textarea' },
    { k: 'confidence', label: '자신감 변화', t: 'textarea' },
    { k: 'values', label: '가치관 변화', t: 'textarea' },
    { k: 'dream', label: '장래희망 변화', t: 'textarea' },
    { k: 'memo', label: '자유 기록', t: 'textarea', full: true, rows: 4 },
    { k: 'tags', label: '태그', t: 'tags', top: 'tags', full: true }
  ];

  const TABS = [['list', '📝 기록'], ['compare', '🎒 학년 비교'], ['then', '🌱 입학 vs 지금'], ['chart', '📈 그래프']];

  function has(v) { return v !== null && v !== undefined && v !== ''; }
  function asc(list) { return list.slice().sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; }); }

  function summary(r) {
    const d = r.data;
    const nums = NUMS.filter(function (n) { return has(d[n[0]]); }).map(function (n) { return n[1] + ' ' + d[n[0]] + n[2]; });
    const texts = TEXTS.filter(function (t) { return has(d[t[0]]); }).map(function (t) { return t[1]; });
    return nums.concat(texts.length ? ['✏️ ' + texts.slice(0, 3).join('·') + (texts.length > 3 ? ' 외 ' + (texts.length - 3) : '')] : []).join(' · ');
  }

  function listHTML(all) {
    const U = M.ui, esc = U.esc;
    return '<div class="item-list">' + all.slice().reverse().map(function (r) {
      return '<a class="item card" href="#/growth/edit/' + r.id + '">' + U.thumb(r, '🌱') +
        '<div class="item-body"><p class="item-title">' + esc(r.title || U.fmtDate(r.date)) + '</p>' +
        '<p class="item-sub">' + esc(U.fmtDate(r.date)) + (r.grade ? ' · ' + r.grade + '학년' : '') + '</p>' +
        '<p class="item-sub">' + esc(summary(r)) + '</p></div></a>';
    }).join('') + '</div>';
  }

  /* 학년별로 가장 마지막에 기록된 값 */
  function latestBy(list, key) {
    for (let i = list.length - 1; i >= 0; i--) if (has(list[i].data[key])) return list[i];
    return null;
  }

  function compareHTML(all) {
    const U = M.ui, esc = U.esc;
    const byG = { 1: [], 2: [], 3: [] };
    all.forEach(function (r) { if (byG[r.grade]) byG[r.grade].push(r); });
    const cell = function (g, key, unit) {
      const r = latestBy(byG[g], key);
      return '<td>' + (r ? esc(r.data[key]) + (unit ? unit : '') : '<span class="dim-text">-</span>') + '</td>';
    };
    const photoRow = '<tr><th>사진</th>' + [1, 2, 3].map(function (g) {
      let r = null;
      for (let i = byG[g].length - 1; i >= 0; i--) if ((byG[g][i].mediaIds || []).length) { r = byG[g][i]; break; }
      return '<td>' + (r ? '<div class="thumb cmp"><img data-media="' + esc(r.mediaIds[0]) + '" alt=""></div>' : '<span class="dim-text">-</span>') + '</td>';
    }).join('') + '</tr>';
    const rows = NUMS.map(function (n) { return '<tr><th>' + n[1] + '</th>' + [1, 2, 3].map(function (g) { return cell(g, n[0], n[2]); }).join('') + '</tr>'; }).join('') +
      TEXTS.filter(function (t) { return all.some(function (r) { return has(r.data[t[0]]); }); })
        .map(function (t) { return '<tr><th>' + t[1] + '</th>' + [1, 2, 3].map(function (g) { return cell(g, t[0], ''); }).join('') + '</tr>'; }).join('');
    return '<div class="card tape table-card"><div class="tbl-wrap"><table class="cmp-table"><thead><tr><th></th><th>1학년</th><th>2학년</th><th>3학년</th></tr></thead><tbody>' +
      photoRow + rows + '</tbody></table></div><p class="fhint">학년마다 가장 마지막에 기록한 내용을 보여줘요. 학년이 비어 있는 기록은 빠져요.</p></div>';
  }

  function thenNowHTML(all) {
    const U = M.ui, esc = U.esc;
    const firstOf = function (key) { for (let i = 0; i < all.length; i++) if (has(all[i].data[key])) return all[i]; return null; };
    const rows = NUMS.map(function (n) { return [n[0], n[1], n[2], true]; }).concat(TEXTS.map(function (t) { return [t[0], t[1], '', false]; }))
      .map(function (x) {
        const a = firstOf(x[0]), b = latestBy(all, x[0]);
        if (!a) return '';
        let diff = '';
        if (x[3] && b && a !== b) {
          const dv = Math.round((Number(b.data[x[0]]) - Number(a.data[x[0]])) * 10) / 10;
          diff = '<span class="badge ' + (dv > 0 ? 'hot' : 'soft') + '">' + (dv > 0 ? '+' : '') + dv + x[2] + '</span>';
        }
        return '<tr><th>' + x[1] + '</th><td>' + esc(a.data[x[0]]) + x[2] + '<small>' + esc(U.fmtDate(a.date, false)) + '</small></td>' +
          '<td>' + (b && b !== a ? esc(b.data[x[0]]) + x[2] + '<small>' + esc(U.fmtDate(b.date, false)) + '</small>' : '<span class="dim-text">같음</span>') + '</td><td>' + diff + '</td></tr>';
      }).join('');
    const firstPhoto = all.find(function (r) { return (r.mediaIds || []).length; });
    let lastPhoto = null;
    for (let i = all.length - 1; i >= 0; i--) if ((all[i].mediaIds || []).length) { lastPhoto = all[i]; break; }
    const ph = function (r) { return r ? '<div class="thumb cmp"><img data-media="' + esc(r.mediaIds[0]) + '" alt=""></div>' : '<span class="dim-text">-</span>'; };
    return '<div class="card tape table-card"><div class="tbl-wrap"><table class="cmp-table"><thead><tr><th></th><th>🌱 처음 기록</th><th>🌳 지금</th><th>변화</th></tr></thead><tbody>' +
      '<tr><th>사진</th><td>' + ph(firstPhoto) + '</td><td>' + (lastPhoto !== firstPhoto ? ph(lastPhoto) : '<span class="dim-text">같음</span>') + '</td><td></td></tr>' +
      rows + '</tbody></table></div><p class="fhint">항목마다 가장 처음 기록한 값과 가장 최근 값을 비교해요.</p></div>';
  }

  /* 간단한 꺾은선 그래프 (SVG) */
  function lineChart(points, label, unit) {
    const esc = M.ui.esc;
    if (points.length < 2) {
      return '<section class="card chart-card"><h2 class="sec-title">' + label + '</h2><p class="empty">' + label + ' 기록이 2개 이상 있어야 그래프가 그려져요. (지금 ' + points.length + '개)</p></section>';
    }
    const W = 640, H = 240, P = { l: 48, r: 18, t: 18, b: 34 };
    const xs = points.map(function (p) { return M.ui.parse(p.date).getTime(); });
    const ys = points.map(function (p) { return p.v; });
    let x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    if (x0 === x1) { x0 -= 86400000; x1 += 86400000; }
    let y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    const pad = Math.max((y1 - y0) * 0.15, 1);
    y0 = Math.floor(y0 - pad); y1 = Math.ceil(y1 + pad);
    const sx = function (x) { return P.l + (x - x0) / (x1 - x0) * (W - P.l - P.r); };
    const sy = function (y) { return H - P.b - (y - y0) / (y1 - y0) * (H - P.t - P.b); };
    const ticks = [0, 1, 2, 3].map(function (i) { return y0 + (y1 - y0) * i / 3; });
    const path = points.map(function (p, i) { return (i ? 'L' : 'M') + sx(xs[i]).toFixed(1) + ' ' + sy(p.v).toFixed(1); }).join(' ');
    return '<section class="card chart-card"><h2 class="sec-title">' + label + ' <small>' + points[0].v + unit + ' → ' + points[points.length - 1].v + unit + '</small></h2>' +
      '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + label + ' 변화 그래프">' +
        ticks.map(function (t) {
          return '<line class="grid" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + sy(t) + '" y2="' + sy(t) + '"/>' +
            '<text class="ax" x="' + (P.l - 8) + '" y="' + (sy(t) + 4) + '" text-anchor="end">' + (Math.round(t * 10) / 10) + '</text>';
        }).join('') +
        '<path class="line" d="' + path + '"/>' +
        points.map(function (p, i) {
          const first = i === 0, last = i === points.length - 1;
          return '<circle class="dot" cx="' + sx(xs[i]) + '" cy="' + sy(p.v) + '" r="5"><title>' + esc(M.ui.fmtDate(p.date, false)) + ' ' + p.v + unit + '</title></circle>' +
            (first || last ? '<text class="ax" x="' + sx(xs[i]) + '" y="' + (H - 10) + '" text-anchor="' + (first ? 'start' : 'end') + '">' + esc(M.ui.fmtDate(p.date, false)) + '</text>' : '');
        }).join('') +
      '</svg></section>';
  }

  M.ui.lineChart = lineChart;

  function chartHTML(all) {
    return NUMS.map(function (n) {
      const pts = all.filter(function (r) { return r.date && has(r.data[n[0]]); }).map(function (r) { return { date: r.date, v: Number(r.data[n[0]]) }; });
      return lineChart(pts, n[1], n[2]);
    }).join('');
  }

  M.mods.growth = async function (el, sub) {
    const mode = sub[0] || 'list';
    if (mode === 'new' || mode === 'edit') {
      let rec = null;
      if (mode === 'edit') {
        rec = await M.db.get(sub[1]);
        if (!rec || rec.trashed) { el.innerHTML = M.ui.empty('🔍', '기록을 찾을 수 없어요.', '#/growth', '목록으로'); return; }
      } else {
        rec = { type: 'growth', date: M.ui.today(), data: {} };
      }
      await M.forms.editor(el, {
        type: 'growth', fields: FIELDS, rec: rec, back: '#/growth', backLabel: '성장 기록',
        titleOf: function (r) { return r.title || M.ui.fmtDate(r.date) + ' 성장 기록'; },
        editHref: function (id) { return '#/growth/edit/' + id; }
      });
      return;
    }
    const tab = TABS.some(function (t) { return t[0] === mode; }) ? mode : 'list';
    const all = asc(await M.db.list('growth'));
    const head = '<div class="sub-bar">' + M.ui.tabs('growth', TABS, tab) + '<a class="btn primary" href="#/growth/new">+ 성장 기록하기</a></div>';
    if (!all.length) {
      el.innerHTML = head + M.ui.empty('🌱', '아직 성장 기록이 없어요. 키, 목소리, 관심사… 원하는 것만 골라서 자유롭게 기록해 보세요.', '#/growth/new', '+ 첫 기록 남기기');
      return;
    }
    el.innerHTML = head + (tab === 'compare' ? compareHTML(all) : tab === 'then' ? thenNowHTML(all) : tab === 'chart' ? chartHTML(all) : listHTML(all));
  };
})();

/* ===== js/mods/school.js ===== */
/* 학교생활 수첩: 선생님 · 동아리 · 반 정보 · 시간표 · 학교 행사 · 일정 · 상장 · 편지 */
(function () {
  const M = window.MMSD;

  const SUBJECTS = ['국어', '수학', '영어', '사회', '과학', '역사', '도덕', '기술·가정', '정보', '음악', '미술', '체육', '진로', '기타'];
  const ACT_KINDS = ['정기 활동', '특별 활동', '행사', '발표·공연', '기타'];

  /* 각 탭 설정 */
  const T = {
    teachers: {
      type: 'teacher', label: '👩‍🏫 선생님', emoji: '👩‍🏫', add: '선생님 추가',
      fields: [
        { t: 'section', label: '👩‍🏫 선생님 정보' },
        { k: 'name', label: '이름', t: 'text', top: 'title' },
        { k: 'honorific', label: '호칭', t: 'text', ph: '예: 김쌤, 담임쌤' },
        { k: 'subject', label: '담당 과목', t: 'select', opts: SUBJECTS },
        { k: 'grade', label: '학년', t: 'grade', top: 'grade', hint: '내가 몇 학년일 때 만난 선생님인지' },
        { k: 'classNo', label: '반', t: 'text' },
        { k: 'years', label: '담당 학년도', t: 'text', ph: '예: 2026년' },
        { k: 'homeroom', label: '🏫 담임 선생님', t: 'check' },
        { k: 'fav', label: '⭐ 즐겨찾기', t: 'check' },
        { k: 'photos', label: '사진 (선택)', t: 'media', top: 'mediaIds', full: true },
        { t: 'section', label: '📝 선생님에 대한 기록' },
        { k: 'personality', label: '성격 및 특징', t: 'textarea', full: true },
        { k: 'style', label: '수업 방식', t: 'textarea', full: true },
        { k: 'quotes', label: '기억에 남는 말씀', t: 'textarea', full: true },
        { k: 'funny', label: '재미있었던 일', t: 'textarea' },
        { k: 'thanks', label: '감사했던 순간', t: 'textarea' },
        { k: 'moments', label: '선생님과의 추억', t: 'rows', full: true, addLabel: '추억 추가',
          cols: [{ k: 'date', label: '날짜', t: 'date', w: 1 }, { k: 'text', label: '어떤 일이 있었나요?', w: 3 }] },
        { k: 'memo', label: '자유 메모', t: 'textarea', full: true },
        { k: 'tags', label: '태그', t: 'tags', top: 'tags', full: true }
      ],
      sub: function (r) {
        return [r.data.honorific, r.data.subject, r.grade ? r.grade + '학년' + (r.data.classNo ? ' ' + r.data.classNo + '반' : '') : ''].filter(Boolean).join(' · ');
      },
      badges: function (r) { return (r.data.homeroom ? '<span class="badge hot">담임</span>' : '') + (r.data.fav ? '<span class="star">⭐</span>' : ''); },
      filter: { key: 'subject', label: '모든 과목', opts: SUBJECTS },
      groupByGrade: true,
      extra: teacherExtra
    },
    clubs: {
      type: 'club', label: '🎨 동아리', emoji: '🎨', add: '동아리 추가',
      fields: [
        { t: 'section', label: '🎨 동아리 정보' },
        { k: 'name', label: '동아리 이름', t: 'text', top: 'title' },
        { k: 'field', label: '분야', t: 'select', opts: ['예술', '음악·공연', '체육', '과학·IT', '학술·토론', '봉사', '독서·문학', '기타'] },
        { k: 'teacher', label: '담당 선생님', t: 'text' },
        { k: 'joinDate', label: '가입 날짜', t: 'date' },
        { k: 'leaveDate', label: '탈퇴 날짜', t: 'date', hint: '지금도 활동 중이면 비워 두세요.' },
        { k: 'grades', label: '활동 학년', t: 'multi', opts: ['1학년', '2학년', '3학년'], full: true },
        { k: 'photos', label: '로고 및 사진첩', t: 'media', top: 'mediaIds', full: true, hint: '첫 번째 사진이 로고처럼 목록에 보여요.' },
        { k: 'regular', label: '정기 활동', t: 'textarea' },
        { k: 'special', label: '특별 활동', t: 'textarea' },
        { k: 'activities', label: '활동 기록 (타임라인)', t: 'rows', full: true, addLabel: '활동 추가',
          cols: [{ k: 'date', label: '날짜', t: 'date', w: 1 }, { k: 'kind', label: '종류', t: 'select', opts: ACT_KINDS, w: 1 }, { k: 'text', label: '무엇을 했나요?', w: 3 }] },
        { k: 'friends', label: '동아리 친구', t: 'link', of: 'friend', full: true, emptyText: '친구 수첩에 친구를 등록하면 여기서 고를 수 있어요.' },
        { k: 'memorable', label: '기억에 남는 사건', t: 'textarea', full: true },
        { k: 'fav', label: '⭐ 즐겨찾기', t: 'check' }
      ],
      sub: function (r) {
        const d = r.data;
        return [d.field, (d.joinDate ? M.ui.fmtDate(d.joinDate, false) : '?') + ' ~ ' + (d.leaveDate ? M.ui.fmtDate(d.leaveDate, false) : '활동 중')].filter(Boolean).join(' · ');
      },
      badges: function (r) {
        const n = (r.data.activities || []).length;
        return (n ? '<span class="badge soft">활동 ' + n + '회</span>' : '') + (!r.data.leaveDate ? '<span class="badge hot">활동 중</span>' : '');
      },
      before: clubHistory,
      extra: clubExtra
    },
    class: {
      type: 'classInfo', label: '🏫 반 정보', emoji: '🏫', add: '반 정보 추가',
      fields: [
        { k: 'grade', label: '학년', t: 'grade', top: 'grade' },
        { k: 'classNo', label: '반', t: 'text', ph: '예: 3' },
        { k: 'homeroom', label: '담임 선생님', t: 'link', of: 'teacher', full: true, emptyText: '선생님 탭에서 선생님을 등록하면 여기서 고를 수 있어요.' },
        { k: 'motto', label: '급훈 · 반 목표', t: 'text', full: true },
        { k: 'classmates', label: '같은 반 친구', t: 'link', of: 'friend', full: true, emptyText: '친구 수첩에 친구를 등록하면 여기서 고를 수 있어요.' },
        { k: 'composition', label: '학급 구성 (반장·부반장·자리 등)', t: 'textarea', full: true, rows: 4 },
        { k: 'memo', label: '우리 반 이야기', t: 'textarea', full: true, rows: 4 }
      ],
      titleOf: function (r) { return (r.grade ? r.grade + '학년 ' : '') + (r.data.classNo ? r.data.classNo + '반' : '반 정보'); },
      sub: function (r) { return r.data.motto ? '“' + r.data.motto + '”' : ''; },
      badges: function (r) { return (r.data.classmates || []).length ? '<span class="badge soft">친구 ' + r.data.classmates.length + '명</span>' : ''; },
      noThumb: true
    },
    timetable: {
      type: 'timetable', label: '🗓️ 시간표', emoji: '🗓️', add: '시간표 추가',
      fields: [
        { k: 'grade', label: '학년', t: 'grade', top: 'grade' },
        { k: 'semester', label: '학기', t: 'select', opts: ['1학기', '2학기'] },
        { k: 'table', label: '시간표', t: 'timetable', full: true },
        { k: 'photos', label: '시간표 사진', t: 'media', top: 'mediaIds', full: true },
        { k: 'memo', label: '메모', t: 'textarea', full: true }
      ],
      titleOf: function (r) { return (r.grade ? r.grade + '학년 ' : '') + (r.data.semester || '') + ' 시간표'; }
    },
    events: {
      type: 'schoolEvent', label: '🎉 학교 행사', emoji: '🎉', add: '행사 추가',
      fields: [
        { k: 'title', label: '행사 이름', t: 'text', top: 'title', full: true },
        { k: 'kind', label: '종류', t: 'select', opts: ['입학식', '체육대회', '축제', '현장체험학습', '수학여행', '수련회', '졸업식', '기타'] },
        { k: 'date', label: '날짜', t: 'date', top: 'date' },
        { k: 'grade', label: '학년', t: 'grade', top: 'grade' },
        { k: 'place', label: '장소', t: 'text' },
        { k: 'content', label: '어떤 행사였나요?', t: 'textarea', full: true, rows: 5 },
        { k: 'photos', label: '사진·동영상', t: 'media', top: 'mediaIds', full: true },
        { k: 'tags', label: '태그', t: 'tags', top: 'tags', full: true }
      ],
      sub: function (r) { return [r.data.kind, M.ui.fmtDate(r.date, false), r.data.place].filter(Boolean).join(' · '); }
    },
    schedule: {
      type: 'schedule', label: '📌 시험·수행 일정', emoji: '📌', add: '일정 추가',
      fields: [
        { k: 'title', label: '일정 이름', t: 'text', top: 'title', full: true, ph: '예: 2학기 기말고사, 과학 탐구 보고서' },
        { k: 'kind', label: '종류', t: 'select', opts: ['시험', '수행평가', '학교 행사', '기타'] },
        { k: 'subject', label: '과목', t: 'select', opts: SUBJECTS },
        { k: 'date', label: '날짜 (마감일)', t: 'date', top: 'date' },
        { k: 'grade', label: '학년', t: 'grade', top: 'grade' },
        { k: 'memo', label: '준비할 것 · 메모', t: 'textarea', full: true },
        { k: 'done', label: '✅ 끝났어요', t: 'check', full: true }
      ],
      sub: function (r) { return [r.data.kind, r.data.subject, M.ui.fmtDate(r.date)].filter(Boolean).join(' · '); },
      badges: function (r) {
        if (r.data.done) return '<span class="badge soft">완료</span>';
        const n = M.ui.daysUntil(r.date);
        return n == null ? '' : '<span class="badge ' + (n >= 0 && n <= 7 ? 'hot' : 'soft') + '">' + M.ui.dday(n) + '</span>';
      },
      noThumb: true,
      custom: scheduleList
    },
    awards: {
      type: 'award', label: '🏆 상장', emoji: '🏆', add: '상장 추가',
      fields: [
        { k: 'title', label: '상 이름', t: 'text', top: 'title', full: true },
        { k: 'date', label: '받은 날짜', t: 'date', top: 'date' },
        { k: 'grade', label: '학년', t: 'grade', top: 'grade' },
        { k: 'org', label: '수여 기관', t: 'text' },
        { k: 'rank', label: '등급 · 순위', t: 'text', ph: '예: 금상, 1등' },
        { k: 'photos', label: '상장 사진', t: 'media', top: 'mediaIds', full: true },
        { k: 'memo', label: '받게 된 이야기', t: 'textarea', full: true }
      ],
      sub: function (r) { return [r.data.rank, r.data.org, M.ui.fmtDate(r.date, false)].filter(Boolean).join(' · '); }
    },
    letters: {
      type: 'letter', label: '💌 편지', emoji: '💌', add: '편지 추가',
      fields: [
        { k: 'title', label: '제목', t: 'text', top: 'title', full: true, ph: '예: 스승의 날 답장, 졸업 축하 쪽지' },
        { k: 'fromKind', label: '보낸 사람', t: 'select', opts: ['선생님', '친구', '학교', '가족', '기타'] },
        { k: 'date', label: '받은 날짜', t: 'date', top: 'date' },
        { k: 'grade', label: '학년', t: 'grade', top: 'grade' },
        { k: 'fromTeacher', label: '보낸 선생님', t: 'link', of: 'teacher', full: true, emptyText: '선생님을 등록하면 선생님 페이지에서도 이 편지를 볼 수 있어요.' },
        { k: 'fromFriend', label: '보낸 친구', t: 'link', of: 'friend', full: true, emptyText: '친구 수첩에 친구를 등록하면 여기서 고를 수 있어요.' },
        { k: 'fromText', label: '그 밖의 보낸 사람', t: 'text' },
        { k: 'content', label: '편지 내용', t: 'textarea', full: true, rows: 6 },
        { k: 'photos', label: '편지·쪽지 사진', t: 'media', top: 'mediaIds', full: true },
        { k: 'tags', label: '태그', t: 'tags', top: 'tags', full: true }
      ],
      sub: function (r) { return [r.data.fromKind, M.ui.fmtDate(r.date, false)].filter(Boolean).join(' · '); }
    }
  };
  function plain(label) { return label.replace(/^\S+\s+/, ''); }
  const TAB_LIST = Object.keys(T).map(function (k) { return [k, T[k].label]; });

  /* ---------- 카드 ---------- */
  function card(cfg, key, r) {
    const U = M.ui, esc = U.esc;
    const sub = cfg.sub ? cfg.sub(r) : '';
    return '<a class="item card" href="#/school/' + key + '/edit/' + r.id + '">' +
      (cfg.noThumb ? '<div class="thumb"><span aria-hidden="true">' + cfg.emoji + '</span></div>' : U.thumb(r, cfg.emoji)) +
      '<div class="item-body"><p class="item-title">' + esc(r.title || '(제목 없음)') + '</p>' +
      (sub ? '<p class="item-sub">' + esc(sub) + '</p>' : '') +
      '<div class="badges">' + (cfg.badges ? cfg.badges(r) : '') + (r.grade && !cfg.groupByGrade ? '<span class="badge soft">' + r.grade + '학년</span>' : '') + '</div>' +
      '</div></a>';
  }

  /* ---------- 선생님 페이지 아래: 편지 · 함께한 기록 ---------- */
  async function teacherExtra(t) {
    const [letters, mem, dia] = await Promise.all([M.db.list('letter'), M.db.list('memory'), M.db.list('diary')]);
    const has = function (arr) { return (arr || []).indexOf(t.id) >= 0; };
    const items = [];
    (t.data.moments || []).forEach(function (m) { items.push({ date: m.date, icon: '🍎', kind: '추억', title: m.text }); });
    letters.filter(function (l) { return has(l.data.fromTeacher); }).forEach(function (l) {
      items.push({ date: l.date, icon: '💌', kind: '편지·쪽지', title: l.title, href: '#/school/letters/edit/' + l.id });
    });
    mem.filter(function (m) { return has(m.data.teachers); }).forEach(function (m) {
      items.push({ date: m.date, icon: '📸', kind: '추억 보관함', title: m.title, href: '#/memories/edit/' + m.id });
    });
    dia.filter(function (d) { return has(d.data.teachersMet); }).forEach(function (d) {
      items.push({ date: d.date, icon: '📔', kind: '일기', title: d.title, href: '#/diary/edit/' + d.id });
    });
    return '<section class="card tape-left"><div class="sec-head"><h2 class="sec-title">🕰️ 선생님과의 추억 타임라인</h2>' +
      '<a class="btn" href="#/school/letters/new">+ 받은 편지 보관</a></div>' +
      M.timelineHTML(items, '위의 "선생님과의 추억"에 적거나, 편지·일기·추억 보관함에서 이 선생님을 고르면 여기에 모여요.') + '</section>';
  }

  /* ---------- 동아리: 변경 이력 + 활동 통계 ---------- */
  function clubHistory(list) {
    if (!list.length) return '';
    const U = M.ui, esc = U.esc;
    const sorted = list.slice().sort(function (a, b) { return (a.data.joinDate || '') < (b.data.joinDate || '') ? -1 : 1; });
    return '<section class="card tape"><h2 class="sec-title">🔁 동아리 변경 이력</h2><ol class="timeline asc">' + sorted.map(function (c) {
      return '<li><a href="#/school/clubs/edit/' + c.id + '"><span class="tl-date">' + esc(c.data.joinDate ? U.fmtDate(c.data.joinDate, false) : '가입일 없음') + '</span>' +
        '<span class="tl-kind">' + (c.data.leaveDate ? '🚪 ' + esc(U.fmtDate(c.data.leaveDate, false)) + ' 탈퇴' : '🌱 활동 중') + '</span>' +
        '<span class="tl-title">' + esc(c.title || '(이름 없음)') + '</span></a></li>';
    }).join('') + '</ol></section>';
  }
  async function clubExtra(c) {
    const acts = c.data.activities || [];
    const counts = {};
    acts.forEach(function (a) { const k = a.kind || '기타'; counts[k] = (counts[k] || 0) + 1; });
    return '<section class="card tape-left"><h2 class="sec-title">📊 활동 횟수</h2>' +
      '<div class="stat-grid"><div class="stat"><span class="n">' + acts.length + '</span><span class="l">전체</span></div>' +
      ACT_KINDS.map(function (k) { return '<div class="stat"><span class="n">' + (counts[k] || 0) + '</span><span class="l">' + k + '</span></div>'; }).join('') + '</div>' +
      '<h2 class="sec-title">🕰️ 활동 타임라인</h2>' +
      M.timelineHTML(acts.map(function (a) { return { date: a.date, icon: '🎨', kind: a.kind || '활동', title: a.text }; }), '위의 "활동 기록"에 활동을 추가하면 여기에 쌓여요.') +
      '</section>';
  }

  /* ---------- 일정: 다가오는 일정 / 지난 일정 ---------- */
  function scheduleList(list, cfg, key) {
    const today = M.ui.today();
    const up = list.filter(function (r) { return !r.data.done && (!r.date || r.date >= today); })
      .sort(function (a, b) { return (a.date || '9') < (b.date || '9') ? -1 : 1; });
    const past = list.filter(function (r) { return up.indexOf(r) < 0; });
    return '<h2 class="sec-title">⏰ 다가오는 일정 <small>' + up.length + '개</small></h2>' +
      (up.length ? '<div class="item-list">' + up.map(function (r) { return card(cfg, key, r); }).join('') + '</div>' : '<p class="empty">다가오는 일정이 없어요.</p>') +
      '<h2 class="sec-title">✅ 지난 일정 · 완료 <small>' + past.length + '개</small></h2>' +
      (past.length ? '<div class="item-list dim">' + past.map(function (r) { return card(cfg, key, r); }).join('') + '</div>' : '<p class="empty">아직 없어요.</p>');
  }

  /* ---------- 목록 ---------- */
  async function listView(el, key) {
    const U = M.ui;
    const cfg = T[key];
    const all = await M.db.list(cfg.type);
    const head = '<div class="sub-bar">' + U.tabs('school', TAB_LIST, key) + '</div>' +
      '<div class="toolbar card">' +
        '<input type="search" class="inp" id="sq" placeholder="🔍 ' + plain(cfg.label) + ' 찾기" aria-label="검색">' +
        '<select class="inp" id="sg" aria-label="학년"><option value="">전체 학년</option><option value="1">1학년</option><option value="2">2학년</option><option value="3">3학년</option></select>' +
        (cfg.filter ? '<select class="inp" id="sf" aria-label="필터"><option value="">' + cfg.filter.label + '</option>' + cfg.filter.opts.map(function (o) { return '<option>' + o + '</option>'; }).join('') + '</select>' : '') +
        (key === 'teachers' ? '<label class="switch"><input type="checkbox" id="sfav"><span>⭐만</span></label>' : '') +
        '<a class="btn primary" href="#/school/' + key + '/new">+ ' + cfg.add + '</a>' +
      '</div>' +
      (cfg.before ? cfg.before(all) : '') +
      '<div id="sres"></div>';
    el.innerHTML = head;
    const q = el.querySelector('#sq'), g = el.querySelector('#sg'), f = el.querySelector('#sf'), fav = el.querySelector('#sfav'), res = el.querySelector('#sres');
    function draw() {
      const list = all.filter(function (r) {
        return U.match(r, q.value.trim()) && (!g.value || String(r.grade) === g.value) &&
          (!f || !f.value || r.data[cfg.filter.key] === f.value) && (!fav || !fav.checked || r.data.fav);
      });
      if (!all.length) {
        res.innerHTML = U.empty(cfg.emoji, '아직 기록이 없어요.', '#/school/' + key + '/new', '+ ' + cfg.add);
      } else if (!list.length) {
        res.innerHTML = '<p class="empty center">찾는 기록이 없어요.</p>';
      } else if (cfg.custom) {
        res.innerHTML = cfg.custom(list, cfg, key);
      } else if (cfg.groupByGrade) {
        res.innerHTML = U.byGrade(list).map(function (gr) {
          const items = gr[1].sort(function (a, b) { return (b.data.homeroom ? 1 : 0) - (a.data.homeroom ? 1 : 0) || (a.title || '').localeCompare(b.title || '', 'ko'); });
          return '<h2 class="sec-title">' + U.gradeLabel(gr[0]) + ' <small>' + items.length + '</small></h2><div class="item-list">' +
            items.map(function (r) { return card(cfg, key, r); }).join('') + '</div>';
        }).join('');
      } else {
        res.innerHTML = '<div class="item-list">' + list.map(function (r) { return card(cfg, key, r); }).join('') + '</div>';
      }
      U.hydrate(res);
    }
    [q, g, f, fav].forEach(function (x) { if (x) x.addEventListener('input', draw); });
    if (f) f.addEventListener('change', draw);
    draw();
  }

  M.mods.school = async function (el, sub) {
    const key = T[sub[0]] ? sub[0] : 'teachers';
    const cfg = T[key];
    const mode = sub[1];
    if (mode === 'new' || mode === 'edit') {
      let rec = null;
      if (mode === 'edit') {
        rec = await M.db.get(sub[2]);
        if (!rec || rec.trashed || rec.type !== cfg.type) {
          el.innerHTML = M.ui.empty('🔍', '기록을 찾을 수 없어요.', '#/school/' + key, '목록으로');
          return;
        }
      }
      await M.forms.editor(el, {
        type: cfg.type, fields: cfg.fields, rec: rec,
        back: '#/school/' + key, backLabel: plain(cfg.label) + ' 목록',
        titleOf: cfg.titleOf,
        editHref: function (id) { return '#/school/' + key + '/edit/' + id; },
        extra: cfg.extra
      });
      return;
    }
    return listView(el, key);
  };
})();

/* ===== js/mods/friends.js ===== */
/* 친구 수첩 */
(function () {
  const M = window.MMSD;

  const RELATIONS = ['단짝·베프', '친한 친구', '친구', '아는 사이', '멀어진 친구', '기타'];

  const FIELDS = [
    { t: 'section', label: '🙂 친구 프로필' },
    { k: 'name', label: '이름', t: 'text', top: 'title' },
    { k: 'nickname', label: '별명', t: 'text' },
    { k: 'birthday', label: '생일', t: 'date', hint: '생일 달력과 홈 화면 알림에 쓰여요.' },
    { k: 'relation', label: '현재 관계', t: 'select', opts: RELATIONS },
    { k: 'firstMet', label: '처음 만난 날짜', t: 'date' },
    { k: 'closeDate', label: '친해진 날짜', t: 'date' },
    { k: 'class1', label: '1학년 때 반', t: 'text', ph: '예: 3 (같은 학교가 아니면 비워 두기)' },
    { k: 'class2', label: '2학년 때 반', t: 'text' },
    { k: 'class3', label: '3학년 때 반', t: 'text' },
    { k: 'photos', label: '사진첩', t: 'media', top: 'mediaIds', full: true },
    { k: 'keywords', label: '친구를 표현하는 키워드 · 태그', t: 'tags', top: 'tags', full: true },
    { k: 'relationLog', label: '관계 변화 기록', t: 'rows', full: true, addLabel: '변화 추가',
      cols: [{ k: 'date', label: '날짜', t: 'date', w: 1 }, { k: 'text', label: '어떤 변화가 있었나요?', w: 3 }] },
    { k: 'memo', label: '자유 메모', t: 'textarea', full: true },
    { k: 'fav', label: '⭐ 즐겨찾는 친구', t: 'check', full: true }
  ];

  const MEM_KINDS = ['함께한 사건', '방문한 장소', '주고받은 편지', '재미있었던 대화', '생일·기념일', '기타'];
  const MEM_FIELDS = [
    { k: 'title', label: '제목', t: 'text', top: 'title', full: true },
    { k: 'kind', label: '종류', t: 'select', opts: MEM_KINDS },
    { k: 'date', label: '날짜', t: 'date', top: 'date' },
    { k: 'grade', label: '학년', t: 'grade', top: 'grade' },
    { k: 'place', label: '장소', t: 'text' },
    { k: 'friends', label: '함께한 친구', t: 'link', of: 'friend', full: true },
    { k: 'content', label: '내용', t: 'textarea', full: true, rows: 5 },
    { k: 'photos', label: '사진 · 편지 사진', t: 'media', top: 'mediaIds', full: true },
    { k: 'tags', label: '태그', t: 'tags', top: 'tags', full: true }
  ];

  const TABS = [['all', '👭 전체'], ['grade', '🎒 학년별'], ['class', '🏫 같은 반'], ['fav', '⭐ 즐겨찾기'], ['birthday', '🎂 생일 달력'], ['memories', '💭 추억 찾기']];

  function grades(f) {
    return [1, 2, 3].filter(function (g) { return f.data['class' + g]; });
  }

  function friendCard(f) {
    const U = M.ui, esc = U.esc, d = f.data;
    const n = d.birthday ? U.daysToBirthday(d.birthday) : null;
    return '<a class="person card" href="#/friends/edit/' + f.id + '">' + U.thumb(f, '🙂', 'round') +
      '<div class="person-body">' +
        '<p class="person-name">' + (d.fav ? '<span class="star" aria-label="즐겨찾기">⭐</span>' : '') + esc(f.title || '(이름 없음)') +
          (d.nickname ? ' <small>' + esc(d.nickname) + '</small>' : '') + '</p>' +
        '<div class="badges">' + (d.relation ? '<span class="badge">' + esc(d.relation) + '</span>' : '') +
          grades(f).map(function (g) { return '<span class="badge soft">' + g + '-' + esc(d['class' + g]) + '</span>'; }).join('') +
          (n != null && n <= 30 ? '<span class="badge hot">🎂 ' + (n === 0 ? '오늘' : 'D-' + n) + '</span>' : '') +
        '</div>' +
        (f.tags && f.tags.length ? '<ul class="tag-list">' + f.tags.slice(0, 4).map(function (t) { return '<li>#' + esc(t) + '</li>'; }).join('') + '</ul>' : '') +
      '</div></a>';
  }

  function cards(list, emptyText) {
    if (!list.length) return '<p class="empty center">' + emptyText + '</p>';
    return '<div class="person-list">' + list.map(friendCard).join('') + '</div>';
  }

  /* 타임라인 공통 (선생님 수첩에서도 사용) */
  M.timelineHTML = function (items, emptyText) {
    const U = M.ui, esc = U.esc;
    if (!items.length) return '<p class="empty">' + emptyText + '</p>';
    items.sort(function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; });
    return '<ol class="timeline">' + items.map(function (it) {
      const inner = '<span class="tl-date">' + esc(it.date ? U.fmtDate(it.date, false) : '날짜 없음') + '</span>' +
        '<span class="tl-kind">' + it.icon + ' ' + esc(it.kind) + '</span>' +
        '<span class="tl-title">' + esc(it.title || '') + '</span>';
      return '<li>' + (it.href ? '<a href="' + it.href + '">' + inner + '</a>' : '<div>' + inner + '</div>') + '</li>';
    }).join('') + '</ol>';
  };

  async function friendTimeline(f) {
    const [fm, mem, dia] = await Promise.all([M.db.list('friendMemory'), M.db.list('memory'), M.db.list('diary')]);
    const has = function (arr) { return (arr || []).indexOf(f.id) >= 0; };
    const items = [];
    fm.filter(function (r) { return has(r.data.friends); }).forEach(function (r) {
      items.push({ date: r.date, icon: '💭', kind: r.data.kind || '추억', title: r.title, href: '#/friends/memory/edit/' + r.id });
    });
    mem.filter(function (r) { return has(r.data.friends); }).forEach(function (r) {
      items.push({ date: r.date, icon: '📸', kind: '추억 보관함', title: r.title, href: '#/memories/edit/' + r.id });
    });
    dia.filter(function (r) { return has(r.data.friendsMet); }).forEach(function (r) {
      items.push({ date: r.date, icon: '📔', kind: '일기', title: r.title, href: '#/diary/edit/' + r.id });
    });
    (f.data.relationLog || []).forEach(function (r) {
      items.push({ date: r.date, icon: '🔁', kind: '관계 변화', title: r.text });
    });
    return '<section class="card tape-left"><div class="sec-head"><h2 class="sec-title">🕰️ ' + M.ui.esc(f.title || '친구') + '와(과)의 추억 타임라인</h2>' +
      '<a class="btn primary" href="#/friends/memory/new/' + f.id + '">+ 추억 추가</a></div>' +
      M.timelineHTML(items, '아직 함께한 추억이 없어요. 추억을 추가하거나, 일기·추억 보관함에서 이 친구를 고르면 여기에 모여요.') + '</section>';
  }

  async function listView(el, tab) {
    const U = M.ui, esc = U.esc;
    const all = (await M.db.list('friend')).sort(function (a, b) { return (a.title || '').localeCompare(b.title || '', 'ko'); });
    const head = '<div class="sub-bar">' + U.tabs('friends', TABS, tab) + '<a class="btn primary" href="#/friends/new">+ 친구 추가</a></div>';

    if (tab === 'memories') {
      const mems = await M.db.list('friendMemory');
      const names = await U.nameMap('friend');
      el.innerHTML = head + '<div class="toolbar card"><input type="search" class="inp" id="fq" placeholder="🔍 친구 이름·장소·내용으로 추억 찾기" aria-label="추억 검색"></div><div id="fres"></div>';
      const q = el.querySelector('#fq'), res = el.querySelector('#fres');
      const draw = function () {
        const s = q.value.trim().toLowerCase();
        const list = mems.filter(function (m) {
          const who = (m.data.friends || []).map(function (id) { return names[id] || ''; }).join(' ');
          return !s || (who.toLowerCase().indexOf(s) >= 0) || U.match(m, s);
        });
        res.innerHTML = M.timelineHTML(list.map(function (m) {
          const who = (m.data.friends || []).map(function (id) { return names[id]; }).filter(Boolean).join(', ');
          return { date: m.date, icon: '💭', kind: (m.data.kind || '추억') + (who ? ' · ' + who : ''), title: m.title, href: '#/friends/memory/edit/' + m.id };
        }), mems.length ? '찾는 추억이 없어요.' : '아직 친구와의 추억이 없어요. 친구 페이지에서 추억을 추가해 보세요.');
      };
      q.addEventListener('input', draw);
      draw();
      return;
    }

    if (!all.length) {
      el.innerHTML = head + U.empty('👭', '아직 등록된 친구가 없어요. 중학교에서 만난 친구를 추가해 보세요.', '#/friends/new', '+ 친구 추가');
      return;
    }

    if (tab === 'grade') {
      el.innerHTML = head + [1, 2, 3].map(function (g) {
        const list = all.filter(function (f) { return f.data['class' + g]; });
        return '<h2 class="sec-title">' + g + '학년 <small>' + list.length + '명</small></h2>' + cards(list, g + '학년 반이 입력된 친구가 없어요.');
      }).join('') + '<p class="fhint">친구 정보의 "N학년 때 반"을 입력하면 학년별로 모여요.</p>';
      return;
    }
    if (tab === 'class') {
      const p = M.profile;
      const groups = {};
      all.forEach(function (f) {
        [1, 2, 3].forEach(function (g) {
          const c = f.data['class' + g];
          if (c) (groups[g + '-' + c] = groups[g + '-' + c] || []).push(f);
        });
      });
      const keys = Object.keys(groups).sort();
      const mine = p && p.grade && p.data.classNo ? p.grade + '-' + p.data.classNo : null;
      el.innerHTML = head + (keys.length ? keys.map(function (k) {
        const gc = k.split('-');
        return '<h2 class="sec-title">' + gc[0] + '학년 ' + esc(gc[1]) + '반' + (k === mine ? ' <span class="badge hot">지금 우리 반</span>' : '') +
          ' <small>' + groups[k].length + '명</small></h2>' + cards(groups[k], '');
      }).join('') : '<p class="empty center">반 정보가 입력된 친구가 없어요.</p>');
      return;
    }
    if (tab === 'fav') {
      el.innerHTML = head + cards(all.filter(function (f) { return f.data.fav; }), '즐겨찾는 친구가 없어요. 친구 정보에서 ⭐를 켜 보세요.');
      return;
    }
    if (tab === 'birthday') {
      const withB = all.filter(function (f) { return U.parse(f.data.birthday); });
      const soon = withB.map(function (f) { return { f: f, n: U.daysToBirthday(f.data.birthday) }; })
        .sort(function (a, b) { return a.n - b.n; }).slice(0, 5);
      el.innerHTML = head +
        (soon.length ? '<section class="card tape soon"><h2 class="sec-title">🎉 다가오는 생일</h2><ul class="mini-list">' + soon.map(function (x) {
          return '<li><a href="#/friends/edit/' + x.f.id + '"><b class="dday">' + (x.n === 0 ? '🎉 오늘' : 'D-' + x.n) + '</b> ' + esc(x.f.title) +
            ' <small>' + (U.parse(x.f.data.birthday).getMonth() + 1) + '월 ' + U.parse(x.f.data.birthday).getDate() + '일</small></a></li>';
        }).join('') + '</ul></section>' : '') +
        '<div class="month-grid">' + Array.from({ length: 12 }, function (_, i) {
          const list = withB.filter(function (f) { return U.parse(f.data.birthday).getMonth() === i; })
            .sort(function (a, b) { return U.parse(a.data.birthday).getDate() - U.parse(b.data.birthday).getDate(); });
          return '<section class="card month' + (new Date().getMonth() === i ? ' now' : '') + '"><h3>' + (i + 1) + '월</h3>' +
            (list.length ? '<ul>' + list.map(function (f) {
              return '<li><a href="#/friends/edit/' + f.id + '"><b>' + U.parse(f.data.birthday).getDate() + '일</b> ' + esc(f.title) + '</a></li>';
            }).join('') + '</ul>' : '<p class="empty">-</p>') + '</section>';
        }).join('') + '</div>';
      return;
    }

    /* 전체 + 검색 */
    el.innerHTML = head + '<div class="toolbar card">' +
      '<input type="search" class="inp" id="fq" placeholder="🔍 이름·별명·태그로 찾기" aria-label="친구 검색">' +
      '<select class="inp" id="fr" aria-label="관계"><option value="">모든 관계</option>' + RELATIONS.map(function (r) { return '<option>' + r + '</option>'; }).join('') + '</select>' +
      '</div><div id="fres"></div>';
    const q = el.querySelector('#fq'), r = el.querySelector('#fr'), res = el.querySelector('#fres');
    const draw = function () {
      const list = all.filter(function (f) { return U.match(f, q.value.trim()) && (!r.value || f.data.relation === r.value); });
      res.innerHTML = cards(list, '찾는 친구가 없어요.');
      U.hydrate(res);
    };
    q.addEventListener('input', draw);
    r.addEventListener('change', draw);
    draw();
  }

  M.mods.friends = async function (el, sub) {
    const mode = sub[0] || 'all';
    if (mode === 'new' || mode === 'edit') {
      let rec = null;
      if (mode === 'edit') {
        rec = await M.db.get(sub[1]);
        if (!rec || rec.trashed) { el.innerHTML = M.ui.empty('🔍', '친구 정보를 찾을 수 없어요.', '#/friends', '친구 목록으로'); return; }
      }
      await M.forms.editor(el, {
        type: 'friend', fields: FIELDS, rec: rec, back: '#/friends', backLabel: '친구 목록',
        editHref: function (id) { return '#/friends/edit/' + id; },
        extra: friendTimeline
      });
      return;
    }
    if (mode === 'memory') {
      /* #/friends/memory/new/<friendId>  ·  #/friends/memory/edit/<id> */
      let rec = null, back = '#/friends/memories';
      if (sub[1] === 'edit') {
        rec = await M.db.get(sub[2]);
        if (!rec || rec.trashed) { el.innerHTML = M.ui.empty('🔍', '추억을 찾을 수 없어요.', '#/friends/memories', '추억 찾기로'); return; }
        if ((rec.data.friends || [])[0]) back = '#/friends/edit/' + rec.data.friends[0];
      } else {
        rec = { type: 'friendMemory', date: M.ui.today(), data: { friends: sub[2] ? [sub[2]] : [] } };
        if (sub[2]) back = '#/friends/edit/' + sub[2];
      }
      await M.forms.editor(el, {
        type: 'friendMemory', fields: MEM_FIELDS, rec: rec, back: back, backLabel: '돌아가기',
        titleOf: function (r) { return r.title || M.ui.snippet(r.data.content, 20) || '친구와의 추억'; },
        editHref: function (id) { return '#/friends/memory/edit/' + id; }
      });
      return;
    }
    return listView(el, TABS.some(function (t) { return t[0] === mode; }) ? mode : 'all');
  };
})();

/* ===== js/mods/diary.js ===== */
/* 일상 다이어리: 달력 · 날짜별 보기 · 모아보기 · 일기 쓰기 */
(function () {
  const M = window.MMSD;
  const O = M.forms.OPTS;

  const FIELDS = [
    { t: 'section', label: '📅 오늘의 기본' },
    { k: 'date', label: '날짜', t: 'date', top: 'date' },
    { k: 'grade', label: '학년', t: 'grade', top: 'grade' },
    { k: 'weather', label: '날씨', t: 'choice', opts: O.weather, full: true },
    { k: 'mood', label: '오늘의 기분', t: 'choice', opts: O.mood, full: true },
    { k: 'oneLine', label: '오늘의 한마디', t: 'text', full: true },
    { k: 'moment', label: '기억에 남는 순간', t: 'textarea', full: true, rows: 4 },
    { k: 'photos', label: '오늘의 사진', t: 'media', top: 'mediaIds', full: true },
    { t: 'section', label: '👥 오늘 만난 사람' },
    { k: 'friendsMet', label: '오늘 만난 친구', t: 'link', of: 'friend', full: true, emptyText: '친구 수첩에 친구를 등록하면 여기서 고를 수 있어요.' },
    { k: 'teachersMet', label: '오늘 만난 선생님', t: 'link', of: 'teacher', full: true, emptyText: '학교생활 수첩에 선생님을 등록하면 여기서 고를 수 있어요.' },
    { t: 'section', label: '🍀 오늘의 이것저것' },
    { k: 'food', label: '오늘 먹은 음식', t: 'text' },
    { k: 'song', label: '오늘 들은 노래', t: 'text' },
    { k: 'school', label: '오늘의 학교생활', t: 'textarea', full: true },
    { k: 'fandom', label: '오늘의 덕질', t: 'textarea', full: true },
    { k: 'achievement', label: '오늘의 성취', t: 'textarea' },
    { k: 'regret', label: '아쉬웠던 일', t: 'textarea' },
    { k: 'memo', label: '자유 메모', t: 'textarea', full: true },
    { k: 'secret', label: '비공개 메모', t: 'secret', full: true },
    { k: 'tags', label: '태그', t: 'tags', top: 'tags', full: true }
  ];

  function titleOf(r) {
    return r.data.oneLine || M.ui.snippet(r.data.moment, 30) || '일기';
  }
  function moodEmoji(r) { return (r.data.mood || '📝').split(' ')[0]; }

  function entryCard(r) {
    const U = M.ui, esc = U.esc;
    return '<a class="entry card" href="#/diary/edit/' + r.id + '">' + U.thumb(r, moodEmoji(r)) +
      '<div class="entry-body">' +
        '<div class="entry-top"><span class="entry-mood" aria-hidden="true">' + moodEmoji(r) + '</span>' +
        '<span class="entry-date">' + esc(U.fmtDate(r.date)) + '</span>' +
        (r.data.weather ? '<span class="entry-weather">' + esc(r.data.weather.split(' ')[0]) + '</span>' : '') +
        (r.grade ? '<span class="badge">' + r.grade + '학년</span>' : '') + '</div>' +
        '<p class="entry-title">' + esc(r.title) + '</p>' +
        (r.data.moment ? '<p class="entry-snip">' + esc(U.snippet(r.data.moment, 70)) + '</p>' : '') +
        (r.tags && r.tags.length ? '<ul class="tag-list">' + r.tags.map(function (t) { return '<li>#' + esc(t) + '</li>'; }).join('') + '</ul>' : '') +
      '</div></a>';
  }

  function topBar(active) {
    return '<div class="sub-bar">' + M.ui.tabs('diary', [['cal', '📅 달력'], ['list', '🗂️ 모아보기']], active) +
      '<a class="btn primary" href="#/diary/new/' + M.ui.today() + '">+ 오늘 일기 쓰기</a></div>';
  }

  function pastSameDay(all, date) {
    const md = date.slice(5);
    const list = all.filter(function (d) { return d.date && d.date.slice(5) === md && d.date < date; });
    if (!list.length) return '';
    return '<section class="past-day"><h2 class="sec-title">⏳ 지난 해 이 날의 일기</h2><div class="entry-list">' +
      list.map(entryCard).join('') + '</div></section>';
  }

  /* ---------- 달력 ---------- */
  function calendar(el, all, ym) {
    const U = M.ui;
    const now = new Date();
    let y = now.getFullYear(), m = now.getMonth() + 1;
    if (/^\d{4}-\d{2}$/.test(ym || '')) { y = Number(ym.slice(0, 4)); m = Number(ym.slice(5)); }
    const first = new Date(y, m - 1, 1);
    const days = new Date(y, m, 0).getDate();
    const prev = new Date(y, m - 2, 1), next = new Date(y, m, 1);
    const key = function (d) { return d.getFullYear() + '-' + U.pad(d.getMonth() + 1); };
    const byDate = {};
    all.forEach(function (d) { if (d.date) (byDate[d.date] = byDate[d.date] || []).push(d); });
    const today = U.today();

    let cells = '';
    for (let i = 0; i < first.getDay(); i++) cells += '<span class="cal-day blank" aria-hidden="true"></span>';
    let monthCount = 0;
    for (let d = 1; d <= days; d++) {
      const ds = y + '-' + U.pad(m) + '-' + U.pad(d);
      const list = byDate[ds] || [];
      monthCount += list.length;
      const wd = new Date(y, m - 1, d).getDay();
      cells += '<a class="cal-day' + (ds === today ? ' today' : '') + (list.length ? ' has' : '') + (wd === 0 ? ' sun' : wd === 6 ? ' sat' : '') +
        '" href="#/diary/day/' + ds + '" aria-label="' + m + '월 ' + d + '일' + (list.length ? ', 일기 ' + list.length + '개' : '') + '">' +
        '<span class="cal-n">' + d + '</span>' +
        (list.length ? '<span class="cal-mood" aria-hidden="true">' + moodEmoji(list[0]) + '</span>' : '') +
        (list.length > 1 ? '<span class="cal-count">' + list.length + '</span>' : '') + '</a>';
    }

    el.innerHTML = topBar('cal') +
      '<section class="card tape calendar">' +
        '<div class="cal-head">' +
          '<a class="btn small" href="#/diary/cal/' + key(prev) + '" aria-label="이전 달">◀</a>' +
          '<h2>' + y + '년 ' + m + '월 <small>일기 ' + monthCount + '개</small></h2>' +
          '<a class="btn small" href="#/diary/cal/' + key(next) + '" aria-label="다음 달">▶</a>' +
        '</div>' +
        '<div class="cal-grid">' + U.WEEK.map(function (w, i) {
          return '<span class="cal-w' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '') + '">' + w + '</span>';
        }).join('') + cells + '</div>' +
        '<p class="fhint">날짜를 누르면 그날의 일기를 보고 새로 쓸 수 있어요.</p>' +
      '</section>' +
      pastSameDay(all, today);
  }

  /* ---------- 날짜별 ---------- */
  function dayView(el, all, date) {
    const U = M.ui;
    const d = U.parse(date);
    if (!d) { location.hash = '#/diary'; return; }
    const list = all.filter(function (r) { return r.date === date; })
      .sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; });
    const prev = new Date(d); prev.setDate(d.getDate() - 1);
    const next = new Date(d); next.setDate(d.getDate() + 1);
    el.innerHTML = topBar('') +
      '<div class="day-head">' +
        '<a class="btn small" href="#/diary/day/' + U.ymd(prev) + '" aria-label="전날">◀</a>' +
        '<h2>' + U.fmtDate(date) + '</h2>' +
        '<a class="btn small" href="#/diary/day/' + U.ymd(next) + '" aria-label="다음 날">▶</a>' +
        '<a class="btn" href="#/diary/cal/' + date.slice(0, 7) + '">📅 달력으로</a>' +
      '</div>' +
      (list.length ? '<div class="entry-list">' + list.map(entryCard).join('') + '</div>'
        : U.empty('📝', '이 날의 일기가 아직 없어요.', null)) +
      '<p class="center"><a class="btn primary" href="#/diary/new/' + date + '">+ 이 날 일기 쓰기</a></p>' +
      pastSameDay(all, date);
  }

  /* ---------- 모아보기 ---------- */
  function listView(el, all) {
    const U = M.ui, esc = U.esc;
    const months = Array.from(new Set(all.map(function (d) { return (d.date || '').slice(0, 7); }).filter(Boolean))).sort().reverse();
    el.innerHTML = topBar('list') +
      '<div class="toolbar card">' +
        '<input type="search" class="inp" id="dq" placeholder="🔍 내용·태그로 찾기" aria-label="일기 검색">' +
        '<select class="inp" id="dg" aria-label="학년"><option value="">전체 학년</option><option value="1">1학년</option><option value="2">2학년</option><option value="3">3학년</option></select>' +
        '<select class="inp" id="dm" aria-label="월"><option value="">전체 기간</option>' +
          months.map(function (m) { return '<option value="' + m + '">' + m.slice(0, 4) + '년 ' + Number(m.slice(5)) + '월</option>'; }).join('') +
        '</select>' +
      '</div><div id="dres"></div>';

    const q = el.querySelector('#dq'), g = el.querySelector('#dg'), mo = el.querySelector('#dm'), res = el.querySelector('#dres');
    function draw() {
      const list = all.filter(function (d) {
        return U.match(d, q.value.trim()) && (!g.value || String(d.grade) === g.value) && (!mo.value || (d.date || '').slice(0, 7) === mo.value);
      });
      if (!list.length) {
        res.innerHTML = all.length ? '<p class="empty center">찾는 일기가 없어요.</p>'
          : U.empty('📔', '아직 쓴 일기가 없어요. 오늘 하루를 기록해 볼까요?', '#/diary/new/' + U.today(), '+ 일기 쓰기');
        return;
      }
      const groups = {};
      list.forEach(function (d) { const k = (d.date || '날짜 없음').slice(0, 7); (groups[k] = groups[k] || []).push(d); });
      res.innerHTML = Object.keys(groups).sort().reverse().map(function (k) {
        const label = /^\d{4}-\d{2}$/.test(k) ? k.slice(0, 4) + '년 ' + Number(k.slice(5)) + '월' : k;
        return '<h2 class="sec-title">' + esc(label) + ' <small>' + groups[k].length + '개</small></h2><div class="entry-list">' + groups[k].map(entryCard).join('') + '</div>';
      }).join('');
      U.hydrate(res);
    }
    [q, g, mo].forEach(function (x) { x.addEventListener('input', draw); });
    draw();
  }

  M.mods.diary = async function (el, sub) {
    const mode = sub[0] || 'cal';
    if (mode === 'new' || mode === 'edit') {
      let rec = null;
      if (mode === 'edit') {
        rec = await M.db.get(sub[1]);
        if (!rec || rec.trashed) { el.innerHTML = M.ui.empty('🔍', '일기를 찾을 수 없어요. 휴지통으로 옮겨졌을 수 있어요.', '#/diary', '달력으로'); return; }
      } else {
        rec = { type: 'diary', date: M.ui.parse(sub[1]) ? sub[1] : M.ui.today(), data: {} };
      }
      const backDate = rec.date || M.ui.today();
      await M.forms.editor(el, {
        type: 'diary', fields: FIELDS, rec: rec, titleOf: titleOf,
        back: '#/diary/day/' + backDate, backLabel: '이 날의 일기',
        editHref: function (id) { return '#/diary/edit/' + id; }
      });
      return;
    }
    const all = await M.db.list('diary');
    if (mode === 'day') return dayView(el, all, sub[1]);
    if (mode === 'list') return listView(el, all);
    return calendar(el, all, sub[1]);
  };

  M.diaryCard = entryCard;
})();

/* ===== js/mods/memories.js ===== */
/* 추억 보관함: 스크랩북 앨범 · 타임라인 · 즐겨찾기 */
(function () {
  const M = window.MMSD;

  const CATS = ['학교 행사', '친구와의 추억', '선생님과의 추억', '공연 및 문화생활', '특별한 날', '개인적인 순간', '자유 추억'];
  const STYLES = ['🎀 리본', '📌 압정', '🧷 클립', '🌼 꽃', '⭐ 별', '💌 편지'];
  const COLORS = ['핑크', '블루', '민트', '레몬', '라벤더', '크림'];
  const COLOR_CLASS = { '핑크': 'c-pink', '블루': 'c-blue', '민트': 'c-mint', '레몬': 'c-lemon', '라벤더': 'c-lav', '크림': 'c-cream' };

  const FIELDS = [
    { t: 'section', label: '📸 추억 기록' },
    { k: 'title', label: '추억 제목', t: 'text', top: 'title', full: true },
    { k: 'category', label: '카테고리', t: 'select', opts: CATS },
    { k: 'date', label: '날짜', t: 'date', top: 'date' },
    { k: 'grade', label: '학년', t: 'grade', top: 'grade' },
    { k: 'place', label: '장소', t: 'text', hint: '지도에 표시하는 기능은 지도 서비스를 정한 뒤에 추가할 수 있어요.' },
    { k: 'photos', label: '대표 사진 · 사진 갤러리 · 동영상 · 티켓 사진', t: 'media', top: 'mediaIds', full: true, hint: '첫 번째 사진이 대표 사진이 돼요.' },
    { k: 'mood', label: '그때의 기분', t: 'choice', opts: M.forms.OPTS.mood, full: true },
    { k: 'highlight', label: '기억에 남는 사건', t: 'textarea', full: true },
    { k: 'review', label: '상세 후기', t: 'textarea', full: true, rows: 6 },
    { t: 'section', label: '👥 함께한 사람 · 연결' },
    { k: 'friends', label: '함께한 친구', t: 'link', of: 'friend', full: true, emptyText: '친구 수첩에 친구를 등록하면 여기서 고를 수 있어요.' },
    { k: 'teachers', label: '함께한 선생님', t: 'link', of: 'teacher', full: true, emptyText: '학교생활 수첩에 선생님을 등록하면 여기서 고를 수 있어요.' },
    { k: 'others', label: '그 밖에 함께한 사람', t: 'text', full: true },
    { k: 'diaries', label: '관련 일기', t: 'link', of: 'diary', full: true, emptyText: '일기를 쓰면 여기서 연결할 수 있어요.' },
    { k: 'tags', label: '태그', t: 'tags', top: 'tags', full: true },
    { t: 'section', label: '🎀 추억 카드 꾸미기' },
    { k: 'cardStyle', label: '카드 장식', t: 'choice', opts: STYLES, full: true },
    { k: 'cardColor', label: '카드 색', t: 'choice', opts: COLORS, full: true },
    { k: 'fav', label: '⭐ 즐겨찾는 추억', t: 'check' },
    { k: 'isCover', label: '📕 이 추억을 앨범 표지로 지정', t: 'check' }
  ];

  const TABS = [['album', '📒 앨범'], ['timeline', '🕰️ 타임라인'], ['fav', '⭐ 즐겨찾기']];

  function memCard(r) {
    const U = M.ui, esc = U.esc, d = r.data;
    const deco = d.cardStyle ? d.cardStyle.split(' ')[0] : '';
    return '<a class="mem card ' + (COLOR_CLASS[d.cardColor] || '') + '" href="#/memories/edit/' + r.id + '">' +
      (deco ? '<span class="mem-deco" aria-hidden="true">' + deco + '</span>' : '') +
      '<div class="mem-photo">' + ((r.mediaIds || [])[0] ? '<img data-media="' + esc(r.mediaIds[0]) + '" alt="">' : '<span aria-hidden="true">📸</span>') + '</div>' +
      '<p class="mem-title">' + (d.fav ? '⭐ ' : '') + esc(r.title || '(제목 없음)') + '</p>' +
      '<p class="mem-meta">' + esc(U.fmtDate(r.date, false)) + (d.category ? ' · ' + esc(d.category) : '') + '</p>' +
      ((r.mediaIds || []).length > 1 ? '<span class="mem-count">🖼️ ' + r.mediaIds.length + '</span>' : '') +
      '</a>';
  }

  function grid(list) { return '<div class="mem-grid">' + list.map(memCard).join('') + '</div>'; }

  async function listView(el, tab) {
    const U = M.ui, esc = U.esc;
    const all = await M.db.list('memory');
    const head = '<div class="sub-bar">' + U.tabs('memories', TABS, tab) + '<a class="btn primary" href="#/memories/new">+ 추억 담기</a></div>';
    if (!all.length) {
      el.innerHTML = head + U.empty('📸', '아직 보관한 추억이 없어요. 오래 간직하고 싶은 특별한 순간을 담아 보세요.', '#/memories/new', '+ 추억 담기');
      return;
    }
    const cover = all.find(function (r) { return r.data.isCover; });
    el.innerHTML = head +
      (tab === 'album' && cover ? '<a class="album-cover card tape" href="#/memories/edit/' + cover.id + '">' +
        '<div class="cover-photo">' + ((cover.mediaIds || [])[0] ? '<img data-media="' + esc(cover.mediaIds[0]) + '" data-variant="full" alt="">' : '<span>📕</span>') + '</div>' +
        '<div class="cover-text"><small>📕 앨범 표지</small><h2>' + esc(cover.title) + '</h2><p>' + esc(U.fmtDate(cover.date)) + '</p></div></a>' : '') +
      '<div class="toolbar card">' +
        '<input type="search" class="inp" id="mq" placeholder="🔍 제목·장소·태그로 찾기" aria-label="추억 검색">' +
        '<select class="inp" id="mc" aria-label="카테고리"><option value="">모든 카테고리</option>' + CATS.map(function (c) { return '<option>' + c + '</option>'; }).join('') + '</select>' +
        '<select class="inp" id="mg" aria-label="학년"><option value="">전체 학년</option><option value="1">1학년</option><option value="2">2학년</option><option value="3">3학년</option></select>' +
      '</div><div id="mres"></div>';
    const q = el.querySelector('#mq'), c = el.querySelector('#mc'), g = el.querySelector('#mg'), res = el.querySelector('#mres');
    function draw() {
      let list = all.filter(function (r) {
        return U.match(r, q.value.trim()) && (!c.value || r.data.category === c.value) && (!g.value || String(r.grade) === g.value) &&
          (tab !== 'fav' || r.data.fav);
      });
      /* 기본 정렬: 날짜순 */
      list = list.sort(function (a, b) { return (a.date || '9') < (b.date || '9') ? -1 : 1; });
      if (!list.length) {
        res.innerHTML = '<p class="empty center">' + (tab === 'fav' ? '즐겨찾는 추억이 없어요. 추억에서 ⭐를 켜 보세요.' : '찾는 추억이 없어요.') + '</p>';
      } else if (tab === 'timeline') {
        const years = {};
        list.forEach(function (r) { const y = (r.date || '날짜 없음').slice(0, 4); (years[y] = years[y] || []).push(r); });
        res.innerHTML = Object.keys(years).sort().map(function (y) {
          return '<h2 class="sec-title">' + esc(y) + (y.length === 4 ? '년' : '') + ' <small>' + years[y].length + '개</small></h2>' +
            M.timelineHTML(years[y].map(function (r) {
              return { date: r.date, icon: r.data.cardStyle ? r.data.cardStyle.split(' ')[0] : '📸', kind: r.data.category || '추억', title: r.title, href: '#/memories/edit/' + r.id };
            }).reverse(), '');
        }).join('');
      } else {
        /* 앨범: 학년별 + 날짜순 */
        res.innerHTML = U.byGrade(list).map(function (gr) {
          return '<h2 class="sec-title">' + U.gradeLabel(gr[0]) + ' <small>' + gr[1].length + '개</small></h2>' + grid(gr[1]);
        }).join('');
      }
      U.hydrate(res);
    }
    [q, c, g].forEach(function (x) { x.addEventListener('input', draw); });
    c.addEventListener('change', draw);
    g.addEventListener('change', draw);
    draw();
  }

  M.mods.memories = async function (el, sub) {
    const mode = sub[0] || 'album';
    if (mode === 'new' || mode === 'edit') {
      let rec = null;
      if (mode === 'edit') {
        rec = await M.db.get(sub[1]);
        if (!rec || rec.trashed) { el.innerHTML = M.ui.empty('🔍', '추억을 찾을 수 없어요.', '#/memories', '앨범으로'); return; }
      } else {
        rec = { type: 'memory', date: M.ui.today(), data: {} };
      }
      await M.forms.editor(el, {
        type: 'memory', fields: FIELDS, rec: rec, back: '#/memories', backLabel: '앨범으로',
        titleOf: function (r) { return r.title || '제목 없는 추억'; },
        editHref: function (id) { return '#/memories/edit/' + id; },
        onSaved: async function (saved) {
          /* 표지는 하나만 */
          if (!saved.data.isCover) return;
          const others = (await M.db.list('memory')).filter(function (r) { return r.id !== saved.id && r.data.isCover; });
          for (const o of others) {
            await M.db.save(Object.assign({}, o, { data: Object.assign({}, o.data, { isCover: false }) }));
          }
        }
      });
      return;
    }
    return listView(el, TABS.some(function (t) { return t[0] === mode; }) ? mode : 'album');
  };
})();

/* ===== js/mods/fandom.js ===== */
/* 덕질노트: HOME · 인물 · 작품 · 공연 관람 · 굿즈 · 음악 · 덕질 일기 · 통계 */
(function () {
  const M = window.MMSD;
  const C = M.coll;
  const BASE = 'fandom';

  const TABS = [['home', '🏠 HOME'], ['persons', '🌟 인물'], ['works', '🎭 작품'], ['shows', '🎫 공연 관람'],
    ['goods', '🛍️ 굿즈'], ['music', '🎵 음악'], ['diary', '💖 덕질 일기'], ['stats', '📊 통계']];
  const FIELDS_OF_WORK = ['뮤지컬', '연극', '영화', '드라마', '음악', '기타'];
  const JOBS = ['뮤지컬 배우', '배우', '가수', '아이돌', '연출가·감독', '작곡가', '기타'];
  const GOODS_CATS = ['포토카드', '티켓', '앨범·OST', '프로그램북', '포스터', '응원봉', '키링·뱃지', '의류', '기타'];
  const GOODS_STATUS = ['소장 중', '위시리스트', '양도·판매함'];

  const themeField = function (label) {
    return { k: 'theme', label: label, t: 'select', opts: C.THEME_NAMES, hint: '이 페이지와 목록 카드가 고른 테마로 보여요. "선택 안 함"이면 덕질노트 테마를 따라가요.' };
  };
  const themeOf = function (r) { return C.themeIdByName(r.data.theme); };
  const has = function (arr, id) { return (arr || []).indexOf(id) >= 0; };
  const stars = function (r) { return r.data.rating ? '<span class="badge soft">' + r.data.rating + '</span>' : ''; };

  /* 재관람 계산: 같은 작품(연결된 작품, 없으면 같은 제목)을 날짜순으로 센 순번 */
  function showKey(p) { return (p.data.work || [])[0] || ('t:' + (p.title || '').replace(/\s+/g, '').toLowerCase()); }
  function rewatchMap(shows) {
    const byKey = {}, nth = {}, total = {};
    shows.slice().sort(function (a, b) { return ((a.date || '') + a.createdAt) < ((b.date || '') + b.createdAt) ? -1 : 1; })
      .forEach(function (p) {
        const k = showKey(p);
        byKey[k] = (byKey[k] || 0) + 1;
        nth[p.id] = byKey[k];
      });
    shows.forEach(function (p) { total[p.id] = byKey[showKey(p)]; });
    return { nth: nth, total: total, byKey: byKey };
  }

  /* ---------------- 각 탭 설정 ---------------- */
  let workCounts = {};
  const CFG = {
    persons: {
      type: 'person', label: '인물', emoji: '🌟', add: '인물 추가', round: true,
      fields: [
        { t: 'section', label: '🌟 인물 정보' },
        { k: 'name', label: '인물 이름', t: 'text', top: 'title' },
        { k: 'job', label: '직업', t: 'select', opts: JOBS },
        { k: 'agency', label: '소속', t: 'text' },
        { k: 'birthday', label: '생일', t: 'date', hint: '생일 카운트다운에 쓰여요.' },
        { k: 'firstLiked', label: '처음 관심을 가진 날짜', t: 'date', hint: '덕질 기념일(N주년)을 알려 줘요.' },
        { k: 'fav', label: '⭐ 최애 · 즐겨찾기', t: 'check' },
        { k: 'reason', label: '좋아하게 된 이유', t: 'textarea', full: true },
        { k: 'intro', label: '인물 소개 및 메모', t: 'textarea', full: true },
        { k: 'photos', label: '프로필 이미지 · 사진 앨범', t: 'media', top: 'mediaIds', full: true, hint: '첫 번째 사진이 프로필 이미지가 돼요.' },
        { k: 'works', label: '연결된 작품', t: 'link', of: 'work', full: true, emptyText: '작품 탭에서 작품을 등록하면 여기서 연결할 수 있어요.' },
        { k: 'tags', label: '태그', t: 'tags', top: 'tags', full: true },
        { t: 'section', label: '🎨 이 인물 페이지 꾸미기' },
        themeField('인물 테마')
      ],
      sub: function (r) { return [r.data.job, r.data.agency].filter(Boolean).join(' · '); },
      badges: function (r) {
        const n = r.data.birthday ? M.ui.daysToBirthday(r.data.birthday) : null;
        return (n != null && n <= 30 ? '<span class="badge hot">🎂 ' + (n === 0 ? '오늘' : 'D-' + n) + '</span>' : '') +
          (r.data.theme ? '<span class="badge soft">🎨 ' + M.ui.esc(r.data.theme) + '</span>' : '');
      },
      filters: [{ key: 'job', label: '모든 직업', opts: JOBS }, { label: '전체', opts: ['⭐ 즐겨찾기만'], test: function (r) { return !!r.data.fav; } }],
      sort: function (a, b) { return (b.data.fav ? 1 : 0) - (a.data.fav ? 1 : 0) || (a.title || '').localeCompare(b.title || '', 'ko'); },
      theme: themeOf,
      extra: personExtra
    },
    works: {
      type: 'work', label: '작품', emoji: '🎭', add: '작품 추가',
      fields: [
        { t: 'section', label: '🎭 작품 정보' },
        { k: 'title', label: '작품 제목', t: 'text', top: 'title', full: true },
        { k: 'field', label: '분야', t: 'select', opts: FIELDS_OF_WORK },
        { k: 'year', label: '제작 연도', t: 'number', unit: '년' },
        { k: 'producer', label: '제작사', t: 'text' },
        { k: 'watchedDate', label: '관람 날짜', t: 'date', hint: '여러 번 봤다면 "공연 관람" 탭에 하나씩 기록하면 횟수가 자동으로 세져요.' },
        { k: 'photos', label: '포스터 및 이미지', t: 'media', top: 'mediaIds', full: true },
        { k: 'castText', label: '출연진', t: 'textarea', full: true },
        { k: 'cast', label: '출연 인물 연결', t: 'link', of: 'person', full: true, emptyText: '인물 탭에서 인물을 등록하면 여기서 연결할 수 있어요.' },
        { k: 'favChar', label: '좋아하는 캐릭터', t: 'text', full: true },
        { k: 'rating', label: '평점', t: 'choice', opts: C.STARS, full: true },
        { k: 'review', label: '감상문', t: 'textarea', full: true, rows: 6 },
        { k: 'fav', label: '⭐ 즐겨찾기', t: 'check' },
        { k: 'tags', label: '태그', t: 'tags', top: 'tags', full: true },
        { t: 'section', label: '🎨 이 작품 페이지 꾸미기' },
        themeField('작품 테마')
      ],
      sub: function (r) { return [r.data.field, r.data.year ? r.data.year + '년' : '', r.data.producer].filter(Boolean).join(' · '); },
      badges: function (r) {
        return stars(r) + (workCounts[r.id] ? '<span class="badge hot">🎫 ' + workCounts[r.id] + '회 관람</span>' : '');
      },
      before: async function () {
        const rw = rewatchMap(await M.db.list('performance'));
        workCounts = rw.byKey;
        return '';
      },
      filters: [{ key: 'field', label: '모든 분야', opts: FIELDS_OF_WORK }, { label: '전체', opts: ['⭐ 즐겨찾기만'], test: function (r) { return !!r.data.fav; } }],
      sort: function (a, b) { return (a.title || '').localeCompare(b.title || '', 'ko'); },
      theme: themeOf,
      extra: workExtra
    },
    shows: {
      type: 'performance', label: '공연 관람', emoji: '🎫', add: '관람 기록 추가',
      fields: [
        { t: 'section', label: '🎫 관람 정보' },
        { k: 'title', label: '공연 제목', t: 'text', top: 'title', full: true },
        { k: 'work', label: '작품 연결 (재관람 횟수 계산에 쓰여요)', t: 'link', of: 'work', full: true, emptyText: '작품을 연결하지 않으면 같은 제목끼리 재관람 횟수를 세요.' },
        { k: 'date', label: '관람 날짜', t: 'date', top: 'date' },
        { k: 'time', label: '관람 시간', t: 'text', ph: '예: 19:30' },
        { k: 'venue', label: '공연장', t: 'text' },
        { k: 'round', label: '관람 회차', t: 'text', ph: '예: 낮공, 막공' },
        { k: 'seat', label: '좌석 및 구역', t: 'text' },
        { k: 'companions', label: '동행인', t: 'text' },
        { k: 'casting', label: '캐스팅', t: 'textarea', full: true },
        { k: 'castLinks', label: '캐스팅 인물 연결', t: 'link', of: 'person', full: true, emptyText: '인물 탭에서 인물을 등록하면 연결할 수 있어요.' },
        { k: 'photos', label: '티켓 사진 · 사진', t: 'media', top: 'mediaIds', full: true },
        { k: 'rating', label: '평점', t: 'choice', opts: C.STARS, full: true },
        { k: 'scenes', label: '기억에 남는 장면', t: 'textarea', full: true },
        { k: 'review', label: '후기', t: 'textarea', full: true, rows: 6 },
        { k: 'tags', label: '태그', t: 'tags', top: 'tags', full: true }
      ],
      newRec: function () { return { date: M.ui.today() }; },
      sub: function (r) { return [M.ui.fmtDate(r.date), r.data.venue, r.data.round].filter(Boolean).join(' · '); },
      sort: function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; },
      custom: function (list, base) {
        return C.cards(Object.assign({}, CFG.shows, {
          badges: function (r) { return stars(r) + (rw.nth[r.id] > 1 ? '<span class="badge hot">🔁 ' + rw.nth[r.id] + '번째 관람</span>' : '<span class="badge soft">첫 관람</span>'); }
        }), base, list);
      },
      before: async function (all) { rw = rewatchMap(all); return ''; },
      extra: showExtra
    },
    goods: {
      type: 'goods', label: '굿즈', emoji: '🛍️', add: '굿즈 추가',
      fields: [
        { k: 'name', label: '굿즈 이름', t: 'text', top: 'title', full: true },
        { k: 'category', label: '종류', t: 'select', opts: GOODS_CATS },
        { k: 'status', label: '소장 여부', t: 'select', opts: GOODS_STATUS },
        { k: 'date', label: '구매 날짜', t: 'date', top: 'date' },
        { k: 'price', label: '가격', t: 'number', unit: '원' },
        { k: 'shop', label: '구매처', t: 'text' },
        { k: 'fav', label: '⭐ 즐겨찾기', t: 'check' },
        { k: 'photos', label: '사진', t: 'media', top: 'mediaIds', full: true },
        { k: 'persons', label: '관련 인물', t: 'link', of: 'person', full: true, emptyText: '인물을 등록하면 연결할 수 있어요.' },
        { k: 'works', label: '관련 작품', t: 'link', of: 'work', full: true, emptyText: '작품을 등록하면 연결할 수 있어요.' },
        { k: 'memo', label: '메모', t: 'textarea', full: true },
        { k: 'tags', label: '태그', t: 'tags', top: 'tags', full: true }
      ],
      sub: function (r) { return [r.data.category, r.data.price ? C.won(r.data.price) : '', r.data.shop].filter(Boolean).join(' · '); },
      badges: function (r) { return r.data.status ? '<span class="badge ' + (r.data.status === '위시리스트' ? 'hot' : 'soft') + '">' + M.ui.esc(r.data.status) + '</span>' : ''; },
      filters: [{ key: 'category', label: '모든 종류', opts: GOODS_CATS }, { key: 'status', label: '소장·위시 전체', opts: GOODS_STATUS }],
      sort: function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; },
      before: function (all) {
        const owned = all.filter(function (g) { return g.data.status !== '위시리스트' && g.data.status !== '양도·판매함'; });
        const wish = all.filter(function (g) { return g.data.status === '위시리스트'; });
        const spent = all.filter(function (g) { return g.data.status !== '위시리스트'; }).reduce(function (s, g) { return s + (Number(g.data.price) || 0); }, 0);
        const count = function (cat) { return owned.filter(function (g) { return g.data.category === cat; }).length; };
        return '<div class="stat-grid card sum-card">' +
          '<div class="stat"><span class="n">' + owned.length + '</span><span class="l">소장품</span></div>' +
          '<div class="stat"><span class="n">' + wish.length + '</span><span class="l">위시리스트</span></div>' +
          '<div class="stat"><span class="n">' + count('포토카드') + '</span><span class="l">포토카드</span></div>' +
          '<div class="stat"><span class="n">' + count('티켓') + '</span><span class="l">티켓</span></div>' +
          '<div class="stat"><span class="n">' + C.won(spent) + '</span><span class="l">총 지출</span></div></div>';
      }
    },
    music: {
      type: 'music', label: '음악', emoji: '🎵', add: '노래 추가',
      fields: [
        { k: 'title', label: '노래 제목', t: 'text', top: 'title', full: true },
        { k: 'kind', label: '구분', t: 'select', opts: ['뮤지컬 넘버', '일반 음악'] },
        { k: 'artist', label: '가수', t: 'text' },
        { k: 'composer', label: '작곡가', t: 'text' },
        { k: 'album', label: '앨범', t: 'text' },
        { k: 'works', label: '관련 작품', t: 'link', of: 'work', full: true, emptyText: '작품을 등록하면 연결할 수 있어요.' },
        { k: 'playlists', label: '플레이리스트', t: 'tags', full: true, hint: '#등교길 #공부할때 처럼 적으면 같은 이름끼리 플레이리스트로 모여요.' },
        { k: 'rating', label: '평점', t: 'choice', opts: C.STARS, full: true },
        { k: 'reason', label: '좋아하는 이유', t: 'textarea', full: true },
        { k: 'memo', label: '메모', t: 'textarea', full: true },
        { k: 'fav', label: '⭐ 즐겨찾기', t: 'check' },
        { k: 'tags', label: '태그', t: 'tags', top: 'tags', full: true }
      ],
      sub: function (r) { return [r.data.kind, r.data.artist, r.data.album].filter(Boolean).join(' · '); },
      badges: function (r) { return stars(r) + (r.data.playlists || []).map(function (p) { return '<span class="badge soft">🎧 ' + M.ui.esc(p) + '</span>'; }).join(''); },
      filters: [{ key: 'kind', label: '뮤지컬 넘버·일반 음악', opts: ['뮤지컬 넘버', '일반 음악'] }],
      sort: function (a, b) { return (a.title || '').localeCompare(b.title || '', 'ko'); },
      before: function (all) {
        const pl = {};
        all.forEach(function (m) { (m.data.playlists || []).forEach(function (p) { (pl[p] = pl[p] || []).push(m); }); });
        const names = Object.keys(pl).sort();
        if (!names.length) return '';
        return '<section class="card tape playlists"><h2 class="sec-title">🎧 플레이리스트</h2>' + names.map(function (n) {
          return '<details><summary><b>' + M.ui.esc(n) + '</b> <small>' + pl[n].length + '곡</small></summary><ol>' +
            pl[n].map(function (m) { return '<li><a href="#/fandom/music/edit/' + m.id + '">' + M.ui.esc(m.title) + (m.data.artist ? ' - ' + M.ui.esc(m.data.artist) : '') + '</a></li>'; }).join('') +
            '</ol></details>';
        }).join('') + '</section>';
      }
    },
    diary: {
      type: 'fandomDiary', label: '덕질 일기', emoji: '💖', add: '덕질 일기 쓰기',
      fields: [
        { k: 'date', label: '날짜', t: 'date', top: 'date' },
        { k: 'title', label: '제목', t: 'text', top: 'title' },
        { k: 'persons', label: '현재 최애 · 관련 인물', t: 'link', of: 'person', full: true, emptyText: '인물을 등록하면 연결할 수 있어요.' },
        { k: 'works', label: '관련 작품', t: 'link', of: 'work', full: true, emptyText: '작품을 등록하면 연결할 수 있어요.' },
        { k: 'mood', label: '기분', t: 'choice', opts: M.forms.OPTS.mood, full: true },
        { k: 'event', label: '덕질 관련 사건', t: 'textarea', full: true },
        { k: 'review', label: '공연 및 작품 감상', t: 'textarea', full: true, rows: 6 },
        { k: 'photos', label: '사진', t: 'media', top: 'mediaIds', full: true },
        { k: 'tags', label: '태그', t: 'tags', top: 'tags', full: true }
      ],
      newRec: function (rest) { return { date: M.ui.today(), data: { persons: rest[0] ? [rest[0]] : [] } }; },
      titleOf: function (r) { return r.title || M.ui.snippet(r.data.event || r.data.review, 24) || '덕질 일기'; },
      sub: function (r) { return [M.ui.fmtDate(r.date), r.data.mood].filter(Boolean).join(' · '); },
      sort: function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; }
    }
  };
  let rw = { nth: {}, total: {}, byKey: {} };

  /* ---------------- 상세 화면 아래 ---------------- */
  function linkList(items, emptyText) {
    if (!items.length) return '<p class="empty">' + emptyText + '</p>';
    return '<ul class="mini-list">' + items.map(function (i) { return '<li><a href="' + i.href + '">' + i.icon + ' ' + M.ui.esc(i.text) + '</a></li>'; }).join('') + '</ul>';
  }
  function gallery(rec) {
    const ids = rec.mediaIds || [];
    if (!ids.length) return '';
    return '<section class="card tape"><h2 class="sec-title">🖼️ 사진첩 <small>' + ids.length + '장</small></h2><div class="gallery">' +
      ids.map(function (id) { return '<div class="g-item"><img data-media="' + M.ui.esc(id) + '" alt=""></div>'; }).join('') + '</div></section>';
  }

  async function personExtra(p) {
    const U = M.ui;
    const [works, shows, diaries, goods] = await Promise.all([M.db.list('work'), M.db.list('performance'), M.db.list('fandomDiary'), M.db.list('goods')]);
    const myWorks = works.filter(function (w) { return has(p.data.works, w.id) || has(w.data.cast, p.id); });
    const myShows = shows.filter(function (s) { return has(s.data.castLinks, p.id); });
    const myDiaries = diaries.filter(function (d) { return has(d.data.persons, p.id); });
    const myGoods = goods.filter(function (g) { return has(g.data.persons, p.id); });
    const bd = p.data.birthday ? U.daysToBirthday(p.data.birthday) : null;
    const fl = U.parse(p.data.firstLiked);
    let anniv = '';
    if (fl) {
      const days = Math.round((U.parse(U.today()) - fl) / 86400000) + 1;
      anniv = '<div class="stat"><span class="n">' + days + '일</span><span class="l">좋아한 지</span></div>';
    }
    return '<section class="card tape-left"><h2 class="sec-title">💗 ' + U.esc(p.title || '인물') + ' 덕질 현황</h2><div class="stat-grid">' +
        (bd != null ? '<div class="stat"><span class="n">' + (bd === 0 ? '🎉 오늘' : 'D-' + bd) + '</span><span class="l">생일까지</span></div>' : '') +
        anniv +
        '<div class="stat"><span class="n">' + myWorks.length + '</span><span class="l">연결된 작품</span></div>' +
        '<div class="stat"><span class="n">' + myShows.length + '</span><span class="l">관람한 공연</span></div>' +
        '<div class="stat"><span class="n">' + myDiaries.length + '</span><span class="l">덕질 일기</span></div>' +
        '<div class="stat"><span class="n">' + myGoods.length + '</span><span class="l">굿즈</span></div>' +
      '</div></section>' +
      gallery(p) +
      '<section class="card"><h2 class="sec-title">🎭 연결된 작품</h2>' +
        linkList(myWorks.map(function (w) { return { href: '#/fandom/works/edit/' + w.id, icon: '🎭', text: w.title }; }), '연결된 작품이 없어요.') +
        '<h2 class="sec-title">🎫 관람한 공연</h2>' +
        linkList(myShows.map(function (s) { return { href: '#/fandom/shows/edit/' + s.id, icon: '🎫', text: U.fmtDate(s.date, false) + ' ' + s.title }; }), '캐스팅에 이 인물을 연결한 관람 기록이 없어요.') +
      '</section>' +
      '<section class="card"><div class="sec-head"><h2 class="sec-title">💖 ' + U.esc(p.title || '') + ' 덕질 일기</h2>' +
        '<a class="btn primary" href="#/fandom/diary/new/' + p.id + '">+ 덕질 일기 쓰기</a></div>' +
        M.timelineHTML(myDiaries.map(function (d) { return { date: d.date, icon: '💖', kind: '덕질 일기', title: d.title, href: '#/fandom/diary/edit/' + d.id }; }), '이 인물과 연결된 덕질 일기가 없어요.') +
      '</section>';
  }

  async function workExtra(w) {
    const U = M.ui;
    const [shows, persons, music, diaries] = await Promise.all([M.db.list('performance'), M.db.list('person'), M.db.list('music'), M.db.list('fandomDiary')]);
    const map = rewatchMap(shows);
    const myShows = shows.filter(function (s) { return has(s.data.work, w.id); }).sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; });
    const cast = persons.filter(function (p) { return has(w.data.cast, p.id) || has(p.data.works, w.id); });
    const songs = music.filter(function (m) { return has(m.data.works, w.id); });
    const dia = diaries.filter(function (d) { return has(d.data.works, w.id); });
    return '<section class="card tape-left"><h2 class="sec-title">🎫 관람 기록 <small>총 ' + myShows.length + '회</small></h2>' +
        linkList(myShows.map(function (s) { return { href: '#/fandom/shows/edit/' + s.id, icon: '🔁 ' + map.nth[s.id] + '회차', text: U.fmtDate(s.date) + (s.data.round ? ' · ' + s.data.round : '') }; }),
          '"공연 관람" 탭에서 이 작품을 연결해 기록하면 관람 횟수가 자동으로 세져요.') +
      '</section>' + gallery(w) +
      '<section class="card"><h2 class="sec-title">🌟 연결된 인물</h2>' +
        linkList(cast.map(function (p) { return { href: '#/fandom/persons/edit/' + p.id, icon: '🌟', text: p.title }; }), '연결된 인물이 없어요.') +
        '<h2 class="sec-title">🎵 관련 음악</h2>' +
        linkList(songs.map(function (m) { return { href: '#/fandom/music/edit/' + m.id, icon: '🎵', text: m.title }; }), '관련 음악이 없어요.') +
        '<h2 class="sec-title">💖 관련 덕질 일기</h2>' +
        linkList(dia.map(function (d) { return { href: '#/fandom/diary/edit/' + d.id, icon: '💖', text: U.fmtDate(d.date, false) + ' ' + d.title }; }), '관련 덕질 일기가 없어요.') +
      '</section>';
  }

  async function showExtra(s) {
    const map = rewatchMap(await M.db.list('performance'));
    return '<section class="card tape-left"><h2 class="sec-title">🔁 재관람 횟수 (자동 계산)</h2><div class="stat-grid">' +
      '<div class="stat"><span class="n">' + (map.nth[s.id] || 1) + '번째</span><span class="l">이번 관람</span></div>' +
      '<div class="stat"><span class="n">' + (map.total[s.id] || 1) + '회</span><span class="l">이 작품 총 관람</span></div></div>' +
      '<p class="fhint">작품을 연결하면 그 작품끼리, 연결하지 않으면 같은 제목끼리 날짜순으로 세요.</p></section>';
  }

  /* ---------------- HOME ---------------- */
  async function homeView(el, head) {
    const U = M.ui, esc = U.esc;
    const [persons, works, shows, goods, diaries, music] = await Promise.all(
      ['person', 'work', 'performance', 'goods', 'fandomDiary', 'music'].map(function (t) { return M.db.list(t); }));
    if (!persons.length && !works.length && !shows.length && !goods.length && !diaries.length && !music.length) {
      el.innerHTML = head + U.empty('💖', '덕질노트가 비어 있어요. 좋아하는 배우나 작품부터 등록해 볼까요?', '#/fandom/persons/new', '+ 인물 등록하기');
      return;
    }
    const recent = function (list, n) { return list.slice().sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; }).slice(0, n); };
    const pcard = function (p) { return C.card(CFG.persons, 'fandom/persons', p); };

    const events = [];
    persons.forEach(function (p) {
      if (U.parse(p.data.birthday)) events.push({ n: U.daysToBirthday(p.data.birthday), text: '🎂 ' + p.title + ' 생일', href: '#/fandom/persons/edit/' + p.id });
      const fl = U.parse(p.data.firstLiked);
      if (fl) {
        const n = U.daysToBirthday(p.data.firstLiked);
        const next = U.parse(U.today());
        next.setDate(next.getDate() + n);
        const years = next.getFullYear() - fl.getFullYear();
        if (years >= 1) events.push({ n: n, text: '💗 ' + p.title + ' 덕질 ' + years + '주년', href: '#/fandom/persons/edit/' + p.id });
      }
    });
    events.sort(function (a, b) { return a.n - b.n; });

    const ym = U.today().slice(0, 7);
    const monthShows = shows.filter(function (s) { return (s.date || '').slice(0, 7) === ym; }).length;
    const monthSpend = goods.filter(function (g) { return (g.date || '').slice(0, 7) === ym && g.data.status !== '위시리스트'; })
      .reduce(function (s, g) { return s + (Number(g.data.price) || 0); }, 0);
    const monthDiary = diaries.filter(function (d) { return (d.date || '').slice(0, 7) === ym; }).length;

    const favs = [].concat(
      works.filter(function (w) { return w.data.fav; }).map(function (w) { return { href: '#/fandom/works/edit/' + w.id, icon: '🎭', text: w.title }; }),
      music.filter(function (m) { return m.data.fav; }).map(function (m) { return { href: '#/fandom/music/edit/' + m.id, icon: '🎵', text: m.title }; }),
      goods.filter(function (g) { return g.data.fav; }).map(function (g) { return { href: '#/fandom/goods/edit/' + g.id, icon: '🛍️', text: g.title }; })
    );

    el.innerHTML = head +
      '<h2 class="sec-title">⭐ 좋아하는 인물</h2>' +
      (persons.some(function (p) { return p.data.fav; }) ? '<div class="item-list">' + persons.filter(function (p) { return p.data.fav; }).map(pcard).join('') + '</div>'
        : '<p class="empty">인물에서 ⭐ 최애를 켜면 여기에 모여요.</p>') +
      '<div class="fandom-grid">' +
        '<section class="card tape"><h2 class="sec-title">📅 이번 달 덕질</h2><div class="stat-grid">' +
          '<div class="stat"><span class="n">' + monthShows + '</span><span class="l">관람</span></div>' +
          '<div class="stat"><span class="n">' + monthDiary + '</span><span class="l">덕질 일기</span></div>' +
          '<div class="stat"><span class="n">' + C.won(monthSpend) + '</span><span class="l">굿즈 지출</span></div></div></section>' +
        '<section class="card tape-left"><h2 class="sec-title">🎂 다가오는 생일 · 기념일</h2>' +
          (events.length ? '<ul class="mini-list">' + events.slice(0, 6).map(function (e) {
            return '<li><a href="' + e.href + '"><b class="dday">' + (e.n === 0 ? '오늘' : 'D-' + e.n) + '</b> ' + esc(e.text) + '</a></li>';
          }).join('') + '</ul>' : '<p class="empty">인물의 생일이나 처음 관심을 가진 날짜를 적으면 알려 줘요.</p>') + '</section>' +
        '<section class="card tape-corner"><h2 class="sec-title">🎫 최근 관람</h2>' +
          linkList(shows.slice(0, 4).map(function (s) { return { href: '#/fandom/shows/edit/' + s.id, icon: '🎫', text: U.fmtDate(s.date, false) + ' ' + s.title }; }), '관람 기록이 없어요.') + '</section>' +
        '<section class="card tape"><h2 class="sec-title">💖 최근 덕질 일기</h2>' +
          linkList(diaries.slice(0, 4).map(function (d) { return { href: '#/fandom/diary/edit/' + d.id, icon: (d.data.mood || '💖').split(' ')[0], text: U.fmtDate(d.date, false) + ' ' + d.title }; }), '덕질 일기가 없어요.') + '</section>' +
        '<section class="card tape-left"><h2 class="sec-title">🆕 최근 등록한 인물 · 작품</h2>' +
          linkList(recent(persons, 3).map(function (p) { return { href: '#/fandom/persons/edit/' + p.id, icon: '🌟', text: p.title }; })
            .concat(recent(works, 3).map(function (w) { return { href: '#/fandom/works/edit/' + w.id, icon: '🎭', text: w.title }; })), '아직 없어요.') + '</section>' +
        '<section class="card tape-corner"><h2 class="sec-title">⭐ 즐겨찾기</h2>' + linkList(favs.slice(0, 8), '즐겨찾기한 작품·음악·굿즈가 없어요.') + '</section>' +
      '</div>';
  }

  /* ---------------- 통계 ---------------- */
  async function statsView(el, head) {
    const U = M.ui, esc = U.esc;
    const [persons, works, shows, goods, diaries, music] = await Promise.all(
      ['person', 'work', 'performance', 'goods', 'fandomDiary', 'music'].map(function (t) { return M.db.list(t); }));
    const map = rewatchMap(shows);
    const workName = {};
    works.forEach(function (w) { workName[w.id] = w.title; });
    const keyLabel = {};
    shows.forEach(function (s) { const k = showKey(s); keyLabel[k] = workName[k] || s.title || '(제목 없음)'; });
    const perWork = Object.keys(map.byKey).map(function (k) { return { label: keyLabel[k], value: map.byKey[k], display: map.byKey[k] + '회' }; })
      .sort(function (a, b) { return b.value - a.value; }).slice(0, 10);

    const interest = persons.map(function (p) {
      const v = works.filter(function (w) { return has(p.data.works, w.id) || has(w.data.cast, p.id); }).length +
        shows.filter(function (s) { return has(s.data.castLinks, p.id); }).length * 2 +
        diaries.filter(function (d) { return has(d.data.persons, p.id); }).length +
        goods.filter(function (g) { return has(g.data.persons, p.id); }).length;
      return { label: p.title || '(이름 없음)', value: v, display: v + '점' };
    }).sort(function (a, b) { return b.value - a.value; }).slice(0, 10);

    const months = C.last12Months();
    const monthShows = months.map(function (m) {
      const n = shows.filter(function (s) { return (s.date || '').slice(0, 7) === m; }).length;
      return { label: m.slice(2).replace('-', '.'), value: n, display: n + '회' };
    });
    const bought = goods.filter(function (g) { return g.data.status !== '위시리스트'; });
    const monthSpend = months.map(function (m) {
      const v = bought.filter(function (g) { return (g.date || '').slice(0, 7) === m; }).reduce(function (s, g) { return s + (Number(g.data.price) || 0); }, 0);
      return { label: m.slice(2).replace('-', '.'), value: v, display: C.won(v) };
    });
    const totalSpend = bought.reduce(function (s, g) { return s + (Number(g.data.price) || 0); }, 0);

    const yearOf = function (r) { return (r.date || r.createdAt || '').slice(0, 4); };
    const years = Array.from(new Set([].concat(shows, diaries, goods, works, persons).map(yearOf).filter(Boolean))).sort();
    const yearRows = years.map(function (y) {
      const c = function (l) { return l.filter(function (r) { return yearOf(r) === y; }).length; };
      return '<tr><th>' + y + '년</th><td>' + c(shows) + '</td><td>' + c(diaries) + '</td><td>' + c(goods) + '</td><td>' + c(works) + '</td><td>' + c(persons) + '</td></tr>';
    }).join('');

    const photos = [];
    [].concat(persons, works, shows, goods, diaries).forEach(function (r) {
      (r.mediaIds || []).forEach(function (id) { photos.push({ id: id, r: r }); });
    });
    const hrefOf = { person: 'persons', work: 'works', performance: 'shows', goods: 'goods', fandomDiary: 'diary' };

    el.innerHTML = head +
      '<div class="stat-grid card sum-card">' +
        '<div class="stat"><span class="n">' + shows.length + '</span><span class="l">전체 공연 관람</span></div>' +
        '<div class="stat"><span class="n">' + shows.filter(function (s) { return (s.date || '').slice(0, 4) === U.today().slice(0, 4); }).length + '</span><span class="l">올해 관람</span></div>' +
        '<div class="stat"><span class="n">' + persons.length + '</span><span class="l">인물</span></div>' +
        '<div class="stat"><span class="n">' + works.length + '</span><span class="l">작품</span></div>' +
        '<div class="stat"><span class="n">' + C.won(totalSpend) + '</span><span class="l">굿즈 총 지출</span></div>' +
      '</div>' +
      '<div class="fandom-grid">' +
        '<section class="card tape"><h2 class="sec-title">🎭 작품별 관람 횟수</h2>' + C.barList(perWork, '', '관람 기록이 없어요.') + '</section>' +
        '<section class="card tape-left"><h2 class="sec-title">🌟 인물별 관심도</h2>' + C.barList(interest, '', '인물과 연결된 기록이 없어요.') +
          '<p class="fhint">연결된 작품·덕질 일기·굿즈는 1점, 캐스팅으로 본 공연은 2점으로 계산해요.</p></section>' +
        '<section class="card tape-corner"><h2 class="sec-title">📅 월별 관람 (최근 12개월)</h2>' + C.barList(monthShows, '', '최근 12개월 관람 기록이 없어요.') + '</section>' +
        '<section class="card tape"><h2 class="sec-title">💸 월별 굿즈 지출 (최근 12개월)</h2>' + C.barList(monthSpend, '', '최근 12개월 굿즈 구매 기록이 없어요.') + '</section>' +
      '</div>' +
      '<section class="card tape-left table-card"><h2 class="sec-title">🗓️ 연간 덕질 활동</h2>' +
        (yearRows ? '<div class="tbl-wrap"><table class="cmp-table"><thead><tr><th></th><th>관람</th><th>덕질 일기</th><th>굿즈</th><th>작품</th><th>인물</th></tr></thead><tbody>' + yearRows + '</tbody></table></div>'
          : '<p class="empty">아직 기록이 없어요.</p>') + '</section>' +
      '<section class="card tape"><h2 class="sec-title">🖼️ 덕질 사진 갤러리 <small>' + photos.length + '장</small></h2>' +
        (photos.length ? '<div class="gallery">' + photos.map(function (p) {
          return '<a class="g-item" href="#/fandom/' + hrefOf[p.r.type] + '/edit/' + p.r.id + '" title="' + esc(p.r.title || '') + '"><img data-media="' + esc(p.id) + '" alt=""></a>';
        }).join('') + '</div>' : '<p class="empty">사진이 있는 덕질 기록이 없어요.</p>') + '</section>';
  }

  M.mods.fandom = async function (el, sub) {
    const tab = TABS.some(function (t) { return t[0] === sub[0]; }) ? sub[0] : 'home';
    const head = '<div class="sub-bar">' + M.ui.tabs(BASE, TABS, tab) + '</div>';
    if (tab === 'home') return homeView(el, head);
    if (tab === 'stats') return statsView(el, head);
    const cfg = CFG[tab];
    if (sub[1] === 'new' || sub[1] === 'edit') return C.editPage(el, BASE + '/' + tab, cfg, sub.slice(1), 'fandom');
    return C.listPage(el, BASE + '/' + tab, head, cfg);
  };
})();

/* ===== js/mods/study.js ===== */
/* 학업 기록: 시험 · 수행평가 · 공부 기록 · 교재 · 과목 관리 · 통계 */
(function () {
  const M = window.MMSD;
  const C = M.coll;
  const BASE = 'study';

  const DEFAULT_SUBJECTS = ['국어', '수학', '영어', '사회', '과학', '역사', '도덕', '기술·가정', '정보', '음악', '미술', '체육', '기타'];
  const TABS = [['exams', '📝 시험'], ['assess', '📋 수행평가'], ['study', '⏱️ 공부 기록'], ['books', '📘 교재'], ['subjects', '📚 과목 관리'], ['stats', '📊 통계']];

  /* ---------- 과목 ---------- */
  async function ensureSubjects() {
    const list = await M.db.list('subject');
    if (list.length) return list;
    /* 처음 열었을 때 기본 과목 13개를 만들어 둠 */
    for (let i = 0; i < DEFAULT_SUBJECTS.length; i++) {
      await M.db.save({ type: 'subject', title: DEFAULT_SUBJECTS[i], data: { order: i + 1, hidden: false } });
    }
    return M.db.list('subject');
  }
  function sortSubjects(list) {
    return list.slice().sort(function (a, b) { return (Number(a.data.order) || 99) - (Number(b.data.order) || 99) || (a.title || '').localeCompare(b.title || '', 'ko'); });
  }
  async function subjectNames() {
    return sortSubjects(await ensureSubjects()).filter(function (s) { return !s.data.hidden && s.title; }).map(function (s) { return s.title; });
  }

  function fmtMin(m) {
    m = Math.round(Number(m) || 0);
    const h = Math.floor(m / 60), r = m % 60;
    return h ? h + '시간' + (r ? ' ' + r + '분' : '') : r + '분';
  }

  /* 시험 평균 (만점이 비어 있으면 100점 기준) */
  function scoresOf(exam) {
    return (exam.data.scores || []).filter(function (s) { return s.subject && s.score !== '' && !isNaN(Number(s.score)); })
      .map(function (s) {
        const max = Number(s.max) || 100;
        return { subject: s.subject, score: Number(s.score), max: max, pct: Number(s.score) / max * 100, rank: s.rank, ach: s.ach, diff: s.diff };
      });
  }
  function avgOf(exam) {
    const s = scoresOf(exam);
    if (!s.length) return null;
    return Math.round(s.reduce(function (a, b) { return a + b.pct; }, 0) / s.length * 10) / 10;
  }

  /* ---------- 탭 설정 ---------- */
  const CFG = {
    exams: {
      type: 'exam', label: '시험', emoji: '📝', add: '시험 기록 추가', noThumb: true,
      fields: async function () {
        const subs = await subjectNames();
        return [
          { k: 'title', label: '시험 이름', t: 'text', top: 'title', full: true, ph: '예: 2학년 1학기 중간고사' },
          { k: 'kind', label: '종류', t: 'select', opts: ['중간고사', '기말고사', '단원평가', '모의고사', '기타'] },
          { k: 'date', label: '시험 날짜', t: 'date', top: 'date' },
          { k: 'grade', label: '학년', t: 'grade', top: 'grade' },
          { k: 'semester', label: '학기', t: 'select', opts: ['1학기', '2학기'] },
          { k: 'scores', label: '과목별 점수 (평균은 자동으로 계산돼요)', t: 'rows', full: true, addLabel: '과목 추가',
            cols: [
              { k: 'subject', label: '과목', t: 'select', opts: subs, w: 2 },
              { k: 'score', label: '점수', t: 'number', w: 1 },
              { k: 'max', label: '만점(100)', t: 'number', w: 1 },
              { k: 'rank', label: '등급', w: 1 },
              { k: 'ach', label: '성취도', t: 'select', opts: ['A', 'B', 'C', 'D', 'E', 'P'], w: 1 },
              { k: 'diff', label: '난이도', t: 'select', opts: ['쉬움', '보통', '어려움'], w: 1 }
            ] },
          { k: 'review', label: '시험 후기', t: 'textarea', full: true, rows: 4 },
          { k: 'nextGoal', label: '다음 시험 목표', t: 'textarea', full: true },
          { k: 'photos', label: '시험지 및 성적표 사진', t: 'media', top: 'mediaIds', full: true }
        ];
      },
      newRec: function () { return { date: M.ui.today() }; },
      sub: function (r) { return [r.grade ? r.grade + '학년' : '', r.data.semester, r.data.kind, M.ui.fmtDate(r.date, false)].filter(Boolean).join(' · '); },
      badges: function (r) {
        const a = avgOf(r);
        return a == null ? '<span class="badge soft">점수 없음</span>' : '<span class="badge hot">평균 ' + a + '점</span><span class="badge soft">' + scoresOf(r).length + '과목</span>';
      },
      filters: [
        { label: '전체 학년', opts: ['1학년', '2학년', '3학년'], test: function (r, v) { return r.grade + '학년' === v; } },
        { key: 'semester', label: '전체 학기', opts: ['1학기', '2학기'] }
      ],
      sort: function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; },
      extra: examExtra
    },
    assess: {
      type: 'assessment', label: '수행평가', emoji: '📋', add: '수행평가 추가', noThumb: true,
      fields: async function () {
        const subs = await subjectNames();
        return [
          { k: 'title', label: '수행평가 이름', t: 'text', top: 'title', full: true },
          { k: 'subject', label: '과목', t: 'select', opts: subs },
          { k: 'grade', label: '학년', t: 'grade', top: 'grade' },
          { k: 'date', label: '마감일', t: 'date', top: 'date' },
          { k: 'submitDate', label: '제출 날짜', t: 'date' },
          { k: 'method', label: '평가 방식', t: 'text', ph: '예: 보고서, 발표, 실기' },
          { k: 'status', label: '진행 상태', t: 'select', opts: ['준비 전', '진행 중', '제출 완료'] },
          { k: 'prep', label: '준비 내용', t: 'textarea', full: true },
          { k: 'score', label: '점수 및 평가', t: 'text', full: true },
          { k: 'files', label: '첨부 파일', t: 'media', top: 'mediaIds', full: true, files: true },
          { k: 'feedback', label: '수행평가 후기', t: 'textarea', full: true },
          { k: 'done', label: '✅ 완료', t: 'check' }
        ];
      },
      sub: function (r) { return [r.data.subject, r.data.method, '마감 ' + (M.ui.fmtDate(r.date, false) || '미정')].filter(Boolean).join(' · '); },
      badges: function (r) {
        if (r.data.done) return '<span class="badge soft">✅ 완료</span>';
        const n = M.ui.daysUntil(r.date);
        return (r.data.status ? '<span class="badge soft">' + M.ui.esc(r.data.status) + '</span>' : '') +
          (n == null ? '' : '<span class="badge ' + (n <= 7 ? 'hot' : 'soft') + '">' + M.ui.dday(n) + '</span>');
      },
      custom: function (list, base) {
        const todo = list.filter(function (r) { return !r.data.done; }).sort(function (a, b) { return (a.date || '9') < (b.date || '9') ? -1 : 1; });
        const done = list.filter(function (r) { return r.data.done; });
        return '<h2 class="sec-title">⏰ 해야 할 수행평가 <small>' + todo.length + '개</small></h2>' +
          (todo.length ? C.cards(CFG.assess, base, todo) : '<p class="empty">남은 수행평가가 없어요. 👏</p>') +
          '<h2 class="sec-title">✅ 완료 <small>' + done.length + '개</small></h2>' +
          (done.length ? '<div class="dim">' + C.cards(CFG.assess, base, done) + '</div>' : '<p class="empty">아직 없어요.</p>');
      }
    },
    study: {
      type: 'studyLog', label: '공부 기록', emoji: '⏱️', add: '공부 기록 추가', noThumb: true,
      fields: async function () {
        const subs = await subjectNames();
        return [
          { k: 'date', label: '날짜', t: 'date', top: 'date' },
          { k: 'subject', label: '과목', t: 'select', opts: subs },
          { k: 'minutes', label: '공부 시간', t: 'number', unit: '분' },
          { k: 'range', label: '공부한 범위', t: 'text' },
          { k: 'goal', label: '오늘의 학습 목표', t: 'text', full: true },
          { k: 'goalDone', label: '🎯 목표 달성', t: 'check' },
          { k: 'books', label: '사용한 교재', t: 'link', of: 'book', full: true, emptyText: '교재 탭에서 문제집·교재를 등록하면 여기서 고를 수 있어요.' },
          { k: 'memo', label: '메모', t: 'textarea', full: true }
        ];
      },
      newRec: function () { return { date: M.ui.today() }; },
      titleOf: function (r) { return (r.data.subject || '공부') + ' ' + fmtMin(r.data.minutes); },
      sub: function (r) { return [M.ui.fmtDate(r.date), r.data.range].filter(Boolean).join(' · '); },
      badges: function (r) { return r.data.goal ? '<span class="badge ' + (r.data.goalDone ? 'soft' : 'hot') + '">🎯 ' + (r.data.goalDone ? '목표 달성' : '목표 진행 중') + '</span>' : ''; },
      sort: function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; },
      before: function (all) {
        const U = M.ui;
        const t = U.parse(U.today());
        const mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7));
        const days = Array.from({ length: 7 }, function (_, i) { const d = new Date(mon); d.setDate(mon.getDate() + i); return U.ymd(d); });
        const week = all.filter(function (r) { return days.indexOf(r.date) >= 0; });
        const total = week.reduce(function (s, r) { return s + (Number(r.data.minutes) || 0); }, 0);
        const ym = U.today().slice(0, 7);
        const monthTotal = all.filter(function (r) { return (r.date || '').slice(0, 7) === ym; }).reduce(function (s, r) { return s + (Number(r.data.minutes) || 0); }, 0);
        return '<section class="card tape week-card"><h2 class="sec-title">📅 이번 주 공부 <small>총 ' + fmtMin(total) + ' · 이번 달 ' + fmtMin(monthTotal) + '</small></h2>' +
          C.barList(days.map(function (d, i) {
            const m = week.filter(function (r) { return r.date === d; }).reduce(function (s, r) { return s + (Number(r.data.minutes) || 0); }, 0);
            return { label: ['월', '화', '수', '목', '금', '토', '일'][i] + (d === U.today() ? ' (오늘)' : ''), value: m, display: fmtMin(m) };
          }), '', '이번 주 공부 기록이 아직 없어요.') + '</section>';
      }
    },
    books: {
      type: 'book', label: '교재', emoji: '📘', add: '교재 추가',
      fields: async function () {
        const subs = await subjectNames();
        return [
          { k: 'title', label: '교재 · 문제집 이름', t: 'text', top: 'title', full: true },
          { k: 'subject', label: '과목', t: 'select', opts: subs },
          { k: 'publisher', label: '출판사', t: 'text' },
          { k: 'status', label: '상태', t: 'select', opts: ['공부 중', '다 풀었어요', '쉬는 중'] },
          { k: 'progress', label: '진도', t: 'text', ph: '예: 3단원까지, 120/300쪽' },
          { k: 'photos', label: '표지 사진', t: 'media', top: 'mediaIds', full: true },
          { k: 'memo', label: '메모', t: 'textarea', full: true }
        ];
      },
      sub: function (r) { return [r.data.subject, r.data.publisher, r.data.progress].filter(Boolean).join(' · '); },
      badges: function (r) { return r.data.status ? '<span class="badge ' + (r.data.status === '공부 중' ? 'hot' : 'soft') + '">' + M.ui.esc(r.data.status) + '</span>' : ''; },
      filters: [{ key: 'status', label: '모든 상태', opts: ['공부 중', '다 풀었어요', '쉬는 중'] }]
    },
    subjects: {
      type: 'subject', label: '과목', emoji: '📚', add: '과목 추가', noThumb: true,
      fields: [
        { k: 'title', label: '과목 이름', t: 'text', top: 'title' },
        { k: 'order', label: '보여줄 순서', t: 'number', hint: '숫자가 작을수록 앞에 나와요.' },
        { k: 'hidden', label: '🙈 과목 고르는 목록에서 숨기기', t: 'check', full: true, hint: '이미 쓴 기록은 그대로 남아요.' },
        { k: 'memo', label: '메모 (선생님, 교과서 등)', t: 'textarea', full: true }
      ],
      newRec: function () { return { data: { order: 50 } }; },
      sort: function (a, b) { return (Number(a.data.order) || 99) - (Number(b.data.order) || 99); },
      sub: function (r) { return r.data.memo ? M.ui.snippet(r.data.memo, 30) : ''; },
      badges: function (r) { return r.data.hidden ? '<span class="badge soft">숨김</span>' : ''; }
    }
  };

  /* ---------- 시험 상세 아래: 평균 · 지난 시험과 비교 ---------- */
  async function examExtra(exam) {
    const U = M.ui, esc = U.esc;
    const s = scoresOf(exam);
    if (!s.length) return '<section class="card tape-left"><h2 class="sec-title">📊 시험 결과</h2><p class="empty">과목별 점수를 적으면 평균이 자동으로 계산돼요.</p></section>';
    const all = (await M.db.list('exam')).filter(function (e) { return e.id !== exam.id && (e.date || '') < (exam.date || ''); })
      .sort(function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; });
    const prev = all[0];
    const prevMap = {};
    if (prev) scoresOf(prev).forEach(function (x) { prevMap[x.subject] = x; });
    const avg = avgOf(exam), pavg = prev ? avgOf(prev) : null;
    const diffBadge = function (d) {
      if (d == null || isNaN(d)) return '';
      d = Math.round(d * 10) / 10;
      return '<span class="badge ' + (d > 0 ? 'hot' : 'soft') + '">' + (d > 0 ? '▲ ' + d : d < 0 ? '▼ ' + (-d) : '±0') + '</span>';
    };
    return '<section class="card tape-left"><h2 class="sec-title">📊 시험 결과</h2><div class="stat-grid">' +
        '<div class="stat"><span class="n">' + avg + '점</span><span class="l">평균 (100점 기준)</span></div>' +
        '<div class="stat"><span class="n">' + Math.round(s.reduce(function (a, b) { return a + b.score; }, 0) * 10) / 10 + '</span><span class="l">총점</span></div>' +
        '<div class="stat"><span class="n">' + s.length + '</span><span class="l">과목 수</span></div>' +
        (pavg != null ? '<div class="stat"><span class="n">' + diffBadge(avg - pavg) + '</span><span class="l">지난 시험 대비</span></div>' : '') +
      '</div>' +
      '<div class="tbl-wrap"><table class="cmp-table"><thead><tr><th>과목</th><th>점수</th><th>등급</th><th>성취도</th><th>난이도</th>' + (prev ? '<th>지난 시험</th>' : '') + '</tr></thead><tbody>' +
        s.map(function (x) {
          const p = prevMap[x.subject];
          return '<tr><th>' + esc(x.subject) + '</th><td>' + x.score + (x.max !== 100 ? ' / ' + x.max : '') + '</td><td>' + esc(x.rank || '-') + '</td><td>' + esc(x.ach || '-') + '</td><td>' + esc(x.diff || '-') + '</td>' +
            (prev ? '<td>' + (p ? p.score + ' ' + diffBadge(x.pct - p.pct) : '-') + '</td>' : '') + '</tr>';
        }).join('') +
      '</tbody></table></div>' +
      (prev ? '<p class="fhint">지난 시험: ' + esc(prev.title || '') + ' (' + esc(U.fmtDate(prev.date, false)) + ')</p>' : '') +
    '</section>';
  }

  /* ---------- 통계 ---------- */
  async function statsView(el, head) {
    const U = M.ui, esc = U.esc;
    const [exams, logs] = await Promise.all([M.db.list('exam'), M.db.list('studyLog')]);
    const bySub = {};
    exams.forEach(function (e) { scoresOf(e).forEach(function (x) { (bySub[x.subject] = bySub[x.subject] || []).push(x.pct); }); });
    const mean = function (a) { return a.length ? Math.round(a.reduce(function (s, v) { return s + v; }, 0) / a.length * 10) / 10 : null; };
    const subjectAvg = Object.keys(bySub).map(function (k) { const v = mean(bySub[k]); return { label: k, value: v, display: v + '점' }; })
      .sort(function (a, b) { return b.value - a.value; });

    const trend = exams.filter(function (e) { return e.date && avgOf(e) != null; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; })
      .map(function (e) { return { date: e.date, v: avgOf(e) }; });

    /* 학년별 비교 */
    const subs = Object.keys(bySub);
    const gradeAvg = function (g, sub) {
      const v = [];
      exams.filter(function (e) { return e.grade === g; }).forEach(function (e) { scoresOf(e).forEach(function (x) { if (x.subject === sub) v.push(x.pct); }); });
      return mean(v);
    };
    const gradeRows = subs.map(function (sub) {
      return '<tr><th>' + esc(sub) + '</th>' + [1, 2, 3].map(function (g) { const v = gradeAvg(g, sub); return '<td>' + (v == null ? '<span class="dim-text">-</span>' : v) + '</td>'; }).join('') + '</tr>';
    }).join('');

    /* 학기별 평균 */
    const semKey = function (e) { return e.grade && e.data.semester ? e.grade + '학년 ' + e.data.semester : null; };
    const sems = {};
    exams.forEach(function (e) { const k = semKey(e), a = avgOf(e); if (k && a != null) (sems[k] = sems[k] || []).push(a); });
    const semList = Object.keys(sems).sort().map(function (k) { const v = mean(sems[k]); return { label: k, value: v, display: v + '점' }; });

    const minBySub = {};
    logs.forEach(function (l) { const k = l.data.subject || '기타'; minBySub[k] = (minBySub[k] || 0) + (Number(l.data.minutes) || 0); });
    const subTime = Object.keys(minBySub).map(function (k) { return { label: k, value: minBySub[k], display: fmtMin(minBySub[k]) }; })
      .sort(function (a, b) { return b.value - a.value; });
    const monthTime = C.last12Months().map(function (m) {
      const v = logs.filter(function (l) { return (l.date || '').slice(0, 7) === m; }).reduce(function (s, l) { return s + (Number(l.data.minutes) || 0); }, 0);
      return { label: m.slice(2).replace('-', '.'), value: v, display: fmtMin(v) };
    });
    const goals = logs.filter(function (l) { return l.data.goal; });
    const done = goals.filter(function (l) { return l.data.goalDone; }).length;
    const rate = goals.length ? Math.round(done / goals.length * 100) : null;
    const total = logs.reduce(function (s, l) { return s + (Number(l.data.minutes) || 0); }, 0);

    el.innerHTML = head +
      '<div class="stat-grid card sum-card">' +
        '<div class="stat"><span class="n">' + exams.length + '</span><span class="l">시험 기록</span></div>' +
        '<div class="stat"><span class="n">' + (mean(trend.map(function (t) { return t.v; })) == null ? '-' : mean(trend.map(function (t) { return t.v; })) + '점') + '</span><span class="l">전체 평균</span></div>' +
        '<div class="stat"><span class="n">' + fmtMin(total) + '</span><span class="l">총 공부 시간</span></div>' +
        '<div class="stat"><span class="n">' + (rate == null ? '-' : rate + '%') + '</span><span class="l">목표 달성률 (' + done + '/' + goals.length + ')</span></div>' +
      '</div>' +
      M.ui.lineChart(trend, '📈 시험 평균 변화', '점') +
      '<div class="fandom-grid">' +
        '<section class="card tape"><h2 class="sec-title">📚 과목별 평균 점수</h2>' + C.barList(subjectAvg, '', '시험 점수를 기록하면 보여요.') + '</section>' +
        '<section class="card tape-left"><h2 class="sec-title">🗓️ 학기별 평균</h2>' + C.barList(semList, '', '학년과 학기를 적은 시험이 있으면 보여요.') + '</section>' +
        '<section class="card tape-corner"><h2 class="sec-title">⏱️ 과목별 공부 시간</h2>' + C.barList(subTime, '', '공부 기록을 남기면 보여요.') + '</section>' +
        '<section class="card tape"><h2 class="sec-title">📅 월별 공부 시간 (최근 12개월)</h2>' + C.barList(monthTime, '', '최근 12개월 공부 기록이 없어요.') + '</section>' +
      '</div>' +
      '<section class="card tape-left table-card"><h2 class="sec-title">🎒 학년별 과목 평균 비교</h2>' +
        (gradeRows ? '<div class="tbl-wrap"><table class="cmp-table"><thead><tr><th>과목</th><th>1학년</th><th>2학년</th><th>3학년</th></tr></thead><tbody>' + gradeRows + '</tbody></table></div>'
          : '<p class="empty">학년을 적은 시험 기록이 있으면 보여요.</p>') +
        '<p class="fhint">점수는 모두 100점 기준으로 바꿔서 평균을 내요.</p></section>';
  }

  M.mods.study = async function (el, sub) {
    const tab = TABS.some(function (t) { return t[0] === sub[0]; }) ? sub[0] : 'exams';
    const head = '<div class="sub-bar">' + M.ui.tabs(BASE, TABS, tab) + '</div>';
    await ensureSubjects();
    if (tab === 'stats') return statsView(el, head);
    const cfg = CFG[tab];
    if (sub[1] === 'new' || sub[1] === 'edit') return C.editPage(el, BASE + '/' + tab, cfg, sub.slice(1), 'study');
    return C.listPage(el, BASE + '/' + tab, head, cfg);
  };

  M.study = { avgOf: avgOf, fmtMin: fmtMin };
})();

/* ===== js/mods/decorate.js ===== */
/* =========================================================
   다이어리 꾸미기: 내 페이지 · 페이지 편집기 · 나만의 스티커 · 테마
   ========================================================= */
(function () {
  const M = window.MMSD;
  const D = M.deco;
  const TABS = [['pages', '📄 내 페이지'], ['stickers', '🧸 나만의 스티커'], ['themes', '🎨 테마']];

  const clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  const uid = function () { return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); };

  /* ---------- 새 페이지 틀 ---------- */
  const TEMPLATES = {
    blank: { name: '빈 페이지', emoji: '📄', data: { bg: 'theme', border: 'none', items: [] } },
    diary: { name: '오늘의 일기', emoji: '📔', data: { bg: 'mintline', border: 'stitch', items: [
      { kind: 'text', text: '오늘의 일기', fs: 54, bold: true, color: '#3f6b5c', x: 70, y: 70, w: 460, h: 80, rot: 0, z: 1 },
      { kind: 'tape', style: 'pink', x: 300, y: 196, w: 200, h: 40, rot: -4, z: 3 },
      { kind: 'memo', style: 'lined', text: '', fs: 26, x: 90, y: 220, w: 620, h: 560, rot: 0, z: 2 },
      { kind: 'sticker', emoji: '⭐', x: 620, y: 60, w: 110, h: 110, rot: 12, z: 4 },
      { kind: 'sticker', emoji: '🌷', x: 70, y: 820, w: 130, h: 130, rot: -8, z: 4 }
    ] } },
    photo: { name: '사진 페이지', emoji: '📸', data: { bg: 'cream', border: 'round', items: [
      { kind: 'memo', style: 'yellow', text: '📷 왼쪽 "사진" 탭에서\n사진이나 콜라주를 넣어 보세요!', fs: 26, x: 200, y: 400, w: 400, h: 200, rot: -3, z: 2 },
      { kind: 'tape', style: 'mint', x: 320, y: 384, w: 160, h: 38, rot: 3, z: 3 },
      { kind: 'sticker', emoji: '✨', x: 600, y: 120, w: 100, h: 100, rot: 0, z: 4 },
      { kind: 'sticker', emoji: '🎀', x: 90, y: 860, w: 120, h: 120, rot: -10, z: 4 }
    ] } },
    fan: { name: '덕질 페이지', emoji: '💖', data: { bg: 'pinkdot', border: 'dashed', items: [
      { kind: 'text', text: 'MY FAVORITE ♡', fs: 60, bold: true, color: '#d6457a', x: 140, y: 80, w: 560, h: 90, rot: -2, z: 2 },
      { kind: 'memo', style: 'pink', text: '최애 이야기', fs: 28, x: 420, y: 640, w: 320, h: 300, rot: 4, z: 2 },
      { kind: 'sticker', emoji: '💖', x: 80, y: 220, w: 120, h: 120, rot: -12, z: 3 },
      { kind: 'sticker', emoji: '🌟', x: 640, y: 210, w: 100, h: 100, rot: 10, z: 3 },
      { kind: 'tape', style: 'rainbow', x: 500, y: 622, w: 180, h: 40, rot: 6, z: 3 }
    ] } }
  };

  function withIds(items) { return (items || []).map(function (it) { return Object.assign(clone(it), { id: uid() }); }); }
  function mediaOf(data) {
    const s = new Set();
    (data.items || []).forEach(function (it) {
      if (it.mediaId) s.add(it.mediaId);
      (it.mediaIds || []).forEach(function (m) { s.add(m); });
    });
    return Array.from(s);
  }

  async function createPage(title, data) {
    const d = Object.assign({ bg: 'theme', border: 'none', items: [] }, clone(data));
    d.items = withIds(d.items);
    return M.db.save({ type: 'page', title: title, date: M.ui.today(), data: d, mediaIds: mediaOf(d) });
  }
  async function copyPage(p) {
    const d = clone(p.data);
    delete d.target;
    d.items = withIds(d.items);
    return M.db.save({ type: 'page', title: (p.title || '꾸민 페이지') + ' (복사)', date: M.ui.today(), data: d, mediaIds: mediaOf(d) });
  }

  /* ---------- 내 페이지 목록 ---------- */
  async function pagesView(el, head) {
    const U = M.ui, esc = U.esc;
    const pages = (await M.db.list('page')).sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; });
    el.innerHTML = head +
      '<section class="card tape new-page"><h2 class="sec-title">✨ 새 페이지 만들기</h2><div class="tpl-row">' +
        Object.keys(TEMPLATES).map(function (k) {
          return '<a class="tpl" href="#/decorate/new/' + k + '"><span aria-hidden="true">' + TEMPLATES[k].emoji + '</span>' + TEMPLATES[k].name + '</a>';
        }).join('') +
      '</div><p class="fhint">인물·작품·추억·일기 같은 기록 화면 위쪽의 "🎀 꾸미기" 버튼을 누르면 그 기록만의 페이지를 꾸밀 수 있어요.</p></section>' +
      (pages.length ? '<div class="page-grid">' + pages.map(function (p) {
        return '<article class="page-card card">' +
          '<a href="#/decorate/edit/' + p.id + '" class="pc-link" aria-label="' + esc(p.title) + ' 열기">' + D.previewHTML(p, 200) + '</a>' +
          '<p class="pc-title">' + esc(p.title || '꾸민 페이지') + '</p>' +
          '<p class="pc-meta">' + esc(U.fmtStamp(p.updatedAt)) + (p.data.target ? ' · 🔗 기록 연결' : '') + '</p>' +
          '<div class="pc-actions"><button type="button" class="btn small" data-copy="' + p.id + '">📄 복사</button>' +
          '<button type="button" class="btn small danger" data-trash="' + p.id + '">🗑️</button></div></article>';
      }).join('') + '</div>' : U.empty('🎀', '아직 꾸민 페이지가 없어요. 위에서 틀을 골라 첫 페이지를 만들어 보세요.', null));
    D.hydratePreviews(el, pages);
    el.addEventListener('click', async function (e) {
      const c = e.target.closest('[data-copy]'), t = e.target.closest('[data-trash]');
      try {
        if (c) {
          const p = pages.find(function (x) { return x.id === c.dataset.copy; });
          await copyPage(p);
          M.toast('페이지를 복사했어요. 복사본을 꾸며 보세요!');
          M.rerender();
        }
        if (t) {
          const id = t.dataset.trash;
          await M.db.trash(id);
          M.toast('휴지통으로 옮겼어요.', false, { label: '되돌리기', fn: async function () { await M.db.restore(id); M.rerender(); } });
          M.rerender();
        }
      } catch (err) { M.toast(M.db.friendly(err).message, true); }
    });
  }

  /* ---------- 나만의 스티커 ---------- */
  async function addMySticker(file) {
    const r = await M.media.addMany([file]);
    if (!r[0].ok) throw r[0].error;
    if (r[0].media.kind !== 'image') throw MMSD.AppError('TYPE', '스티커는 사진(이미지) 파일만 쓸 수 있어요.');
    return M.db.save({ type: 'sticker', title: file.name.replace(/\.[^.]+$/, ''), mediaIds: [r[0].media.id], data: {} });
  }
  async function stickersView(el, head) {
    const esc = M.ui.esc;
    const list = await M.db.list('sticker');
    el.innerHTML = head +
      '<section class="card tape"><h2 class="sec-title">🧸 나만의 스티커</h2>' +
      '<p class="desc">직접 그린 그림이나 사진을 스티커로 등록해요. 배경이 투명한 PNG 파일이면 진짜 스티커처럼 붙어요.</p>' +
      '<label class="btn primary">+ 스티커 등록<input type="file" accept="image/png,image/webp,image/gif,image/jpeg" multiple hidden id="stkIn"></label>' +
      (list.length ? '<div class="my-stickers">' + list.map(function (s) {
        return '<div class="ms-item"><img data-media="' + esc(s.mediaIds[0]) + '" data-variant="full" alt="' + esc(s.title) + '">' +
          '<span>' + esc(s.title) + '</span><button type="button" class="mp-del" data-del="' + s.id + '" aria-label="스티커 삭제">✕</button></div>';
      }).join('') + '</div>' : '<p class="empty">아직 등록한 스티커가 없어요.</p>') + '</section>';
    el.querySelector('#stkIn').addEventListener('change', async function (e) {
      const files = Array.from(e.target.files || []);
      for (const f of files) {
        try { await addMySticker(f); } catch (err) { M.toast(M.db.friendly(err).message, true); }
      }
      M.toast('스티커를 등록했어요 🧸');
      M.rerender();
    });
    el.addEventListener('click', async function (e) {
      const b = e.target.closest('[data-del]');
      if (!b) return;
      const id = b.dataset.del;
      await M.db.trash(id);
      M.toast('스티커를 휴지통으로 옮겼어요.', false, { label: '되돌리기', fn: async function () { await M.db.restore(id); M.rerender(); } });
      M.rerender();
    });
  }

  /* =========================================================
     페이지 편집기
     ========================================================= */
  async function editor(el, id) {
    const U = M.ui, esc = U.esc;
    const rec = await M.db.get(id);
    if (!rec || rec.trashed || rec.type !== 'page') {
      el.innerHTML = U.empty('🔍', '페이지를 찾을 수 없어요. 휴지통으로 옮겨졌을 수 있어요.', '#/decorate', '내 페이지로');
      return;
    }
    const page = rec;
    const data = page.data;
    data.items = data.items || [];
    let sel = null;
    let scale = 1;
    const myStickers = await M.db.list('sticker');
    let target = null;
    if (data.target) {
      target = await M.db.get(data.target.id);
      if (target && target.trashed) target = null;
    }

    el.innerHTML =
      '<div class="deco-bar card">' +
        '<a class="btn small" href="#/decorate">← 내 페이지</a>' +
        '<input class="inp deco-title" id="dTitle" value="' + esc(page.title || '') + '" aria-label="페이지 제목" placeholder="페이지 제목">' +
        (target ? '<a class="btn small" href="' + U.hrefOf(target) + '">🔗 ' + esc(U.snippet(target.title || '연결된 기록', 12)) + '</a>' : '') +
        '<button type="button" class="btn small" id="dPng">🖼️ 이미지로 저장</button>' +
        '<button type="button" class="btn small" id="dCopy">📄 복사</button>' +
        '<button type="button" class="btn small danger" id="dDel">🗑️</button>' +
      '</div>' +
      '<div class="deco-wrap">' +
        '<aside class="deco-panel card" aria-label="꾸미기 재료">' +
          '<div class="dp-tabs" role="tablist">' +
            [['stk', '🐰 스티커'], ['tape', '🎞️ 테이프'], ['memo', '📝 메모지'], ['photo', '📷 사진'], ['text', '🔤 글자'], ['page', '🎨 배경'], ['mine', '🧸 내 스티커']]
              .map(function (t, i) { return '<button type="button" role="tab" data-ptab="' + t[0] + '" aria-selected="' + (i === 0) + '">' + t[1] + '</button>'; }).join('') +
          '</div><div class="dp-body" id="dPanel"></div>' +
        '</aside>' +
        '<div class="deco-main">' +
          '<div class="deco-tools card" id="dTools"></div>' +
          '<div class="deco-outer" id="dOuter"><div class="d-stage-holder" id="dHolder"><div id="dStage" tabindex="0" aria-label="꾸미는 페이지"></div></div></div>' +
        '</div>' +
      '</div>';

    const stage = el.querySelector('#dStage'), holder = el.querySelector('#dHolder'), outer = el.querySelector('#dOuter');
    const tools = el.querySelector('#dTools'), panel = el.querySelector('#dPanel'), titleIn = el.querySelector('#dTitle');
    const els = new Map();

    /* ---- 저장 ---- */
    const saver = M.autosave.create(async function (r) {
      const saved = await M.db.save(r);
      page.updatedAt = saved.updatedAt;
    }, 600);
    function save() {
      saver.schedule(function () {
        return { id: page.id, type: 'page', title: titleIn.value.trim() || '꾸민 페이지', date: page.date, data: clone(data), mediaIds: mediaOf(data) };
      });
    }
    titleIn.addEventListener('input', save);

    /* ---- 크기 맞추기 ---- */
    function fit() {
      scale = Math.min(1, outer.clientWidth / D.W);
      holder.style.transform = 'scale(' + scale + ')';
      outer.style.height = Math.round(D.H * scale) + 'px';
      stage.style.setProperty('--hs', (30 / scale) + 'px');
    }

    /* ---- 그리기 ---- */
    function drawAll() {
      D.renderStage(stage, page);
      stage.id = 'dStage';
      stage.tabIndex = 0;
      els.clear();
      stage.querySelectorAll('.d-item').forEach(function (n) { els.set(n.dataset.id, n); });
      fit();
      if (sel && !getItem(sel)) sel = null;
      markSel();
    }
    function getItem(i) { return data.items.find(function (x) { return x.id === i; }); }
    function redrawItem(it) {
      const n = els.get(it.id);
      if (!n) return drawAll();
      n.innerHTML = D.itemInner(it);
      D.applyGeom(n, it);
      U.hydrate(n);
      if (sel === it.id) addHandles(n);
    }
    function addHandles(n) {
      n.querySelectorAll('.h').forEach(function (h) { h.remove(); });
      n.insertAdjacentHTML('beforeend', '<span class="h h-rot" data-h="rot" title="돌리기">↻</span><span class="h h-size" data-h="size" title="크기">⤡</span>');
    }
    function markSel() {
      els.forEach(function (n, i) {
        n.classList.toggle('sel', i === sel);
        if (i === sel) addHandles(n); else n.querySelectorAll('.h').forEach(function (h) { h.remove(); });
      });
      drawTools();
    }
    function select(i) { sel = i; markSel(); }

    /* ---- 재료 추가 ---- */
    function maxZ() { return data.items.reduce(function (m, it) { return Math.max(m, it.z || 0); }, 0); }
    function viewCenterY() {
      const r = stage.getBoundingClientRect();
      const y = (window.innerHeight / 2 - r.top) / scale;
      return Math.max(160, Math.min(D.H - 160, y));
    }
    function add(it) {
      it.id = uid();
      it.z = maxZ() + 1;
      it.rot = it.rot || 0;
      it.x = Math.round(D.W / 2 - it.w / 2 + (Math.random() * 120 - 60));
      it.y = Math.round(viewCenterY() - it.h / 2 + (Math.random() * 80 - 40));
      data.items.push(it);
      const n = D.makeItemEl(it);
      stage.appendChild(n);
      els.set(it.id, n);
      U.hydrate(n);
      select(it.id);
      save();
    }

    /* ---- 재료 패널 ---- */
    let stkCat = D.STICKERS[0].id;
    function drawPanel(tab) {
      let h = '';
      if (tab === 'stk') {
        h = '<div class="dp-cats">' + D.STICKERS.map(function (c) {
          return '<button type="button" class="chip-btn" data-scat="' + c.id + '" aria-pressed="' + (c.id === stkCat) + '">' + c.name + '</button>';
        }).join('') + '</div><div class="emoji-grid">' + D.find(D.STICKERS, stkCat).list.map(function (e) {
          return '<button type="button" data-emoji="' + e + '" aria-label="' + e + ' 스티커 붙이기">' + e + '</button>';
        }).join('') + '</div>';
      }
      if (tab === 'tape') {
        h = '<div class="mat-grid">' + D.TAPES.map(function (t) {
          return '<button type="button" class="mat" data-tape="' + t.id + '"><span class="mat-tape" style="background:' + D.tapeCSS(t) + '"></span>' + t.name + '</button>';
        }).join('') + '</div>';
      }
      if (tab === 'memo') {
        h = '<div class="mat-grid">' + D.MEMOS.map(function (m) {
          return '<button type="button" class="mat" data-memo="' + m.id + '"><span class="mat-memo" style="' + D.memoCSS(m) + '"></span>' + m.name + '</button>';
        }).join('') + '</div>';
      }
      if (tab === 'photo') {
        h = '<label class="btn primary block">📷 사진 넣기<input type="file" accept="image/*" multiple hidden id="dPhotoIn"></label>' +
          '<label class="btn block">🧩 콜라주 만들기 (2~6장)<input type="file" accept="image/*" multiple hidden id="dCollageIn"></label>' +
          '<p class="fhint">사진을 넣은 뒤 아래 도구에서 사진 틀, 확대, 위치(자르기)를 바꿀 수 있어요.</p>' +
          '<div class="frame-row">' + D.FRAMES.map(function (f) { return '<span class="frame-chip fr-demo fr-' + f[0] + '">' + f[1] + '</span>'; }).join('') + '</div>';
      }
      if (tab === 'text') {
        h = '<button type="button" class="btn primary block" data-addtext="title">✏️ 큰 제목 넣기</button>' +
          '<button type="button" class="btn block" data-addtext="body">🔤 글자 넣기</button>' +
          '<p class="fhint">글자를 넣은 뒤 아래 도구에서 내용, 크기, 색을 바꿀 수 있어요.</p>';
      }
      if (tab === 'page') {
        h = '<h3 class="dp-h">배경 · 종이 질감</h3><div class="mat-grid">' + D.BGS.map(function (b) {
          const pat = b.p ? D.patternCSS(b.p, b.pc) : null;
          const st = b.id === 'theme' ? 'background:var(--bg);background-image:var(--pattern);background-size:var(--pattern-size)' :
            'background-color:' + b.c + ';' + (pat ? 'background-image:' + pat.img + ';background-size:' + pat.size : '');
          return '<button type="button" class="mat" data-bg="' + b.id + '" aria-pressed="' + ((data.bg || 'theme') === b.id) + '"><span class="mat-bg" style="' + st + '"></span>' + b.name + '</button>';
        }).join('') + '</div>' +
        '<h3 class="dp-h">테두리</h3><div class="choice">' + D.BORDERS.map(function (b) {
          return '<button type="button" class="chip-btn" data-border="' + b[0] + '" aria-pressed="' + ((data.border || 'none') === b[0]) + '">' + b[1] + '</button>';
        }).join('') + '</div>' +
        '<h3 class="dp-h">페이지 테마 (배경이 "테마 따라가기"일 때)</h3><select class="inp" id="dTheme"><option value="">메뉴 테마 따르기</option>' +
          M.themes.list.map(function (t) { return '<option value="' + t.id + '"' + (data.themeId === t.id ? ' selected' : '') + '>' + t.emoji + ' ' + t.name + '</option>'; }).join('') + '</select>';
      }
      if (tab === 'mine') {
        h = '<label class="btn primary block">+ 나만의 스티커 등록<input type="file" accept="image/png,image/webp,image/gif,image/jpeg" hidden id="dMyIn"></label>' +
          (myStickers.length ? '<div class="emoji-grid mine">' + myStickers.map(function (s) {
            return '<button type="button" data-mys="' + esc(s.mediaIds[0]) + '" aria-label="' + esc(s.title) + ' 붙이기"><img data-media="' + esc(s.mediaIds[0]) + '" data-variant="full" alt=""></button>';
          }).join('') + '</div>' : '<p class="empty">등록한 스티커가 없어요. 배경이 투명한 PNG 그림을 올려 보세요.</p>');
      }
      panel.innerHTML = h;
      U.hydrate(panel);
    }
    let curTab = 'stk';
    drawPanel(curTab);
    el.querySelector('.dp-tabs').addEventListener('click', function (e) {
      const b = e.target.closest('[data-ptab]');
      if (!b) return;
      curTab = b.dataset.ptab;
      el.querySelectorAll('[data-ptab]').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
      drawPanel(curTab);
    });

    async function photosFrom(files) {
      const res = await M.media.addMany(Array.from(files));
      const ok = [];
      res.forEach(function (r) {
        if (!r.ok) M.toast(r.error.message, true);
        else if (r.media.kind !== 'image') M.toast('"' + r.file.name + '"은(는) 사진이 아니라서 넣을 수 없어요.', true);
        else ok.push(r.media);
      });
      return ok;
    }

    panel.addEventListener('click', function (e) {
      const t = e.target;
      const sc = t.closest('[data-scat]');
      if (sc) { stkCat = sc.dataset.scat; drawPanel('stk'); return; }
      const em = t.closest('[data-emoji]');
      if (em) return add({ kind: 'sticker', emoji: em.dataset.emoji, w: 120, h: 120 });
      const tp = t.closest('[data-tape]');
      if (tp) return add({ kind: 'tape', style: tp.dataset.tape, w: 220, h: 44, rot: Math.round(Math.random() * 16 - 8) });
      const mm = t.closest('[data-memo]');
      if (mm) return add({ kind: 'memo', style: mm.dataset.memo, text: '', fs: 26, w: 320, h: 300, rot: Math.round(Math.random() * 6 - 3) });
      const tx = t.closest('[data-addtext]');
      if (tx) {
        const big = tx.dataset.addtext === 'title';
        return add({ kind: 'text', text: big ? '제목을 적어요' : '글자를 적어요', fs: big ? 56 : 32, bold: big, color: '#4a3540', w: big ? 520 : 400, h: big ? 80 : 120 });
      }
      const my = t.closest('[data-mys]');
      if (my) return add({ kind: 'sticker', mediaId: my.dataset.mys, w: 160, h: 160 });
      const bg = t.closest('[data-bg]');
      if (bg) { data.bg = bg.dataset.bg; drawAll(); drawPanel('page'); save(); return; }
      const bd = t.closest('[data-border]');
      if (bd) { data.border = bd.dataset.border; drawAll(); drawPanel('page'); save(); }
    });
    panel.addEventListener('change', async function (e) {
      const t = e.target;
      if (t.id === 'dTheme') { data.themeId = t.value || null; drawAll(); save(); return; }
      if (t.id === 'dPhotoIn') {
        const ms = await photosFrom(t.files);
        ms.forEach(function (m) {
          const ratio = m.width && m.height ? m.height / m.width : 1;
          const w = 340;
          add({ kind: 'photo', mediaId: m.id, frame: 'polaroid', zoom: 1, cx: 50, cy: 50, w: w, h: Math.round(w * Math.min(1.5, Math.max(0.6, ratio)) + 50), rot: Math.round(Math.random() * 8 - 4) });
        });
        t.value = '';
      }
      if (t.id === 'dCollageIn') {
        const ms = await photosFrom(t.files);
        if (ms.length < 2) { if (ms.length) M.toast('콜라주는 사진을 2장 이상 골라 주세요.', true); t.value = ''; return; }
        if (ms.length > 6) M.toast('콜라주에는 처음 6장만 들어가요.');
        add({ kind: 'collage', mediaIds: ms.slice(0, 6).map(function (m) { return m.id; }), w: 560, h: ms.length >= 5 ? 400 : 440 });
        t.value = '';
      }
      if (t.id === 'dMyIn' && t.files[0]) {
        try {
          const s = await addMySticker(t.files[0]);
          myStickers.unshift(s);
          drawPanel('mine');
          add({ kind: 'sticker', mediaId: s.mediaIds[0], w: 160, h: 160 });
        } catch (err) { M.toast(M.db.friendly(err).message, true); }
        t.value = '';
      }
    });

    /* ---- 선택한 재료 도구 ---- */
    function range(p, label, min, max, step, v) {
      return '<label class="tool"><span>' + label + '</span><input type="range" data-p="' + p + '" min="' + min + '" max="' + max + '" step="' + (step || 1) + '" value="' + v + '"></label>';
    }
    function drawTools() {
      const it = sel ? getItem(sel) : null;
      if (!it) {
        tools.innerHTML = '<p class="tools-hint">👆 재료를 눌러 고르면 여기서 크기·회전·순서를 바꿀 수 있어요. 끌어서 옮기고, 모서리 ⤡로 크기, ↻로 돌려요.</p>';
        return;
      }
      let h = '<div class="tool-row">' +
        range('size', '크기', 24, 800, 1, Math.round(it.w)) +
        range('rot', '회전', -180, 180, 1, Math.round(it.rot || 0)) +
        '<div class="tool-btns">' +
          '<button type="button" class="btn small" data-act="up" title="앞으로">⬆️ 앞으로</button>' +
          '<button type="button" class="btn small" data-act="down" title="뒤로">⬇️ 뒤로</button>' +
          '<button type="button" class="btn small" data-act="dup">📑 복제</button>' +
          '<button type="button" class="btn small danger" data-act="del">🗑️ 빼기</button>' +
        '</div></div>';
      if (it.kind === 'photo' || it.kind === 'collage') {
        if (it.kind === 'photo') {
          h += '<div class="tool-row"><label class="tool"><span>사진 틀</span><select class="inp" data-p="frame">' +
            D.FRAMES.map(function (f) { return '<option value="' + f[0] + '"' + ((it.frame || 'none') === f[0] ? ' selected' : '') + '>' + f[1] + '</option>'; }).join('') + '</select></label>' +
            range('zoom', '확대 (자르기)', 1, 3, 0.05, it.zoom || 1) +
            range('cx', '가로 위치', 0, 100, 1, it.cx == null ? 50 : it.cx) +
            range('cy', '세로 위치', 0, 100, 1, it.cy == null ? 50 : it.cy) + '</div>';
        }
      }
      if (it.kind === 'tape') {
        h += '<div class="tool-row"><label class="tool"><span>테이프 무늬</span><select class="inp" data-p="style">' +
          D.TAPES.map(function (t) { return '<option value="' + t.id + '"' + (it.style === t.id ? ' selected' : '') + '>' + t.name + '</option>'; }).join('') + '</select></label>' +
          range('h', '두께', 16, 120, 1, it.h) + '</div>';
      }
      if (it.kind === 'memo') {
        h += '<div class="tool-row"><label class="tool"><span>메모지</span><select class="inp" data-p="style">' +
          D.MEMOS.map(function (m) { return '<option value="' + m.id + '"' + (it.style === m.id ? ' selected' : '') + '>' + m.name + '</option>'; }).join('') + '</select></label>' +
          range('fs', '글자 크기', 14, 60, 1, it.fs || 26) + range('h', '높이', 60, 1000, 1, it.h) + '</div>' +
          '<label class="tool wide"><span>메모 내용</span><textarea class="inp" rows="3" data-p="text">' + esc(it.text || '') + '</textarea></label>';
      }
      if (it.kind === 'text') {
        h += '<div class="tool-row">' + range('fs', '글자 크기', 14, 120, 1, it.fs || 40) +
          '<label class="tool"><span>색</span><input type="color" data-p="color" value="' + esc(it.color || '#4a3540') + '"></label>' +
          '<label class="switch"><input type="checkbox" data-p="bold"' + (it.bold ? ' checked' : '') + '><span>굵게</span></label></div>' +
          '<label class="tool wide"><span>글자 내용</span><textarea class="inp" rows="2" data-p="text">' + esc(it.text || '') + '</textarea></label>';
      }
      tools.innerHTML = h;
    }
    function onTool(e) {
      const it = sel ? getItem(sel) : null;
      const t = e.target;
      if (!it || !t.dataset.p) return;
      const p = t.dataset.p;
      const v = t.type === 'checkbox' ? t.checked : t.value;
      if (p === 'size') {
        const ratio = it.h / it.w;
        const nw = Number(v);
        const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
        it.w = nw;
        if (it.kind !== 'tape' && it.kind !== 'memo' && it.kind !== 'text') it.h = Math.round(nw * ratio);
        it.x = Math.round(cx - it.w / 2);
        it.y = Math.round(cy - it.h / 2);
      } else if (['rot', 'zoom', 'cx', 'cy', 'fs', 'h'].indexOf(p) >= 0) {
        it[p] = Number(v);
      } else {
        it[p] = v;
      }
      redrawItem(it);
      save();
    }
    tools.addEventListener('input', onTool);
    tools.addEventListener('change', onTool);
    tools.addEventListener('click', function (e) {
      const b = e.target.closest('[data-act]');
      const it = sel ? getItem(sel) : null;
      if (!b || !it) return;
      const act = b.dataset.act;
      if (act === 'up') { it.z = maxZ() + 1; redrawItem(it); }
      if (act === 'down') {
        const minZ = data.items.reduce(function (m, x) { return Math.min(m, x.z || 0); }, 1);
        it.z = minZ - 1; redrawItem(it);
      }
      if (act === 'dup') {
        const c = clone(it);
        c.x += 30; c.y += 30;
        delete c.id;
        const keepX = c.x, keepY = c.y;
        add(c);
        c.x = keepX; c.y = keepY;
        redrawItem(c);
      }
      if (act === 'del') {
        data.items = data.items.filter(function (x) { return x.id !== it.id; });
        const n = els.get(it.id);
        if (n) n.remove();
        els.delete(it.id);
        select(null);
      }
      save();
    });

    /* ---- 끌기 · 크기 · 회전 (마우스·터치 공통) ---- */
    let drag = null;
    function local(e) {
      const r = stage.getBoundingClientRect();
      return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
    }
    stage.addEventListener('pointerdown', function (e) {
      const itEl = e.target.closest('.d-item');
      if (!itEl) { select(null); return; }
      const it = getItem(itEl.dataset.id);
      if (!it) return;
      if (sel !== it.id) select(it.id);
      e.preventDefault();
      stage.focus({ preventScroll: true });
      try { stage.setPointerCapture(e.pointerId); } catch (_) { /* 무시 */ }
      const h = e.target.closest('[data-h]');
      drag = { mode: h ? h.dataset.h : 'move', start: local(e), o: { x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot || 0 }, it: it, moved: false };
    });
    stage.addEventListener('pointermove', function (e) {
      if (!drag) return;
      const p = local(e), it = drag.it, o = drag.o;
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
      if (drag.mode === 'move') {
        it.x = Math.round(Math.max(-o.w + 30, Math.min(D.W - 30, o.x + dx)));
        it.y = Math.round(Math.max(-o.h + 30, Math.min(D.H - 30, o.y + dy)));
      } else if (drag.mode === 'size') {
        if (it.kind === 'tape' || it.kind === 'memo' || it.kind === 'text') {
          it.w = Math.round(Math.max(40, o.w + dx));
          it.h = Math.round(Math.max(20, o.h + dy));
        } else {
          const nw = Math.max(24, o.w + Math.max(dx, dy * o.w / o.h));
          it.w = Math.round(nw);
          it.h = Math.round(nw * o.h / o.w);
        }
      } else if (drag.mode === 'rot') {
        const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
        let a = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI + 90;
        if (a > 180) a -= 360;
        if (!e.shiftKey) { const snap = Math.round(a / 45) * 45; if (Math.abs(a - snap) < 4) a = snap; }
        it.rot = Math.round(a);
      }
      const n = els.get(it.id);
      if (n) D.applyGeom(n, it);
    });
    function endDrag() {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (moved) { drawTools(); save(); }
    }
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    /* 키보드: 화살표로 옮기기, Delete로 빼기 */
    stage.addEventListener('keydown', function (e) {
      const it = sel ? getItem(sel) : null;
      if (!it) return;
      const step = e.shiftKey ? 10 : 2;
      const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (mv) { e.preventDefault(); it.x += mv[0]; it.y += mv[1]; D.applyGeom(els.get(it.id), it); save(); }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        tools.querySelector('[data-act="del"]').click();
      }
      if (e.key === 'Escape') select(null);
    });

    /* ---- 위쪽 버튼 ---- */
    el.querySelector('#dPng').addEventListener('click', async function (e) {
      const b = e.currentTarget;
      b.disabled = true;
      b.textContent = '⏳ 만드는 중…';
      try {
        page.title = titleIn.value.trim() || '꾸민 페이지';
        await D.downloadPNG(page, stage);
        M.toast('이미지를 저장했어요 🖼️ ' + M.savedWhere());
      } catch (err) {
        M.toast('이미지로 저장하지 못했어요: ' + M.db.friendly(err).message, true);
      }
      b.disabled = false;
      b.textContent = '🖼️ 이미지로 저장';
    });
    el.querySelector('#dCopy').addEventListener('click', async function () {
      try {
        await saver.flush();
        const c = await copyPage(Object.assign({}, page, { title: titleIn.value.trim() || page.title, data: data }));
        M.toast('복사본을 만들었어요. 복사본을 열었어요.');
        location.hash = '#/decorate/edit/' + c.id;
      } catch (err) { M.toast(M.db.friendly(err).message, true); }
    });
    el.querySelector('#dDel').addEventListener('click', async function () {
      try {
        await saver.flush();
        await M.db.trash(page.id);
        M.toast('휴지통으로 옮겼어요.', false, { label: '되돌리기', fn: async function () { await M.db.restore(page.id); M.rerender(); } });
        location.hash = '#/decorate';
      } catch (err) { M.toast(M.db.friendly(err).message, true); }
    });

    drawAll();
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(function () { if (!outer.isConnected) { ro.disconnect(); return; } fit(); });
      ro.observe(outer);
    } else {
      window.addEventListener('resize', fit);
    }
  }

  /* ---------- 기록 연결 페이지 (#/decorate/for/<기록 id>) ---------- */
  async function forTarget(el, id) {
    const rec = await M.db.get(id);
    if (!rec || rec.trashed) { el.innerHTML = M.ui.empty('🔍', '기록을 찾을 수 없어요.', '#/decorate', '내 페이지로'); return; }
    const pages = await M.db.list('page');
    let p = pages.find(function (x) { return x.data.target && x.data.target.id === id; });
    if (!p) {
      const themeId = (rec.type === 'person' || rec.type === 'work') ? M.coll.themeIdByName(rec.data.theme) : null;
      p = await createPage((rec.title || '기록') + ' 꾸미기', {
        bg: 'theme', border: 'dashed', themeId: themeId, target: { type: rec.type, id: rec.id },
        items: [{ kind: 'text', text: rec.title || '', fs: 56, bold: true, color: '#4a3540', x: 80, y: 70, w: 640, h: 90, rot: 0, z: 1 }]
      });
    }
    M.replaceHash('#/decorate/edit/' + p.id);
    return editor(el, p.id);
  }

  M.mods.decorate = async function (el, sub) {
    const mode = sub[0] || 'pages';
    if (mode === 'edit') return editor(el, sub[1]);
    if (mode === 'for') return forTarget(el, sub[1]);
    if (mode === 'new') {
      const t = TEMPLATES[sub[1]] || TEMPLATES.blank;
      const p = await createPage(t.name === '빈 페이지' ? '새 페이지' : t.name, t.data);
      M.replaceHash('#/decorate/edit/' + p.id);
      return editor(el, p.id);
    }
    const tab = TABS.some(function (t) { return t[0] === mode; }) ? mode : 'pages';
    const head = '<div class="sub-bar">' + M.ui.tabs('decorate', TABS, tab) + '</div>';
    if (tab === 'stickers') return stickersView(el, head);
    if (tab === 'themes') {
      el.innerHTML = head + M.pages.settings(true);
      M.bindSettings();
      return;
    }
    return pagesView(el, head);
  };
})();

/* ===== js/mods/system.js ===== */
/* =========================================================
   통합 검색 · 설정 및 데이터 관리 (화면 · 백업 · 인쇄 · 포토북 · 휴지통 · 계정 · 저장 공간)
   ========================================================= */
(function () {
  const M = window.MMSD;

  /* 기록 종류 이름 (검색 카테고리) */
  const TYPE_INFO = {
    diary: ['📔', '일기'], friend: ['👭', '친구'], friendMemory: ['💭', '친구와의 추억'], teacher: ['👩‍🏫', '선생님'], club: ['🎨', '동아리'],
    performance: ['🎫', '공연'], person: ['🌟', '배우·인물'], work: ['🎭', '작품'], goods: ['🛍️', '굿즈'], memory: ['📸', '추억'],
    exam: ['📝', '시험'], assessment: ['📋', '수행평가'], studyLog: ['⏱️', '공부 기록'],
    profile: ['🙋', '프로필'], growth: ['🌱', '성장 기록'], classInfo: ['🏫', '반 정보'], timetable: ['🗓️', '시간표'],
    schoolEvent: ['🎉', '학교 행사'], schedule: ['📌', '일정'], award: ['🏆', '상장'], letter: ['💌', '편지'],
    music: ['🎵', '음악'], fandomDiary: ['💖', '덕질 일기'], book: ['📘', '교재'], subject: ['📚', '과목'],
    page: ['🎀', '꾸민 페이지'], sticker: ['🧸', '나만의 스티커']
  };
  const SEARCH_CATS = ['diary', 'friend', 'friendMemory', 'teacher', 'club', 'performance', 'person', 'work', 'goods', 'memory', 'exam', 'assessment', 'studyLog',
    'profile', 'growth', 'classInfo', 'timetable', 'schoolEvent', 'schedule', 'award', 'letter', 'music', 'fandomDiary', 'book', 'page'];
  function typeLabel(t) { const i = TYPE_INFO[t]; return i ? i[0] + ' ' + i[1] : t; }

  async function allRecords() {
    return M.db._run(['records'], 'readonly', function (t) { return M.db._reqP(t.objectStore('records').getAll()); });
  }

  /* ---------- 검색용 글자 모으기 ---------- */
  const SKIP = { theme: 1, cardStyle: 1, cardColor: 1, avatar: 1, items: 1, target: 1, order: 1, hidden: 1 };
  function flatten(v, names, out, people) {
    if (v == null || v === '' || v === false) return;
    if (Array.isArray(v)) { v.forEach(function (x) { flatten(x, names, out, people); }); return; }
    if (typeof v === 'object') { Object.keys(v).forEach(function (k) { if (!SKIP[k]) flatten(v[k], names, out, people); }); return; }
    const s = String(v);
    if (names[s]) { people.push(names[s]); return; }   /* 연결된 기록 id → 이름 */
    if (v === true) return;
    out.push(s);
  }
  function indexOf(rec, names) {
    const content = [], people = [];
    Object.keys(rec.data || {}).forEach(function (k) { if (!SKIP[k]) flatten(rec.data[k], names, content, people); });
    if (rec.type === 'page') (rec.data.items || []).forEach(function (it) { if (it.text) content.push(it.text); });
    return {
      title: rec.title || '',
      content: content.join(' · '),
      people: people.join(' · '),
      tags: (rec.tags || []).join(' '),
      date: rec.date || ''
    };
  }

  function hl(text, q) {
    const esc = M.ui.esc;
    if (!q) return esc(text);
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }
  function around(text, q, n) {
    if (!text) return '';
    const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (i < 0) return M.ui.snippet(text, n * 2);
    const s = Math.max(0, i - n);
    return (s > 0 ? '…' : '') + text.slice(s, i + q.length + n) + (i + q.length + n < text.length ? '…' : '');
  }

  /* ---------- 통합 검색 화면 ---------- */
  M.mods.search = async function (el, sub) {
    const U = M.ui, esc = U.esc;
    const all = (await allRecords()).filter(function (r) { return !r.trashed && TYPE_INFO[r.type] && r.type !== 'sticker'; });
    const names = {};
    all.forEach(function (r) { if (r.title) names[r.id] = r.title; });
    const idx = new Map();
    all.forEach(function (r) { idx.set(r.id, indexOf(r, names)); });
    const tags = Array.from(new Set(all.reduce(function (a, r) { return a.concat(r.tags || []); }, []))).sort();
    const q0 = sub[0] ? decodeURIComponent(sub[0]) : '';

    el.innerHTML =
      '<form class="card tape search-form" id="sForm" role="search">' +
        '<div class="search-main"><input class="inp" type="search" id="sQ" value="' + esc(q0) + '" placeholder="찾고 싶은 말을 적어 보세요" aria-label="검색어">' +
        '<select class="inp" id="sIn" aria-label="검색 조건"><option value="all">전체에서</option><option value="title">제목</option><option value="content">내용</option>' +
          '<option value="people">인물 (연결된 친구·선생님·배우)</option><option value="tags">태그</option><option value="date">날짜 (예: 2026-05)</option></select></div>' +
        '<div class="search-filters">' +
          '<select class="inp" id="sCat" aria-label="카테고리"><option value="">모든 카테고리</option>' +
            SEARCH_CATS.map(function (t) { return '<option value="' + t + '">' + typeLabel(t) + '</option>'; }).join('') + '</select>' +
          '<select class="inp" id="sGrade" aria-label="학년"><option value="">모든 학년</option><option value="1">1학년</option><option value="2">2학년</option><option value="3">3학년</option></select>' +
          '<select class="inp" id="sTag" aria-label="태그"><option value="">모든 태그</option>' + tags.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('') + '</select>' +
          '<label class="date-range"><span>기간</span><input class="inp" type="date" id="sFrom" aria-label="시작 날짜"> ~ <input class="inp" type="date" id="sTo" aria-label="끝 날짜"></label>' +
        '</div></form>' +
      '<div id="sRes" aria-live="polite"></div>';

    const $ = function (id) { return el.querySelector('#' + id); };
    const qIn = $('sQ'), res = $('sRes');
    let timer = null;

    function run() {
      const q = qIn.value.trim();
      const where = $('sIn').value, cat = $('sCat').value, g = $('sGrade').value, tag = $('sTag').value, from = $('sFrom').value, to = $('sTo').value;
      M.replaceHash('#/search/' + encodeURIComponent(q));
      const anyFilter = cat || g || tag || from || to;
      if (!q && !anyFilter) {
        res.innerHTML = '<p class="empty center">검색어를 적거나 카테고리·학년·태그·기간을 골라 보세요. 일기, 친구, 선생님, 동아리, 공연, 배우, 작품, 굿즈, 추억, 시험, 수행평가, 공부 기록을 한 번에 찾아요.</p>';
        return;
      }
      const ql = q.toLowerCase();
      const hits = all.filter(function (r) {
        if (cat && r.type !== cat) return false;
        if (g && String(r.grade) !== g) return false;
        if (tag && (r.tags || []).indexOf(tag) < 0) return false;
        if ((from || to) && !r.date) return false;
        if (from && r.date < from) return false;
        if (to && r.date > to) return false;
        if (!q) return true;
        const x = idx.get(r.id);
        const fields = where === 'all' ? [x.title, x.content, x.people, x.tags, x.date] : [x[where]];
        return fields.some(function (f) { return f.toLowerCase().indexOf(ql) >= 0; });
      }).sort(function (a, b) { return (b.date || b.updatedAt) < (a.date || a.updatedAt) ? -1 : 1; });

      if (!hits.length) { res.innerHTML = '<p class="empty center">찾는 기록이 없어요. 다른 말로 찾아보거나 조건을 줄여 보세요.</p>'; return; }
      const groups = {};
      hits.forEach(function (r) { (groups[r.type] = groups[r.type] || []).push(r); });
      const order = SEARCH_CATS.filter(function (t) { return groups[t]; });
      res.innerHTML = '<p class="search-count">' + hits.length + '개의 기록을 찾았어요</p>' +
        '<div class="search-jump">' + order.map(function (t) { return '<a href="#" data-jump="' + t + '">' + typeLabel(t) + ' ' + groups[t].length + '</a>'; }).join('') + '</div>' +
        order.map(function (t) {
          return '<section class="search-group" id="sg-' + t + '"><h2 class="sec-title">' + typeLabel(t) + ' <small>' + groups[t].length + '개</small></h2>' +
            groups[t].map(function (r) {
              const x = idx.get(r.id);
              const href = U.hrefOf(r) || '#';
              const showText = (where === 'people' ? x.people : where === 'tags' ? x.tags : x.content) || x.people;
              return '<a class="search-hit card" href="' + href + '">' +
                '<span class="sh-title">' + hl(r.title || '(제목 없음)', q) + '</span>' +
                '<span class="sh-meta">' + [r.date ? U.fmtDate(r.date) : '', r.grade ? r.grade + '학년' : ''].filter(Boolean).join(' · ') +
                  (x.people ? ' · 👥 ' + hl(M.ui.snippet(x.people, 40), q) : '') + '</span>' +
                (showText ? '<span class="sh-text">' + hl(around(showText, q, 50), q) + '</span>' : '') +
                (r.tags && r.tags.length ? '<span class="sh-tags">' + r.tags.map(function (tg) { return hl('#' + tg, q); }).join(' ') + '</span>' : '') +
              '</a>';
            }).join('') + '</section>';
        }).join('');
    }
    function later() { clearTimeout(timer); timer = setTimeout(run, 200); }
    qIn.addEventListener('input', later);
    el.querySelector('#sForm').addEventListener('change', run);
    el.querySelector('#sForm').addEventListener('submit', function (e) { e.preventDefault(); run(); });
    res.addEventListener('click', function (e) {
      const j = e.target.closest('[data-jump]');
      if (!j) return;
      e.preventDefault();
      const s = el.querySelector('#sg-' + j.dataset.jump);
      if (s) s.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    run();
    qIn.focus();
  };

  /* =========================================================
     설정 및 데이터 관리
     ========================================================= */
  const TABS = [['display', '🎨 화면'], ['backup', '📦 백업·복원'], ['print', '🖨️ 인쇄·PDF'], ['photobook', '📚 졸업 포토북'],
    ['trash', '🗑️ 휴지통'], ['account', '👤 계정'], ['storage', '💾 저장 공간']];

  /* ---------- 백업 · 복원 ---------- */
  async function backupView(el, head) {
    const U = M.ui, esc = U.esc, B = M.backup;
    const [last, size, stats] = await Promise.all([B.lastBackup(), B.estimate(), M.db.stats()]);
    const days = last ? Math.floor((Date.now() - new Date(last.at).getTime()) / 86400000) : null;
    el.innerHTML = head + '<div class="settings-stack">' +
      '<section class="card tape"><h2>📦 백업 파일 만들기</h2>' +
        '<p class="desc">기록은 이 브라우저 안에만 있어서, 브라우저 데이터를 지우거나 기기를 바꾸면 사라질 수 있어요. 백업 파일을 만들어 USB나 다른 곳에 직접 보관해 주세요. 백업 파일은 인터넷으로 보내지지 않아요.</p>' +
        '<p class="backup-last ' + (days == null || days > 30 ? 'warn' : '') + '">' +
          (last ? '마지막 백업: <b>' + esc(U.fmtStamp(last.at)) + '</b> (' + (days === 0 ? '오늘' : days + '일 전') + ', ' + (last.kind === 'full' ? '전체' : '기록만') + ')' : '⚠️ 아직 백업한 적이 없어요.') +
          (days != null && days > 30 ? ' · 백업한 지 한 달이 넘었어요!' : '') + '</p>' +
        '<div class="backup-btns">' +
          '<button type="button" class="btn primary" id="bkFull">📦 전체 백업 (사진·동영상 포함)<small>ZIP 파일 · 약 ' + M.media.fmtSize(size + 200 * 1024) + '</small></button>' +
          '<button type="button" class="btn" id="bkJson">📝 기록만 백업 (사진 제외)<small>JSON 파일 · 작고 빨라요</small></button>' +
        '</div><p class="fhint" id="bkProg"></p>' +
        '<ul class="todo-list"><li>기록 ' + stats.records + '개, 휴지통 ' + stats.trashed + '개, 사진 ' + stats.images + '장, 동영상 ' + stats.videos + '개가 들어가요.</li>' +
          '<li>한 백업 파일은 4GB까지 만들 수 있어요.</li><li>🔒 계정 아이디·비밀번호는 백업에 들어가지 않아요. 이 계정의 기록만 담겨요.</li></ul>' +
      '</section>' +
      '<section class="card tape-left"><h2>♻️ 백업 파일로 복원하기</h2>' +
        '<p class="desc">이 다이어리에서 만든 백업 파일(.zip 또는 .json)을 고르면, 복원하기 전에 내용을 먼저 보여 줘요.</p>' +
        '<label class="btn">📂 백업 파일 고르기<input type="file" accept=".zip,.json,application/zip,application/json" hidden id="rsFile"></label>' +
        '<div id="rsPreview"></div></section></div>';

    const prog = el.querySelector('#bkProg');
    async function make(full) {
      const btns = el.querySelectorAll('.backup-btns .btn');
      btns.forEach(function (b) { b.disabled = true; });
      prog.textContent = '⏳ 백업 파일을 만드는 중…';
      try {
        await M.autosave.flushAll();
        const r = await B.create(full, function (i, n) { prog.textContent = '⏳ 사진·동영상 담는 중… ' + i + ' / ' + n; });
        await B.download(r.blob, r.name);
        await B.markBackup(full ? 'full' : 'json');
        prog.textContent = '✅ "' + r.name + '" (' + M.media.fmtSize(r.blob.size) + ')을 만들었어요. ' + M.savedWhere();
        M.toast('백업 파일을 만들었어요 📦');
      } catch (err) {
        prog.textContent = '';
        M.toast('백업하지 못했어요: ' + M.db.friendly(err).message, true);
      }
      btns.forEach(function (b) { b.disabled = false; });
    }
    el.querySelector('#bkFull').addEventListener('click', function () { make(true); });
    el.querySelector('#bkJson').addEventListener('click', function () { make(false); });

    const pv = el.querySelector('#rsPreview');
    el.querySelector('#rsFile').addEventListener('change', async function (e) {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      pv.innerHTML = '<p class="empty">⏳ 백업 파일을 읽는 중…</p>';
      let opened;
      try { opened = await B.open(file); } catch (err) {
        pv.innerHTML = '<p class="bot-err">⚠️ ' + esc(M.db.friendly(err).message) + '</p>';
        return;
      }
      const s = opened.summary;
      const rows = Object.keys(s.byType).sort(function (a, b) { return s.byType[b] - s.byType[a]; })
        .map(function (t) { return '<li>' + M.typeLabel(t) + ' <b>' + s.byType[t] + '</b></li>'; }).join('');
      pv.innerHTML = '<div class="restore-box">' +
        '<h3>📄 ' + esc(opened.fileName) + '</h3>' +
        '<p>만든 날: <b>' + esc(U.fmtStamp(s.exportedAt)) + '</b> · 기록 <b>' + s.records + '</b>개' + (s.trashed ? ' (휴지통 ' + s.trashed + '개)' : '') +
          ' · 사진·동영상 <b>' + (s.withMedia ? s.media - s.missing : 0) + '</b>개</p>' +
        (rows ? '<ul class="type-chips">' + rows + '</ul>' : '') +
        (!s.withMedia && s.media ? '<p class="fhint">⚠️ "기록만 백업" 파일이라 사진·동영상은 들어 있지 않아요. 지금 기기에 있는 사진은 그대로 남아요.</p>' : '') +
        (s.withMedia && s.missing ? '<p class="bot-err">⚠️ 사진·동영상 ' + s.missing + '개가 백업 파일에서 빠져 있어요.</p>' : '') +
        (s.invalid ? '<p class="fhint">알 수 없는 기록 ' + s.invalid + '개는 건너뛰어요.</p>' : '') +
        '<fieldset class="restore-mode"><legend>복원 방법</legend>' +
          '<label class="switch"><input type="radio" name="rsMode" value="merge" checked><span><b>합치기</b> — 지금 기록은 그대로 두고 백업의 기록을 더해요. 같은 기록이 양쪽에 있으면 <b>더 최근에 수정한 쪽</b>을 남기고, 같은 사진은 하나만 남겨요.</span></label>' +
          '<label class="switch"><input type="radio" name="rsMode" value="replace"><span><b>전부 교체</b> — 지금 기록을 모두 지우고 백업 내용으로 바꿔요. 화면 설정도 백업 때로 돌아가요.</span></label>' +
        '</fieldset>' +
        '<div class="toolbar-in"><button type="button" class="btn" id="rsSafe">📦 지금 기록 먼저 백업하기</button><button type="button" class="btn primary" id="rsGo">♻️ 복원하기</button></div>' +
        '<p class="fhint" id="rsProg"></p></div>';
      pv.querySelector('#rsSafe').addEventListener('click', function () { make(true); });
      pv.querySelector('#rsGo').addEventListener('click', async function () {
        const mode = pv.querySelector('[name="rsMode"]:checked').value;
        const cur = await M.db.stats();
        const msg = mode === 'replace'
          ? '정말 전부 교체할까요?\n지금 있는 기록 ' + (cur.records + cur.trashed) + '개' + (s.withMedia ? '와 사진·동영상 ' + (cur.images + cur.videos) + '개' : '') + '가 모두 지워지고 백업 내용으로 바뀌어요.\n되돌릴 수 없으니, 먼저 지금 기록을 백업해 두는 걸 추천해요.'
          : '백업의 기록 ' + s.records + '개를 지금 기록에 합칠까요?';
        if (!window.confirm(msg)) return;
        const go = pv.querySelector('#rsGo'), p = pv.querySelector('#rsProg');
        go.disabled = true;
        p.textContent = '⏳ 복원하는 중…';
        try {
          await M.autosave.flushAll();
          const r = await B.restore(opened, mode, function (i, n) { p.textContent = '⏳ 사진·동영상 꺼내는 중… ' + i + ' / ' + n; });
          p.innerHTML = '✅ 복원을 마쳤어요. 새로 넣은 기록 ' + r.added + '개' + (mode === 'merge' ? ', 더 최근 것으로 바꾼 기록 ' + r.updated + '개, 그대로 둔 기록 ' + r.skipped + '개' : '') +
            ', 사진·동영상 ' + r.mediaAdded + '개' + (r.mediaSkipped ? ' (이미 있던 사진 ' + r.mediaSkipped + '개는 건너뜀)' : '') + '.' +
            (r.mediaFixed ? '<br>🔧 이미 있던 사진 ' + r.mediaFixed + '개도 백업 속 사진으로 새로 저장했어요. (깨진 사진이 있었다면 고쳐져요)' : '') +
            (r.mediaBroken ? '<br>⚠️ 제대로 저장되지 않은 사진이 ' + r.mediaBroken + '개 있어요.' : '');
          M.toast('복원을 마쳤어요 ♻️');
          await B.markBackup(last ? last.kind : 'json').catch(function () {});
        } catch (err) {
          p.textContent = '';
          M.toast('복원하지 못했어요. 지금 기록은 바뀌지 않았어요. (' + M.db.friendly(err).message + ')', true);
        }
        go.disabled = false;
      });
    });
  }

  /* ---------- 화면: 다크 모드 · 글자 크기 · 테마 ---------- */
  function displayView(el, head) {
    const s = M.settings.get();
    el.innerHTML = head +
      '<div class="settings-stack"><section class="card tape-left"><h2>🌙 화면 모드</h2>' +
        '<p class="desc">어두운 곳에서는 다크 모드가 눈이 편해요. "기기 설정 따라가기"는 휴대폰·컴퓨터의 설정에 맞춰 바뀌어요.</p>' +
        '<div class="choice">' + [['system', '🖥️ 기기 설정 따라가기'], ['light', '☀️ 밝게'], ['dark', '🌙 어둡게 (다크 모드)']].map(function (m) {
          return '<button type="button" class="chip-btn" data-mode="' + m[0] + '" aria-pressed="' + (s.mode === m[0]) + '">' + m[1] + '</button>';
        }).join('') + '</div>' +
        '<h2 class="mt">🔤 글자 크기</h2><div class="choice">' + [[90, '작게'], [100, '보통'], [112, '크게'], [125, '아주 크게']].map(function (f) {
          return '<button type="button" class="chip-btn" data-font="' + f[0] + '" aria-pressed="' + (s.fontScale === f[0]) + '" style="font-size:' + (f[0] / 100 * 0.9) + 'rem">' + f[1] + '</button>';
        }).join('') + '</div></section></div>' +
      M.pages.settings(true);
    M.bindSettings();
    el.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!M.settings.setMode(b.dataset.mode)) return M.toast('저장하지 못했어요.', true);
        M.display.apply();
        M.toast('화면 모드를 바꿨어요.');
        M.rerender();
      });
    });
    el.querySelectorAll('[data-font]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!M.settings.setFontScale(Number(b.dataset.font))) return M.toast('저장하지 못했어요.', true);
        M.display.apply();
        M.toast('글자 크기를 바꿨어요.');
        M.rerender();
      });
    });
  }

  /* ---------- 휴지통 ---------- */
  async function trashView(el, head) {
    const U = M.ui, esc = U.esc;
    const list = await M.db.listTrash();
    el.innerHTML = head +
      '<section class="card tape trash-head"><h2 class="sec-title">🗑️ 휴지통 <small>' + list.length + '개</small></h2>' +
        '<p class="desc">지운 기록은 여기에 보관돼요. <b>직접 비울 때까지 자동으로 지워지지 않아요.</b> "완전히 삭제"하면 그 기록에만 쓰인 사진·동영상도 함께 지워지고 되돌릴 수 없어요.</p>' +
        (list.length ? '<div class="toolbar-in"><input type="search" class="inp" id="tq" placeholder="🔍 휴지통에서 찾기" aria-label="휴지통 검색">' +
          '<button type="button" class="btn danger" id="tEmpty">휴지통 비우기</button></div>' : '') +
      '</section><div id="tRes"></div>';
    const res = el.querySelector('#tRes'), q = el.querySelector('#tq');
    function draw() {
      const s = q ? q.value.trim() : '';
      const rows = list.filter(function (r) { return U.match(r, s) || typeLabel(r.type).indexOf(s) >= 0; });
      if (!list.length) { res.innerHTML = U.empty('🗑️', '휴지통이 비어 있어요.', null); return; }
      res.innerHTML = rows.length ? '<ul class="trash-list">' + rows.map(function (r) {
        return '<li class="card"><span class="tr-type">' + typeLabel(r.type) + '</span>' +
          '<span class="tr-title">' + esc(r.title || '(제목 없음)') + (r.date ? ' <small>' + esc(U.fmtDate(r.date, false)) + '</small>' : '') + '</span>' +
          '<span class="tr-when">' + esc(U.fmtStamp(r.trashedAt)) + ' 삭제</span>' +
          '<span class="tr-btns"><button type="button" class="btn small" data-restore="' + r.id + '">↩️ 복구</button>' +
          '<button type="button" class="btn small danger" data-purge="' + r.id + '">완전히 삭제</button></span></li>';
      }).join('') + '</ul>' : '<p class="empty center">찾는 기록이 없어요.</p>';
    }
    if (q) q.addEventListener('input', draw);
    draw();
    res.addEventListener('click', async function (e) {
      const rb = e.target.closest('[data-restore]'), pb = e.target.closest('[data-purge]');
      try {
        if (rb) {
          const r = await M.db.restore(rb.dataset.restore);
          const href = U.hrefOf(r);
          M.toast('"' + (r.title || '기록') + '"을(를) 복구했어요.', false, href ? { label: '보러 가기', fn: function () { location.hash = href; } } : null);
          M.rerender();
        }
        if (pb) {
          const r = list.find(function (x) { return x.id === pb.dataset.purge; });
          if (!window.confirm('"' + (r.title || '기록') + '"을(를) 완전히 삭제할까요?\n이 기록에만 쓰인 사진·동영상도 함께 지워지고, 되돌릴 수 없어요.')) return;
          await M.db.purge(r.id);
          M.toast('완전히 삭제했어요.');
          M.rerender();
        }
      } catch (err) { M.toast(M.db.friendly(err).message, true); }
    });
    const emp = el.querySelector('#tEmpty');
    if (emp) emp.addEventListener('click', async function () {
      if (!window.confirm('휴지통에 있는 기록 ' + list.length + '개를 모두 완전히 삭제할까요?\n함께 쓰인 사진·동영상도 지워지고, 되돌릴 수 없어요.')) return;
      try {
        for (const r of list) await M.db.purge(r.id);
        M.toast('휴지통을 비웠어요.');
      } catch (err) { M.toast(M.db.friendly(err).message, true); }
      M.rerender();
    });
  }

  /* ---------- 계정 ---------- */
  function accountView(el, head) {
    const A = M.accounts, esc = M.ui.esc;
    const me = A.current();
    const others = A.list().filter(function (a) { return a.id !== me.id; });
    const qPicker = function (id) {
      return '<label class="flabel" for="' + id + '">복구 질문</label><select class="inp" id="' + id + '">' +
        A.QUESTIONS.map(function (q) { return '<option>' + q + '</option>'; }).join('') + '</select>' +
        '<input class="inp" id="' + id + 'Own" placeholder="나만의 질문을 적어 주세요" hidden>';
    };
    el.innerHTML = head + '<div class="settings-stack">' +
      '<section class="card tape"><h2>👤 내 계정</h2>' +
        '<p class="desc">🔒 계정마다 기록·사진·테마가 완전히 따로 저장돼요. 다른 사람은 내 기록을 볼 수 없어요. 계정 정보와 기록은 이 기기 안에만 있고 인터넷으로 보내지 않아요. 다만 기기를 잘 아는 사람이 마음먹고 열어 보는 것까지 완벽하게 막지는 못해요.</p>' +
        '<p>아이디: <b>' + esc(me.username) + '</b> · 만든 날: ' + esc(M.ui.fmtStamp(me.createdAt)) + '</p>' +
        '<p>복구 질문: <b>' + esc(me.q) + '</b></p>' +
        '<form id="acName" class="form-grid lock-form">' +
          '<div class="field"><label class="flabel" for="acNm">이름 · 별명</label><input class="inp" id="acNm" value="' + esc(me.name) + '"></div>' +
          '<div class="field full"><span class="flabel">캐릭터</span><div class="choice">' + A.AVATARS.map(function (a) {
            return '<button type="button" class="chip-btn big" data-av="' + a + '" aria-pressed="' + (me.avatar === a) + '">' + a + '</button>';
          }).join('') + '</div></div>' +
          '<div class="field full"><button class="btn" type="submit">이름 · 캐릭터 저장</button></div></form>' +
        '<button type="button" class="btn primary" id="acOut">👋 로그아웃</button>' +
      '</section>' +
      '<section class="card tape-left"><h2>🔑 비밀번호 바꾸기</h2><form id="acPw" class="form-grid lock-form">' +
        '<div class="field full"><label class="flabel" for="acCur">지금 비밀번호</label><input class="inp" type="password" id="acCur" autocomplete="current-password" required></div>' +
        '<div class="field"><label class="flabel" for="acNew">새 비밀번호</label><input class="inp" type="password" id="acNew" autocomplete="new-password" minlength="4" required></div>' +
        '<div class="field"><label class="flabel" for="acNew2">새 비밀번호 확인</label><input class="inp" type="password" id="acNew2" autocomplete="new-password" minlength="4" required></div>' +
        '<div class="field full"><button class="btn primary" type="submit">비밀번호 바꾸기</button></div></form></section>' +
      '<section class="card tape-corner"><h2>❓ 복구 질문 바꾸기</h2><form id="acQ" class="form-grid lock-form">' +
        '<div class="field full"><label class="flabel" for="acCur2">지금 비밀번호</label><input class="inp" type="password" id="acCur2" autocomplete="current-password" required></div>' +
        '<div class="field full">' + qPicker('acQs') + '</div>' +
        '<div class="field full"><label class="flabel" for="acA">새 복구 답</label><input class="inp" type="text" id="acA" autocomplete="off" required></div>' +
        '<div class="field full"><button class="btn" type="submit">복구 질문 바꾸기</button></div></form></section>' +
      '<section class="card"><h2>👨‍👩‍👧 이 기기의 다른 계정</h2>' +
        (others.length ? '<ul class="todo-list">' + others.map(function (a) { return '<li>' + esc(a.avatar) + ' ' + esc(a.name) + '</li>'; }).join('') + '</ul>' : '<p class="empty">아직 다른 계정이 없어요.</p>') +
        '<p class="desc">새 계정은 로그아웃한 뒤 로그인 화면의 "+ 새 계정 만들기"에서 만들 수 있어요.</p></section>' +
      '<section class="card"><h2>🗑️ 내 계정 삭제</h2>' +
        '<p class="desc">계정을 지우면 <b>이 계정의 모든 기록·사진·동영상·설정이 이 기기에서 완전히 지워지고 되돌릴 수 없어요.</b> 지우기 전에 <a href="#/settings/backup">📦 전체 백업</a>을 꼭 만들어 두세요.</p>' +
        '<form id="acDel" class="form-grid lock-form">' +
          '<div class="field full"><label class="flabel" for="acCur3">지금 비밀번호</label><input class="inp" type="password" id="acCur3" autocomplete="current-password" required></div>' +
          '<div class="field full"><label class="flabel" for="acConf">확인을 위해 아이디 "' + esc(me.username) + '"를 적어 주세요</label><input class="inp" id="acConf" autocomplete="off" required></div>' +
          '<div class="field full"><button class="btn danger" type="submit">계정 완전히 삭제</button></div></form></section>' +
      '</div>';

    const v = function (id) { return el.querySelector('#' + id).value; };
    let avatar = me.avatar;
    el.querySelectorAll('[data-av]').forEach(function (b) {
      b.addEventListener('click', function () {
        avatar = b.dataset.av;
        el.querySelectorAll('[data-av]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      });
    });
    el.querySelector('#acQs').addEventListener('change', function (e) { el.querySelector('#acQsOwn').hidden = e.target.value !== '직접 입력할게요'; });
    el.querySelector('#acOut').addEventListener('click', function () { A.logout(); });
    function guard(id, fn) {
      el.querySelector('#' + id).addEventListener('submit', async function (e) {
        e.preventDefault();
        const b = e.target.querySelector('button[type="submit"]');
        b.disabled = true;
        try { await fn(); } catch (err) { M.toast(err.message || '다시 시도해 주세요.', true); }
        b.disabled = false;
      });
    }
    guard('acName', async function () {
      A.rename(me, v('acNm'), avatar);
      A.refreshUI();
      M.toast('이름과 캐릭터를 저장했어요.');
    });
    guard('acPw', async function () {
      await A.check(me, 'pw', v('acCur'));
      if (v('acNew').length < 4) throw MMSD.AppError('PW', '비밀번호는 4자 이상으로 정해 주세요.');
      if (v('acNew') !== v('acNew2')) throw MMSD.AppError('PW', '두 비밀번호가 서로 달라요.');
      await A.changePassword(me, v('acNew'));
      M.toast('비밀번호를 바꿨어요 🔑');
      M.rerender();
    });
    guard('acQ', async function () {
      await A.check(me, 'pw', v('acCur2'));
      const q = v('acQs') === '직접 입력할게요' ? v('acQsOwn') : v('acQs');
      await A.changeQuestion(me, q, v('acA'));
      M.toast('복구 질문을 바꿨어요.');
      M.rerender();
    });
    guard('acDel', async function () {
      await A.check(me, 'pw', v('acCur3'));
      if (v('acConf').trim().toLowerCase() !== me.username) throw MMSD.AppError('CONF', '아이디가 맞지 않아요. 확인을 위해 아이디를 그대로 적어 주세요.');
      if (!window.confirm('정말 "' + me.name + '" 계정을 지울까요?\n이 계정의 모든 기록·사진·설정이 완전히 지워지고 되돌릴 수 없어요.')) return;
      await M.autosave.flushAll();
      await A.remove(me);
      M.toast('계정을 지웠어요.');
      A.logout();
    });
  }

  /* ---------- 저장 공간 ---------- */
  function storageView(el, head) {
    el.innerHTML = head + '<div class="settings-stack">' +
      '<section class="card tape"><h2>💾 저장 공간</h2>' +
        '<p class="desc">글 기록과 사진·동영상을 따로 나눠서 이 기기 안에 저장해요.</p>' +
        '<div id="storageInfo"><p class="empty">확인하는 중…</p></div></section>' +
      '<section class="card tape-corner"><h2>🩺 사진 점검</h2>' +
        '<p class="desc">사진이 깨져 보일 때 눌러 보세요. 저장된 사진을 하나씩 열어 보고 결과를 알려 줘요. (다이어리 버전 ' + M.VERSION + ')</p>' +
        '<button type="button" class="btn" id="photoCheckBtn">🩺 사진 점검하기</button>' +
        '<div id="photoCheckOut" class="desc" style="margin-top:10px"></div></section>' +
      '<section class="card tape-corner"><h2>🔒 개인정보 보호</h2>' +
        '<p class="desc">이 다이어리는 인터넷 서버를 쓰지 않아요. 모든 기록은 이 기기의 브라우저 안에만 저장되고, 외부로 보내지 않아요.</p>' +
        '<ul class="todo-list"><li>브라우저의 "사이트 데이터 삭제"를 하거나 기기를 바꾸면 기록이 사라질 수 있어요. <a href="#/settings/backup">📦 백업·복원</a>에서 백업 파일을 자주 만들어 두세요.</li></ul></section></div>';
    M.pages.fillStorage(el.querySelector('#storageInfo'));
    const cb = el.querySelector('#photoCheckBtn'), co = el.querySelector('#photoCheckOut');
    cb.addEventListener('click', async function () {
      cb.disabled = true;
      co.textContent = '점검하는 중…';
      try { co.innerHTML = await checkPhotos(function (i, n) { co.textContent = '점검하는 중… ' + i + ' / ' + n; }); }
      catch (e) { co.textContent = '⚠️ 점검하지 못했어요: ' + M.db.friendly(e).message; }
      cb.disabled = false;
    });
  }

  function canShow(blob) {
    return new Promise(function (resolve) {
      const u = URL.createObjectURL(blob);
      const img = new Image();
      const done = function (ok) { clearTimeout(timer); URL.revokeObjectURL(u); resolve(ok); };
      const timer = setTimeout(function () { done(false); }, 8000);
      img.onload = function () { done(true); };
      img.onerror = function () { done(false); };
      img.src = u;
    });
  }
  async function checkPhotos(onStep) {
    const all = await M.db._run(['media'], 'readonly', function (t) { return M.db._reqP(t.objectStore('media').getAll()); });
    let ok = 0, noData = 0, badRead = 0, badShow = 0, firstErr = '';
    for (let i = 0; i < all.length; i++) {
      const m = all[i];
      onStep(i + 1, all.length);
      if (!m.blob) { noData++; continue; }
      try { await m.blob.slice(0, Math.min(16, m.blob.size)).arrayBuffer(); }
      catch (e) { badRead++; if (!firstErr) firstErr = (e && e.name) + ' ' + (e && e.message || ''); continue; }
      if (m.kind === 'image' && !(await canShow(m.thumb || m.blob))) { badShow++; continue; }
      ok++;
    }
    const esc = M.ui.esc;
    return '<b>사진·동영상 ' + all.length + '개 중 정상 ' + ok + '개</b>' +
      (noData ? '<br>· 내용이 없는 것: ' + noData + '개' : '') +
      (badRead ? '<br>· 읽을 수 없는 것: ' + badRead + '개 <small>(' + esc(firstErr) + ')</small>' : '') +
      (badShow ? '<br>· 읽히지만 화면에 안 보이는 것: ' + badShow + '개' : '') +
      (ok === all.length ? '<br>✅ 모든 사진이 정상이에요.'
        : '<br>🔧 고치는 방법: 사진이 있는 원래 기기의 전체 백업 ZIP으로 <a href="#/settings/backup">📦 백업·복원</a>에서 "합치기" 복원을 해 주세요.');
  }

  M.mods.settings = async function (el, sub) {
    const tab = TABS.some(function (t) { return t[0] === sub[0]; }) ? sub[0] : 'display';
    const head = '<div class="sub-bar">' + M.ui.tabs('settings', TABS, tab) + '</div>';
    if (tab === 'backup') return backupView(el, head);
    if (tab === 'print') return M.printer.printView(el, head);
    if (tab === 'photobook') return M.printer.photobookView(el, head);
    if (tab === 'trash') return trashView(el, head);
    if (tab === 'account') return accountView(el, head);
    if (tab === 'storage') return storageView(el, head);
    return displayView(el, head);
  };

  M.typeLabel = typeLabel;
})();

/* ===== js/zip.js ===== */
/* =========================================================
   ZIP 파일 만들기 · 읽기 (외부 라이브러리 없이)
   - 만들 때: 압축하지 않고 담기만 함(사진·동영상은 이미 압축된 파일이라 크기 차이가 거의 없음)
   - 읽을 때: 담기만 한 파일 + 일반 압축(deflate) 파일 모두 읽을 수 있음
   - 한 파일 최대 4GB (ZIP 기본 형식의 한계)
   ========================================================= */
MMSD.zip = (function () {
  const enc = new TextEncoder();
  const LIMIT = 0xFFFFFFFF;
  const CHUNK = 8 * 1024 * 1024;

  const TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, prev) {
    let c = (prev || 0) ^ 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  async function blobCrc(blob) {
    let c = 0;
    for (let o = 0; o < blob.size; o += CHUNK) c = crc32(new Uint8Array(await blob.slice(o, o + CHUNK).arrayBuffer()), c);
    return c;
  }
  function dos(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  function Writer() {
    const parts = [], central = [];
    let offset = 0, count = 0;
    const t = dos(new Date());

    this.add = async function (name, data) {
      const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? enc.encode(data) : data]);
      const crc = await blobCrc(blob);
      const nameB = enc.encode(name);
      const size = blob.size;
      if (offset + 30 + nameB.length + size > LIMIT) throw MMSD.AppError('ZIP_LIMIT', '백업 파일이 4GB를 넘어요. 큰 동영상을 줄이거나 "기록만 백업"을 이용해 주세요.');
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, t.time, true); h.setUint16(12, t.date, true); h.setUint32(14, crc, true);
      h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, nameB.length, true); h.setUint16(28, 0, true);
      parts.push(h.buffer, nameB, blob);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, t.time, true); c.setUint16(14, t.date, true); c.setUint32(16, crc, true);
      c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, nameB.length, true);
      c.setUint32(42, offset, true);
      central.push(c.buffer, nameB);
      offset += 30 + nameB.length + size;
      count++;
    };
    this.finish = function () {
      const cdStart = offset;
      let cdSize = 0;
      central.forEach(function (p) { cdSize += p.byteLength; });
      const e = new DataView(new ArrayBuffer(22));
      e.setUint32(0, 0x06054b50, true); e.setUint16(8, count, true); e.setUint16(10, count, true);
      e.setUint32(12, cdSize, true); e.setUint32(16, cdStart, true);
      return new Blob(parts.concat(central, [e.buffer]), { type: 'application/zip' });
    };
  }

  async function read(file) {
    const tailStart = Math.max(0, file.size - 65557);
    const tail = new DataView(await file.slice(tailStart).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw MMSD.AppError('ZIP', 'ZIP 파일을 읽을 수 없어요. 파일이 손상되었을 수 있어요.');
    const count = tail.getUint16(eocd + 10, true);
    const cdSize = tail.getUint32(eocd + 12, true);
    const cdOff = tail.getUint32(eocd + 16, true);
    const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.getUint32(p, true) !== 0x02014b50) throw MMSD.AppError('ZIP', 'ZIP 파일 목록이 손상되었어요.');
      const method = cd.getUint16(p + 10, true), comp = cd.getUint32(p + 20, true), size = cd.getUint32(p + 24, true);
      const n = cd.getUint16(p + 28, true), e = cd.getUint16(p + 30, true), c = cd.getUint16(p + 32, true);
      const local = cd.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, n));
      entries.set(name, { name: name, method: method, comp: comp, size: size, local: local });
      p += 46 + n + e + c;
    }
    async function blob(name, type) {
      const en = entries.get(name);
      if (!en) return null;
      const lh = new DataView(await file.slice(en.local, en.local + 30).arrayBuffer());
      const start = en.local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const raw = file.slice(start, start + en.comp);
      /* 아이패드·아이폰(사파리)은 고른 파일을 잠깐만 보관해요. 파일 조각을 그대로 저장하면
         나중에 사진이 깨지므로, 내용을 통째로 읽어 새로 만든 데이터로 돌려줘요. */
      if (en.method === 0) return new Blob([await raw.arrayBuffer()], { type: type || '' });
      if (en.method === 8) {
        if (!window.DecompressionStream) throw MMSD.AppError('ZIP', '이 브라우저는 압축된 ZIP 파일을 풀 수 없어요.');
        const out = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
        return new Blob([out], { type: type || '' });
      }
      throw MMSD.AppError('ZIP', '지원하지 않는 압축 방식이에요.');
    }
    return { entries: entries, blob: blob };
  }

  return { Writer: Writer, read: read, crc32: crc32 };
})();

/* ===== js/backup.js ===== */
/* =========================================================
   백업 · 복원
   - 전체 백업(ZIP): data.json + media/(원본) + thumbs/(미리보기)
   - 기록만 백업(JSON): 글 기록만, 사진·동영상 제외
   - 복원: 미리보기 → "전부 교체" 또는 "합치기"
     합치기 규칙: 같은 기록(같은 ID)이 있으면 더 최근에 수정된 쪽을 남김
                  같은 사진(같은 파일 내용)이 있으면 하나만 남김
   - 잠금 비밀번호는 백업에 넣지 않음
   ========================================================= */
MMSD.backup = (function () {
  const M = window.MMSD;
  const APP = 'my-middle-school-diary';
  const FORMAT = 1;
  const EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'application/pdf': 'pdf'
  };

  function getAll(store) {
    return M.db._run([store], 'readonly', function (t) { return M.db._reqP(t.objectStore(store).getAll()); });
  }
  function stamp() {
    const d = new Date(), p = M.ui.pad;
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }
  function extOf(m) {
    return EXT[m.mime] || ((m.name || '').split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  }

  /* ---------- 백업 만들기 ---------- */
  async function estimate() {
    const media = await getAll('media');
    return media.reduce(function (s, m) { return s + (m.size || 0) + (m.thumb ? m.thumb.size : 0); }, 0);
  }

  async function create(withMedia, onProgress) {
    const [records, media, meta] = await Promise.all([getAll('records'), getAll('media'), getAll('meta')]);
    const s = M.settings.get();
    const data = {
      app: APP, format: FORMAT, exportedAt: new Date().toISOString(), withMedia: !!withMedia,
      settings: { defaultTheme: s.defaultTheme, pageThemes: s.pageThemes, mode: s.mode, fontScale: s.fontScale },
      meta: meta.filter(function (m) { return m.key !== 'lastBackup'; }),
      records: records,
      media: media.map(function (m) {
        return {
          id: m.id, kind: m.kind, mime: m.mime, name: m.name, size: m.size, hash: m.hash,
          width: m.width, height: m.height, duration: m.duration, createdAt: m.createdAt,
          file: withMedia ? 'media/' + m.id + '.' + extOf(m) : null,
          thumb: withMedia && m.thumb ? 'thumbs/' + m.id + '.jpg' : null
        };
      })
    };
    let blob, name;
    if (!withMedia) {
      blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      name = '중학생활다이어리_기록백업_' + stamp() + '.json';
    } else {
      const total = media.reduce(function (s2, m) { return s2 + (m.size || 0) + (m.thumb ? m.thumb.size : 0); }, 0);
      if (total > 0xFFFFFFFF - 50 * 1024 * 1024) throw MMSD.AppError('ZIP_LIMIT', '사진·동영상이 4GB를 넘어서 한 파일로 백업할 수 없어요. 큰 동영상을 정리하거나 "기록만 백업"을 이용해 주세요.');
      const z = new M.zip.Writer();
      await z.add('data.json', JSON.stringify(data));
      for (let i = 0; i < media.length; i++) {
        const m = media[i];
        if (m.blob) await z.add(data.media[i].file, m.blob);
        if (m.thumb) await z.add(data.media[i].thumb, m.thumb);
        if (onProgress) onProgress(i + 1, media.length);
      }
      blob = z.finish();
      name = '중학생활다이어리_전체백업_' + stamp() + '.zip';
    }
    return { blob: blob, name: name, records: records.length, media: media.length };
  }

  function download(blob, name) { return M.saveFile(blob, name); }

  /* ---------- 백업 파일 읽기 + 미리보기 ---------- */
  async function open(file) {
    let data, zip = null;
    const isZip = /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
    try {
      if (isZip) {
        zip = await M.zip.read(file);
        const j = await zip.blob('data.json');
        if (!j) throw MMSD.AppError('BACKUP', '이 ZIP 파일에는 다이어리 기록(data.json)이 없어요.');
        data = JSON.parse(await j.text());
      } else {
        data = JSON.parse(await file.text());
      }
    } catch (e) {
      if (e.isAppError) throw e;
      throw MMSD.AppError('BACKUP', '백업 파일을 읽지 못했어요. 이 다이어리에서 만든 백업 파일인지 확인해 주세요.');
    }
    if (!data || data.app !== APP || !Array.isArray(data.records)) {
      throw MMSD.AppError('BACKUP', '이 다이어리의 백업 파일이 아니에요.');
    }
    if (data.format > FORMAT) throw MMSD.AppError('BACKUP', '더 새로운 버전에서 만든 백업이에요. 다이어리를 최신으로 바꾼 뒤 복원해 주세요.');

    const types = M.db.TYPES;
    const valid = data.records.filter(function (r) { return r && r.id && types.indexOf(r.type) >= 0; });
    const byType = {};
    valid.forEach(function (r) { if (!r.trashed) byType[r.type] = (byType[r.type] || 0) + 1; });
    const media = Array.isArray(data.media) ? data.media : [];
    let missing = 0;
    if (zip) media.forEach(function (m) { if (!m.file || !zip.entries.has(m.file)) missing++; });
    return {
      data: data, zip: zip, fileName: file.name,
      summary: {
        exportedAt: data.exportedAt, withMedia: !!(zip && data.withMedia),
        records: valid.filter(function (r) { return !r.trashed; }).length,
        trashed: valid.filter(function (r) { return r.trashed; }).length,
        invalid: data.records.length - valid.length,
        byType: byType, media: media.length, missing: zip ? missing : media.length
      }
    };
  }

  /* ---------- 복원 ---------- */
  async function restore(opened, mode, onProgress) {
    const data = opened.data, zip = opened.zip;
    const types = M.db.TYPES;
    const records = data.records.filter(function (r) { return r && r.id && types.indexOf(r.type) >= 0; });
    const inMedia = Array.isArray(data.media) ? data.media : [];

    /* 1) 사진·동영상 파일을 먼저 꺼내 둠 (저장 작업 도중에 파일을 읽으면 저장이 끊기기 때문) */
    const ready = [];
    if (zip) {
      for (let i = 0; i < inMedia.length; i++) {
        const m = inMedia[i];
        const blob = m.file ? await zip.blob(m.file, m.mime) : null;
        if (blob) {
          const thumb = m.thumb ? await zip.blob(m.thumb, 'image/jpeg') : null;
          ready.push({
            id: m.id, kind: m.kind, mime: m.mime, name: m.name, size: blob.size, hash: m.hash,
            width: m.width || null, height: m.height || null, duration: m.duration || null, createdAt: m.createdAt,
            blob: blob, thumb: thumb
          });
        }
        if (onProgress) onProgress(i + 1, inMedia.length);
      }
    }

    const result = { added: 0, updated: 0, skipped: 0, mediaAdded: 0, mediaSkipped: 0, mediaMissing: inMedia.length - ready.length };

    if (mode === 'replace') {
      await M.db._run(['records', 'media', 'meta'], 'readwrite', async function (t) {
        const rs = t.objectStore('records'), ms = t.objectStore('media'), mt = t.objectStore('meta');
        const keepBackup = await M.db._reqP(mt.get('lastBackup'));
        await M.db._reqP(rs.clear());
        /* 기록만 백업(JSON)으로 교체할 때는 지금 있는 사진을 지우지 않음 */
        if (zip) await M.db._reqP(ms.clear());
        await M.db._reqP(mt.clear());
        if (keepBackup) await M.db._reqP(mt.put(keepBackup));
        for (const m of (data.meta || [])) if (m && m.key && m.key !== 'lastBackup') await M.db._reqP(mt.put(m));
        for (const r of records) { await M.db._reqP(rs.put(r)); result.added++; }
        for (const m of ready) { await M.db._reqP(ms.put(m)); result.mediaAdded++; }
      });
      if (data.settings) {
        const s = data.settings;
        if (s.defaultTheme) M.settings.setDefaultTheme(s.defaultTheme);
        Object.keys(M.settings.get().pageThemes).forEach(function (k) { M.settings.setPageTheme(k, null); });
        Object.keys(s.pageThemes || {}).forEach(function (k) { M.settings.setPageTheme(k, s.pageThemes[k]); });
        if (s.mode) M.settings.setMode(s.mode);
        if (s.fontScale) M.settings.setFontScale(s.fontScale);
        M.display.apply();
      }
    } else {
      /* 합치기: 같은 내용의 사진은 이미 있는 것을 쓰고, 기록 속 사진 ID를 바꿔 줌 */
      const existing = await getAll('media');
      /* 이미 있는 사진도 백업 속 사진으로 "다시 저장"해 줌
         (아이패드처럼 예전에 사진이 깨진 채 저장된 경우를 고치기 위해, 깨졌는지 따지지 않고 항상 새로 씀) */
      const byId = {}, byHash = {};
      existing.forEach(function (m) { byId[m.id] = m; if (m.hash && !byHash[m.hash]) byHash[m.hash] = m.id; });
      const idMap = {};
      const toAdd = [];
      const refreshed = {};
      ready.forEach(function (m) {
        let target = null;
        if (byId[m.id]) target = byId[m.id];
        else if (m.hash && byHash[m.hash]) { target = byId[byHash[m.hash]]; idMap[m.id] = target.id; }
        if (!target) { toAdd.push(m); return; }
        if (refreshed[target.id]) return;
        refreshed[target.id] = 1;
        toAdd.push(Object.assign({}, target, { blob: m.blob, thumb: m.thumb || null, size: m.blob.size }));
        result.mediaFixed = (result.mediaFixed || 0) + 1;
      });
      const remap = function (r) {
        const keys = Object.keys(idMap);
        if (!keys.length) return r;
        let s = JSON.stringify(r);
        keys.forEach(function (k) { s = s.split(k).join(idMap[k]); });
        return JSON.parse(s);
      };
      await M.db._run(['records', 'media', 'meta'], 'readwrite', async function (t) {
        const rs = t.objectStore('records'), ms = t.objectStore('media'), mt = t.objectStore('meta');
        for (const m of toAdd) { await M.db._reqP(ms.put(m)); if (!refreshed[m.id]) result.mediaAdded++; }
        for (const raw of records) {
          const r = remap(raw);
          const cur = await M.db._reqP(rs.get(r.id));
          if (!cur) { await M.db._reqP(rs.put(r)); result.added++; }
          else if ((r.updatedAt || '') > (cur.updatedAt || '')) { await M.db._reqP(rs.put(r)); result.updated++; }
          else result.skipped++;
        }
        for (const m of (data.meta || [])) {
          if (!m || !m.key || m.key === 'lastBackup') continue;
          const cur = await M.db._reqP(mt.get(m.key));
          if (!cur) await M.db._reqP(mt.put(m));
        }
      });
    }

    /* 복원 확인: 사진 파일 크기가 맞게 저장되었는지 */
    const after = await getAll('media');
    result.mediaBroken = 0;
    for (const m of after) if (!m.blob || m.blob.size !== m.size || !(await readable(m.blob))) result.mediaBroken++;
    M.profile = null;
    return result;
  }

  async function readable(b) {
    if (!b) return false;
    try { await b.slice(0, Math.min(16, b.size)).arrayBuffer(); return true; } catch (e) { return false; }
  }

  async function lastBackup() { return M.db.getMeta('lastBackup'); }
  async function markBackup(kind) { return M.db.setMeta('lastBackup', { at: new Date().toISOString(), kind: kind }); }

  return { create: create, download: download, open: open, restore: restore, estimate: estimate, lastBackup: lastBackup, markBackup: markBackup };
})();

/* ===== js/printer.js ===== */
/* =========================================================
   다이어리 인쇄 · PDF · 졸업 포토북
   PDF는 브라우저 인쇄 창에서 "PDF로 저장"을 골라 만들어요. (외부로 보내지 않음)
   ========================================================= */
MMSD.printer = (function () {
  const M = window.MMSD;

  /* 기록 항목 이름 */
  const LABELS = {
    nickname: '별명', birth: '생년월일', classNo: '반', number: '번호', entryDate: '입학일', gradDate: '졸업 예정일', mbti: 'MBTI', blood: '혈액형',
    height: '키', weight: '몸무게', shoe: '신발 사이즈', foot: '발 크기', clothes: '옷 사이즈', bodyEtc: '기타 신체 변화',
    hobby: '취미', talent: '특기', likeFood: '좋아하는 음식', dislikeFood: '싫어하는 음식', color: '좋아하는 색깔', season: '좋아하는 계절',
    interests: '관심사', dream: '장래희망', motto: '좌우명 · 급훈', tmi: 'TMI', intro: '소개',
    face: '얼굴 변화', hair: '헤어스타일', skin: '피부 변화', fashion: '패션 스타일', voice: '목소리 변화', range: '음역대 · 공부 범위',
    singing: '노래 실력', sports: '운동 능력', newSkill: '새롭게 배운 기술', personality: '성격', confidence: '자신감 변화', values: '가치관 변화',
    birthday: '생일', relation: '관계', firstMet: '처음 만난 날', closeDate: '친해진 날', class1: '1학년 반', class2: '2학년 반', class3: '3학년 반',
    relationLog: '관계 변화', kind: '종류', place: '장소', content: '내용', friends: '함께한 친구', teachers: '함께한 선생님', others: '함께한 사람',
    weather: '날씨', mood: '기분', oneLine: '한마디', moment: '기억에 남는 순간', friendsMet: '만난 친구', teachersMet: '만난 선생님',
    food: '먹은 음식', song: '들은 노래', school: '학교생활', fandom: '덕질', achievement: '성취', regret: '아쉬웠던 일', memo: '메모',
    category: '카테고리', highlight: '기억에 남는 사건', review: '후기 · 감상', diaries: '관련 일기',
    honorific: '호칭', subject: '과목', years: '담당 학년도', homeroom: '담임', style: '수업 방식', quotes: '기억에 남는 말씀',
    funny: '재미있었던 일', thanks: '감사했던 순간', moments: '추억', field: '분야', teacher: '담당 선생님', joinDate: '가입', leaveDate: '탈퇴',
    grades: '활동 학년', regular: '정기 활동', special: '특별 활동', activities: '활동 기록', memorable: '기억에 남는 사건',
    classmates: '같은 반 친구', composition: '학급 구성', semester: '학기', done: '완료', org: '수여 기관', rank: '등급 · 순위',
    fromKind: '보낸 사람', fromTeacher: '보낸 선생님', fromFriend: '보낸 친구', fromText: '보낸 사람',
    job: '직업', agency: '소속', firstLiked: '처음 관심을 가진 날', reason: '좋아하는 이유', works: '연결된 작품', year: '제작 연도',
    producer: '제작사', watchedDate: '관람 날짜', castText: '출연진', cast: '출연 인물', favChar: '좋아하는 캐릭터', rating: '평점',
    work: '작품', time: '시간', venue: '공연장', round: '회차', seat: '좌석', companions: '동행인', casting: '캐스팅', castLinks: '캐스팅 인물',
    scenes: '기억에 남는 장면', status: '상태', price: '가격', shop: '구매처', persons: '인물', artist: '가수', composer: '작곡가', album: '앨범',
    playlists: '플레이리스트', event: '덕질 사건', scores: '과목별 점수', nextGoal: '다음 목표', submitDate: '제출 날짜', method: '평가 방식',
    prep: '준비 내용', score: '점수', feedback: '후기', minutes: '공부 시간', goal: '목표', goalDone: '목표 달성', books: '교재', publisher: '출판사', progress: '진도'
  };
  const UNITS = { height: 'cm', weight: 'kg', shoe: 'mm', foot: 'mm', minutes: '분', price: '원', year: '년' };
  const SKIP = { fav: 1, theme: 1, avatar: 1, cardStyle: 1, cardColor: 1, isCover: 1, secret: 1, items: 1, target: 1, order: 1, hidden: 1, table: 1, bg: 1, border: 1, themeId: 1 };
  const YES = { homeroom: '담임 선생님', done: '완료', goalDone: '달성' };

  function fmtVal(k, v, names) {
    const U = M.ui;
    if (v == null || v === '' || v === false || (Array.isArray(v) && !v.length)) return null;
    if (v === true) return YES[k] || '예';
    if (Array.isArray(v)) {
      if (typeof v[0] === 'object') {
        return v.map(function (o) {
          return Object.keys(o).map(function (kk) { const x = o[kk]; return /^\d{4}-\d{2}-\d{2}$/.test(x) ? U.fmtDate(x, false) : x; }).filter(Boolean).join(' · ');
        }).join('\n');
      }
      return v.map(function (x) { return names[x] || x; }).join(', ');
    }
    if (typeof v === 'object') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return U.fmtDate(v, false);
    if (typeof v === 'number' && k === 'price') return v.toLocaleString('ko-KR') + '원';
    return String(v) + (UNITS[k] && typeof v === 'number' ? UNITS[k] : '');
  }

  async function loadAll() {
    const [records, media] = await Promise.all([
      M.db._run(['records'], 'readonly', function (t) { return M.db._reqP(t.objectStore('records').getAll()); }),
      M.db._run(['media'], 'readonly', function (t) { return M.db._reqP(t.objectStore('media').getAll()); })
    ]);
    const live = records.filter(function (r) { return !r.trashed; });
    const names = {};
    live.forEach(function (r) { if (r.title) names[r.id] = r.title; });
    const kinds = {};
    media.forEach(function (m) { kinds[m.id] = m.kind; });
    return { records: live, names: names, kinds: kinds };
  }
  function imagesOf(rec, kinds, max) {
    return (rec.mediaIds || []).filter(function (id) { return kinds[id] === 'image'; }).slice(0, max || 6);
  }

  function recordBlock(rec, ctx, withPhotos) {
    const esc = M.ui.esc, U = M.ui;
    const rows = Object.keys(rec.data || {}).filter(function (k) { return !SKIP[k] && LABELS[k]; }).map(function (k) {
      const v = fmtVal(k, rec.data[k], ctx.names);
      return v ? '<div><dt>' + LABELS[k] + '</dt><dd>' + esc(v).replace(/\n/g, '<br>') + '</dd></div>' : '';
    }).join('');
    const imgs = withPhotos ? imagesOf(rec, ctx.kinds, 6) : [];
    return '<article class="pr-rec"><h3>' + esc(rec.title || '(제목 없음)') + '</h3>' +
      '<p class="pr-meta">' + [M.typeLabel(rec.type), rec.date ? U.fmtDate(rec.date) : '', rec.grade ? rec.grade + '학년' : ''].filter(Boolean).join(' · ') +
      (rec.tags && rec.tags.length ? ' · ' + rec.tags.map(function (t) { return '#' + esc(t); }).join(' ') : '') + '</p>' +
      (rows ? '<dl class="pr-dl">' + rows + '</dl>' : '') +
      (imgs.length ? '<div class="pr-photos">' + imgs.map(function (id) { return '<img data-media="' + esc(id) + '" data-variant="full" alt="">'; }).join('') + '</div>' : '') +
      '</article>';
  }

  /* 인쇄 전에 사진이 다 불러와질 때까지 기다림 */
  function waitImages(root) {
    const imgs = Array.from(root.querySelectorAll('img'));
    return Promise.all(imgs.map(function (img) {
      if (img.complete && img.naturalWidth) return true;
      return new Promise(function (res) {
        const t = setTimeout(res, 8000);
        img.addEventListener('load', function () { clearTimeout(t); res(); }, { once: true });
        img.addEventListener('error', function () { clearTimeout(t); res(); }, { once: true });
      });
    }));
  }
  async function print(root) {
    M.ui.hydrate(root);
    await new Promise(function (r) { setTimeout(r, 300); });
    await waitImages(root);
    /* 안드로이드 앱 안에서는 휴대폰의 인쇄 화면(PDF로 저장 가능)을 열어요 */
    if (window.AndroidDiary) window.AndroidDiary.print(document.title || '중학생활 다이어리');
    else window.print();
  }

  /* =========================================================
     다이어리 전체 인쇄
     ========================================================= */
  const GROUPS = [
    { id: 'profile', name: '🙋 프로필', types: ['profile'] },
    { id: 'growth', name: '🌱 성장 기록', types: ['growth'] },
    { id: 'diary', name: '📔 일상 다이어리', types: ['diary'] },
    { id: 'memory', name: '📸 추억 보관함', types: ['memory'] },
    { id: 'friends', name: '👭 친구 수첩', types: ['friend', 'friendMemory'] },
    { id: 'school', name: '🏫 학교생활 수첩', types: ['teacher', 'club', 'classInfo', 'timetable', 'schoolEvent', 'schedule', 'award', 'letter'] },
    { id: 'fandom', name: '💖 덕질노트', types: ['person', 'work', 'performance', 'goods', 'music', 'fandomDiary'] },
    { id: 'study', name: '📚 학업 기록', types: ['exam', 'assessment', 'studyLog', 'book'] }
  ];

  async function printView(el, head) {
    const esc = M.ui.esc;
    el.innerHTML = head +
      '<section class="card tape no-print"><h2 class="sec-title">🖨️ 다이어리 인쇄 · PDF</h2>' +
        '<p class="desc">인쇄할 메뉴를 고르고 "미리보기 만들기"를 누른 뒤 "인쇄 / PDF로 저장"을 눌러요. 인쇄 창에서 대상(프린터)을 <b>"PDF로 저장"</b>으로 바꾸면 PDF 파일이 돼요. 비공개 메모는 인쇄되지 않아요.</p>' +
        '<div class="choice" id="pGroups">' + GROUPS.map(function (g) {
          return '<label class="chk"><input type="checkbox" value="' + g.id + '" checked><span>' + g.name + '</span></label>';
        }).join('') + '</div>' +
        '<div class="toolbar-in mt8"><select class="inp" id="pGrade" aria-label="학년"><option value="">모든 학년</option><option value="1">1학년</option><option value="2">2학년</option><option value="3">3학년</option></select>' +
        '<label class="switch"><input type="checkbox" id="pPhotos" checked><span>사진 넣기</span></label>' +
        '<button type="button" class="btn" id="pMake">👀 미리보기 만들기</button>' +
        '<button type="button" class="btn primary" id="pPrint" disabled>🖨️ 인쇄 / PDF로 저장</button></div>' +
      '</section><div id="pDoc"></div>';
    const doc = el.querySelector('#pDoc');
    el.querySelector('#pMake').addEventListener('click', async function () {
      const groups = Array.from(el.querySelectorAll('#pGroups input:checked')).map(function (i) { return i.value; });
      const g = el.querySelector('#pGrade').value;
      const photos = el.querySelector('#pPhotos').checked;
      const ctx = await loadAll();
      const prof = ctx.records.find(function (r) { return r.type === 'profile'; });
      let html = '<div class="print-doc"><section class="pb-page pr-cover"><h1>📒 나의 중학생활 다이어리</h1><p>' +
        esc(prof && prof.title ? prof.title : '') + (g ? ' · ' + g + '학년' : '') + '</p><p class="pr-date">' + esc(M.ui.fmtDate(M.ui.today())) + ' 인쇄</p></section>';
      let total = 0;
      GROUPS.filter(function (x) { return groups.indexOf(x.id) >= 0; }).forEach(function (grp) {
        const list = ctx.records.filter(function (r) { return grp.types.indexOf(r.type) >= 0 && (!g || String(r.grade) === g || r.type === 'profile'); })
          .sort(function (a, b) { return grp.types.indexOf(a.type) - grp.types.indexOf(b.type) || ((a.date || '') < (b.date || '') ? -1 : 1); });
        if (!list.length) return;
        total += list.length;
        html += '<section class="pb-page"><h2 class="pr-h">' + grp.name + ' <small>' + list.length + '개</small></h2>' +
          list.map(function (r) { return recordBlock(r, ctx, photos); }).join('') + '</section>';
      });
      html += '</div>';
      doc.innerHTML = total ? html : M.ui.empty('🖨️', '고른 조건에 맞는 기록이 없어요.', null);
      M.ui.hydrate(doc);
      el.querySelector('#pPrint').disabled = !total;
      if (total) M.toast('미리보기를 만들었어요. 기록 ' + total + '개');
    });
    el.querySelector('#pPrint').addEventListener('click', function () { print(doc); });
  }

  /* =========================================================
     졸업 포토북
     ========================================================= */
  const SECTIONS = [
    ['cover', '📕 표지'], ['toc', '📑 목차'], ['grades', '🎒 학년별 기록'], ['friends', '👭 친구와의 추억'], ['school', '🏫 학교생활'],
    ['fandom', '💖 공연 및 덕질 기록'], ['growth', '🌱 성장 기록'], ['pages', '🎀 꾸민 페이지'], ['last', '💌 마지막 페이지']
  ];
  const DEFAULT = {
    title: '나의 중학교 3년', subtitle: '20XX ~ 20XX', grades: [1, 2, 3],
    sections: { cover: true, toc: true, grades: true, friends: true, school: true, fandom: true, growth: true, pages: false, last: true },
    coverId: '', lastMessage: '3년 동안 정말 고마웠어, 나의 중학교!\n앞으로도 반짝반짝 빛나길 ✨'
  };

  function photo(id, cls) { return id ? '<div class="pb-ph ' + (cls || '') + '"><img data-media="' + M.ui.esc(id) + '" data-variant="full" alt=""></div>' : ''; }
  function firstImg(r, ctx) { return imagesOf(r, ctx.kinds, 1)[0]; }
  function card(r, ctx, sub, text) {
    const esc = M.ui.esc;
    const img = firstImg(r, ctx);
    return '<div class="pb-card">' + (img ? photo(img) : '') + '<b>' + esc(r.title || '') + '</b>' +
      (sub ? '<small>' + esc(sub) + '</small>' : '') + (text ? '<p>' + esc(M.ui.snippet(text, 120)) + '</p>' : '') + '</div>';
  }

  async function buildBook(cfg) {
    const U = M.ui, esc = U.esc;
    const ctx = await loadAll();
    const R = ctx.records;
    const of = function (t) { return R.filter(function (r) { return r.type === t; }); };
    const inG = function (r) { return !r.grade || cfg.grades.indexOf(Number(r.grade)) >= 0; };
    const byDate = function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; };
    const prof = of('profile')[0];
    const on = cfg.sections;
    const pages = [];
    const titles = [];

    if (on.cover) {
      const cover = R.find(function (r) { return r.id === cfg.coverId; });
      const img = cover ? firstImg(cover, ctx) : (prof ? firstImg(prof, ctx) : null);
      pages.push('<section class="pb-page pb-cover"><span class="pb-tape t1"></span><span class="pb-tape t2"></span>' +
        '<p class="pb-small">GRADUATION PHOTOBOOK</p><h1>' + esc(cfg.title) + '</h1><p class="pb-sub">' + esc(cfg.subtitle) + '</p>' +
        (img ? photo(img, 'pb-cover-ph') : '<div class="pb-cover-emoji">🎓</div>') +
        '<p class="pb-name">' + esc(prof && prof.title ? prof.title : '') + (prof && prof.data.nickname ? ' (' + esc(prof.data.nickname) + ')' : '') + '</p>' +
        '<span class="pb-stk s1">🌸</span><span class="pb-stk s2">⭐</span><span class="pb-stk s3">🎀</span></section>');
    }

    const body = [];
    if (on.grades) {
      cfg.grades.slice().sort().forEach(function (g) {
        const cls = of('classInfo').filter(function (r) { return Number(r.grade) === g; })[0];
        const mems = of('memory').filter(function (r) { return Number(r.grade) === g; }).sort(byDate);
        const dias = of('diary').filter(function (r) { return Number(r.grade) === g && (firstImg(r, ctx) || r.data.oneLine); }).sort(byDate).slice(0, 12);
        const evs = of('schoolEvent').filter(function (r) { return Number(r.grade) === g; }).sort(byDate);
        if (!cls && !mems.length && !dias.length && !evs.length) return;
        titles.push(g + '학년');
        body.push('<section class="pb-page"><h2 class="pb-h">🎒 ' + g + '학년</h2>' +
          (cls ? '<p class="pb-lead">' + esc(cls.title) + (cls.data.motto ? ' · “' + esc(cls.data.motto) + '”' : '') +
            ((cls.data.homeroom || []).length ? ' · 담임 ' + esc((cls.data.homeroom || []).map(function (i) { return ctx.names[i] || ''; }).join(', ')) : '') + '</p>' : '') +
          (mems.length ? '<h3 class="pb-h3">📸 추억</h3><div class="pb-grid">' + mems.map(function (m) { return card(m, ctx, U.fmtDate(m.date, false) + (m.data.category ? ' · ' + m.data.category : ''), m.data.highlight || m.data.review); }).join('') + '</div>' : '') +
          (evs.length ? '<h3 class="pb-h3">🎉 학교 행사</h3><div class="pb-grid">' + evs.map(function (m) { return card(m, ctx, U.fmtDate(m.date, false), m.data.content); }).join('') + '</div>' : '') +
          (dias.length ? '<h3 class="pb-h3">📔 그날의 일기</h3><div class="pb-grid">' + dias.map(function (d) {
            return card(d, ctx, U.fmtDate(d.date, false) + ' ' + (d.data.mood || '') + ' ' + (d.data.weather || '').split(' ')[0], d.data.moment);
          }).join('') + '</div>' : '') + '</section>');
      });
    }
    if (on.friends) {
      const fr = of('friend').filter(function (f) {
        const gs = [1, 2, 3].filter(function (g) { return f.data['class' + g]; });
        return !gs.length || gs.some(function (g) { return cfg.grades.indexOf(g) >= 0; });
      });
      const fm = of('friendMemory').filter(inG).sort(byDate);
      if (fr.length || fm.length) {
        titles.push('친구와의 추억');
        body.push('<section class="pb-page"><h2 class="pb-h">👭 친구와의 추억</h2>' +
          (fr.length ? '<div class="pb-grid">' + fr.map(function (f) { return card(f, ctx, [f.data.nickname, f.data.relation].filter(Boolean).join(' · '), (f.tags || []).map(function (t) { return '#' + t; }).join(' ') + ' ' + (f.data.memo || '')); }).join('') + '</div>' : '') +
          (fm.length ? '<h3 class="pb-h3">💭 함께한 순간</h3><div class="pb-grid">' + fm.map(function (m) { return card(m, ctx, U.fmtDate(m.date, false) + (m.data.kind ? ' · ' + m.data.kind : ''), m.data.content); }).join('') + '</div>' : '') +
          '</section>');
      }
    }
    if (on.school) {
      const te = of('teacher').filter(inG), cl = of('club'), aw = of('award').filter(inG).sort(byDate), le = of('letter').filter(inG).sort(byDate);
      if (te.length || cl.length || aw.length || le.length) {
        titles.push('학교생활');
        body.push('<section class="pb-page"><h2 class="pb-h">🏫 학교생활</h2>' +
          (te.length ? '<h3 class="pb-h3">👩‍🏫 선생님</h3><div class="pb-grid">' + te.map(function (t) { return card(t, ctx, [t.data.subject, t.grade ? t.grade + '학년' : '', t.data.homeroom ? '담임' : ''].filter(Boolean).join(' · '), t.data.quotes ? '“' + t.data.quotes + '”' : t.data.thanks); }).join('') + '</div>' : '') +
          (cl.length ? '<h3 class="pb-h3">🎨 동아리</h3><div class="pb-grid">' + cl.map(function (c) { return card(c, ctx, c.data.field || '', c.data.memorable || c.data.regular); }).join('') + '</div>' : '') +
          (aw.length ? '<h3 class="pb-h3">🏆 상장</h3><ul class="pb-list">' + aw.map(function (a) { return '<li><b>' + esc(a.title) + '</b> ' + esc([a.data.rank, U.fmtDate(a.date, false)].filter(Boolean).join(' · ')) + '</li>'; }).join('') + '</ul>' : '') +
          (le.length ? '<h3 class="pb-h3">💌 받은 편지</h3><div class="pb-grid">' + le.map(function (l) { return card(l, ctx, [l.data.fromKind, U.fmtDate(l.date, false)].filter(Boolean).join(' · '), l.data.content); }).join('') + '</div>' : '') +
          '</section>');
      }
    }
    if (on.fandom) {
      const ps = of('person'), sh = of('performance').sort(byDate), wk = of('work');
      if (ps.length || sh.length || wk.length) {
        titles.push('공연 및 덕질 기록');
        body.push('<section class="pb-page"><h2 class="pb-h">💖 공연 및 덕질 기록</h2>' +
          (ps.length ? '<h3 class="pb-h3">🌟 좋아한 사람들</h3><div class="pb-grid">' + ps.map(function (p) { return card(p, ctx, p.data.job || '', p.data.reason); }).join('') + '</div>' : '') +
          (wk.length ? '<h3 class="pb-h3">🎭 작품</h3><div class="pb-grid">' + wk.map(function (w) { return card(w, ctx, [w.data.field, w.data.rating].filter(Boolean).join(' · '), w.data.review); }).join('') + '</div>' : '') +
          (sh.length ? '<h3 class="pb-h3">🎫 관람 기록 · 총 ' + sh.length + '회</h3><ul class="pb-list">' + sh.map(function (s) { return '<li>' + esc(U.fmtDate(s.date, false)) + ' <b>' + esc(s.title) + '</b> ' + esc(s.data.venue || '') + '</li>'; }).join('') + '</ul>' : '') +
          '</section>');
      }
    }
    if (on.growth) {
      const gr = of('growth').sort(byDate);
      if (gr.length) {
        titles.push('성장 기록');
        const last = function (g, k) {
          const l = gr.filter(function (r) { return Number(r.grade) === g && r.data[k] != null && r.data[k] !== ''; });
          return l.length ? l[l.length - 1].data[k] : null;
        };
        const ph = function (g) { const l = gr.filter(function (r) { return Number(r.grade) === g && firstImg(r, ctx); }); return l.length ? firstImg(l[l.length - 1], ctx) : null; };
        const gs = cfg.grades.slice().sort();
        const rows = [['height', '키', 'cm'], ['weight', '몸무게', 'kg'], ['shoe', '신발', 'mm'], ['dream', '장래희망', ''], ['interests', '관심사', ''], ['voice', '목소리', '']];
        body.push('<section class="pb-page"><h2 class="pb-h">🌱 성장 기록</h2><div class="pb-grow">' +
          gs.map(function (g) { return '<div class="pb-gcol"><h3 class="pb-h3">' + g + '학년</h3>' + (photo(ph(g)) || '<div class="pb-ph empty">🌱</div>') + '</div>'; }).join('') + '</div>' +
          '<table class="pb-table"><thead><tr><th></th>' + gs.map(function (g) { return '<th>' + g + '학년</th>'; }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr><th>' + r[1] + '</th>' + gs.map(function (g) { const v = last(g, r[0]); return '<td>' + (v == null ? '-' : esc(v) + r[2]) + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table></section>');
      }
    }
    if (on.pages) {
      const ps = of('page');
      if (ps.length) {
        titles.push('꾸민 페이지');
        const host = document.querySelector('.d-stage') || document.documentElement;
        for (const p of ps) {
          try {
            const c = await M.deco.toCanvas(p, host);
            body.push('<section class="pb-page pb-deco"><img src="' + c.toDataURL('image/jpeg', 0.9) + '" alt="' + esc(p.title) + '"></section>');
          } catch (e) { /* 그리지 못한 페이지는 건너뜀 */ }
        }
      }
    }
    if (on.toc && titles.length) {
      pages.push('<section class="pb-page pb-toc"><h2 class="pb-h">📑 목차</h2><ol>' + titles.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ol></section>');
    }
    pages.push.apply(pages, body);
    if (on.last) {
      pages.push('<section class="pb-page pb-last"><span class="pb-tape t1"></span><div class="pb-last-emoji">🎓</div><h2>졸업을 축하해!</h2>' +
        '<p class="pb-msg">' + esc(cfg.lastMessage).replace(/\n/g, '<br>') + '</p><p class="pb-small">' + esc(U.fmtDate(U.today())) + '</p>' +
        '<span class="pb-stk s1">💐</span><span class="pb-stk s3">✨</span></section>');
    }
    return '<div class="print-doc pb-book">' + pages.join('') + '</div>';
  }

  async function photobookView(el, head) {
    const esc = M.ui.esc;
    const saved = await M.db.getMeta('photobook');
    const cfg = Object.assign({}, DEFAULT, saved || {});
    cfg.sections = Object.assign({}, DEFAULT.sections, (saved && saved.sections) || {});
    const prof = await M.ui.loadProfile();
    if (!saved && prof && prof.data.entryDate) {
      const y = Number(prof.data.entryDate.slice(0, 4));
      cfg.subtitle = y + ' ~ ' + (prof.data.gradDate ? prof.data.gradDate.slice(0, 4) : y + 3);
    }
    const mems = (await M.db.list('memory')).concat(await M.db.list('schoolEvent')).filter(function (r) { return (r.mediaIds || []).length; });

    el.innerHTML = head +
      '<section class="card tape no-print pb-controls"><h2 class="sec-title">📚 졸업 기념 포토북 만들기</h2>' +
        '<p class="desc">넣고 싶은 학년과 내용을 고르면 아래에 포토북이 만들어져요. "인쇄 / PDF로 저장"을 누르고 대상을 <b>"PDF로 저장"</b>으로 고르면 PDF 포토북이 돼요. 설정은 자동으로 저장돼요.</p>' +
        '<div class="form-grid pb-form">' +
          '<div class="field"><label class="flabel" for="bTitle">포토북 제목</label><input class="inp" id="bTitle" value="' + esc(cfg.title) + '"></div>' +
          '<div class="field"><label class="flabel" for="bSub">부제목 · 기간</label><input class="inp" id="bSub" value="' + esc(cfg.subtitle) + '"></div>' +
          '<div class="field full"><span class="flabel">넣을 학년</span><div class="choice">' + [1, 2, 3].map(function (g) {
            return '<label class="chk"><input type="checkbox" data-bg="' + g + '"' + (cfg.grades.indexOf(g) >= 0 ? ' checked' : '') + '><span>' + g + '학년</span></label>';
          }).join('') + '</div></div>' +
          '<div class="field full"><span class="flabel">넣을 내용</span><div class="choice">' + SECTIONS.map(function (s) {
            return '<label class="chk"><input type="checkbox" data-bs="' + s[0] + '"' + (cfg.sections[s[0]] ? ' checked' : '') + '><span>' + s[1] + '</span></label>';
          }).join('') + '</div></div>' +
          '<div class="field full"><label class="flabel" for="bCover">표지 사진</label><select class="inp" id="bCover"><option value="">프로필 사진 (없으면 🎓)</option>' +
            mems.map(function (m) { return '<option value="' + m.id + '"' + (cfg.coverId === m.id ? ' selected' : '') + '>' + esc(m.title) + '</option>'; }).join('') + '</select></div>' +
          '<div class="field full"><label class="flabel" for="bLast">마지막 페이지에 남길 말</label><textarea class="inp" id="bLast" rows="3">' + esc(cfg.lastMessage) + '</textarea></div>' +
        '</div>' +
        '<div class="toolbar-in"><button type="button" class="btn" id="bMake">👀 포토북 미리보기</button><button type="button" class="btn primary" id="bPrint" disabled>🖨️ 인쇄 / PDF로 저장</button></div>' +
      '</section><div id="bDoc"></div>';

    const $ = function (s) { return el.querySelector(s); };
    function read() {
      return {
        title: $('#bTitle').value.trim() || DEFAULT.title, subtitle: $('#bSub').value.trim(),
        grades: Array.from(el.querySelectorAll('[data-bg]:checked')).map(function (i) { return Number(i.dataset.bg); }),
        sections: SECTIONS.reduce(function (o, s) { o[s[0]] = !!el.querySelector('[data-bs="' + s[0] + '"]').checked; return o; }, {}),
        coverId: $('#bCover').value, lastMessage: $('#bLast').value
      };
    }
    const saver = M.autosave.create(function (v) { return M.db.setMeta('photobook', v); }, 600);
    el.querySelector('.pb-controls').addEventListener('input', function () { saver.schedule(read); });
    el.querySelector('.pb-controls').addEventListener('change', function () { saver.schedule(read); });
    const doc = $('#bDoc');
    $('#bMake').addEventListener('click', async function (e) {
      const b = e.currentTarget;
      const c = read();
      if (!c.grades.length) { M.toast('학년을 하나 이상 골라 주세요.', true); return; }
      b.disabled = true; b.textContent = '⏳ 만드는 중…';
      try {
        doc.innerHTML = await buildBook(c);
        M.ui.hydrate(doc);
        const n = doc.querySelectorAll('.pb-page').length;
        $('#bPrint').disabled = !n;
        M.toast('포토북 ' + n + '장(섹션)을 만들었어요 📚');
      } catch (err) { M.toast('포토북을 만들지 못했어요: ' + M.db.friendly(err).message, true); }
      b.disabled = false; b.textContent = '👀 포토북 미리보기';
    });
    $('#bPrint').addEventListener('click', function () { print(doc); });
  }

  return { printView: printView, photobookView: photobookView, buildBook: buildBook, recordBlock: recordBlock, loadAll: loadAll };
})();

/* ===== js/app.js ===== */
/* 화면 이동(라우터) · 사이드바 · 테마 적용 */
(function () {
  const M = window.MMSD;
  M.VERSION = '2026-11-08 (3)';
  const view = document.getElementById('view');
  const nav = document.getElementById('nav');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('overlay');
  const menuBtn = document.getElementById('menuBtn');
  const topbarTitle = document.getElementById('topbarTitle');
  const toastEl = document.getElementById('toast');
  let toastTimer = null;

  /* ---------- 알림 ---------- */
  function toast(msg, isError, action) {
    toastEl.innerHTML = '';
    toastEl.appendChild(document.createTextNode(msg));
    toastEl.classList.toggle('error', !!isError);
    toastEl.classList.toggle('has-action', !!action);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-btn';
      b.textContent = action.label;
      b.addEventListener('click', function () {
        toastEl.classList.remove('show');
        Promise.resolve(action.fn()).catch(function (e) { toast(M.db.friendly(e).message, true); });
      });
      toastEl.appendChild(b);
    }
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, isError ? 5500 : (action ? 6000 : 2200));
  }
  M.toast = toast;
  function saved(ok, msg) {
    if (ok) toast(msg);
    else toast('저장하지 못했어요. 브라우저 저장 공간이나 개인정보 보호 모드를 확인해 주세요.', true);
  }

  /* ---------- 사이드바 ---------- */
  function buildNav() {
    nav.innerHTML = M.menu.filter(function (m) { return !m.hidden; }).map(function (m) {
      return '<li><a href="#/' + m.id + '" data-id="' + m.id + '">' +
        '<span class="nav-ic" aria-hidden="true">' + m.icon + '</span><span>' + m.title + '</span></a></li>';
    }).join('');
  }
  function openSidebar() {
    sidebar.classList.add('open');
    overlay.classList.add('show');
    menuBtn.setAttribute('aria-expanded', 'true');
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('show');
    menuBtn.setAttribute('aria-expanded', 'false');
  }
  menuBtn.addEventListener('click', function () {
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
  });
  overlay.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sidebar.classList.contains('open')) { closeSidebar(); menuBtn.focus(); }
  });

  /* ---------- 라우터: #/메뉴/하위/... ---------- */
  function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    const id = M.findMenu(parts[0]) ? parts[0] : 'home';
    return { id: id, sub: id === parts[0] ? parts.slice(1).filter(function (x) { return x !== ''; }) : [] };
  }

  function header(menu) {
    const s = M.settings.get();
    const own = s.pageThemes[menu.id] || '';
    const defaultName = M.themes.byId(s.defaultTheme).name;
    const opts = '<option value="">기본 테마 따르기 (' + defaultName + ')</option>' +
      M.themes.list.map(function (t) {
        return '<option value="' + t.id + '"' + (own === t.id ? ' selected' : '') + '>' + t.emoji + ' ' + t.name + '</option>';
      }).join('');
    return '<div class="page-head">' +
      '<div><h1 class="page-title"><a href="#/' + menu.id + '" class="title-link"><span aria-hidden="true">' + menu.icon + '</span> <span class="hl">' + menu.title + '</span></a></h1>' +
      '<p class="page-sub">' + menu.sub + '</p></div>' +
      '<label class="theme-pick">🎨 이 페이지 테마' +
      '<select class="select" id="pageThemeSelect">' + opts + '</select></label>' +
      '</div>';
  }

  let renderSeq = 0;
  async function render(keepScroll) {
    if (M.accounts.isLocked()) return;   /* 로그인 전에는 아무 기록도 화면에 그리지 않음 */
    const seq = ++renderSeq;
    const r = route();
    const id = r.id;
    const menu = M.findMenu(id);
    const themeId = M.themes.effectiveFor(id);
    M.themes.apply(themeId);

    nav.querySelectorAll('a').forEach(function (a) {
      if (a.dataset.id === id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    topbarTitle.textContent = menu.icon + ' ' + menu.title;
    document.title = (id === 'home' ? '' : menu.title + ' · ') + 'MY MIDDLE SCHOOL DIARY';

    M.media.releaseAll();
    const banner = M.dbError
      ? '<div class="db-banner" role="alert"><b>⚠️ 기록 저장소를 열 수 없어요.</b> ' + M.dbError.message +
        ' 지금은 기록이 저장되지 않으니, 문제를 해결한 뒤 새로고침해 주세요.</div>'
      : '';
    const scrollY = window.scrollY;
    view.innerHTML = banner + header(menu) + '<div id="pageBody"><p class="empty loading">불러오는 중…</p></div>';
    bindHeader(id);
    const body = document.getElementById('pageBody');

    try {
      if (!M.profile) await M.ui.loadProfile();
      if (seq !== renderSeq) return;
      if (M.mods[id]) {
        await M.mods[id](body, r.sub, themeId);
      } else if (id === 'settings') {
        body.innerHTML = M.pages.settings();
        bindSettings();
        M.pages.fillStorage(document.getElementById('storageInfo'));
      } else {
        body.innerHTML = M.pages.placeholder(menu);
      }
      if (seq !== renderSeq) return;
      M.ui.hydrate(body);
    } catch (e) {
      console.error(e);
      if (seq === renderSeq) {
        body.innerHTML = '<div class="db-banner" role="alert"><b>⚠️ 화면을 불러오지 못했어요.</b> ' +
          M.ui.esc(M.db.friendly(e).message) + ' 새로고침해도 계속되면 백업 후 브라우저를 바꿔 보세요.</div>';
      }
    }
    if (keepScroll) window.scrollTo(0, scrollY);
    else { window.scrollTo(0, 0); view.focus({ preventScroll: true }); }
  }
  M.rerender = function () { render(true); };

  function bindHeader(id) {
    document.getElementById('pageThemeSelect').addEventListener('change', async function (e) {
      await M.autosave.flushAll();
      saved(M.settings.setPageTheme(id, e.target.value), '이 페이지 테마를 저장했어요 🎨');
      render(true);
    });
  }

  M.bindSettings = function () { bindSettings(); };
  function bindSettings() {
    view.querySelectorAll('[data-pick-default]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const t = M.themes.byId(btn.dataset.pickDefault);
        saved(M.settings.setDefaultTheme(t.id), '기본 테마를 "' + t.name + '"(으)로 바꿨어요');
        render(true);
      });
    });
    view.querySelectorAll('[data-page-theme]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        const page = sel.dataset.pageTheme;
        saved(M.settings.setPageTheme(page, sel.value), M.findMenu(page).title + ' 테마를 저장했어요');
        render(true);
      });
    });
  }

  /* 페이지 이동 전에 저장하지 못한 기록이 있으면 먼저 저장, 실패하면 물어봄 */
  let lastHash = location.hash;
  let ignoreNext = false;
  M.replaceHash = function (h) {
    history.replaceState(null, '', h);
    lastHash = location.hash;
  };
  window.addEventListener('hashchange', async function () {
    if (ignoreNext) { ignoreNext = false; return; }
    closeSidebar();
    if (M.autosave.hasUnsaved()) {
      const ok = await M.autosave.flushAll();
      if (!ok && !window.confirm('아직 저장하지 못한 기록이 있어요. 이동하면 방금 입력한 내용이 사라질 수 있어요.\n그래도 이동할까요?')) {
        ignoreNext = true;
        location.hash = lastHash;
        return;
      }
    }
    lastHash = location.hash;
    render(false);
  });

  buildNav();

  /* 로그인 → 그 계정의 기록 저장소를 연 뒤 첫 화면 표시 (로그아웃 후 다시 로그인할 때도 사용) */
  M.start = async function () {
    await M.accounts.gate();
    M.dbError = null;
    try {
      await M.db.open();
      M.dbReady = true;
      M.media.cleanupOrphans().catch(function () { return 0; });
    } catch (e) {
      M.dbError = M.db.friendly(e);
    }
    M.accounts.refreshUI();
    if (M.protectStorage) M.protectStorage();
    render(false);
  };
  M.start();

  /* 사이드바 검색 · 로그아웃 */
  const sForm = document.getElementById('sideSearch');
  if (sForm) sForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const q = sForm.querySelector('input').value.trim();
    location.hash = '#/search/' + encodeURIComponent(q);
    sForm.querySelector('input').value = '';
  });
  const outBtn = document.getElementById('logoutBtn');
  if (outBtn) outBtn.addEventListener('click', function () { closeSidebar(); M.accounts.logout(); });

  /* ---------- 웹앱: 인터넷 없이 열기 · 앱으로 설치 ---------- */
  const isWeb = (location.protocol === 'https:' || location.hostname === 'localhost') && !window.AndroidDiary;
  if (isWeb && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* 설치 기능 없이도 그대로 쓸 수 있어요 */ });
  }
  let installEvt = null;
  const installBtn = document.getElementById('installBtn');
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installEvt = e;
    if (installBtn) installBtn.hidden = false;
  });
  if (installBtn) installBtn.addEventListener('click', async function () {
    if (!installEvt) return;
    installEvt.prompt();
    const r = await installEvt.userChoice;
    installEvt = null;
    installBtn.hidden = true;
    if (r && r.outcome === 'accepted') toast('홈 화면에 다이어리 앱을 설치했어요 📲');
  });
  window.addEventListener('appinstalled', function () { if (installBtn) installBtn.hidden = true; });

  /* 앱으로 설치해서 쓸 때는 브라우저가 기록을 함부로 지우지 않도록 자동으로 요청해요 */
  M.protectStorage = function () {
    const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    if (!standalone || !navigator.storage || !navigator.storage.persist) return;
    navigator.storage.persisted().then(function (p) { if (!p) navigator.storage.persist(); }).catch(function () {});
  };
})();

