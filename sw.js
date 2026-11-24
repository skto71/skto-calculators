/* СКТО | Конькобежные расчёты — service worker
 *
 * Этот файл принадлежит ОБОЛОЧКЕ. Для обновления одного из калькуляторов
 * его менять НЕ нужно: модули обновляются заменой своей папки в modules/.
 * Менять sw.js нужно только при добавлении нового модуля (список MODULE_IDS)
 * или при изменении списка файлов оболочки (SHELL_FILES / STATIC_FILES).
 *
 * Кэши (у каждого свой, независимый):
 *   skto-tools-shell        оболочка: index.html, manifest, version.json
 *   skto-tools-static       иконки
 *   skto-tools-mod-<id>     по одному кэшу на каждый модуль
 * ВАЖНО: на github.io все проекты одного пользователя делят один origin
 * (в том числе «Дневник конькобежца»), поэтому sw.js удаляет ТОЛЬКО кэши
 * с префиксом «skto-tools-» и никогда не трогает чужие.
 */
'use strict';

const PREFIX = 'skto-tools-';
const SHELL_CACHE = PREFIX + 'shell';
const STATIC_CACHE = PREFIX + 'static';
const MODULE_CACHE_PREFIX = PREFIX + 'mod-';
const modCache = id => MODULE_CACHE_PREFIX + id;

/* Модули, которые нужно сохранить для офлайна сразу при установке.
   Список файлов каждого модуля лежит в modules/<id>/files.json. */
const MODULE_IDS = ['age-groups', 'ranks'];

const SHELL_FILES = ['index.html', 'manifest.webmanifest', 'version.json'];
const STATIC_FILES = [
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/favicon.png'
];

/* Ревизия иконок: 2 (смена этого файла заставляет браузер переустановить SW и заново скачать иконки). */
const NET_TIMEOUT = 4000; // мс: при плохой связи показываем сохранённую копию

const SCOPE = self.registration.scope;               // всегда оканчивается на «/»
const SCOPE_PATH = new URL(SCOPE).pathname;
const abs = p => new URL(p, SCOPE).href;

/* Ключ в кэше: без ?query и #hash; «папка/» = «папка/index.html» */
function keyFor(url) {
  const u = new URL(url);
  u.search = ''; u.hash = '';
  if (u.pathname.endsWith('/')) u.pathname += 'index.html';
  return u.href;
}

function classify(u) {
  if (!u.pathname.startsWith(SCOPE_PATH)) return null;
  const rel = u.pathname.slice(SCOPE_PATH.length);
  if (rel === '' || rel === 'index.html' || rel === 'manifest.webmanifest') return { type: 'shell' };
  if (rel === 'version.json') return { type: 'version' };
  if (rel.startsWith('icons/')) return { type: 'static' };
  if (rel.startsWith('modules/')) {
    const id = rel.split('/')[1];
    if (/^[a-z0-9-]+$/.test(id || '')) return { type: 'module', id };
  }
  return null; // sw.js и всё прочее — обычная сеть
}

/* ---------- загрузка набора файлов «всё или ничего» ---------- */
async function fetchFiles(paths) {
  return Promise.all(paths.map(async p => {
    const r = await fetch(abs(p), { cache: 'reload' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + p);
    return [keyFor(abs(p)), r];
  }));
}
async function fetchModuleFiles(id) {
  const base = 'modules/' + id + '/';
  const r = await fetch(abs(base + 'files.json'), { cache: 'reload' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + base + 'files.json');
  const list = (await r.json()).files;
  if (!Array.isArray(list) || !list.length) throw new Error('files.json пуст: ' + id);
  const entries = await fetchFiles(list.map(f => base + f));
  const jr = await fetch(abs(base + 'files.json'), { cache: 'reload' });
  entries.push([keyFor(abs(base + 'files.json')), jr]);
  return entries;
}
async function commit(cacheName, entries) {
  const cache = await caches.open(cacheName);
  for (const [k, r] of entries) await cache.put(k, r);
}
/* Заменить содержимое кэша модуля новой версией; лишние старые файлы удаляются
   только ПОСЛЕ того, как все новые файлы успешно скачаны. */
async function refreshModule(id) {
  const entries = await fetchModuleFiles(id);
  const cache = await caches.open(modCache(id));
  for (const [k, r] of entries) await cache.put(k, r);
  const keep = new Set(entries.map(e => e[0]));
  for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
  return entries.length;
}
async function refreshShell() {
  await commit(SHELL_CACHE, await fetchFiles(SHELL_FILES));
  await commit(STATIC_CACHE, await fetchFiles(STATIC_FILES));
}

/* ---------- install / activate ---------- */
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const shell = await fetchFiles(SHELL_FILES);
    const stat = await fetchFiles(STATIC_FILES);
    const mods = {};
    for (const id of MODULE_IDS) mods[id] = await fetchModuleFiles(id);
    // всё скачано без ошибок — только теперь записываем в кэши
    await commit(SHELL_CACHE, shell);
    await commit(STATIC_CACHE, stat);
    for (const id of MODULE_IDS) await commit(modCache(id), mods[id]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // чистим только свои устаревшие кэши (с префиксом skto-tools-)
    for (const name of await caches.keys()) {
      if (!name.startsWith(PREFIX)) continue;
      if (name === SHELL_CACHE || name === STATIC_CACHE || name.startsWith(MODULE_CACHE_PREFIX)) continue;
      await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

/* ---------- стратегии ---------- */
const timeoutNull = ms => new Promise(r => setTimeout(() => r(null), ms));

function offlineModulePage() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="background:#000;color:#fff;font:16px sans-serif;padding:24px">' +
    '<h3>Модуль недоступен без интернета</h3><p style="color:#c4c8d0">Откройте приложение один раз при подключении к сети.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/* network-first: свежая версия из сети, при сбое/таймауте — сохранённая копия */
async function networkFirst(evt, cacheName, opts) {
  opts = opts || {};
  const req = evt.request, key = keyFor(req.url);
  const cache = await caches.open(cacheName);
  const cached = await cache.match(key);
  const net = fetch(req.url, { cache: opts.cache || 'no-cache' })
    .then(async r => { if (r.ok) await cache.put(key, r.clone()); return r; })
    .catch(() => null);
  if (!cached) {
    const r = await net;
    return r || (opts.fallback ? opts.fallback() : Response.error());
  }
  evt.waitUntil(net);
  const r = await Promise.race([net, timeoutNull(NET_TIMEOUT)]);
  return (r && r.ok) ? r : cached;
}

/* stale-while-revalidate: иконки */
async function staleWhileRevalidate(evt, cacheName) {
  const req = evt.request, key = keyFor(req.url);
  const cache = await caches.open(cacheName);
  const cached = await cache.match(key);
  const net = fetch(req.url, { cache: 'no-cache' })
    .then(async r => { if (r.ok) await cache.put(key, r.clone()); return r; })
    .catch(() => null);
  if (cached) { evt.waitUntil(net); return cached; }
  return (await net) || Response.error();
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return;
  const c = classify(u);
  if (!c) return;
  if (c.type === 'shell') e.respondWith(networkFirst(e, SHELL_CACHE));
  else if (c.type === 'version') e.respondWith(networkFirst(e, SHELL_CACHE, { cache: 'no-store' }));
  else if (c.type === 'static') e.respondWith(staleWhileRevalidate(e, STATIC_CACHE));
  else if (c.type === 'module') e.respondWith(networkFirst(e, modCache(c.id), { fallback: offlineModulePage }));
});

/* ---------- сообщения от оболочки ---------- */
self.addEventListener('message', e => {
  const d = e.data || {}, port = e.ports && e.ports[0];
  if (!port) return;
  e.waitUntil((async () => {
    try {
      if (d.type === 'refresh-module') {
        if (!/^[a-z0-9-]+$/.test(d.id || '')) throw new Error('bad id');
        port.postMessage({ ok: true, files: await refreshModule(d.id) });
      } else if (d.type === 'refresh-shell') {
        await refreshShell();
        port.postMessage({ ok: true });
      } else if (d.type === 'status') {
        const st = { ok: true, shell: 0, modules: {} };
        st.shell = (await (await caches.open(SHELL_CACHE)).keys()).length;
        for (const id of MODULE_IDS) st.modules[id] = (await (await caches.open(modCache(id))).keys()).length;
        port.postMessage(st);
      } else port.postMessage({ ok: false, error: 'unknown' });
    } catch (err) {
      port.postMessage({ ok: false, error: String((err && err.message) || err) });
    }
  })());
});
