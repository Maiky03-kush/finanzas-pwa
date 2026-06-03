const CACHE = 'finanzas-v22';
const ASSETS = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json'];

// Solo cachear recursos propios del dominio
const isOwnOrigin = url => url.startsWith(self.location.origin);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Solo interceptar GET de nuestro propio dominio
  if (e.request.method !== 'GET') return;
  if (!isOwnOrigin(e.request.url)) return;
  // No interceptar llamadas a la API ni auth
  const path = new URL(e.request.url).pathname;
  if (path.startsWith('/api/') || path.startsWith('/auth/') || path === '/health') return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if (res.ok && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
      // Cache-first para assets, network-first para HTML (para recibir CSP fresco)
      const isHTML = e.request.headers.get('accept')?.includes('text/html');
      if (isHTML) {
        return networkFetch.catch(() => cached || caches.match('/index.html'));
      }
      return cached || networkFetch.catch(() => caches.match('/index.html'));
    })
  );
});
