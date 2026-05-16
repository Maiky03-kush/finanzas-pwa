const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
};

function yahooFetch(url, res) {
  const opts = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com/'
    }
  };
  https.get(url, opts, (r) => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => {
      res.writeHead(r.statusCode || 200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
  }).on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: e.message }));
  });
}

http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' });
    res.end(); return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── /api/quote?ticker=AAPL ──────────────────────────────
  if (url.pathname === '/api/quote') {
    const ticker = url.searchParams.get('ticker');
    if (!ticker) { res.writeHead(400); res.end('Missing ticker'); return; }
    yahooFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
      res
    );
    return;
  }

  // ── /api/search?q=apple ─────────────────────────────────
  if (url.pathname === '/api/search') {
    const q = url.searchParams.get('q');
    if (!q) { res.writeHead(400); res.end('Missing q'); return; }
    yahooFetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`,
      res
    );
    return;
  }

  // ── Static files ────────────────────────────────────────
  let urlPath = url.pathname;
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);
  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`\n🚀 Finanzas PWA corriendo en http://localhost:${PORT}\n`);
  console.log('   Ctrl+C para detener\n');
});
