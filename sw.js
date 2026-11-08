/* =========================================================
   서비스 워커 — 한 번 열면 인터넷이 없어도 다이어리가 열리게 해요.
   - 다이어리 프로그램 파일만 휴대폰에 보관해요. (기록은 원래대로 기기 안 저장소에)
   - 새 버전을 올리면 다음에 열 때 자동으로 바뀌어요.
   ========================================================= */
const VERSION = 'mmsd-v4';
const FILES = [
  './', './index.html', './manifest.webmanifest', './style.css', './app.js',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES.map(function (f) { return new Request(f, { cache: 'reload' }); })); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/* 보관해 둔 파일로 바로 열고, 인터넷이 되면 뒤에서 새 파일로 바꿔 둬요 */
self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(VERSION).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      const net = fetch(req, { cache: 'no-cache' }).then(function (res) {
        if (res && res.ok) c.put(req, res.clone());
        return res;
      }).catch(function () { return hit || (req.mode === 'navigate' ? c.match('./index.html') : undefined); });
      return hit || net;
    });
  }));
});
