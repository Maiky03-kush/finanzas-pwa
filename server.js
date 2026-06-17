const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const zlib  = require('zlib');

const PORT          = process.env.PORT || 3000;
const voiceRateLimit = new Map(); // ip → { count, resetAt }
const ROOT          = __dirname;
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BASE_URL      = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TOKEN_FILE    = path.join('/tmp', 'finanzas_refresh_token');

// Carga el refresh token: env var tiene prioridad, luego archivo persistido
let refreshToken = process.env.GOOGLE_REFRESH_TOKEN || '';
if (!refreshToken) {
  try { refreshToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) {}
}

function saveRefreshToken(token) {
  refreshToken = token;
  try { fs.writeFileSync(TOKEN_FILE, token, 'utf8'); } catch (_) {}
}

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

// Cache-Control por tipo de archivo
const CACHE_CONTROL = {
  'sw.js':         'no-store',                                      // SW siempre fresco
  '.html':         'no-cache',                                      // HTML siempre valida
  'manifest.json': 'no-cache',                                      // manifest siempre valida
  '.css':          'no-cache',
  '.js':           'no-cache',
  '.png':          'public, max-age=604800',                        // 7 días
  '.ico':          'public, max-age=604800',
  '.webp':         'public, max-age=604800',
  '.svg':          'public, max-age=604800',
};

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg']);

function cacheHeader(filename, ext) {
  const base = path.basename(filename);
  if (CACHE_CONTROL[base]) return CACHE_CONTROL[base];
  return CACHE_CONTROL[ext] || 'no-cache';
}

function sendFile(req, res, statusCode, headers, data) {
  const accept = req.headers['accept-encoding'] || '';
  if (accept.includes('gzip')) {
    zlib.gzip(data, (err, compressed) => {
      if (err) { res.writeHead(statusCode, headers); res.end(data); return; }
      res.writeHead(statusCode, { ...headers, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      res.end(compressed);
    });
  } else {
    res.writeHead(statusCode, headers);
    res.end(data);
  }
}

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

function yahooFetch(req, url, res) {
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
      const headers = secHeaders({
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });
      sendFile(req, res, r.statusCode || 200, headers, Buffer.from(data));
    });
  }).on('error', (e) => {
    res.writeHead(502, secHeaders({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }));
    res.end(JSON.stringify({ error: e.message }));
  });
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://apis.google.com https://www.gstatic.com https://content.googleapis.com https://*.googleapis.com",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://*.googleapis.com https://accounts.google.com https://www.gstatic.com",
  "img-src 'self' data: https:",
  "frame-src https://accounts.google.com https://www.gstatic.com",
  "font-src 'self' https://fonts.gstatic.com",
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

  // ── /health ──────────────────────────────────────────────
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()) }));
    return;
  }

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
        saveRefreshToken(tokens.refresh_token);
        console.log('\n✅ Auth OK — refresh token guardado en disco.\n');
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
      try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
    }
    res.writeHead(200, secHeaders({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }));
    res.end(JSON.stringify({ ok: true })); return;
  }

  // ── /api/quote?ticker=AAPL ──────────────────────────────
  if (url.pathname === '/api/quote') {
    const ticker = url.searchParams.get('ticker');
    if (!ticker) { res.writeHead(400); res.end('Missing ticker'); return; }
    yahooFetch(req, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`, res);
    return;
  }

  // ── /api/history?ticker=AAPL&range=1mo ─────────────────
  if (url.pathname === '/api/history') {
    const ticker = url.searchParams.get('ticker');
    const range  = url.searchParams.get('range') || '1mo';
    if (!ticker) { res.writeHead(400); res.end('Missing ticker'); return; }
    yahooFetch(req, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${encodeURIComponent(range)}`, res);
    return;
  }

  // ── /api/search?q=apple ─────────────────────────────────
  if (url.pathname === '/api/search') {
    const q = url.searchParams.get('q');
    if (!q) { res.writeHead(400); res.end('Missing q'); return; }
    yahooFetch(req, `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`, res);
    return;
  }

  // ── /api/parse-voice  (Claude Haiku NLP) ────────────────
  if (url.pathname === '/api/parse-voice' && req.method === 'POST') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.writeHead(503, secHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY no configurada en Railway' }));
      return;
    }

    // Rate limiting: 15 requests/min per IP (prevents API cost abuse)
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rl = voiceRateLimit.get(ip) || { count: 0, resetAt: now + 60000 };
    if (now > rl.resetAt) { rl.count = 0; rl.resetAt = now + 60000; }
    rl.count++;
    voiceRateLimit.set(ip, rl);
    if (rl.count > 15) {
      res.writeHead(429, secHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: 'Demasiadas solicitudes. Espera un minuto.' }));
      return;
    }

    let body = '';
    let bodyBytes = 0;
    req.on('data', c => {
      bodyBytes += c.length;
      if (bodyBytes > 65536) { req.destroy(); return; } // 64 KB cap
      body += c;
    });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        if (!text || typeof text !== 'string') throw new Error('Texto requerido');
        const safeText = text.slice(0, 500); // max 500 chars → bounded token cost

        const systemPrompt = `Eres el asistente de una app personal de finanzas colombiana. Parsea el comando de voz del usuario y responde SOLO con JSON válido, sin explicación.

Categorías de Gasto (usa exactamente estas, sin variaciones):
Vehículo, SimRacing, Alimentación, Transporte, Servicios, Entretenimiento, Salud, Educación, Hogar, Otros

Categorías de Ingreso (usa exactamente estas):
Salario, Freelance, Inversiones, Arriendos, Bonos, Otros

Reglas de monto:
- "X mil" → X*1000, "X millones"/"X palos" → X*1000000
- "X dólares"/"X USD" → currency:"USD", default:"COP"
- Escribe el número sin separadores: "doce mil quinientos" → 12500

Schemas de respuesta:

Transacción: {"action":"transaction","type":"Gasto"|"Ingreso","amount":number,"currency":"COP"|"USD","description":"string","category":"string","paymentMethod":"Efectivo"|"Tarjeta"}

Compra de inversión: {"action":"investment","subaction":"buy","ticker":"SYMBOL","amountUSD":number,"description":"string"}

Alerta de precio: {"action":"alert","ticker":"SYMBOL","condition":"above"|"below","targetPrice":number}

Consulta portafolio: {"action":"query","subject":"portfolio"|"ticker","ticker":"SYMBOL_o_null"}

No entendido: {"action":"unknown","suggestion":"pide al usuario que aclare en español"}

Ejemplos:
"gasté 12500 en efectivo en desayuno" → {"action":"transaction","type":"Gasto","amount":12500,"currency":"COP","description":"desayuno","category":"Alimentación","paymentMethod":"Efectivo"}
"me pagaron el salario 3 millones" → {"action":"transaction","type":"Ingreso","amount":3000000,"currency":"COP","description":"salario","category":"Salario","paymentMethod":"Efectivo"}
"invertí 100 dólares en apple" → {"action":"investment","subaction":"buy","ticker":"AAPL","amountUSD":100,"description":"Apple"}
"pon alerta si tesla baja de 200" → {"action":"alert","ticker":"TSLA","condition":"below","targetPrice":200}
"cuánto llevo en inversiones" → {"action":"query","subject":"portfolio","ticker":null}`;

        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 256,
            system: systemPrompt,
            messages: [{ role: 'user', content: safeText }]
          })
        });

        const claudeData = await claudeRes.json();
        if (!claudeRes.ok || claudeData.error) throw new Error(claudeData.error?.message || `Claude ${claudeRes.status}`);
        if (!claudeData.content?.[0]?.text) throw new Error('Respuesta inesperada de Claude');
        const parsed = JSON.parse(claudeData.content[0].text.trim());

        res.writeHead(200, secHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ ok: true, result: parsed, transcript: safeText }));
      } catch(e) {
        res.writeHead(500, secHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Static files ─────────────────────────────────────────
  let urlPath = url.pathname;
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);
  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        const headers = secHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        sendFile(req, res, 200, headers, d2);
      });
      return;
    }
    const headers = secHeaders({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheHeader(filePath, ext)
    });
    const shouldCompress = COMPRESSIBLE.has(ext);
    if (shouldCompress) {
      sendFile(req, res, 200, headers, data);
    } else {
      res.writeHead(200, headers);
      res.end(data);
    }
  });

}).listen(PORT, () => {
  console.log(`\n🚀 Finanzas PWA corriendo en ${BASE_URL}\n`);
  if (!CLIENT_SECRET) console.warn('⚠️  GOOGLE_CLIENT_SECRET no configurado\n');
  if (!refreshToken)  console.warn('⚠️  GOOGLE_REFRESH_TOKEN no configurado — visita /auth/login para autorizar\n');
  console.log('   Ctrl+C para detener\n');
});
