const CACHE = 'finanzas-v26';
const PRICE_CACHE = 'finanzas-prices-v1';
const ASSETS = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json'];

const isOwnOrigin = url => url.startsWith(self.location.origin);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE && k !== PRICE_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (!isOwnOrigin(e.request.url)) return;

  const path = new URL(e.request.url).pathname;

  // Price APIs: network-first → cache fallback (offline support)
  // Stores responses with a timestamp header for freshness tracking
  if (path === '/api/quote' || path === '/api/history') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok && res.status === 200) {
            const headers = new Headers(res.headers);
            headers.set('X-Fetched-At', String(Date.now()));
            const clone = res.clone();
            const stamped = new Response(clone.body, { status: res.status, statusText: res.statusText, headers });
            caches.open(PRICE_CACHE).then(c => c.put(e.request, stamped));
          }
          return res;
        })
        .catch(() =>
          caches.open(PRICE_CACHE)
            .then(c => c.match(e.request))
            .then(cached => cached || Response.error())
        )
    );
    return;
  }

  // Skip other API / auth routes (no caching)
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
      const isHTML = e.request.headers.get('accept')?.includes('text/html');
      if (isHTML) {
        return networkFetch.catch(() => cached || caches.match('/index.html'));
      }
      return cached || networkFetch.catch(() => caches.match('/index.html'));
    })
  );
});
