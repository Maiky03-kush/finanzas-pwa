const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT          = process.env.PORT || 3000;
const ROOT          = __dirname;
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BASE_URL      = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
let   refreshToken  = process.env.GOOGLE_REFRESH_TOKEN || '';

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

function googlePost(apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = Object.entries(body)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: apiPath, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, r => {
      let buf = '';
      r.on('data', c => buf += c);
      r.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { reject(new Error(buf)); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

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
      res.writeHead(r.statusCode || 200, secHeaders({
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      }));
      res.end(data);
    });
  }).on('error', (e) => {
    res.writeHead(502, secHeaders({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }));
    res.end(JSON.stringify({ error: e.message }));
  });
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://apis.google.com",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://*.googleapis.com https://accounts.google.com",
  "img-src 'self' data: https:",
  "frame-src https://accounts.google.com",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

function secHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': CSP,
    ...extra
  };
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST' });
    res.end(); return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── /auth/login ──────────────────────────────────────────
  if (url.pathname === '/auth/login') {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      res.writeHead(500); res.end('Faltan env vars: GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET'); return;
    }
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: `${BASE_URL}/auth/callback`,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
      access_type: 'offline',
      prompt: 'consent'
    });
    res.writeHead(302, { ...secHeaders(), Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    res.end(); return;
  }

  // ── /auth/callback ───────────────────────────────────────
  if (url.pathname === '/auth/callback') {
    const code  = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error || !code) {
      res.writeHead(302, { ...secHeaders(), Location: `/?auth_error=${encodeURIComponent(error || 'missing_code')}` });
      res.end(); return;
    }
    try {
      const tokens = await googlePost('/token', {
        code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/auth/callback`, grant_type: 'authorization_code'
      });
      if (tokens.refresh_token) {
        refreshToken = tokens.refresh_token;
        console.log('\n✅ Auth OK — agrega esta variable a Railway para persistir entre reinicios:');
        console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
      }
      res.writeHead(302, {
        ...secHeaders(),
        Location: `/?at=${encodeURIComponent(tokens.access_token)}&ei=${tokens.expires_in || 3600}`
      });
      res.end();
    } catch(e) {
      console.error('Auth callback error:', e.message);
      res.writeHead(302, { ...secHeaders(), Location: `/?auth_error=token_exchange_failed` });
      res.end();
    }
    return;
  }

  // ── /auth/token ──────────────────────────────────────────
  if (url.pathname === '/auth/token') {
    if (!refreshToken) {
      res.writeHead(401, secHeaders({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }));
      res.end(JSON.stringify({ error: 'no_refresh_token' })); return;
    }
    try {
      const tokens = await googlePost('/token', {
        refresh_token: refreshToken, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token'
      });
      if (tokens.error) {
        res.writeHead(401, secHeaders({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }));
        res.end(JSON.stringify({ error: tokens.error })); return;
      }
      res.writeHead(200, secHeaders({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }));
      res.end(JSON.stringify({ access_token: tokens.access_token, expires_in: tokens.expires_in || 3600 }));
    } catch(e) {
      res.writeHead(500, secHeaders({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }));
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /auth/revoke ─────────────────────────────────────────
  if (url.pathname === '/auth/revoke' && req.method === 'POST') {
    if (refreshToken) {
      https.get(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, () => {});
      refreshToken = '';
    }
    res.writeHead(200, secHeaders({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }));
    res.end(JSON.stringify({ ok: true })); return;
  }

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

  // ── /api/history?ticker=AAPL&range=1mo ─────────────────
  if (url.pathname === '/api/history') {
    const ticker = url.searchParams.get('ticker');
    const range  = url.searchParams.get('range') || '1mo';
    if (!ticker) { res.writeHead(400); res.end('Missing ticker'); return; }
    yahooFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${encodeURIComponent(range)}`,
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
        res.writeHead(200, secHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, secHeaders({ 'Content-Type': MIME[ext] || 'application/octet-stream' }));
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`\n🚀 Finanzas PWA corriendo en ${BASE_URL}\n`);
  if (!CLIENT_SECRET) console.warn('⚠️  GOOGLE_CLIENT_SECRET no configurado\n');
  if (!refreshToken)  console.warn('⚠️  GOOGLE_REFRESH_TOKEN no configurado — visita /auth/login para autorizar\n');
  console.log('   Ctrl+C para detener\n');
});
