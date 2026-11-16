// Студия медитаций — офлайн-работа.  © Елена Кирсанова
// Сначала сеть (чтобы получать обновления), без интернета — сохранённая копия.
// Safari не открывает страницу, если service worker отдаёт ответ, полученный через перенаправление
// (сайт перенаправляет …/index.html → …/), поэтому страница хранится только под адресом './'.
const VERSION = 'studio-v2-2026-11-16';
const CORE = ['./', './manifest.webmanifest', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon.svg'];
async function cleanResp(r) {
  if (!r || !r.redirected) return r;
  const body = await r.blob();
  return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
}
const okResp = r => r && r.ok && r.type !== 'opaqueredirect';
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.all(CORE.map(async url => { try { const r = await cleanResp(await fetch(new Request(url, { cache: 'reload' }))); if (okResp(r)) await c.put(url, r); } catch (err) {} }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k.startsWith('studio')) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/api/')) return;
  const isPage = r.mode === 'navigate' || /\/(index\.html)?$/.test(u.pathname) && u.pathname.startsWith(new URL('./', self.registration.scope).pathname) && !/\.[a-z0-9]+$/i.test(u.pathname.replace(/index\.html$/, ''));
  const key = isPage ? './' : r;
  e.respondWith((async () => {
    try {
      const net = await cleanResp(await fetch(isPage ? new Request('./', { cache: 'no-cache' }) : r));
      if (okResp(net)) { const c = await caches.open(VERSION); await c.put(key, net.clone()); }
      return net;
    } catch (err) {
      const c = await caches.open(VERSION);
      const hit = await c.match(key, { ignoreSearch: true }) || await c.match('./');
      return hit ? cleanResp(hit) : new Response('Нет связи с интернетом', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  })());
});
