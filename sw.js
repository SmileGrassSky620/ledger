// ============================================================
//  Service Worker：把 App 的文件缓存到手机上，没网也能打开
//  ⚠️ 每次修改了 html/css/js，都要把下面的版本号 +1，
//     否则手机会一直用旧的缓存
// ============================================================
const CACHE = 'ledger-v5';
const FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// 安装：把文件存进缓存
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

// 激活：删掉旧版本的缓存
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// 请求：先用缓存，缓存没有再上网拿
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request))
  );
});
