/* 청약딱 서비스 워커: 항상 네트워크를 먼저 쓰고, 연결이 없을 때만 마지막으로 받은 사본을 보여 준다.
   공고 일정이 오래된 사본으로 보이지 않도록 캐시 우선 전략은 쓰지 않는다. */
var CACHE = 'cheongyakddak-v1';
var SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'favicon.svg', 'icon-192.png',
  'data/listings.json', 'data/sync-status.json'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(fetch(req).then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) {
      return hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
    });
  }));
});
