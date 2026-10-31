// ============================================================
//  Service Worker：让 App 没网也能打开
//  策略：有网 → 先去网上拿最新文件（顺便更新缓存）；没网 → 用缓存
//  这样每次改完代码推送后，手机联网打开就是新版，不会卡在旧版
//  ⚠️ 改了代码后还是建议把版本号 +1，旧缓存会被清理掉
// ============================================================
const CACHE = 'ledger-v6';
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

// 安装：把文件存进缓存。cache: 'reload' = 跳过浏览器缓存，一定从网上拿最新的
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
  );
  self.skipWaiting();
});

// 激活：删掉旧版本的缓存
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// 请求：只管自己网站的文件，DeepSeek 之类的外部请求直接放行
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req.url, { cache: 'no-cache' })        // 先上网拿（会向服务器确认是不是最新）
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));   // 顺便更新缓存
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })   // 没网：用缓存
        .then(hit => hit || caches.match('./index.html')))
  );
});
