/* =========================================================
   Finanzas PWA — app.js
   ========================================================= */

const CONFIG = {
  CLIENT_ID: '278188681867-0jl265efd6o0eha8j75et3m2cvfedofv.apps.googleusercontent.com',
  API_KEY: 'AIzaSyCHaSw6CM7Ns3xTsnoNlpxGieL36DNJ9AQ',
  SCOPES: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
  SHEET_NAME: 'Finanzas App - Datos',
  DISCOVERY_DOCS: ['https://sheets.googleapis.com/$discovery/rest?version=v4']
};

let state = {
  user: null, accessToken: null, spreadsheetId: null,
  transactions: [], savings: [], investments: [], investmentPurchases: [],
  subscriptions: [], alerts: [], snapshots: [], budgets: [],
  benchmarks: {},          // { spy: { ytdPct, name }, btc: { ytdPct, name }, fetchedAt }
  benchmarksFetching: false,
  view: 'dashboard', syncing: false,
  tokenRefreshTimer: null,
  gapiReady: false,
  globalPriceTimer: null,
  addType: 'Gasto', addPaymentMethod: 'Efectivo',
  txFilter: 'Gasto', txSearch: '',
  savingsSubTab: 'goals',
  txDateRange: 'all',
  invCurrency: 'USD',
  snapshotRange: 12,
  usdCopRate: 4200,
  priceRefreshTimer: null,
  pricesLastUpdated: null,
  categories: {
    Gasto:   ['Vehículo','SimRacing','Alimentación','Transporte','Servicios','Entretenimiento','Salud','Educación','Hogar','Otros'],
    Ingreso: ['Salario','Freelance','Inversiones','Arriendos','Bonos','Otros']
  }
};

/* ── Sheets API via fetch (bypass gapi.client que cuelga) ── */
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
function sheetsHeaders() {
  return { 'Authorization': `Bearer ${state.accessToken}`, 'Content-Type': 'application/json' };
}
async function sheetsFetch(url, opts = {}) {
  const resp = await fetch(url, { ...opts, headers: sheetsHeaders() });
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.message || resp.status); }
  const result = await resp.json();
  return { result };
}
const Sheets = {
  spreadsheets: {
    get: ({ spreadsheetId }) =>
      sheetsFetch(`${SHEETS_BASE}/${spreadsheetId}`),
    create: ({ resource }) =>
      sheetsFetch(`${SHEETS_BASE}`, { method: 'POST', body: JSON.stringify(resource) }),
    batchUpdate: ({ spreadsheetId, resource }) =>
      sheetsFetch(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify(resource) }),
    values: {
      get: ({ spreadsheetId, range, valueRenderOption }) => {
        const p = new URLSearchParams(valueRenderOption ? { valueRenderOption } : {});
        return sheetsFetch(`${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?${p}`);
      },
      update: ({ spreadsheetId, range, valueInputOption, resource }) => {
        const p = new URLSearchParams({ valueInputOption: valueInputOption || 'RAW' });
        return sheetsFetch(`${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?${p}`, { method: 'PUT', body: JSON.stringify(resource) });
      },
      append: ({ spreadsheetId, range, valueInputOption, insertDataOption, resource }) => {
        const p = new URLSearchParams({ valueInputOption: valueInputOption || 'RAW', ...(insertDataOption ? { insertDataOption } : {}) });
        return sheetsFetch(`${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?${p}`, { method: 'POST', body: JSON.stringify(resource) });
      },
      batchGet: ({ spreadsheetId, ranges, valueRenderOption }) => {
        const p = new URLSearchParams(valueRenderOption ? { valueRenderOption } : {});
        (ranges || []).forEach(r => p.append('ranges', r));
        return sheetsFetch(`${SHEETS_BASE}/${spreadsheetId}/values:batchGet?${p}`);
      },
      batchUpdate: ({ spreadsheetId, resource }) =>
        sheetsFetch(`${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`, { method: 'POST', body: JSON.stringify(resource) }),
      batchClear: ({ spreadsheetId, resource }) =>
        sheetsFetch(`${SHEETS_BASE}/${spreadsheetId}/values:batchClear`, { method: 'POST', body: JSON.stringify(resource) }),
    }
  }
};

/* ── Service Worker ──────────────────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}

/* ── IndexedDB (offline-first cache) ─────────────────────── */
let _idb = null;
function openIDB() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((res, rej) => {
    const req = indexedDB.open('finanzas', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = e => { _idb = e.target.result; res(_idb); };
    req.onerror   = () => rej(req.error);
  });
}
async function idbSet(key, value) {
  try {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch(e) {}
}
async function idbGet(key) {
  try {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
    });
  } catch(e) { return null; }
}

/* ── localStorage + IndexedDB ────────────────────────────── */
function saveLocal() {
  localStorage.setItem('finanzas_transactions', JSON.stringify(state.transactions));
  localStorage.setItem('finanzas_savings',      JSON.stringify(state.savings));
  const invToSave = state.investments.map(({ marketPrice, marketChange, marketChangePct, marketCurrency, marketName, marketExchange, ...rest }) => rest);
  localStorage.setItem('finanzas_investments',  JSON.stringify(invToSave));
  if (state.spreadsheetId) localStorage.setItem('finanzas_sheetId', state.spreadsheetId);
  localStorage.setItem('finanzas_inv_purchases', JSON.stringify(state.investmentPurchases));
  localStorage.setItem('finanzas_subscriptions', JSON.stringify(state.subscriptions));
  localStorage.setItem('finanzas_categories',    JSON.stringify(state.categories));
  localStorage.setItem('finanzas_alerts',        JSON.stringify(state.alerts));
  localStorage.setItem('finanzas_snapshots',     JSON.stringify(state.snapshots));
  localStorage.setItem('finanzas_budgets',       JSON.stringify(state.budgets));
  // Mirror critical data to IndexedDB so standalone PWA shares the same cache
  idbSet('investments',  invToSave);
  idbSet('transactions', state.transactions);
  idbSet('savings',      state.savings);
  idbSet('purchases',     state.investmentPurchases);
  idbSet('sheetId',       state.spreadsheetId);
  idbSet('alerts',        state.alerts);
  idbSet('snapshots',     state.snapshots);
  idbSet('subscriptions', state.subscriptions);
  idbSet('categories',    state.categories);
  idbSet('budgets',       state.budgets);

  // Persist market prices separately so they survive reloads (offline-first)
  if (state.pricesLastUpdated) {
    const prices = {};
    state.investments.forEach(inv => {
      if (inv.marketPrice != null) {
        prices[inv.id] = {
          marketPrice: inv.marketPrice, marketChange: inv.marketChange,
          marketChangePct: inv.marketChangePct, marketCurrency: inv.marketCurrency,
          marketName: inv.marketName, marketExchange: inv.marketExchange
        };
      }
    });
    idbSet('marketPrices', prices);
    idbSet('pricesLastUpdated', state.pricesLastUpdated.toISOString());
  }
}

async function loadLocal() {
  try {
    const [idbInv, idbTx, idbSav, idbPur, idbSheetId, idbAlerts, idbSnaps, idbSubs, idbCats, idbBudgets, idbPrices, idbPriceTs] = await Promise.all([
      idbGet('investments'), idbGet('transactions'), idbGet('savings'),
      idbGet('purchases'),   idbGet('sheetId'),
      idbGet('alerts'),      idbGet('snapshots'),
      idbGet('subscriptions'), idbGet('categories'), idbGet('budgets'),
      idbGet('marketPrices'), idbGet('pricesLastUpdated')
    ]);
    state.transactions        = idbTx      || JSON.parse(localStorage.getItem('finanzas_transactions')   || '[]');
    state.savings             = idbSav     || JSON.parse(localStorage.getItem('finanzas_savings')        || '[]');
    state.investments         = idbInv     || JSON.parse(localStorage.getItem('finanzas_investments')    || '[]');
    state.investmentPurchases = idbPur     || JSON.parse(localStorage.getItem('finanzas_inv_purchases') || '[]');
    state.subscriptions       = idbSubs    || JSON.parse(localStorage.getItem('finanzas_subscriptions') || '[]');
    state.alerts              = idbAlerts  || JSON.parse(localStorage.getItem('finanzas_alerts')        || '[]');
    state.snapshots           = idbSnaps   || JSON.parse(localStorage.getItem('finanzas_snapshots')     || '[]');
    state.budgets             = idbBudgets || JSON.parse(localStorage.getItem('finanzas_budgets')       || '[]');
    state.spreadsheetId       = idbSheetId || localStorage.getItem('finanzas_sheetId') || null;
    const savedCats = idbCats || JSON.parse(localStorage.getItem('finanzas_categories') || 'null');
    if (savedCats) state.categories = savedCats;

    // Restore last-known market prices (offline-first: show stale data until refresh)
    if (idbPrices) {
      state.investments.forEach(inv => {
        const p = idbPrices[inv.id];
        if (p) Object.assign(inv, p);
      });
    }
    if (idbPriceTs) state.pricesLastUpdated = new Date(idbPriceTs);
  } catch(e) {
    state.transactions = []; state.savings = []; state.investments = []; state.subscriptions = []; state.budgets = [];
  }
}

/* ── Formatters ──────────────────────────────────────────── */
function formatCOP(n) {
  return new Intl.NumberFormat('es-CO', { style:'currency', currency:'COP', minimumFractionDigits:0, maximumFractionDigits:0 }).format(Number(n)||0);
}
function formatUSD(n) {
  return new Intl.NumberFormat('en-US', { style:'currency', currency:'USD', minimumFractionDigits:2, maximumFractionDigits:2 }).format(Number(n)||0);
}
function dateStr(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString('es-CO', { day:'2-digit', month:'short', year:'numeric' });
}
function catIcon(cat) {
  const m = { 'Vehículo':'🚗','SimRacing':'🎮','Alimentación':'🍽️','Transporte':'🚌','Servicios':'⚡',
    'Entretenimiento':'🎬','Salud':'💊','Educación':'📚','Hogar':'🏠','Otros':'📦',
    'Salario':'💼','Freelance':'💻','Inversiones':'📈','Arriendos':'🏘️','Bonos':'🎁' };
  return m[cat] || '💰';
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function todayISO() { return new Date().toISOString().slice(0,10); }

/* ── Financial calculations ──────────────────────────────── */
function getBalance() {
  return state.transactions.reduce((a,t) => t.type==='Ingreso' ? a+Number(t.amount) : a-Number(t.amount), 0);
}
function getMonthTotals(year, month) {
  const txs = state.transactions.filter(t => {
    const d = new Date(t.date+'T00:00:00');
    return d.getFullYear()===year && d.getMonth()===month;
  });
  const income  = txs.filter(t=>t.type==='Ingreso').reduce((a,t)=>a+Number(t.amount),0);
  const expense = txs.filter(t=>t.type==='Gasto').reduce((a,t)=>a+Number(t.amount),0);
  return { income, expense, net: income-expense, txs };
}
function getCategoryBreakdown(year, month) {
  const { txs } = getMonthTotals(year, month);
  const expenses = txs.filter(t=>t.type==='Gasto');
  const total = expenses.reduce((a,t)=>a+Number(t.amount),0);
  const map = {};
  expenses.forEach(t=>{ map[t.category]=(map[t.category]||0)+Number(t.amount); });
  return Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([cat,amt])=>({ cat, amt, pct: total?(amt/total*100):0 }));
}
function getMonthlyHistory(n=6) {
  const now = new Date();
  return Array.from({length:n}, (_,i) => {
    const d = new Date(now.getFullYear(), now.getMonth()-( n-1-i ), 1);
    const { income, expense } = getMonthTotals(d.getFullYear(), d.getMonth());
    const savePct = income > 0 ? ((income-expense)/income*100) : 0;
    return { label: d.toLocaleDateString('es-CO',{month:'short',year:'2-digit'}), fullLabel: d.toLocaleDateString('es-CO',{month:'long',year:'numeric'}), income, expense, net: income-expense, savePct };
  });
}
function getAvgMonthlyIncome()  { const h=getMonthlyHistory().filter(m=>m.income>0);  return h.length?h.reduce((a,m)=>a+m.income,0)/h.length:0; }
function getAvgMonthlyExpense() { const h=getMonthlyHistory().filter(m=>m.expense>0); return h.length?h.reduce((a,m)=>a+m.expense,0)/h.length:0; }
function getPortfolioSummary() {
  const rate = state.usdCopRate || 1;
  let investedUSD = 0, currentUSD = 0;
  state.investments.forEach(i => {
    investedUSD += i.shares > 0 && i.purchasePrice > 0 ? i.shares * i.purchasePrice : Number(i.invested);
    currentUSD  += i.shares > 0 && i.marketPrice ? i.shares * i.marketPrice
                 : i.shares > 0 && i.purchasePrice > 0 ? i.shares * i.purchasePrice : Number(i.currentValue);
  });
  const invested = investedUSD * rate, current = currentUSD * rate;
  const pnl = current - invested;
  return { invested, current, pnl, pct: invested ? (pnl / invested * 100) : 0 };
}

function getPortfolioAllocation() {
  const totals = {};
  state.investments.forEach(i => {
    const type = i.type || 'Otro';
    totals[type] = (totals[type] || 0) + Number(i.currentValue || i.invested || 0);
  });
  const grand = Object.values(totals).reduce((a,v)=>a+v,0) || 1;
  return Object.entries(totals)
    .sort((a,b)=>b[1]-a[1])
    .map(([label, value]) => ({ label, value, pct: value/grand*100 }));
}

function buildDonutSVG(segments) {
  const COLORS = {
    'Acciones':'#007AFF','ETF':'#34C759','Criptomoneda':'#FF9500',
    'Bono':'#AF52DE','Fondo':'#5AC8FA','Otro':'#8E8E93'
  };
  const size = 110, sw = 22, r = (size-sw)/2, circ = 2*Math.PI*r;
  let offset = 0;
  const arcs = segments.map(seg => {
    const dash = seg.pct/100*circ, gap = circ-dash;
    const arc = `<circle cx="${size/2}" cy="${size/2}" r="${r}"
      fill="none" stroke="${COLORS[seg.label]||'#8E8E93'}" stroke-width="${sw}"
      stroke-linecap="butt"
      stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}"
      stroke-dashoffset="${(-(offset/100)*circ).toFixed(2)}"
      transform="rotate(-90 ${size/2} ${size/2})"/>`;
    offset += seg.pct;
    return arc;
  });
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0">${arcs.join('')}</svg>`;
}

function fmtInv(usdVal) {
  if (state.invCurrency === 'COP') return formatCOP(usdVal * (state.usdCopRate || 4200));
  return formatUSD(usdVal);
}
function setInvCurrency(cur) { state.invCurrency = cur; renderView(); }

function fmtYAxis(v) {
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return (v / 1_000_000_000).toFixed(1) + 'B';
  if (abs >= 1_000_000)     return (v / 1_000_000).toFixed(1) + 'M';
  if (abs >= 1_000)         return (v / 1_000).toFixed(0) + 'K';
  return v.toFixed(0);
}

function buildPatrimonioSVG(snaps) {
  const W = 400, H = 180;
  const PAD = { top: 14, right: 12, bottom: 32, left: 56 };
  const pw = W - PAD.left - PAD.right;
  const ph = H - PAD.top  - PAD.bottom;

  const vals = snaps.map(s => s.patrimonioCOP);
  const rawMin = Math.min(...vals), rawMax = Math.max(...vals);
  const margin = (rawMax - rawMin) * 0.1 || rawMax * 0.05 || 1;
  const mn = rawMin - margin, mx = rawMax + margin;
  const rng = mx - mn;

  const toX = i => PAD.left + (snaps.length > 1 ? (i / (snaps.length - 1)) * pw : pw / 2);
  const toY = v => PAD.top + ph - ((v - mn) / rng) * ph;

  const isUp  = vals[vals.length - 1] >= vals[0];
  const col   = isUp ? '#34C759' : '#FF3B30';
  const pts   = snaps.map((s, i) => `${toX(i).toFixed(1)},${toY(s.patrimonioCOP).toFixed(1)}`).join(' ');
  const areaL = `${toX(0).toFixed(1)},${(PAD.top + ph).toFixed(1)}`;
  const areaR = `${toX(snaps.length - 1).toFixed(1)},${(PAD.top + ph).toFixed(1)}`;

  // Y ticks
  const tickCount = 4;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => mn + (rng * i / tickCount));

  // X labels — skip intermediate ones if too crowded
  const step = snaps.length > 9 ? 3 : snaps.length > 6 ? 2 : 1;

  // Store data for hover handler (keyed by chart id)
  window._pcData = { snaps, toX, toY, col, PAD, ph };

  return `
    <svg id="patr-svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" style="overflow:visible;display:block">
      <defs>
        <linearGradient id="patr-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${col}" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
        </linearGradient>
        <clipPath id="patr-clip">
          <rect x="${PAD.left}" y="${PAD.top}" width="${pw}" height="${ph}"/>
        </clipPath>
      </defs>

      ${yTicks.map(v => {
        const y = toY(v).toFixed(1);
        return `<line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}"
                  stroke="var(--border)" stroke-width="0.7" stroke-dasharray="3,4"/>
                <text x="${(PAD.left - 7).toFixed(0)}" y="${y}" text-anchor="end"
                  dominant-baseline="middle" font-size="9.5" fill="var(--muted)"
                  font-family="system-ui,sans-serif">${fmtYAxis(v)}</text>`;
      }).join('')}

      ${snaps.map((s, i) => {
        if (i % step !== 0 && i !== snaps.length - 1) return '';
        const label = new Date(s.month + '-02').toLocaleDateString('es-CO', { month: 'short', year: '2-digit' });
        return `<text x="${toX(i).toFixed(1)}" y="${(PAD.top + ph + 18).toFixed(1)}"
                  text-anchor="middle" font-size="9.5" fill="var(--muted)"
                  font-family="system-ui,sans-serif">${label}</text>`;
      }).join('')}

      <polygon points="${areaL} ${pts} ${areaR}" fill="url(#patr-grad)" clip-path="url(#patr-clip)"/>
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2.2"
        stroke-linejoin="round" stroke-linecap="round" clip-path="url(#patr-clip)"/>

      ${snaps.map((s, i) => `
        <circle cx="${toX(i).toFixed(1)}" cy="${toY(s.patrimonioCOP).toFixed(1)}"
          r="3.5" fill="${col}" stroke="var(--card)" stroke-width="1.8"/>
      `).join('')}

      <line id="patr-hline" x1="0" y1="${PAD.top}" x2="0" y2="${PAD.top + ph}"
        stroke="${col}" stroke-width="1" stroke-dasharray="4,3" opacity="0"/>
      <circle id="patr-hdot" cx="0" cy="0" r="5" fill="${col}"
        stroke="var(--card)" stroke-width="2" opacity="0"/>

      <rect id="patr-overlay"
        x="${PAD.left}" y="${PAD.top}" width="${pw}" height="${ph}"
        fill="transparent" style="cursor:crosshair"/>
    </svg>
    <div id="patr-tip" style="display:none;position:absolute;background:var(--card);
      border:1px solid var(--border);border-radius:10px;padding:8px 12px;
      font-size:12px;pointer-events:none;z-index:20;box-shadow:var(--shadow);
      min-width:140px"></div>`;
}

function setPatrimonioRange(months) {
  state.snapshotRange = months;
  renderView();
}

function initPatrimonioChart() {
  const overlay = document.getElementById('patr-overlay');
  const svg     = document.getElementById('patr-svg');
  const hline   = document.getElementById('patr-hline');
  const hdot    = document.getElementById('patr-hdot');
  const tip     = document.getElementById('patr-tip');
  if (!overlay || !window._pcData) return;

  const { snaps, toX, toY, col, PAD, ph } = window._pcData;

  function getNearestIdx(clientX) {
    const rect = svg.getBoundingClientRect();
    const scaleX = 400 / rect.width;
    const svgX   = (clientX - rect.left) * scaleX;
    let best = 0, bestDist = Infinity;
    snaps.forEach((_, i) => {
      const d = Math.abs(toX(i) - svgX);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  }

  function showTip(clientX, containerRect) {
    const idx  = getNearestIdx(clientX);
    const snap = snaps[idx];
    const prev = snaps[idx - 1];
    const delta = prev ? snap.patrimonioCOP - prev.patrimonioCOP : null;
    const rate  = state.usdCopRate || 4200;
    const label = new Date(snap.month + '-02').toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });

    hline.setAttribute('x1', toX(idx).toFixed(1));
    hline.setAttribute('x2', toX(idx).toFixed(1));
    hline.setAttribute('opacity', '0.7');
    hdot.setAttribute('cx', toX(idx).toFixed(1));
    hdot.setAttribute('cy', toY(snap.patrimonioCOP).toFixed(1));
    hdot.setAttribute('opacity', '1');

    tip.style.display = 'block';
    tip.innerHTML = `
      <div style="font-weight:700;margin-bottom:5px;color:var(--text)">${label}</div>
      <div style="color:var(--muted);font-size:11px;margin-bottom:2px">Patrimonio</div>
      <div style="font-weight:600;font-size:14px;color:var(--text)">${formatCOP(snap.patrimonioCOP)}</div>
      ${delta !== null ? `<div style="font-size:11px;margin-top:3px;color:${delta >= 0 ? '#34C759' : '#FF3B30'}">${delta >= 0 ? '+' : ''}${formatCOP(delta)} vs mes anterior</div>` : ''}
      <div style="border-top:1px solid var(--border);margin-top:6px;padding-top:6px;font-size:11px;color:var(--muted)">
        Portafolio ${formatCOP(snap.portfolioUSD * rate)}<br>
        Balance ${formatCOP(snap.balanceCOP)}
      </div>`;

    const svgRect  = svg.getBoundingClientRect();
    const wrapRect = svg.closest('.patr-chart-wrap').getBoundingClientRect();
    const dotX     = toX(idx) / 400 * svgRect.width;
    const dotY     = toY(snap.patrimonioCOP) / 180 * svgRect.height;
    const tipW     = 160;
    let left = dotX + svgRect.left - wrapRect.left + 10;
    if (left + tipW > wrapRect.width) left = dotX + svgRect.left - wrapRect.left - tipW - 10;
    tip.style.left = left + 'px';
    tip.style.top  = Math.max(0, dotY + svgRect.top - wrapRect.top - 30) + 'px';
  }

  overlay.addEventListener('mousemove', e => showTip(e.clientX));
  overlay.addEventListener('touchmove',  e => { e.preventDefault(); showTip(e.touches[0].clientX); }, { passive: false });
  overlay.addEventListener('mouseleave', () => {
    hline.setAttribute('opacity', '0'); hdot.setAttribute('opacity', '0'); tip.style.display = 'none';
  });
  overlay.addEventListener('touchend', () => {
    setTimeout(() => { hline.setAttribute('opacity', '0'); hdot.setAttribute('opacity', '0'); tip.style.display = 'none'; }, 1500);
  });
}

function renderPatrimonioPanel() {
  const rate       = state.usdCopRate || 4200;
  const balanceCOP = getBalance();
  let totalCurUSD  = 0, totalInvUSD = 0;
  state.investments.forEach(i => {
    totalInvUSD += i.shares > 0 && i.purchasePrice > 0 ? i.shares * i.purchasePrice : Number(i.invested);
    totalCurUSD += i.shares > 0 && i.marketPrice ? i.shares * i.marketPrice
      : i.shares > 0 && i.purchasePrice > 0 ? i.shares * i.purchasePrice : Number(i.currentValue);
  });
  const portfolioCOP  = totalCurUSD * rate;
  const patrimonioCOP = balanceCOP + portfolioCOP;
  const pnlCOP        = (totalCurUSD - totalInvUSD) * rate;

  // Filter snapshots by selected range
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - state.snapshotRange);
  const cutKey = cutoff.toISOString().slice(0, 7);
  const allSnaps  = state.snapshots;
  const snaps = state.snapshotRange >= 999
    ? allSnaps
    : allSnaps.filter(s => s.month >= cutKey);

  const ranges = [
    { label: '3M', val: 3 }, { label: '6M', val: 6 },
    { label: '12M', val: 12 }, { label: 'Todo', val: 999 }
  ];

  const chartHtml = snaps.length >= 2
    ? `<div class="patr-chart-wrap" style="position:relative;margin:16px 0 4px">
        ${buildPatrimonioSVG(snaps)}
      </div>`
    : `<p style="text-align:center;color:var(--muted);font-size:13px;padding:24px 0">
        Sin historial aún — vuelve el próximo mes para ver el gráfico.
      </p>`;

  // History table (last 6 entries max, reversed)
  const tableSnaps = [...snaps].reverse().slice(0, 6);
  const histHtml = snaps.length >= 2 ? `
    <details style="margin-top:14px">
      <summary style="font-size:11px;font-weight:600;color:var(--muted);cursor:pointer;list-style:none;display:flex;align-items:center;gap:4px">
        <span>HISTORIAL MENSUAL</span><span style="margin-left:auto;font-size:10px">▼</span>
      </summary>
      <table class="summary-table" style="margin-top:8px">
        <thead><tr><th>Mes</th><th>Portafolio</th><th>Balance</th><th>Patrimonio</th></tr></thead>
        <tbody>
          ${tableSnaps.map((s, idx, arr) => {
            const prev  = arr[idx + 1];
            const delta = prev ? s.patrimonioCOP - prev.patrimonioCOP : 0;
            const label = new Date(s.month + '-02').toLocaleDateString('es-CO', { month: 'short', year: '2-digit' });
            return `<tr>
              <td>${label}</td>
              <td>${formatCOP(s.portfolioUSD * rate)}</td>
              <td>${formatCOP(s.balanceCOP)}</td>
              <td>${formatCOP(s.patrimonioCOP)}
                ${prev ? `<br><small class="${delta >= 0 ? 'col-income' : 'col-expense'}">${delta >= 0 ? '+' : ''}${formatCOP(delta)}</small>` : ''}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </details>` : '';

  return `
    <div class="section-header">
      <span class="section-title">Patrimonio neto</span>
    </div>
    <div class="card patrimonio-card">
      <div class="patrimonio-totals">
        <div class="patrimonio-main">
          <div class="patrimonio-label">Total patrimonio</div>
          <div class="patrimonio-value">${formatCOP(patrimonioCOP)}</div>
        </div>
        <div class="patrimonio-breakdown">
          <div class="patrimonio-item">
            <span class="patrimonio-item-label">Balance (flujo)</span>
            <span class="patrimonio-item-val">${formatCOP(balanceCOP)}</span>
          </div>
          <div class="patrimonio-item">
            <span class="patrimonio-item-label">Portafolio</span>
            <span class="patrimonio-item-val">${formatCOP(portfolioCOP)}</span>
          </div>
          <div class="patrimonio-item">
            <span class="patrimonio-item-label">P&amp;L inversiones</span>
            <span class="patrimonio-item-val ${pnlCOP >= 0 ? 'income' : 'expense'}">${pnlCOP >= 0 ? '+' : ''}${formatCOP(pnlCOP)}</span>
          </div>
        </div>
      </div>
      <div class="patr-range-btns">
        ${ranges.map(r => `<button class="patr-range-btn${state.snapshotRange === r.val ? ' active' : ''}"
          onclick="setPatrimonioRange(${r.val})">${r.label}</button>`).join('')}
      </div>
      ${chartHtml}
      ${histHtml}
    </div>`;
}

function renderPortfolioPanel() {
  if (!state.investments.length) return '';
  let totalInvUSD = 0, totalCurUSD = 0;
  state.investments.forEach(i => {
    const invUSD = i.shares>0&&i.purchasePrice>0 ? i.shares*i.purchasePrice : Number(i.invested);
    const curUSD = i.shares>0&&i.marketPrice ? i.shares*i.marketPrice
      : i.shares>0&&i.purchasePrice>0 ? i.shares*i.purchasePrice : Number(i.currentValue);
    totalInvUSD += invUSD; totalCurUSD += curUSD;
  });
  const pnlUSD = totalCurUSD - totalInvUSD;
  const pctUSD = totalInvUSD>0 ? pnlUSD/totalInvUSD*100 : 0;
  const alloc  = getPortfolioAllocation();
  const COLORS  = { 'Acciones':'#007AFF','ETF':'#34C759','Criptomoneda':'#FF9500','Bono':'#AF52DE','Fondo':'#5AC8FA','Otro':'#8E8E93' };

  return `
    <div class="section-header">
      <span class="section-title">Portafolio</span>
      <button class="section-link" onclick="navigate('investments')">Ver todo</button>
    </div>
    <div class="card portfolio-panel">
      <div class="portfolio-totals">
        <div class="portfolio-stat">
          <div class="portfolio-stat-label">Valor actual</div>
          <div class="portfolio-stat-value">${formatUSD(totalCurUSD)}</div>
          <div class="portfolio-stat-sub">≈ ${formatCOP(totalCurUSD * state.usdCopRate)}</div>
        </div>
        <div class="portfolio-stat">
          <div class="portfolio-stat-label">Invertido</div>
          <div class="portfolio-stat-value">${formatUSD(totalInvUSD)}</div>
        </div>
        <div class="portfolio-stat">
          <div class="portfolio-stat-label">P&amp;L</div>
          <div class="portfolio-stat-value ${pnlUSD>=0?'income':'expense'}">${pnlUSD>=0?'+':''}${formatUSD(pnlUSD)}</div>
          <div class="portfolio-stat-sub ${pctUSD>=0?'income':'expense'}">${pctUSD>=0?'+':''}${pctUSD.toFixed(2)}%</div>
        </div>
      </div>
      ${alloc.length > 1 ? `
      <div class="portfolio-alloc">
        ${buildDonutSVG(alloc)}
        <div class="alloc-legend">
          ${alloc.map(s=>`
            <div class="alloc-item">
              <span class="alloc-dot" style="background:${COLORS[s.label]||'#8E8E93'}"></span>
              <span class="alloc-label">${s.label}</span>
              <span class="alloc-pct">${s.pct.toFixed(0)}%</span>
              <span class="alloc-val">${formatUSD(s.value)}</span>
            </div>`).join('')}
        </div>
      </div>` : ''}
      ${renderBenchmarkBar()}
    </div>`;
}

/* ══════════════════════════════════════════════════════════
   MARKET DATA — Yahoo Finance via local proxy
   ══════════════════════════════════════════════════════════ */
function renderBenchmarkBar() {
  const bm      = state.benchmarks;
  const portYtd = getPortfolioYtdPct();
  const year    = new Date().getFullYear();
  const hasSnap = state.snapshots.some(s => s.month.startsWith(year));

  const fmt = pct => pct === null
    ? '<span style="color:var(--muted)">—</span>'
    : `<span style="color:${pct >= 0 ? 'var(--green)' : 'var(--red)'}; font-weight:700">
        ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%
       </span>`;

  const col = (pct, ref) => {
    if (pct === null || ref === null) return 'var(--muted)';
    return pct >= ref ? 'var(--green)' : 'var(--red)';
  };

  const spyPct = bm.spy?.ytdPct ?? null;
  const btcPct = bm.btc?.ytdPct ?? null;
  const loading = !bm.fetchedAt;

  return `
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
      <div style="font-size:11px;font-weight:600;color:var(--muted);margin-bottom:10px;letter-spacing:.4px">
        RENDIMIENTO ${year} (YTD)${!hasSnap ? ' · <span style="font-weight:400;font-style:italic">P&L total sin snapshot de enero</span>' : ''}
      </div>
      ${loading
        ? `<div style="color:var(--muted);font-size:13px">Cargando benchmarks…</div>`
        : `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center">
            <div style="background:var(--bg);border-radius:10px;padding:10px 6px">
              <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Tu portafolio</div>
              <div style="font-size:18px">${fmt(portYtd)}</div>
            </div>
            <div style="background:var(--bg);border-radius:10px;padding:10px 6px;position:relative">
              <div style="font-size:11px;color:var(--muted);margin-bottom:4px">SPY (S&amp;P500)</div>
              <div style="font-size:18px">${fmt(spyPct)}</div>
              ${portYtd !== null && spyPct !== null
                ? `<div style="font-size:10px;color:${col(portYtd, spyPct)};margin-top:2px">
                    ${portYtd >= spyPct ? '▲ le ganas' : '▼ te supera'}
                   </div>` : ''}
            </div>
            <div style="background:var(--bg);border-radius:10px;padding:10px 6px">
              <div style="font-size:11px;color:var(--muted);margin-bottom:4px">BTC</div>
              <div style="font-size:18px">${fmt(btcPct)}</div>
              ${portYtd !== null && btcPct !== null
                ? `<div style="font-size:10px;color:${col(portYtd, btcPct)};margin-top:2px">
                    ${portYtd >= btcPct ? '▲ le ganas' : '▼ te supera'}
                   </div>` : ''}
            </div>
          </div>`}
    </div>`;
}
function normalizeTicker(t) {
  const s = (t||'').toUpperCase().trim();
  if (/^[A-Z]{2,10}USD$/.test(s) && !s.includes('-')) return s.slice(0,-3)+'-USD';
  return s;
}

async function fetchQuote(ticker) {
  const sym = normalizeTicker(ticker);
  try {
    const r = await fetch(`/api/quote?ticker=${encodeURIComponent(sym)}`);
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    return {
      price:      meta.regularMarketPrice || 0,
      change:     meta.regularMarketChange || 0,
      changePct:  meta.regularMarketChangePercent || 0,
      currency:   meta.currency || 'USD',
      name:       meta.shortName || meta.longName || ticker,
      exchange:   meta.exchangeName || ''
    };
  } catch(e) { return null; }
}

const _sparklineCache = {};

async function fetchHistory(ticker, range = '1mo') {
  const key = `${ticker}_${range}`;
  const cached = _sparklineCache[key];
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.prices;
  try {
    const r = await fetch(`/api/history?ticker=${encodeURIComponent(ticker)}&range=${range}`);
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const closes = result.indicators?.quote?.[0]?.close || [];
    const prices = closes.filter(p => p != null);
    if (prices.length < 2) return null;
    _sparklineCache[key] = { prices, ts: Date.now() };
    return prices;
  } catch(e) { return null; }
}

function buildSparklineSVG(prices, ticker) {
  const W = 280, H = 58, pad = 4;
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const isUp = prices[prices.length - 1] >= prices[0];
  const color = isUp ? '#34C759' : '#FF3B30';
  const fillId = `sf_${ticker.replace(/[^a-z0-9]/gi,'_')}`;

  const toX = i  => pad + (i / (prices.length - 1)) * (W - pad * 2);
  const toY = p  => H - pad - ((p - min) / range) * (H - pad * 2);

  const pts = prices.map((p, i) => `${toX(i).toFixed(1)},${toY(p).toFixed(1)}`).join(' ');
  const lastX = toX(prices.length - 1).toFixed(1);
  const lastY = toY(prices[prices.length - 1]).toFixed(1);
  const firstX = toX(0).toFixed(1), baseY = (H - pad).toFixed(1);

  const changePct = ((prices[prices.length-1] - prices[0]) / prices[0] * 100);
  const label = `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% 30d`;

  return `
    <div class="sparkline-wrap">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.18"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <polygon points="${firstX},${baseY} ${pts} ${lastX},${baseY}" fill="url(#${fillId})"/>
        <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${lastX}" cy="${lastY}" r="3" fill="${color}"/>
      </svg>
      <div class="sparkline-meta">
        <span class="sparkline-range">30 días</span>
        <span class="sparkline-change" style="color:${color}">${label}</span>
      </div>
    </div>`;
}

async function loadSparkline(invId, ticker) {
  const el = document.getElementById(`sparkline-${invId}`);
  if (!el) return;
  const prices = await fetchHistory(ticker);
  if (!prices) { el.innerHTML = ''; return; }
  el.outerHTML = buildSparklineSVG(prices, ticker);
}

async function fetchSearch(query) {
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await r.json();
    return (data?.quotes || [])
      .filter(q => ['EQUITY','ETF','MUTUALFUND','CRYPTOCURRENCY'].includes(q.quoteType))
      .slice(0, 7);
  } catch(e) { return []; }
}

async function fetchBenchmarks() {
  const CACHE_MS = 5 * 60 * 1000;
  if (state.benchmarksFetching) return;
  if (state.benchmarks.fetchedAt && Date.now() - state.benchmarks.fetchedAt < CACHE_MS) return;
  state.benchmarksFetching = true;
  try {
    const [spyPrices, btcPrices] = await Promise.all([
      fetchHistory('SPY', 'ytd'),
      fetchHistory('BTC-USD', 'ytd')
    ]);
    const ytdPct = prices => prices && prices.length >= 2
      ? ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100
      : null;
    state.benchmarks = {
      spy: spyPrices ? { ytdPct: ytdPct(spyPrices), name: 'SPY' } : null,
      btc: btcPrices ? { ytdPct: ytdPct(btcPrices), name: 'BTC' } : null,
      fetchedAt: Date.now()
    };
    if (state.view === 'dashboard' || state.view === 'investments') renderView();
  } catch(e) { console.warn('fetchBenchmarks', e); }
  finally { state.benchmarksFetching = false; }
}

function getPortfolioYtdPct() {
  const year = new Date().getFullYear();
  // Current portfolio value in USD
  let currentUSD = 0;
  state.investments.forEach(i => {
    currentUSD += i.shares > 0 && i.marketPrice ? i.shares * i.marketPrice
      : i.shares > 0 && i.purchasePrice > 0 ? i.shares * i.purchasePrice
      : Number(i.currentValue);
  });
  if (currentUSD === 0) return null;
  // Year-start baseline: earliest snapshot of this year (portfolioUSD)
  const yearSnap = state.snapshots.find(s => s.month.startsWith(year));
  if (yearSnap && yearSnap.portfolioUSD > 0) {
    return ((currentUSD - yearSnap.portfolioUSD) / yearSnap.portfolioUSD) * 100;
  }
  // Fallback: overall P&L vs cost basis (not strictly YTD but best available)
  let investedUSD = 0;
  state.investments.forEach(i => {
    investedUSD += i.shares > 0 && i.purchasePrice > 0 ? i.shares * i.purchasePrice : Number(i.invested);
  });
  return investedUSD > 0 ? ((currentUSD - investedUSD) / investedUSD) * 100 : null;
}

async function fetchExchangeRate() {
  const q = await fetchQuote('USDCOP=X');
  if (q && q.price > 100) state.usdCopRate = q.price;
}

/* ══════════════════════════════════════════════════════════
   PRICE ALERTS
   ══════════════════════════════════════════════════════════ */
async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

async function showNotif(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, { body, tag, icon: '/icon-192.png', badge: '/icon-192.png', renotify: false });
      return;
    } catch(e) {}
  }
  try { new Notification(title, { body, tag, icon: '/icon-192.png', badge: '/icon-192.png' }); } catch(e) {}
}

function fireNotification(title, body, tag) {
  showNotif(title, body, tag);
}

// ── In-app toast (visible while user is in the app) ───────
function showToast(message, type = 'info', duration = 3200) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const icons = { success: '✅', warning: '⚠️', error: '❌', info: 'ℹ️', alert: '🔔' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${icons[type] || icons.info}</span><span class="toast-msg">${message}</span><button class="toast-close" onclick="this.parentElement.remove()">✕</button>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-exit');
    const remove = () => { if (toast.parentElement) toast.remove(); };
    toast.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 600); // fallback if animationend never fires
  }, duration);
}

function addAlert(alert) {
  alert.id = uid();
  alert.triggered = false;
  alert.createdAt = todayISO();
  state.alerts.push(alert);
  saveLocal();
}

function deleteAlert(id) {
  state.alerts = state.alerts.filter(a => a.id !== id);
  saveLocal();
  renderView();
}

function resetAlert(id) {
  const a = state.alerts.find(a => a.id === id);
  if (a) { a.triggered = false; saveLocal(); renderView(); }
}

function checkAlerts() {
  let changed = false;
  for (const alert of state.alerts) {
    if (!alert.active || alert.triggered) continue;
    const inv = state.investments.find(i => i.id === alert.invId);
    if (!inv || !inv.marketPrice) continue;
    const price = inv.marketPrice;
    const hit = alert.condition === 'above' ? price >= alert.targetPrice
                                            : price <= alert.targetPrice;
    if (!hit) continue;
    alert.triggered = true;
    changed = true;
    const dir = alert.condition === 'above' ? '▲ subió sobre' : '▼ bajó bajo';
    fireNotification(
      `${alert.ticker} ${dir} ${formatUSD(alert.targetPrice)}`,
      `Precio actual: ${formatUSD(price)}`,
      `alert_${alert.id}`
    );
    showToast(`🔔 <strong>${alert.ticker}</strong> ${dir} ${formatUSD(alert.targetPrice)} — hoy: ${formatUSD(price)}`, 'alert', 6000);
  }
  if (changed) {
    saveLocal();
    if (state.view === 'investments') renderView();
  }
}

async function refreshInvestmentPrices() {
  await fetchExchangeRate();
  fetchBenchmarks(); // non-blocking, updates view when ready
  let updated = false;
  for (const inv of state.investments) {
    if (!inv.ticker) continue;
    const q = await fetchQuote(inv.ticker);
    if (!q) continue;
    inv.marketPrice    = q.price;
    inv.marketChange   = q.change;
    inv.marketChangePct = q.changePct;
    inv.marketCurrency = q.currency;
    inv.marketName     = q.name;
    inv.marketExchange = q.exchange;
    // Auto-update currentValue when shares are tracked
    if (Number(inv.shares) > 0) {
      const valueUSD = Number(inv.shares) * q.price;
      inv.currentValue = valueUSD;
      updated = true;
    }
  }
  state.pricesLastUpdated = new Date();
  checkAlerts();
  if (updated) {
    saveLocal();
    if (state.accessToken) {
      // Update Inversiones!F (Valor Actual) with fresh prices
      for (const inv of state.investments) {
        if (inv.ticker && Number(inv.shares) > 0) {
          try { await updateRowById('Inversiones', inv.id, invArr(inv)); } catch(e) {}
        }
      }
      // Update Precios tab with latest marketPrice numbers (non-blocking)
      syncPreciosTab().catch(() => {});
    }
  }
}

/* ── Navigation ──────────────────────────────────────────── */
function navigate(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.view === view));

  if (view === 'investments') {
    // Refresh prices immediately on entering investments view
    // (global 60s timer handles periodic refresh)
    refreshInvestmentPrices().then(() => { if (state.view==='investments') renderView(); });
  } else {
    renderView();
  }
}

function renderView() {
  ({ dashboard:renderDashboard, transactions:renderTransactions, savings:renderSavings, investments:renderInvestments, projection:renderProjection }[state.view] || renderDashboard)();
}

/* ── Sync badge ──────────────────────────────────────────── */
function updateSyncBadge(text, cls) {
  const b = document.getElementById('sync-badge');
  if (!b) return;
  b.textContent = text;
  b.className = 'sync-badge ' + (cls||'');
}

/* ── Google Auth ─────────────────────────────────────────── */
function gapiLoaded() {
  // GAPI solo se usa para setToken() — las llamadas a Sheets van por fetch() directo
  gapi.load('client', () => {
    state.gapiReady = true;
    onGapiReady();
  });
}
function gisLoaded() {} // GIS ya no se usa para auth — mantenemos el callback vacío por compatibilidad

async function onGapiReady() {
  await loadLocal();
  renderView();
  // Si vienen parámetros del OAuth callback, usarlos directamente
  const urlParams = new URLSearchParams(window.location.search);
  const cbToken  = urlParams.get('at');
  const cbExpiry = urlParams.get('ei');
  const cbError  = urlParams.get('auth_error');
  if (cbToken) {
    window.history.replaceState({}, '', '/');
    await applyAccessToken(cbToken, Number(cbExpiry) || 3600);
    return;
  }
  if (cbError) {
    window.history.replaceState({}, '', '/');
    showReconnectCard(`Error de autenticación: ${cbError}`);
    return;
  }
  // Intentar obtener token del servidor
  if (localStorage.getItem('finanzas_wasConnected')) {
    await tryServerToken();
  } else {
    showReconnectCard();
  }
}

async function tryServerToken() {
  try {
    const resp = await fetch('/auth/token');
    if (resp.status === 401) { showReconnectCard(); return; }
    const data = await resp.json();
    if (data.error) { showReconnectCard(); return; }
    await applyAccessToken(data.access_token, data.expires_in || 3600);
  } catch(e) {
    showReconnectCard();
  }
}

async function applyAccessToken(token, expiresIn) {
  state.accessToken = token;
  gapi.client.setToken({ access_token: token });
  localStorage.setItem('finanzas_wasConnected', '1');
  hideReconnectCard();
  // Renovar token 5 min antes de que expire
  clearTimeout(state.tokenRefreshTimer);
  state.tokenRefreshTimer = setTimeout(() => tryServerToken(), (expiresIn - 300) * 1000);
  // Timer global: refresh precios cada 60s sin importar la vista
  clearInterval(state.globalPriceTimer);
  state.globalPriceTimer = setInterval(() => {
    if (state.investments.some(i => i.ticker)) {
      refreshInvestmentPrices().then(() => {
        if (state.view === 'investments' || state.view === 'dashboard') renderView();
      });
    }
  }, 60000);
  updateAuthUI(true);
  updateSyncBadge('Sincronizando…', 'syncing');
  await ensureSpreadsheet();
  await syncFromSheets();
  updateSyncBadge('Sincronizado ✓', 'synced');
  renderView();
  if (state.investments.some(i => i.ticker)) {
    refreshInvestmentPrices().then(() => {
      updateSyncBadge('Sincronizado ✓', 'synced');
      if (state.view === 'investments') renderView();
      syncPreciosTab();
    });
  } else {
    syncPreciosTab();
  }
}

function showReconnectCard(msg) {
  let el = document.getElementById('reconnect-card');
  if (el) { if (msg) el.querySelector('.reconnect-msg').textContent = msg; return; }
  el = document.createElement('div');
  el.id = 'reconnect-card';
  el.className = 'standalone-prompt';
  el.innerHTML = `
    <div class="standalone-prompt-inner">
      <div style="font-size:40px;margin-bottom:12px">📊</div>
      <div style="font-weight:700;font-size:17px;margin-bottom:6px">Finanzas</div>
      <div class="reconnect-msg" style="color:var(--muted);font-size:14px;margin-bottom:20px;text-align:center">${msg || 'Conecta tu cuenta Google<br>para sincronizar tus datos'}</div>
      <button class="standalone-connect-btn" onclick="reconnectGoogle()">Conectar con Google</button>
    </div>`;
  document.getElementById('app-content').prepend(el);
}

function hideReconnectCard() {
  const el = document.getElementById('reconnect-card');
  if (el) el.remove();
}

function reconnectGoogle() {
  window.location.href = '/auth/login';
}

function toggleAuth() {
  if (state.accessToken) {
    fetch('/auth/revoke', { method: 'POST' }).catch(() => {});
    clearTimeout(state.tokenRefreshTimer);
    clearInterval(state.globalPriceTimer);
    clearInterval(state.priceRefreshTimer);
    state.accessToken = null; state.user = null;
    localStorage.removeItem('finanzas_wasConnected');
    hideReconnectCard();
    updateAuthUI(false); updateSyncBadge('Local'); renderView();
  } else {
    reconnectGoogle();
  }
}
function updateAuthUI(connected) {
  const btn = document.getElementById('auth-btn');
  if (btn) { btn.textContent = connected?'Desconectar':'Conectar Google'; btn.classList.toggle('connected',connected); }
  // Show/hide sheet link
  let link = document.getElementById('sheet-link');
  if (connected && state.spreadsheetId) {
    if (!link) {
      link = document.createElement('a');
      link.id = 'sheet-link';
      link.className = 'sheet-link';
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = '📊 Ver Sheet';
      document.querySelector('.header-left').appendChild(link);
    }
    link.href = `https://docs.google.com/spreadsheets/d/${state.spreadsheetId}`;
    link.style.display = 'inline-flex';
  } else if (link) {
    link.style.display = 'none';
  }
}

/* ── Sheets bootstrap ────────────────────────────────────── */
async function ensureSpreadsheet() {
  if (state.spreadsheetId) {
    try { await Sheets.spreadsheets.get({spreadsheetId:state.spreadsheetId}); return; }
    catch(e) { state.spreadsheetId = null; }
  }
  const driveUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`name='${CONFIG.SHEET_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`)}&fields=files(id,name)`;
  const driveResp = await sheetsFetch(driveUrl);
  const files = driveResp.result.files || [];
  if (files.length > 0) { state.spreadsheetId = files[0].id; localStorage.setItem('finanzas_sheetId', state.spreadsheetId); return; }
  const createResp = await Sheets.spreadsheets.create({
    resource:{ properties:{title:CONFIG.SHEET_NAME}, sheets:[
      {properties:{title:'Transacciones'}},{properties:{title:'Ahorro'}},
      {properties:{title:'Inversiones'}},{properties:{title:'Compras_Inv'}},
      {properties:{title:'Suscripciones'}},{properties:{title:'Precios'}}
    ]}
  });
  state.spreadsheetId = createResp.result.spreadsheetId;
  localStorage.setItem('finanzas_sheetId', state.spreadsheetId);
  // Write plain-text headers (RAW) for all sheets
  await Sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: state.spreadsheetId,
    resource:{ valueInputOption:'RAW', data:[
      { range:'Transacciones!A1:G1', values:[['ID','Fecha','Tipo','Categoría','Descripción','Monto','Pago']] },
      { range:'Ahorro!A1:F1',        values:[['ID','Nombre','Meta','Actual','Fecha Límite','Notas']] },
      { range:'Inversiones!A1:P1',   values:[['ID','Nombre','Ticker','Tipo','Invertido $','Valor Actual (App)','Acciones','Precio Compra $','Notas','Ganancia $','Ganancia %','Precio GFIN $','Valor GFIN $','Δ App vs GFIN','Invertido ∑Compras','Acciones ∑Compras']] },
      { range:'Compras_Inv!A1:F1',   values:[['ID','InvID','Fecha','Acciones','PrecioUSD','MontoUSD']] },
      { range:'Suscripciones!A1:H1', values:[['ID','Nombre','Monto','Moneda','Frecuencia','ProximoPago','Categoria','Notas']] },
      { range:'Precios!A1:C1',       values:[['Ticker','Precio Live (GFIN)','Última actualización']] }
    ]}
  });
  // Precios tab first so VLOOKUP formulas below don't get a #REF! on creation
  await ensurePreciosSheet();
  // Sheet-managed formulas for Inversiones (app never writes to J:P)
  try {
    await Sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: state.spreadsheetId,
      resource:{ valueInputOption:'USER_ENTERED', data:[
        { range:'Inversiones!J2', values:[['=ARRAYFORMULA(F2:F-E2:E)']] },
        { range:'Inversiones!K2', values:[['=ARRAYFORMULA((F2:F-E2:E)/(E2:E+(E2:E=0))*100)']] },
        { range:'Inversiones!L2', values:[['=ARRAYFORMULA(IFERROR(VLOOKUP(C2:C,Precios!$A:$B,2,0),""))']] },
        { range:'Inversiones!M2', values:[['=ARRAYFORMULA(IFERROR(G2:G*VLOOKUP(C2:C,Precios!$A:$B,2,0),""))']] },
        { range:'Inversiones!N2', values:[['=ARRAYFORMULA(IFERROR(G2:G*VLOOKUP(C2:C,Precios!$A:$B,2,0)-F2:F,""))']] },
        { range:'Inversiones!O2', values:[['=ARRAYFORMULA(IF(A2:A="","",SUMIF(Compras_Inv!B:B,A2:A,Compras_Inv!F:F)))']] },
        { range:'Inversiones!P2', values:[['=ARRAYFORMULA(IF(A2:A="","",SUMIF(Compras_Inv!B:B,A2:A,Compras_Inv!D:D)))']] }
      ]}
    });
  } catch(e) { console.warn('ensureSpreadsheet formulas:', e); }
}

async function ensureSuscripcionesSheet() {
  if (!state.spreadsheetId) return;
  try {
    const meta = await Sheets.spreadsheets.get({spreadsheetId:state.spreadsheetId});
    const exists = meta.result.sheets.some(s=>s.properties.title==='Suscripciones');
    if (!exists) {
      await Sheets.spreadsheets.batchUpdate({
        spreadsheetId:state.spreadsheetId,
        resource:{requests:[{addSheet:{properties:{title:'Suscripciones'}}}]}
      });
      await Sheets.spreadsheets.values.update({
        spreadsheetId:state.spreadsheetId, range:'Suscripciones!A1:H1',
        valueInputOption:'RAW', resource:{values:[['ID','Nombre','Monto','Moneda','Frecuencia','ProximoPago','Categoria','Notas']]}
      });
    }
  } catch(e) {}
}

async function ensureComprasInvSheet() {
  if (!state.spreadsheetId) return;
  try {
    const meta = await Sheets.spreadsheets.get({spreadsheetId:state.spreadsheetId});
    const exists = meta.result.sheets.some(s=>s.properties.title==='Compras_Inv');
    if (!exists) {
      await Sheets.spreadsheets.batchUpdate({
        spreadsheetId:state.spreadsheetId,
        resource:{requests:[{addSheet:{properties:{title:'Compras_Inv'}}}]}
      });
      await Sheets.spreadsheets.values.update({
        spreadsheetId:state.spreadsheetId, range:'Compras_Inv!A1:F1',
        valueInputOption:'RAW', resource:{values:[['ID','InvID','Fecha','Acciones','PrecioUSD','MontoCOP']]}
      });
    }
  } catch(e) {}
}

/* ── Precios sheet — bridge between app prices and sheet formulas ── */
async function ensurePreciosSheet() {
  if (!state.spreadsheetId) return;
  try {
    const meta = await Sheets.spreadsheets.get({spreadsheetId: state.spreadsheetId});
    const exists = meta.result.sheets.some(s => s.properties.title === 'Precios');
    if (!exists) {
      await Sheets.spreadsheets.batchUpdate({
        spreadsheetId: state.spreadsheetId,
        resource: { requests: [{ addSheet: { properties: { title: 'Precios' } } }] }
      });
    }
    await Sheets.spreadsheets.values.update({
      spreadsheetId: state.spreadsheetId, range: 'Precios!A1:C1',
      valueInputOption: 'RAW',
      resource: { values: [['Ticker', 'Precio USD (Yahoo Finance)', 'Actualizado']] }
    });
  } catch(e) { console.warn('ensurePreciosSheet:', e); }
}

// Writes tickers + live prices (numbers, not formulas) to the Precios tab.
// Using numbers avoids all Google Sheets locale issues with formula separators.
// Prices come from Yahoo Finance (same source as the app UI).
// Inversiones!L/M/N use VLOOKUP on this tab to show live values in the sheet.
async function syncPreciosTab() {
  if (!state.spreadsheetId || !state.accessToken) return;
  const tickers = [...new Set(state.investments.filter(i => i.ticker).map(i => i.ticker))];
  if (!tickers.length) return;
  try {
    await ensurePreciosSheet();
    await Sheets.spreadsheets.values.batchClear({
      spreadsheetId: state.spreadsheetId,
      resource: { ranges: ['Precios!A2:C'] }
    });
    const now = new Date().toLocaleString('es-CO');
    const rows = tickers.map(t => {
      const inv = state.investments.find(i => i.ticker === t);
      const price = inv?.marketPrice || inv?.purchasePrice || 0;
      return [t, price, now];
    });
    await Sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: state.spreadsheetId,
      resource: { valueInputOption: 'RAW', data: [
        { range: 'Precios!A2:C', values: rows }
      ]}
    });
  } catch(e) { console.warn('syncPreciosTab:', e); }
}

/* ── Sheet formula migration ─────────────────────────────── */
// Replaces raw Ganancia numbers in Inversiones!J:K with ARRAYFORMULA.
// Uses pure-math formulas (no IF/SI) to avoid Google Sheets locale issues.
// Flag key bumped to v2 to force re-migration (v1 had locale-broken formulas).
async function migrateInversionesFormulas() {
  if (!state.spreadsheetId || !state.accessToken) return;
  try {
    // Precios tab must exist before writing VLOOKUP formulas that reference it
    await ensurePreciosSheet();
    await Sheets.spreadsheets.values.batchClear({
      spreadsheetId: state.spreadsheetId,
      resource: { ranges: ['Inversiones!J:N'] }
    });
    await Sheets.spreadsheets.values.update({
      spreadsheetId: state.spreadsheetId,
      range: 'Inversiones!J1:N1',
      valueInputOption: 'RAW',
      resource: { values: [['Ganancia $','Ganancia %','Precio GFIN $','Valor GFIN $','Δ App vs GFIN']] }
    });
    await Sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: state.spreadsheetId,
      resource: { valueInputOption: 'USER_ENTERED', data: [
        { range: 'Inversiones!J2', values: [['=ARRAYFORMULA(F2:F-E2:E)']] },
        { range: 'Inversiones!K2', values: [['=ARRAYFORMULA((F2:F-E2:E)/(E2:E+(E2:E=0))*100)']] },
        // L: live price from Precios tab via VLOOKUP — IFERROR returns "" when ticker not in Precios yet
        { range: 'Inversiones!L2', values: [['=ARRAYFORMULA(IFERROR(VLOOKUP(C2:C,Precios!$A:$B,2,0),""))']] },
        // M: shares × live price — IFERROR handles missing price gracefully
        { range: 'Inversiones!M2', values: [['=ARRAYFORMULA(IFERROR(G2:G*VLOOKUP(C2:C,Precios!$A:$B,2,0),""))']] },
        // N: delta between GFIN value and app-written value (validation column)
        { range: 'Inversiones!N2', values: [['=ARRAYFORMULA(IFERROR(G2:G*VLOOKUP(C2:C,Precios!$A:$B,2,0)-F2:F,""))']] },
        // O: sum of amountUSD from Compras_Inv — audit column to verify E matches
        { range: 'Inversiones!O2', values: [['=ARRAYFORMULA(IF(A2:A="","",SUMIF(Compras_Inv!B:B,A2:A,Compras_Inv!F:F)))']] },
        // P: sum of shares from Compras_Inv — audit column to verify G matches
        { range: 'Inversiones!P2', values: [['=ARRAYFORMULA(IF(A2:A="","",SUMIF(Compras_Inv!B:B,A2:A,Compras_Inv!D:D)))']] }
      ]}
    });
    await Sheets.spreadsheets.values.update({
      spreadsheetId: state.spreadsheetId,
      range: 'Inversiones!O1:P1',
      valueInputOption: 'RAW',
      resource: { values: [['Invertido ∑Compras','Acciones ∑Compras']] }
    });
  } catch(e) { console.warn('migrateInversionesFormulas:', e); }
}

async function ensureSnapshotsSheet() {
  if (!state.spreadsheetId) return;
  try {
    const meta = await Sheets.spreadsheets.get({ spreadsheetId: state.spreadsheetId });
    const exists = meta.result.sheets.some(s => s.properties.title === 'Snapshots');
    if (!exists) {
      await Sheets.spreadsheets.batchUpdate({
        spreadsheetId: state.spreadsheetId,
        resource: { requests: [{ addSheet: { properties: { title: 'Snapshots' } } }] }
      });
    }
    await Sheets.spreadsheets.values.update({
      spreadsheetId: state.spreadsheetId, range: 'Snapshots!A1:F1',
      valueInputOption: 'RAW',
      resource: { values: [['Mes','Portfolio USD','Invertido USD','Balance COP','Patrimonio COP','Timestamp']] }
    });
  } catch(e) { console.warn('ensureSnapshotsSheet:', e); }
}

async function ensurePresupuestoSheet() {
  if (!state.spreadsheetId) return;
  try {
    const meta = await Sheets.spreadsheets.get({ spreadsheetId: state.spreadsheetId });
    const exists = meta.result.sheets.some(s => s.properties.title === 'Presupuesto');
    if (!exists) {
      await Sheets.spreadsheets.batchUpdate({
        spreadsheetId: state.spreadsheetId,
        resource: { requests: [{ addSheet: { properties: { title: 'Presupuesto' } } }] }
      });
    }
    await Sheets.spreadsheets.values.update({
      spreadsheetId: state.spreadsheetId, range: 'Presupuesto!A1:C1',
      valueInputOption: 'RAW',
      resource: { values: [['ID', 'Categoría', 'LímiteMensual']] }
    });
  } catch(e) { console.warn('ensurePresupuestoSheet:', e); }
}

async function loadBudgets() {
  try {
    const resp = await Sheets.spreadsheets.values.get({
      spreadsheetId: state.spreadsheetId, range: 'Presupuesto!A2:C', valueRenderOption: 'UNFORMATTED_VALUE'
    });
    state.budgets = (resp.result.values || [])
      .map(r => ({ id: r[0] || uid(), category: r[1] || '', monthlyLimit: Number(r[2]) || 0 }))
      .filter(b => b.category && b.monthlyLimit > 0);
    saveLocal();
  } catch(e) { await ensurePresupuestoSheet(); }
}

async function saveBudget(budget) {
  const existing = state.budgets.find(b => b.category === budget.category);
  if (existing) {
    existing.monthlyLimit = budget.monthlyLimit;
    saveLocal();
    try { await updateRowById('Presupuesto', existing.id, [existing.id, existing.category, existing.monthlyLimit]); } catch(e) {}
  } else {
    budget.id = uid();
    state.budgets.push(budget);
    saveLocal();
    try { await appendRow('Presupuesto', [budget.id, budget.category, budget.monthlyLimit]); } catch(e) {}
  }
  renderView();
}

async function deleteBudget(id) {
  state.budgets = state.budgets.filter(b => b.id !== id);
  saveLocal();
  try { await deleteRowById('Presupuesto', id); } catch(e) {}
  renderView();
}

function getBudgetProgress() {
  const now   = new Date();
  const year  = now.getFullYear(), month = now.getMonth();
  const txThisMonth = state.transactions.filter(t => {
    if (t.type !== 'Gasto') return false;
    const d = new Date(t.date + 'T00:00:00');
    return d.getFullYear() === year && d.getMonth() === month;
  });
  return state.budgets.map(b => {
    const spent = txThisMonth
      .filter(t => t.category === b.category)
      .reduce((a, t) => a + Number(t.amount), 0);
    const pct = b.monthlyLimit > 0 ? (spent / b.monthlyLimit) * 100 : 0;
    return { ...b, spent, pct };
  }).sort((a, b) => b.pct - a.pct);
}

async function saveMonthlySnapshot() {
  if (!state.spreadsheetId || !state.accessToken) return;
  const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
  if (state.snapshots.some(s => s.month === monthKey)) return; // already saved this month

  let totalInvUSD = 0, totalCurUSD = 0;
  state.investments.forEach(i => {
    totalInvUSD += i.shares > 0 && i.purchasePrice > 0 ? i.shares * i.purchasePrice : Number(i.invested);
    totalCurUSD += i.shares > 0 && i.marketPrice ? i.shares * i.marketPrice
      : i.shares > 0 && i.purchasePrice > 0 ? i.shares * i.purchasePrice : Number(i.currentValue);
  });
  const balanceCOP  = getBalance();
  const rate        = state.usdCopRate || 4200;
  const patrimonioCOP = balanceCOP + totalCurUSD * rate;
  const snap = {
    month: monthKey,
    portfolioUSD: Math.round(totalCurUSD * 100) / 100,
    investedUSD:  Math.round(totalInvUSD * 100) / 100,
    balanceCOP:   Math.round(balanceCOP),
    patrimonioCOP: Math.round(patrimonioCOP),
    ts: new Date().toISOString()
  };

  state.snapshots.push(snap);
  state.snapshots.sort((a, b) => a.month.localeCompare(b.month));
  saveLocal();

  try {
    await ensureSnapshotsSheet();
    await Sheets.spreadsheets.values.append({
      spreadsheetId: state.spreadsheetId, range: 'Snapshots!A2',
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      resource: { values: [[snap.month, snap.portfolioUSD, snap.investedUSD, snap.balanceCOP, snap.patrimonioCOP, snap.ts]] }
    });
  } catch(e) { console.warn('saveMonthlySnapshot:', e); }
}

async function loadSnapshots() {
  if (!state.spreadsheetId || !state.accessToken) return;
  try {
    await ensureSnapshotsSheet();
    const resp = await Sheets.spreadsheets.values.get({
      spreadsheetId: state.spreadsheetId, range: 'Snapshots!A2:F', valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const rows = resp.result.values || [];
    if (rows.length === 0) return;
    state.snapshots = rows.map(r => ({
      month: r[0] || '', portfolioUSD: Number(r[1]) || 0,
      investedUSD: Number(r[2]) || 0, balanceCOP: Number(r[3]) || 0,
      patrimonioCOP: Number(r[4]) || 0, ts: r[5] || ''
    })).filter(s => s.month);
    saveLocal();
  } catch(e) { console.warn('loadSnapshots:', e); }
}

async function syncFromSheets() {
  if (!state.spreadsheetId || !state.accessToken) return;
  // Migration v5: add Compras_Inv audit columns O:P (Invertido ∑Compras, Acciones ∑Compras)
  if (!localStorage.getItem('finanzas_formulas_v5')) {
    localStorage.removeItem('finanzas_formulas_v1');
    localStorage.removeItem('finanzas_formulas_v2');
    localStorage.removeItem('finanzas_formulas_v3');
    localStorage.removeItem('finanzas_formulas_v4');
    await migrateInversionesFormulas();
    localStorage.setItem('finanzas_formulas_v5', '1');
  }
  try {
    const resp = await Sheets.spreadsheets.values.batchGet({
      spreadsheetId: state.spreadsheetId,
      ranges:['Transacciones!A2:G','Ahorro!A2:F','Inversiones!A2:I'],
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const vrs = resp.result.valueRanges;
    state.transactions = (vrs[0].values||[]).map(r=>({ id:r[0]||uid(), date:r[1]||'', type:r[2]||'Gasto', category:r[3]||'Otros', description:r[4]||'', amount:Number(r[5])||0, paymentMethod:r[6]||'' })).filter(t=>t.date);
    state.savings      = (vrs[1].values||[]).map(r=>({ id:r[0]||uid(), name:r[1]||'', goal:Number(r[2])||0, current:Number(r[3])||0, deadline:r[4]||'', notes:r[5]||'' })).filter(s=>s.name);
    // Snapshot local investments before overwriting — used as fallback below
    const prevInvestments = [...state.investments];
    state.investments = (vrs[2].values||[]).map(r => {
      const inv = { id:r[0]||uid(), name:r[1]||'', ticker:r[2]||'', type:r[3]||'',
        invested:Number(r[4])||0, currentValue:Number(r[5])||0,
        shares:Number(r[6])||0, purchasePrice:Number(r[7])||0, notes:r[8]||'' };
      // Auto-repair: if shares=0 but invested>0 and purchasePrice>0 → recalculate
      if (inv.shares === 0 && inv.invested > 0 && inv.purchasePrice > 0) {
        inv.shares = Math.round(inv.invested / inv.purchasePrice * 1e8) / 1e8;
      }
      // Fallback: if sheet still has zeros, restore from last good local state.
      // This prevents a reconnect from wiping values the user already sees correctly.
      const prev = prevInvestments.find(p => p.id === inv.id);
      if (prev) {
        if (inv.shares === 0 && prev.shares > 0)               inv.shares = prev.shares;
        if (inv.purchasePrice === 0 && prev.purchasePrice > 0) inv.purchasePrice = prev.purchasePrice;
        if (inv.currentValue === 0 && prev.currentValue > 0)   inv.currentValue = prev.currentValue;
        // Carry over live market data — never stored in the sheet
        if (prev.marketPrice)    inv.marketPrice    = prev.marketPrice;
        if (prev.marketChange)   inv.marketChange   = prev.marketChange;
        if (prev.marketChangePct)inv.marketChangePct= prev.marketChangePct;
        if (prev.marketCurrency) inv.marketCurrency = prev.marketCurrency;
      }
      // Last resort: if currentValue is still 0 but invested>0, show cost basis
      if (inv.currentValue === 0 && inv.invested > 0) inv.currentValue = inv.invested;
      return inv;
    }).filter(i=>i.name);
    try {
      const purResp = await Sheets.spreadsheets.values.get({
        spreadsheetId:state.spreadsheetId, range:'Compras_Inv!A2:F', valueRenderOption:'UNFORMATTED_VALUE'
      });
      const repairedIds = new Set();
      state.investmentPurchases = (purResp.result.values||[]).map(r => {
        const p = { id:r[0]||uid(), investmentId:r[1]||'', date:r[2]||'',
          shares:Number(r[3])||0, priceUSD:Number(r[4])||0, amountUSD:Number(r[5])||0 };
        // Auto-repair: if priceUSD=0 but parent investment has purchasePrice, use it
        if (p.priceUSD === 0 && p.amountUSD > 0) {
          const parent = state.investments.find(i=>i.id===p.investmentId);
          if (parent && parent.purchasePrice > 0) {
            p.priceUSD = parent.purchasePrice;
            p.shares   = Math.round(p.amountUSD / p.priceUSD * 1e8) / 1e8;
            repairedIds.add(p.id);
          }
        }
        return p;
      }).filter(p=>p.investmentId);
      // Write only actually-repaired purchases back to Compras_Inv so they persist
      const repairedPurchases = state.investmentPurchases.filter(p => repairedIds.has(p.id));
      for (const p of repairedPurchases) {
        try { await updateRowById('Compras_Inv', p.id, [p.id,p.investmentId,p.date,p.shares,p.priceUSD,p.amountUSD]); } catch(e) {}
      }
      // Recalc all investments that have purchases with real amountUSD > 0.
      // Guards against stale Inversiones rows when a 2nd purchase was added but
      // the sheet write failed (network/offline). Skips investments whose purchases
      // all have amountUSD=0 (e.g. SCHD/ETH-USD manually entered) to avoid zeroing invested.
      const purchasedInvIds = new Set(
        state.investmentPurchases.filter(p => p.amountUSD > 0).map(p => p.investmentId)
      );
      for (const invId of purchasedInvIds) {
        const inv = state.investments.find(i => i.id === invId);
        if (!inv) continue;
        const prevShares = inv.shares, prevInvested = inv.invested, prevPrice = inv.purchasePrice;
        recalcInvestment(invId);
        if (inv.shares !== prevShares || Math.abs(inv.invested - prevInvested) > 0.001 || Math.abs(inv.purchasePrice - prevPrice) > 0.001) {
          try { await updateRowById('Inversiones', inv.id, invArr(inv)); } catch(e) {}
        }
      }
    } catch(e) { await ensureComprasInvSheet(); }
    try {
      const subResp = await Sheets.spreadsheets.values.get({
        spreadsheetId:state.spreadsheetId, range:'Suscripciones!A2:H', valueRenderOption:'UNFORMATTED_VALUE'
      });
      state.subscriptions = (subResp.result.values||[]).map(r=>({ id:r[0]||uid(), name:r[1]||'', amount:Number(r[2])||0, currency:r[3]||'COP', frequency:r[4]||'monthly', nextPaymentDate:r[5]||'', category:r[6]||'Servicios', notes:r[7]||'' })).filter(s=>s.name);
    } catch(e) { await ensureSuscripcionesSheet(); }
    saveLocal();
    // Load snapshots and budgets from Sheet
    await loadSnapshots();
    await saveMonthlySnapshot();
    await loadBudgets();
  } catch(e) { console.error('syncFromSheets', e); }
}

/* ── Sheets write helpers ────────────────────────────────── */
async function appendRow(sheet, values) {
  if (!state.spreadsheetId || !state.accessToken) return;
  await Sheets.spreadsheets.values.append({ spreadsheetId:state.spreadsheetId, range:`${sheet}!A1`, valueInputOption:'RAW', insertDataOption:'INSERT_ROWS', resource:{values:[values]} });
}
async function deleteRowById(sheet, id) {
  if (!state.spreadsheetId || !state.accessToken) return;
  const resp = await Sheets.spreadsheets.values.get({ spreadsheetId:state.spreadsheetId, range:`${sheet}!A:A` });
  const rows = resp.result.values || [];
  const rowIndex = rows.findIndex(r=>r[0]===id);
  if (rowIndex < 1) return;
  const meta = await Sheets.spreadsheets.get({spreadsheetId:state.spreadsheetId});
  const sh = meta.result.sheets.find(s=>s.properties.title===sheet);
  if (!sh) return;
  await Sheets.spreadsheets.batchUpdate({ spreadsheetId:state.spreadsheetId, resource:{requests:[{deleteDimension:{range:{sheetId:sh.properties.sheetId,dimension:'ROWS',startIndex:rowIndex,endIndex:rowIndex+1}}}]} });
}
async function updateRowById(sheet, id, values) {
  if (!state.spreadsheetId || !state.accessToken) return;
  const resp = await Sheets.spreadsheets.values.get({ spreadsheetId:state.spreadsheetId, range:`${sheet}!A:A` });
  const rows = resp.result.values || [];
  const rowIndex = rows.findIndex(r=>r[0]===id);
  if (rowIndex < 1) return;
  await Sheets.spreadsheets.values.update({ spreadsheetId:state.spreadsheetId, range:`${sheet}!A${rowIndex+1}`, valueInputOption:'RAW', resource:{values:[values]} });
}

/* ── CRUD: Transactions ──────────────────────────────────── */
async function addTransaction(tx) {
  tx.id = uid(); state.transactions.unshift(tx); saveLocal(); renderView();
  if (!state.accessToken) return;
  try { await appendRow('Transacciones',[tx.id,tx.date,tx.type,tx.category,tx.description,tx.amount,tx.paymentMethod||'']); updateSyncBadge('Sincronizado ✓','synced'); } catch(e) { updateSyncBadge('Error sync','error'); }
}
async function deleteTransaction(id) {
  state.transactions = state.transactions.filter(t=>t.id!==id); saveLocal(); renderView();
  if (!state.accessToken) return;
  try { await deleteRowById('Transacciones',id); } catch(e) {}
}

/* ── CRUD: Savings ───────────────────────────────────────── */
async function addSavingsGoal(goal) {
  goal.id = uid(); goal.current = 0; state.savings.push(goal); saveLocal(); renderView();
  if (!state.accessToken) return;
  try { await appendRow('Ahorro',[goal.id,goal.name,goal.goal,0,goal.deadline,goal.notes||'']); } catch(e) {}
}
async function updateSavingsProgress(id, addAmount) {
  const g = state.savings.find(s=>s.id===id); if (!g) return;
  g.current = Math.min(g.current+Number(addAmount), g.goal); saveLocal(); renderView();
  if (!state.accessToken) return;
  try { await updateRowById('Ahorro',id,[id,g.name,g.goal,g.current,g.deadline,g.notes||'']); } catch(e) {}
}
async function deleteSavingsGoal(id) {
  state.savings = state.savings.filter(s=>s.id!==id); saveLocal(); renderView();
  if (!state.accessToken) return;
  try { await deleteRowById('Ahorro',id); } catch(e) {}
}

/* ── Subscriptions: helpers ──────────────────────────────── */
function freqLabel(f) {
  return { weekly:'Semanal', monthly:'Mensual', quarterly:'Trimestral', semestral:'Semestral', annual:'Anual' }[f] || f;
}
function freqMonths(f) {
  return { weekly:7/30, monthly:1, quarterly:3, semestral:6, annual:12 }[f] || 1;
}
function calcNextPaymentDate(frequency, fromDate) {
  const d = new Date(fromDate + 'T00:00:00');
  switch(frequency) {
    case 'weekly':    d.setDate(d.getDate()+7); break;
    case 'monthly':   d.setMonth(d.getMonth()+1); break;
    case 'quarterly': d.setMonth(d.getMonth()+3); break;
    case 'semestral': d.setMonth(d.getMonth()+6); break;
    case 'annual':    d.setFullYear(d.getFullYear()+1); break;
  }
  return d.toISOString().slice(0,10);
}
function getUpcomingSubscriptions(days=30) {
  const now = new Date(); now.setHours(0,0,0,0);
  const limit = new Date(now); limit.setDate(limit.getDate()+days);
  return state.subscriptions.filter(s => {
    if (!s.nextPaymentDate) return false;
    const d = new Date(s.nextPaymentDate+'T00:00:00');
    return d <= limit;
  }).sort((a,b) => a.nextPaymentDate.localeCompare(b.nextPaymentDate));
}
function getMonthlySubscriptionCost() {
  return state.subscriptions.reduce((total, s) => {
    const monthly = s.amount / freqMonths(s.frequency);
    return total + (s.currency === 'USD' ? monthly * (state.usdCopRate||4200) : monthly);
  }, 0);
}
function subDaysUntil(dateStr) {
  const now = new Date(); now.setHours(0,0,0,0);
  return Math.ceil((new Date(dateStr+'T00:00:00') - now) / 86400000);
}
function subIcon(cat) {
  const m = {'Streaming':'📺','Música':'🎵','Software':'💻','Membresías':'🏷️','Seguros':'🛡️','Servicios':'⚡','Gimnasio':'🏋️','Nube':'☁️','Gaming':'🎮','Otros':'📦'};
  return m[cat] || '📦';
}

/* ── CRUD: Subscriptions ─────────────────────────────────── */
async function addSubscription(sub) {
  sub.id = uid();
  state.subscriptions.push(sub); saveLocal(); renderView();
  if (!state.accessToken) return;
  try { await appendRow('Suscripciones',[sub.id,sub.name,sub.amount,sub.currency,sub.frequency,sub.nextPaymentDate,sub.category,sub.notes||'']); } catch(e) {}
}
async function deleteSubscription(id) {
  state.subscriptions = state.subscriptions.filter(s=>s.id!==id); saveLocal(); renderView();
  if (!state.accessToken) return;
  try { await deleteRowById('Suscripciones',id); } catch(e) {}
}
async function markSubscriptionPaid(id, createTx = true) {
  const sub = state.subscriptions.find(s=>s.id===id); if (!sub) return;
  if (createTx) {
    await addTransaction({ date: todayISO(), type: 'Gasto', category: sub.category||'Servicios',
      description: sub.name, amount: sub.amount, paymentMethod: '' });
  }
  sub.nextPaymentDate = calcNextPaymentDate(sub.frequency, todayISO());
  saveLocal(); renderView();
  if (!state.accessToken) return;
  try { await updateRowById('Suscripciones',id,[id,sub.name,sub.amount,sub.currency,sub.frequency,sub.nextPaymentDate,sub.category,sub.notes||'']); } catch(e) {}
}

/* ── Investment row helper ───────────────────────────────── */
// Returns columns A-I only (J:N are sheet-managed formulas — never written by the app)
function invArr(inv) {
  return [inv.id, inv.name, inv.ticker||'', inv.type||'', inv.invested, inv.currentValue,
          inv.shares||0, inv.purchasePrice||0, inv.notes||''];
}

/* ── CRUD: Investments ───────────────────────────────────── */
async function addInvestment(inv) {
  inv.id = uid();
  if (!inv.currentValue) inv.currentValue = inv.invested;
  state.investments.push(inv); saveLocal(); renderView();
  try { await appendRow('Inversiones', invArr(inv)); } catch(e) {}
  if (inv.ticker) syncPreciosTab().catch(()=>{});
}
async function updateInvestmentValue(id, newValue) {
  const inv = state.investments.find(i=>i.id===id); if (!inv) return;
  inv.currentValue = Number(newValue); saveLocal(); renderView();
  try { await updateRowById('Inversiones', id, invArr(inv)); } catch(e) {}
}
async function deleteInvestment(id) {
  const relPurchases = state.investmentPurchases.filter(p=>p.investmentId===id);
  state.investments = state.investments.filter(i=>i.id!==id);
  state.investmentPurchases = state.investmentPurchases.filter(p=>p.investmentId!==id);
  saveLocal(); renderView();
  try { await deleteRowById('Inversiones',id); } catch(e) {}
  for (const p of relPurchases) { try { await deleteRowById('Compras_Inv',p.id); } catch(e) {} }
  syncPreciosTab().catch(()=>{});
}

async function addInvestmentPurchase(purchase) {
  purchase.id = uid();
  state.investmentPurchases.push(purchase);
  recalcInvestment(purchase.investmentId);
  saveLocal(); renderView();
  const inv = state.investments.find(i=>i.id===purchase.investmentId);
  try {
    await appendRow('Compras_Inv',[purchase.id,purchase.investmentId,purchase.date,purchase.shares,purchase.priceUSD,purchase.amountUSD]);
    if (inv) await updateRowById('Inversiones', inv.id, invArr(inv));
  } catch(e) {}
}

async function deleteInvestmentPurchase(purchaseId) {
  const purchase = state.investmentPurchases.find(p=>p.id===purchaseId);
  if (!purchase) return;
  const invId = purchase.investmentId;
  state.investmentPurchases = state.investmentPurchases.filter(p=>p.id!==purchaseId);
  recalcInvestment(invId);
  saveLocal(); renderView();
  try { await deleteRowById('Compras_Inv', purchaseId); } catch(e) {}
  const inv = state.investments.find(i=>i.id===invId);
  if (inv) { try { await updateRowById('Inversiones', inv.id, invArr(inv)); } catch(e) {} }
}

function openEditPurchaseModal(purchaseId) {
  const p = state.investmentPurchases.find(x=>x.id===purchaseId);
  if (!p) return;
  const inv = state.investments.find(i=>i.id===p.investmentId);
  // If priceUSD=0 but we have a live market price, suggest it as default
  const suggestedPrice = p.priceUSD || (inv?.marketPrice || '');
  const priceIsEstimate = !p.priceUSD && inv?.marketPrice;
  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">Editar compra</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <p style="color:var(--muted);margin-bottom:16px;font-size:13px">${inv?.name||''} ${inv?.ticker?'('+inv.ticker+')':''}</p>
    ${priceIsEstimate ? `<div class="inv-repair-banner" style="margin-bottom:14px">⚠️ Precio no registrado — ingresa el precio que pagaste. Como referencia, hoy vale <strong>${formatUSD(inv.marketPrice)}</strong>.</div>` : ''}
    <form onsubmit="submitEditPurchase(event,'${purchaseId}')">
      <div class="form-group">
        <label class="form-label">Fecha de compra</label>
        <input class="form-input" type="date" id="ep-date" value="${p.date}" required>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Monto invertido (USD)</label>
          <input class="form-input" type="number" id="ep-amount" placeholder="Ej: 50.00" min="0" step="any" value="${p.amountUSD||''}" oninput="calcEditPurchase()" required>
        </div>
        <div class="form-group">
          <label class="form-label">Precio de entrada (USD)</label>
          <input class="form-input" type="number" id="ep-price" placeholder="Ej: 191.50" min="0" step="any" value="${suggestedPrice}" oninput="calcEditPurchase()">
        </div>
      </div>
      <div class="calc-hint" id="ep-hint"></div>
      <button type="submit" class="btn-primary">Guardar cambios</button>
    </form>`);
  setTimeout(calcEditPurchase, 50);
}
function calcEditPurchase() {
  const amount = Number(document.getElementById('ep-amount')?.value)||0;
  const price  = Number(document.getElementById('ep-price')?.value)||0;
  const hint   = document.getElementById('ep-hint');
  if (hint) hint.textContent = amount>0 && price>0
    ? `${formatUSD(amount)} ÷ ${formatUSD(price)} = ${Math.round(amount/price*1e8)/1e8} unidades ≈ ${formatCOP(amount*state.usdCopRate)}`
    : '';
}
async function submitEditPurchase(e, purchaseId) {
  e.preventDefault();
  const amount = Number(document.getElementById('ep-amount').value)||0;
  const price  = Number(document.getElementById('ep-price').value)||0;
  if (amount <= 0) { alert('Ingresa el monto invertido.'); return; }
  if (price  <= 0) { alert('Ingresa el precio de entrada.'); return; }
  const shares = Math.round(amount / price * 1e8) / 1e8;
  const p = state.investmentPurchases.find(x=>x.id===purchaseId);
  if (!p) return;
  p.date = document.getElementById('ep-date').value;
  p.amountUSD = amount;
  p.priceUSD  = price;
  p.shares    = shares;
  recalcInvestment(p.investmentId);
  closeModal(); saveLocal(); renderView();
  const inv = state.investments.find(i=>i.id===p.investmentId);
  try {
    await updateRowById('Compras_Inv', purchaseId, [purchaseId, p.investmentId, p.date, shares, price, amount]);
    if (inv) await updateRowById('Inversiones', inv.id, invArr(inv));
  } catch(e) {}
}

function recalcInvestment(invId) {
  const inv = state.investments.find(i=>i.id===invId);
  if (!inv) return;
  const allP = state.investmentPurchases.filter(p=>p.investmentId===invId);
  inv.shares    = allP.reduce((a,p)=>a+p.shares, 0);
  inv.invested  = allP.reduce((a,p)=>a+p.amountUSD, 0);
  const totalSh = inv.shares;
  inv.purchasePrice = totalSh>0 ? allP.reduce((a,p)=>a+p.shares*p.priceUSD,0)/totalSh : 0;
  if (!inv.ticker) inv.currentValue = inv.invested;
}

/* ── Modal ───────────────────────────────────────────────── */
function openModal(html) { document.getElementById('modal-content').innerHTML=html; document.getElementById('modal-overlay').classList.remove('hidden'); }
function closeModal()    { document.getElementById('modal-overlay').classList.add('hidden'); }

async function openAlertModal(invId, prefill = null) {
  const inv = state.investments.find(i => i.id === invId);
  if (!inv) return;
  const invAlerts = state.alerts.filter(a => a.invId === invId);
  const currentPrice = inv.marketPrice ? formatUSD(inv.marketPrice) : '—';

  await requestNotificationPermission();

  openModal(`
    <div class="modal-header">
      <h3>🔔 Alertas — ${inv.ticker || inv.name}</h3>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--muted);font-size:13px;margin-bottom:16px">Precio actual: <strong style="color:var(--text)">${currentPrice}</strong></p>

      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">
        <div class="form-group">
          <label class="form-label">Condición</label>
          <select id="alert-condition" class="form-input">
            <option value="above" ${prefill?.condition === 'above' ? 'selected' : ''}>▲ Sube sobre</option>
            <option value="below" ${prefill?.condition === 'below' ? 'selected' : ''}>▼ Baja bajo</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Precio target (USD)</label>
          <input id="alert-price" type="number" step="0.01" min="0" class="form-input" placeholder="Ej: 180.00" value="${prefill?.targetPrice ?? ''}">
        </div>
        <button class="btn-primary" onclick="submitAlert('${invId}','${inv.ticker}')">Agregar alerta</button>
      </div>

      ${invAlerts.length ? `
        <div style="border-top:1px solid var(--border);padding-top:14px">
          <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:10px">ALERTAS ACTIVAS</div>
          ${invAlerts.map(a => `
            <div class="alert-row ${a.triggered ? 'triggered' : ''}">
              <span class="alert-cond">${a.condition === 'above' ? '▲' : '▼'} ${formatUSD(a.targetPrice)}</span>
              ${a.triggered
                ? `<span class="alert-status fired">Disparada</span>
                   <button class="alert-action" onclick="resetAlert('${a.id}');openAlertModal('${invId}')">↺ Reset</button>`
                : `<span class="alert-status active">Activa</span>`}
              <button class="alert-action danger" onclick="deleteAlert('${a.id}');openAlertModal('${invId}')">🗑️</button>
            </div>`).join('')}
        </div>` : ''}

      ${typeof Notification !== 'undefined' && Notification.permission === 'denied' ? `
        <p style="color:var(--red);font-size:12px;margin-top:12px">⚠️ Notificaciones bloqueadas en este navegador. Actívalas en Ajustes del sitio.</p>` : ''}
    </div>`);
}

function submitAlert(invId, ticker) {
  const condition   = document.getElementById('alert-condition').value;
  const targetPrice = parseFloat(document.getElementById('alert-price').value);
  if (!targetPrice || targetPrice <= 0) { alert('Ingresa un precio válido'); return; }
  addAlert({ invId, ticker, condition, targetPrice, active: true });
  openAlertModal(invId);
}
function handleOverlayClick(e) { if (e.target===document.getElementById('modal-overlay')) closeModal(); }
function openAddModal() {
  if (state.view === 'savings' && state.savingsSubTab === 'subs') return openSubscriptionModal();
  if (state.view === 'savings') return openSavingsModal();
  ({ dashboard:openTransactionModal, transactions:openTransactionModal, investments:openInvestmentModal, projection:openTransactionModal }[state.view]||openTransactionModal)();
}

/* ── Transaction Modal ───────────────────────────────────── */
function openTransactionModal(tx) {
  const editing = !!tx && !!tx.id;   // only editing when tx has an existing id
  const type = tx ? tx.type : state.addType;
  const cats = state.categories[type];
  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">${editing?'Editar':'Nueva'} Transacción</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="type-toggle" style="margin-bottom:20px">
      <button class="type-btn ${type==='Gasto'?'active':''}" onclick="switchModalType('Gasto')">Gasto</button>
      <button class="type-btn ${type==='Ingreso'?'active':''}" onclick="switchModalType('Ingreso')">Ingreso</button>
    </div>
    <form id="tx-form" onsubmit="submitTransaction(event,'${tx?.id||''}')">
      <div class="form-group">
        <label class="form-label">Fecha</label>
        <input class="form-input" type="date" id="tx-date" value="${tx?.date||todayISO()}" required>
      </div>
      <div class="form-group">
        <label class="form-label">Categoría</label>
        <select class="form-input" id="tx-cat" onchange="handleCatChange(this)">
          ${cats.map(c=>`<option value="${c}" ${tx?.category===c?'selected':''}>${catIcon(c)} ${c}</option>`).join('')}
          <option value="__nueva__">✏️ Nueva categoría…</option>
        </select>
        <input class="form-input" type="text" id="tx-cat-custom" placeholder="Nombre de la nueva categoría" style="display:none;margin-top:8px">
      </div>
      <div class="form-group">
        <label class="form-label">Descripción</label>
        <input class="form-input" type="text" id="tx-desc" placeholder="${type==='Gasto'?'Ej: Gasolina':'Ej: Salario mensual'}" value="${tx?.description||''}" required>
      </div>
      <div class="form-group">
        <label class="form-label">Monto (COP)</label>
        <input class="form-input" type="number" id="tx-amount" placeholder="0" min="0" value="${tx?.amount||''}" required>
      </div>
      <div class="form-group">
        <label class="form-label">Método</label>
        <div class="pay-toggle">
          <button type="button" class="pay-btn ${(tx?.paymentMethod||state.addPaymentMethod)==='Efectivo'?'active':''}" onclick="switchPayMethod('Efectivo')">💵 Efectivo</button>
          ${type==='Gasto'
            ? `<button type="button" class="pay-btn ${(tx?.paymentMethod||state.addPaymentMethod)==='Tarjeta'?'active':''}" onclick="switchPayMethod('Tarjeta')">💳 Tarjeta</button>`
            : `<button type="button" class="pay-btn ${(tx?.paymentMethod||state.addPaymentMethod)==='Transferencia'?'active':''}" onclick="switchPayMethod('Transferencia')">🏦 Transferencia</button>`
          }
        </div>
      </div>
      <button type="submit" class="btn-primary">${editing?'Guardar cambios':'Agregar'}</button>
    </form>`);
}
function switchModalType(type) {
  const desc = document.getElementById('tx-desc')?.value ?? '';
  const amt  = document.getElementById('tx-amount')?.value ?? '';
  const date = document.getElementById('tx-date')?.value ?? todayISO();
  state.addType = type;
  state.addPaymentMethod = 'Efectivo';
  openTransactionModal(desc || amt ? { type, description: desc, amount: parseFloat(amt) || undefined, date } : null);
}
function handleCatChange(sel) {
  const custom = document.getElementById('tx-cat-custom');
  if (custom) custom.style.display = sel.value==='__nueva__' ? 'block' : 'none';
}
function switchPayMethod(method) { state.addPaymentMethod=method; document.querySelectorAll('.pay-btn').forEach(b=>b.classList.toggle('active',b.textContent.includes(method))); }
async function submitTransaction(e, editId) {
  e.preventDefault();
  const paymentMethod = state.addPaymentMethod;
  let category = document.getElementById('tx-cat').value;
  if (category === '__nueva__') {
    const custom = document.getElementById('tx-cat-custom')?.value.trim();
    if (!custom) { alert('Escribe el nombre de la nueva categoría.'); return; }
    category = custom;
    if (!state.categories[state.addType].includes(category)) {
      state.categories[state.addType].push(category);
      saveLocal();
    }
  }
  const tx = { date:document.getElementById('tx-date').value, type:state.addType, category, description:document.getElementById('tx-desc').value.trim(), amount:Number(document.getElementById('tx-amount').value), paymentMethod };
  closeModal();
  if (editId) {
    const idx = state.transactions.findIndex(t=>t.id===editId);
    if (idx>=0) state.transactions[idx] = {...state.transactions[idx],...tx};
    saveLocal(); renderView();
    try { await updateRowById('Transacciones',editId,[editId,tx.date,tx.type,tx.category,tx.description,tx.amount,tx.paymentMethod||'']); } catch(e) {}
  } else {
    await addTransaction(tx);
    // Auto-link: if a Gasto matches a subscription name, advance its next payment date
    if (tx.type === 'Gasto') {
      const matched = state.subscriptions.find(s =>
        tx.description.toLowerCase().includes(s.name.toLowerCase()) ||
        s.name.toLowerCase().includes(tx.description.toLowerCase())
      );
      if (matched) await markSubscriptionPaid(matched.id, false);
    }
  }
}

/* ── Savings Modal ───────────────────────────────────────── */
function openSavingsModal() {
  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">Nueva Meta de Ahorro</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <form onsubmit="submitSavingsGoal(event)">
      <div class="form-group"><label class="form-label">Nombre</label><input class="form-input" type="text" id="sv-name" placeholder="Ej: Viaje a Europa" required></div>
      <div class="form-group"><label class="form-label">Meta (COP)</label><input class="form-input" type="number" id="sv-goal" min="1" required></div>
      <div class="form-group"><label class="form-label">Fecha límite (opcional)</label><input class="form-input" type="date" id="sv-deadline"></div>
      <div class="form-group"><label class="form-label">Notas</label><input class="form-input" type="text" id="sv-notes" placeholder="Opcional"></div>
      <button type="submit" class="btn-primary">Crear meta</button>
    </form>`);
}
async function submitSavingsGoal(e) {
  e.preventDefault();
  closeModal();
  await addSavingsGoal({ name:document.getElementById('sv-name').value.trim(), goal:Number(document.getElementById('sv-goal').value), deadline:document.getElementById('sv-deadline').value, notes:document.getElementById('sv-notes').value.trim() });
}
function openAddProgressModal(id) {
  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">Agregar Ahorro</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <form onsubmit="submitProgress(event,'${id}')">
      <div class="form-group"><label class="form-label">Monto a agregar (COP)</label><input class="form-input" type="number" id="prog-amount" min="1" required></div>
      <button type="submit" class="btn-primary">Agregar</button>
    </form>`);
}
async function submitProgress(e, id) {
  e.preventDefault();
  const amt = Number(document.getElementById('prog-amount').value);
  closeModal(); await updateSavingsProgress(id, amt);
}
function openEditSavingsModal(s) {
  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">Editar Meta</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <form onsubmit="submitEditSavings(event,'${s.id}')">
      <div class="form-group"><label class="form-label">Nombre</label><input class="form-input" type="text" id="sv-edit-name" value="${s.name}" required></div>
      <div class="form-group"><label class="form-label">Meta (COP)</label><input class="form-input" type="number" id="sv-edit-goal" value="${s.goal}" min="1" required></div>
      <div class="form-group"><label class="form-label">Fecha límite</label><input class="form-input" type="date" id="sv-edit-deadline" value="${s.deadline||''}"></div>
      <div class="form-group"><label class="form-label">Notas</label><input class="form-input" type="text" id="sv-edit-notes" value="${s.notes||''}"></div>
      <button type="submit" class="btn-primary">Guardar cambios</button>
    </form>`);
}
async function submitEditSavings(e, id) {
  e.preventDefault();
  const s = state.savings.find(s=>s.id===id); if (!s) return;
  s.name     = document.getElementById('sv-edit-name').value.trim();
  s.goal     = Number(document.getElementById('sv-edit-goal').value);
  s.deadline = document.getElementById('sv-edit-deadline').value;
  s.notes    = document.getElementById('sv-edit-notes').value.trim();
  closeModal(); saveLocal(); renderView();
  if (!state.accessToken) return;
  try { await updateRowById('Ahorro',id,[id,s.name,s.goal,s.current,s.deadline,s.notes||'']); } catch(e) {}
}

/* ── Subscription Modal ──────────────────────────────────── */
function openSubscriptionModal(sub) {
  const editing = !!sub;
  const cats = ['Streaming','Música','Software','Membresías','Seguros','Servicios','Gimnasio','Nube','Gaming','Otros'];
  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">${editing?'Editar':'Nueva'} Suscripción</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <form onsubmit="submitSubscription(event,'${sub?.id||''}')">
      <div class="form-group">
        <label class="form-label">Nombre</label>
        <input class="form-input" type="text" id="sub-name" placeholder="Ej: Netflix, Spotify…" value="${sub?.name||''}" required>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Monto</label>
          <input class="form-input" type="number" id="sub-amount" placeholder="0" min="0" step="any" value="${sub?.amount||''}" required>
        </div>
        <div class="form-group">
          <label class="form-label">Moneda</label>
          <select class="form-input" id="sub-currency">
            <option value="COP" ${(sub?.currency||'COP')==='COP'?'selected':''}>COP</option>
            <option value="USD" ${sub?.currency==='USD'?'selected':''}>USD</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Frecuencia</label>
          <select class="form-input" id="sub-freq">
            ${['weekly','monthly','quarterly','semestral','annual'].map(f=>`<option value="${f}" ${(sub?.frequency||'monthly')===f?'selected':''}>${freqLabel(f)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Categoría</label>
          <select class="form-input" id="sub-cat">
            ${cats.map(c=>`<option value="${c}" ${sub?.category===c?'selected':''}>${subIcon(c)} ${c}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Próximo pago</label>
        <input class="form-input" type="date" id="sub-next" value="${sub?.nextPaymentDate||todayISO()}" required>
      </div>
      <div class="form-group">
        <label class="form-label">Notas</label>
        <input class="form-input" type="text" id="sub-notes" placeholder="Opcional" value="${sub?.notes||''}">
      </div>
      <button type="submit" class="btn-primary">${editing?'Guardar cambios':'Agregar suscripción'}</button>
    </form>`);
}
async function submitSubscription(e, editId) {
  e.preventDefault();
  const sub = {
    name:            document.getElementById('sub-name').value.trim(),
    amount:          Number(document.getElementById('sub-amount').value),
    currency:        document.getElementById('sub-currency').value,
    frequency:       document.getElementById('sub-freq').value,
    category:        document.getElementById('sub-cat').value,
    nextPaymentDate: document.getElementById('sub-next').value,
    notes:           document.getElementById('sub-notes').value.trim()
  };
  closeModal();
  if (editId) {
    const idx = state.subscriptions.findIndex(s=>s.id===editId);
    if (idx>=0) state.subscriptions[idx] = {...state.subscriptions[idx],...sub};
    saveLocal(); renderView();
    const s = state.subscriptions[idx>=0?idx:0];
    try { await updateRowById('Suscripciones',editId,[editId,s.name,s.amount,s.currency,s.frequency,s.nextPaymentDate,s.category,s.notes||'']); } catch(e) {}
  } else { await addSubscription(sub); }
}

/* ── Subscription Card ───────────────────────────────────── */
function subscriptionCard(sub) {
  const days = subDaysUntil(sub.nextPaymentDate);
  const isOverdue = days < 0;
  const isUrgent  = !isOverdue && days <= 3;
  const isSoon    = !isOverdue && days <= 7;
  const monthlyCOP = sub.currency === 'USD'
    ? (sub.amount / freqMonths(sub.frequency)) * (state.usdCopRate||4200)
    : sub.amount / freqMonths(sub.frequency);
  const daysLabel = isOverdue
    ? `⚠️ Vencida hace ${Math.abs(days)} día${Math.abs(days)!==1?'s':''}`
    : days===0 ? '🔴 Hoy' : days===1 ? '🟡 Mañana' : `📅 En ${days} días`;
  const urgCls = isOverdue ? 'sub-overdue' : isUrgent ? 'sub-urgent' : isSoon ? 'sub-soon' : '';
  return `
    <div class="sub-card ${urgCls}">
      <div class="sub-header">
        <div class="sub-icon-name">
          <span class="sub-icon-badge">${subIcon(sub.category)}</span>
          <div>
            <div class="sub-name">${sub.name}</div>
            <div class="sub-meta">${freqLabel(sub.frequency)} · ${sub.category}</div>
          </div>
        </div>
        <div class="sub-actions-row">
          <button class="action-btn" onclick="editSubscription('${sub.id}')">✏️</button>
          <button class="action-btn danger" onclick="confirmDelete('sub','${sub.id}')">🗑️</button>
        </div>
      </div>
      <div class="sub-body">
        <div>
          <div class="sub-amount-val">${sub.currency==='USD'?formatUSD(sub.amount):formatCOP(sub.amount)}</div>
          <div class="sub-monthly-val">≈ ${formatCOP(monthlyCOP)}/mes</div>
        </div>
        <div class="sub-next-block">
          <div class="sub-next-label">Próximo pago</div>
          <div class="sub-next-date">${dateStr(sub.nextPaymentDate)}</div>
          <div class="sub-days ${urgCls}">${daysLabel}</div>
        </div>
      </div>
      <button class="sub-paid-btn" onclick="markSubscriptionPaid('${sub.id}')">✓ Marcar pagada · avanzar al próximo ciclo</button>
    </div>`;
}

/* ── Investment Modal (with ticker search) ───────────────── */
function openInvestmentModal(prefill = null) {
  const prefillTicker = prefill?.ticker ?? '';
  const prefillAmount = prefill?.amountUSD ?? '';
  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">Nueva Inversión</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>

    <div class="form-group">
      <label class="form-label">Buscar acción / ETF / Cripto</label>
      <div class="search-box">
        <input class="form-input" type="text" id="inv-search" placeholder="Ej: Apple, AAPL, Bitcoin, BTC-USD…" autocomplete="off" oninput="searchTicker(this.value)">
        <div id="search-results" class="search-dropdown hidden"></div>
      </div>
    </div>

    <form onsubmit="submitInvestment(event)">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Ticker / Símbolo</label>
          <input class="form-input" type="text" id="inv-ticker" placeholder="Ej: AAPL, BTC-USD" style="text-transform:uppercase" value="${prefillTicker}">
        </div>
        <div class="form-group">
          <label class="form-label">Nombre</label>
          <input class="form-input" type="text" id="inv-name" placeholder="Ej: Apple Inc." required>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Tipo</label>
          <select class="form-input" id="inv-type">
            <option>Acciones</option><option>ETF</option><option>Criptomoneda</option>
            <option>Fondo de inversión</option><option>Bonos</option><option>CDT</option><option>Otro</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Fecha de compra</label>
          <input class="form-input" type="date" id="inv-date" value="${todayISO()}" required>
        </div>
      </div>

      <div class="form-group" style="background:var(--bg);border:1.5px solid var(--border);border-radius:10px;padding:14px;margin-top:4px">
        <div style="font-weight:600;margin-bottom:12px;color:var(--text)">📦 Primera compra</div>
        <div class="form-row">
          <div class="form-group" style="margin-bottom:8px">
            <label class="form-label">Monto invertido (USD)</label>
            <input class="form-input" type="number" id="inv-amount" placeholder="Ej: 50.00" min="0" step="any" oninput="calcSharesFromAmount()" required value="${prefillAmount}">
          </div>
          <div class="form-group" style="margin-bottom:8px">
            <label class="form-label">Precio de entrada (USD)</label>
            <input class="form-input" type="number" id="inv-purchase-price" placeholder="Ej: 191.50" min="0" step="any" oninput="calcSharesFromAmount()" required>
          </div>
        </div>
        <div class="calc-hint" id="inv-calc-hint" style="margin-top:4px"></div>
      </div>

      <div class="form-group">
        <label class="form-label">Notas</label>
        <input class="form-input" type="text" id="inv-notes" placeholder="Opcional">
      </div>
      <button type="submit" class="btn-primary">Agregar inversión</button>
    </form>`);
}

/* Ticker search autocomplete */
let _searchTimeout;
function searchTicker(query) {
  clearTimeout(_searchTimeout);
  const dd = document.getElementById('search-results');
  if (!dd) return;
  if (query.length < 2) { dd.classList.add('hidden'); return; }
  _searchTimeout = setTimeout(async () => {
    dd.innerHTML = '<div class="search-result loading">Buscando…</div>';
    dd.classList.remove('hidden');
    const results = await fetchSearch(query);
    if (!results.length) { dd.innerHTML = '<div class="search-result loading">Sin resultados</div>'; return; }
    dd.innerHTML = results.map(r => {
      const sym  = (r.symbol||'').replace(/'/g,"\\'");
      const name = (r.shortname||r.longname||r.symbol||'').replace(/'/g,"\\'");
      const exch = r.exchange || r.exchDisp || '';
      const type = r.quoteType || '';
      return `<div class="search-result" onclick="selectTicker('${sym}','${name}','${exch}','${type}')">
        <div class="sr-ticker">${r.symbol} <span class="sr-exch">${exch}</span></div>
        <div class="sr-name">${r.shortname||r.longname||''}</div>
      </div>`;
    }).join('');
  }, 300);
}
function selectTicker(symbol, name, exchange, type) {
  document.getElementById('inv-ticker').value = symbol;
  document.getElementById('inv-name').value   = name;
  document.getElementById('inv-search').value = `${symbol} — ${name}`;
  const typeMap = { EQUITY:'Acciones', ETF:'ETF', MUTUALFUND:'Fondo de inversión', CRYPTOCURRENCY:'Criptomoneda' };
  const sel = document.getElementById('inv-type');
  if (sel && typeMap[type]) {
    Array.from(sel.options).forEach(o => { if (o.value===typeMap[type]) o.selected=true; });
  }
  document.getElementById('search-results').classList.add('hidden');
}
function calcSharesFromAmount() {
  const amount = Number(document.getElementById('inv-amount')?.value)||0;
  const price  = Number(document.getElementById('inv-purchase-price')?.value)||0;
  const hint   = document.getElementById('inv-calc-hint');
  if (amount>0 && price>0) {
    const shares = Math.round(amount / price * 1e8) / 1e8;
    if (hint) hint.textContent = `${formatUSD(amount)} ÷ ${formatUSD(price)} = ${shares} unidades ≈ ${formatCOP(amount * state.usdCopRate)}`;
  } else if (hint) hint.textContent = '';
}
async function submitInvestment(e) {
  e.preventDefault();
  const amount = Number(document.getElementById('inv-amount').value)||0;
  const price  = Number(document.getElementById('inv-purchase-price').value)||0;
  if (amount <= 0) { alert('Ingresa el monto invertido.'); return; }
  if (price  <= 0) { alert('Ingresa el precio de entrada para calcular las unidades.'); return; }
  const shares = Math.round(amount / price * 1e8) / 1e8;
  const date   = document.getElementById('inv-date').value || todayISO();
  const inv = {
    name:          document.getElementById('inv-name').value.trim(),
    ticker:        normalizeTicker(document.getElementById('inv-ticker').value.trim()),
    type:          document.getElementById('inv-type').value,
    invested: amount, currentValue: amount,
    shares, purchasePrice: price,
    notes:         document.getElementById('inv-notes').value.trim()
  };
  closeModal();
  await addInvestment(inv);
  if (amount > 0 && price > 0) {
    await addInvestmentPurchase({ investmentId:inv.id, date, shares, priceUSD:price, amountUSD:amount });
  }
  if (inv.ticker) { await refreshInvestmentPrices(); renderView(); }
}

function openAddPurchaseModal(invId) {
  const inv = state.investments.find(i=>i.id===invId);
  if (!inv) return;
  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">Agregar Compra</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <p style="color:var(--text-secondary);margin-bottom:16px">${inv.name}${inv.ticker?' ('+inv.ticker+')':''}</p>
    <form onsubmit="submitAddPurchase(event,'${invId}')">
      <div class="form-group">
        <label class="form-label">Fecha de compra</label>
        <input class="form-input" type="date" id="pur-date" value="${todayISO()}" required>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Monto invertido (USD)</label>
          <input class="form-input" type="number" id="pur-amount" placeholder="Ej: 50.00" min="0" step="any" oninput="calcSharesFromPurchase()" required>
        </div>
        <div class="form-group">
          <label class="form-label">Precio de entrada (USD)</label>
          <input class="form-input" type="number" id="pur-price" placeholder="0.00" min="0" step="any" value="${inv.marketPrice||inv.purchasePrice||''}" oninput="calcSharesFromPurchase()">
        </div>
      </div>
      <div class="calc-hint" id="pur-calc-hint"></div>
      <button type="submit" class="btn-primary">Registrar compra</button>
    </form>`);
}
function calcSharesFromPurchase() {
  const amount = Number(document.getElementById('pur-amount')?.value)||0;
  const price  = Number(document.getElementById('pur-price')?.value)||0;
  const hint   = document.getElementById('pur-calc-hint');
  if (amount>0 && price>0) {
    const shares = Math.round(amount / price * 1e8) / 1e8;
    if (hint) hint.textContent = `${formatUSD(amount)} ÷ ${formatUSD(price)} = ${shares} unidades ≈ ${formatCOP(amount * state.usdCopRate)}`;
  } else if (hint) hint.textContent = '';
}
async function submitAddPurchase(e, invId) {
  e.preventDefault();
  const amount = Number(document.getElementById('pur-amount').value)||0;
  const price  = Number(document.getElementById('pur-price').value)||0;
  if (amount <= 0) { alert('Ingresa el monto invertido.'); return; }
  if (price  <= 0) { alert('Ingresa el precio de entrada.'); return; }
  const shares = Math.round(amount / price * 1e8) / 1e8;
  const purchase = { investmentId:invId, date:document.getElementById('pur-date').value, shares, priceUSD:price, amountUSD:amount };
  closeModal();
  await addInvestmentPurchase(purchase);
  await refreshInvestmentPrices();
  renderView();
}
function togglePurchaseHistory(invId) {
  const el = document.getElementById(`ph-${invId}`);
  const arr = document.getElementById(`ph-arrow-${invId}`);
  if (!el) return;
  const hidden = el.classList.toggle('hidden');
  if (arr) arr.textContent = hidden ? '▶' : '▼';
}
function openUpdateValueModal(id) {
  const inv = state.investments.find(i=>i.id===id); if (!inv) return;
  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">Actualizar Valor</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <p style="color:var(--text-secondary);margin-bottom:16px">${inv.name}${inv.ticker?' ('+inv.ticker+')':''}</p>
    <form onsubmit="submitUpdateValue(event,'${id}')">
      <div class="form-group"><label class="form-label">Nuevo valor actual (USD)</label>
        <input class="form-input" type="number" id="inv-newval" value="${inv.currentValue}" min="0" step="any" required></div>
      <button type="submit" class="btn-primary">Actualizar</button>
    </form>`);
}
async function submitUpdateValue(e, id) {
  e.preventDefault();
  const val = Number(document.getElementById('inv-newval').value);
  closeModal(); await updateInvestmentValue(id, val);
}
function openEditInvestmentModal(inv) {
  const types = ['Acciones','ETF','Criptomoneda','Fondo de inversión','Bonos','CDT','Otro'];
  const fi = state.investments.find(i=>i.id===inv.id) || inv;
  const hasTicker  = !!(fi.ticker);
  const livePrice  = fi.marketPrice || 0;
  const shares     = fi.shares || 0;
  const invested   = fi.invested || 0;
  // Valor actual: shares × precio vivo, o currentValue si no hay precio
  const curVal  = hasTicker && livePrice > 0 ? shares * livePrice : (fi.currentValue || invested);
  const gain    = curVal - invested;
  const gainPct = invested > 0 ? (gain / invested * 100) : 0;
  const gainCol = gain >= 0 ? 'var(--green)' : 'var(--red)';
  const gainSign= gain >= 0 ? '+' : '';

  const livePanelHtml = hasTicker ? `
    <div class="inv-edit-panel">
      <div class="inv-edit-panel-row">
        <span>Precio en vivo</span>
        <strong>${livePrice > 0
          ? `${formatUSD(livePrice)} <span class="live-dot">⚡</span>`
          : '<span style="color:var(--muted)">No cargado aún — actualiza precios</span>'}</strong>
      </div>
      <div class="inv-edit-panel-row">
        <span>Unidades / Acciones</span>
        <strong>${shares > 0 ? shares : '<span style="color:var(--red)">0 — edita el lote ✏️</span>'}</strong>
      </div>
      <div class="inv-edit-panel-row">
        <span>Monto invertido</span>
        <strong>${formatUSD(invested)}</strong>
      </div>
      <div class="inv-edit-panel-row">
        <span>Valor actual</span>
        <strong>${formatUSD(curVal)}</strong>
      </div>
      <div class="inv-edit-panel-row inv-edit-panel-gain">
        <span>Ganancia / Pérdida</span>
        <strong style="color:${gainCol}">${gainSign}${formatUSD(gain)} (${gainSign}${gainPct.toFixed(2)}%)</strong>
      </div>
    </div>
    ${shares === 0 ? `<p class="inv-edit-warn">⚠️ Unidades en 0 — abre el historial y pulsa ✏️ en el lote de compra para corregir el precio y las unidades.</p>` : ''}
  ` : `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Monto invertido (USD)</label>
        <input class="form-input" type="number" id="inv-edit-invested" min="0" step="any" value="${invested}">
      </div>
      <div class="form-group">
        <label class="form-label">Valor actual (USD)</label>
        <input class="form-input" type="number" id="inv-edit-value" min="0" step="any" value="${fi.currentValue||0}">
      </div>
    </div>
  `;

  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">Editar Inversión</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <form onsubmit="submitEditInvestment(event,'${fi.id}')">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Ticker</label>
          <input class="form-input" type="text" id="inv-edit-ticker" value="${fi.ticker||''}" style="text-transform:uppercase">
        </div>
        <div class="form-group">
          <label class="form-label">Nombre</label>
          <input class="form-input" type="text" id="inv-edit-name" value="${fi.name||''}" required>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Tipo</label>
        <select class="form-input" id="inv-edit-type">
          ${types.map(t=>`<option value="${t}" ${fi.type===t?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      ${livePanelHtml}
      <div class="form-group">
        <label class="form-label">Notas</label>
        <input class="form-input" type="text" id="inv-edit-notes" value="${fi.notes||''}">
      </div>
      <button type="submit" class="btn-primary">Guardar cambios</button>
    </form>`);
}
async function submitEditInvestment(e, id) {
  e.preventDefault();
  const inv = state.investments.find(i=>i.id===id); if (!inv) return;
  inv.ticker = document.getElementById('inv-edit-ticker').value.trim().toUpperCase();
  inv.name   = document.getElementById('inv-edit-name').value.trim();
  inv.type   = document.getElementById('inv-edit-type').value;
  inv.notes  = document.getElementById('inv-edit-notes').value.trim();
  if (!inv.ticker) {
    // Sin ticker: los valores se editan manualmente
    inv.currentValue = Number(document.getElementById('inv-edit-value')?.value) || 0;
    inv.invested     = Number(document.getElementById('inv-edit-invested')?.value) || 0;
  } else {
    // Con ticker: los valores vienen de compras + precio en vivo, no se tocan aquí
    recalcInvestment(id);
  }
  closeModal(); saveLocal(); renderView();
  if (!state.accessToken) return;
  try { await updateRowById('Inversiones', id, invArr(inv)); } catch(e) {}
}

/* ── Confirm delete ──────────────────────────────────────── */
function confirmDelete(entity, id) {
  let title = '¿Eliminar?';
  let detail = '';
  let warning = '';

  if (entity === 'tx') {
    const tx = state.transactions.find(t => t.id === id);
    if (tx) {
      detail = `<p class="confirm-detail">"${tx.description}"<br><strong>${formatUSD(Math.abs(tx.amount))}</strong></p>`;
    }
  } else if (entity === 'savings') {
    const sg = state.savings.find(s => s.id === id);
    if (sg) {
      detail = `<p class="confirm-detail">"${sg.name}"<br><strong>${formatUSD(sg.saved)}</strong> ahorrados</p>`;
    }
  } else if (entity === 'inv') {
    const inv = state.investments.find(i => i.id === id);
    if (inv) {
      const lotCount = state.investmentPurchases.filter(p => p.investmentId === id).length;
      detail = `<p class="confirm-detail">${inv.name}${inv.ticker ? ` (${inv.ticker})` : ''}</p>`;
      if (lotCount > 0) {
        warning = `<div class="confirm-warning">⚠️ También se eliminarán ${lotCount} lote${lotCount > 1 ? 's' : ''} de compra del historial.</div>`;
      }
    }
  } else if (entity === 'sub') {
    const sub = state.subscriptions.find(s => s.id === id);
    if (sub) {
      detail = `<p class="confirm-detail">"${sub.name}"<br><strong>${formatUSD(sub.amount)}/mes</strong></p>`;
    }
  } else if (entity === 'purchase') {
    const p = state.investmentPurchases.find(x => x.id === id);
    if (p) {
      const inv = state.investments.find(i => i.id === p.investmentId);
      const invName = inv ? `${inv.name}${inv.ticker ? ` (${inv.ticker})` : ''}` : '';
      detail = `<p class="confirm-detail">${invName}<br>${p.shares} unidades · ${formatUSD(p.priceUSD)} c/u · ${dateStr(p.date)}</p>`;
    }
  }

  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">${title}</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    ${detail}
    ${warning}
    <p style="color:var(--text-secondary);margin-bottom:24px;font-size:13px">Esta acción no se puede deshacer.</p>
    <div style="display:flex;gap:12px">
      <button class="btn-secondary" style="flex:1" onclick="closeModal()">Cancelar</button>
      <button class="btn-danger"    style="flex:1" onclick="doDelete('${entity}','${id}')">Eliminar</button>
    </div>`);
}
async function doDelete(entity, id) {
  closeModal();
  if (entity === 'tx')       await deleteTransaction(id);
  if (entity === 'savings')  await deleteSavingsGoal(id);
  if (entity === 'inv')      await deleteInvestment(id);
  if (entity === 'sub')      await deleteSubscription(id);
  if (entity === 'purchase') await deleteInvestmentPurchase(id);
}

/* ── ID-based edit wrappers (avoid JSON.stringify in onclick) ── */
function editTransaction(id)  { openTransactionModal(state.transactions.find(t => t.id === id)); }
function editSavings(id)      { openEditSavingsModal(state.savings.find(s => s.id === id)); }
function editSubscription(id) { openSubscriptionModal(state.subscriptions.find(s => s.id === id)); }
function editInvestment(id)   { openEditInvestmentModal(state.investments.find(i => i.id === id)); }

/* ════════════════════════════════════════════════════════════
   BUDGET PANEL + MODAL
   ════════════════════════════════════════════════════════════ */
function budgetBarColor(pct) {
  if (pct >= 100) return 'var(--red)';
  if (pct >= 80)  return '#FF9F0A';
  return 'var(--green)';
}

function renderBudgetPanel() {
  const progress = getBudgetProgress();
  const now = new Date();
  const monthLabel = now.toLocaleDateString('es-CO', { month: 'long' });

  if (!progress.length) {
    return `
      <div class="section-header">
        <span class="section-title">Presupuesto — ${monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1)}</span>
        <button class="section-link" onclick="openBudgetModal()">+ Agregar</button>
      </div>
      <div class="card" style="text-align:center;padding:24px 20px">
        <div style="font-size:28px;margin-bottom:8px">🎯</div>
        <div style="font-weight:600;margin-bottom:4px">Sin presupuestos</div>
        <div style="color:var(--muted);font-size:13px;margin-bottom:14px">Define un límite mensual por categoría para controlar tus gastos.</div>
        <button class="btn-primary" style="font-size:13px;padding:8px 20px" onclick="openBudgetModal()">Crear presupuesto</button>
      </div>`;
  }

  const totalBudget = progress.reduce((a, b) => a + b.monthlyLimit, 0);
  const totalSpent  = progress.reduce((a, b) => a + b.spent, 0);
  const overCount   = progress.filter(b => b.pct >= 100).length;

  return `
    <div class="section-header">
      <span class="section-title">Presupuesto — ${monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1)}</span>
      <button class="section-link" onclick="openBudgetModal()">Gestionar</button>
    </div>
    <div class="card" style="padding:16px 20px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px">
        <div>
          <span style="font-size:20px;font-weight:700">${formatCOP(totalSpent)}</span>
          <span style="color:var(--muted);font-size:13px"> / ${formatCOP(totalBudget)}</span>
        </div>
        ${overCount > 0
          ? `<span style="font-size:12px;font-weight:600;color:var(--red)">⚠️ ${overCount} excedido${overCount > 1 ? 's' : ''}</span>`
          : `<span style="font-size:12px;font-weight:600;color:var(--green)">✓ En control</span>`}
      </div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${progress.map(b => {
          const col   = budgetBarColor(b.pct);
          const width = Math.min(b.pct, 100).toFixed(1);
          const over  = b.pct > 100;
          return `
            <div>
              <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <span style="font-size:13px">${catIcon(b.category)} ${b.category}</span>
                <span style="font-size:12px;font-weight:600;color:${col}">
                  ${formatCOP(b.spent)} / ${formatCOP(b.monthlyLimit)}
                  ${over ? `<span style="margin-left:4px">+${formatCOP(b.spent - b.monthlyLimit)}</span>` : ''}
                </span>
              </div>
              <div style="background:var(--border);border-radius:4px;height:6px;overflow:hidden">
                <div style="height:100%;width:${width}%;background:${col};border-radius:4px;transition:width 0.4s"></div>
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function openBudgetModal() {
  const cats    = state.categories.Gasto;
  const budgets = state.budgets;

  openModal(`
    <div class="modal-header">
      <h3>🎯 Presupuesto mensual</h3>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      ${budgets.length ? `
        <div style="margin-bottom:16px">
          ${budgets.map(b => `
            <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
              <span style="flex:1;font-size:14px">${catIcon(b.category)} ${b.category}</span>
              <span style="font-weight:600;font-size:14px">${formatCOP(b.monthlyLimit)}</span>
              <button onclick="openEditBudget('${b.id}')" style="background:none;border:none;cursor:pointer;font-size:16px;padding:4px">✏️</button>
              <button onclick="deleteBudget('${b.id}').then(()=>openBudgetModal())" style="background:none;border:none;cursor:pointer;font-size:16px;padding:4px">🗑️</button>
            </div>`).join('')}
        </div>` : ''}
      <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:10px">
        ${budgets.length ? 'AGREGAR OTRO' : 'NUEVA CATEGORÍA'}
      </div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <select id="budget-cat" class="form-input">
          ${cats.filter(c => !budgets.find(b => b.category === c)).map(c =>
            `<option value="${c}">${catIcon(c)} ${c}</option>`).join('')}
        </select>
        <input id="budget-amount" class="form-input" type="number" min="0" placeholder="Límite mensual (COP)" style="font-size:16px">
        <button class="btn-primary" onclick="submitBudget()">Guardar presupuesto</button>
      </div>
    </div>`);
}

function openEditBudget(id) {
  const b = state.budgets.find(x => x.id === id);
  if (!b) return;
  openModal(`
    <div class="modal-header">
      <h3>✏️ Editar — ${b.category}</h3>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div style="display:flex;flex-direction:column;gap:12px">
        <label style="font-size:13px;color:var(--muted)">Límite mensual</label>
        <input id="budget-edit-amount" class="form-input" type="number" min="0"
          value="${b.monthlyLimit}" style="font-size:16px">
        <button class="btn-primary" onclick="submitEditBudget('${id}')">Guardar</button>
        <button class="btn-secondary" onclick="openBudgetModal()">Cancelar</button>
      </div>
    </div>`);
}

async function submitBudget() {
  const cat    = document.getElementById('budget-cat')?.value;
  const amount = Number(document.getElementById('budget-amount')?.value);
  if (!cat || !amount || amount <= 0) return;
  closeModal();
  await saveBudget({ category: cat, monthlyLimit: amount });
}

async function submitEditBudget(id) {
  const amount = Number(document.getElementById('budget-edit-amount')?.value);
  if (!amount || amount <= 0) return;
  const b = state.budgets.find(x => x.id === id);
  if (!b) return;
  b.monthlyLimit = amount;
  saveLocal();
  closeModal();
  try { await updateRowById('Presupuesto', id, [id, b.category, b.monthlyLimit]); } catch(e) {}
  renderView();
}

/* ════════════════════════════════════════════════════════════
   VIEW: DASHBOARD
   ════════════════════════════════════════════════════════════ */
function renderDashboard() {
  const now   = new Date();
  const year  = now.getFullYear(), month = now.getMonth();
  const balance = getBalance();
  const { current: portValue } = getPortfolioSummary();
  const history = getMonthlyHistory(4);
  const cats  = getCategoryBreakdown(year, month);
  const avgExp = getAvgMonthlyExpense();
  const hasTx  = state.transactions.length > 0;

  document.getElementById('app-content').innerHTML = `
    <div class="content-inner">
      <!-- Balance -->
      <div class="balance-card">
        <div class="balance-label">Balance total</div>
        <div class="balance-amount">${formatCOP(balance)}</div>
        <div class="balance-sub">${formatCOP(portValue)} en portafolio · ${formatCOP(balance+portValue)} total patrimonio</div>
      </div>

      <!-- Patrimonio neto -->
      ${renderPatrimonioPanel()}

      <!-- Resumen mensual tabla -->
      <div class="section-header">
        <span class="section-title">Resumen mensual</span>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <table class="summary-table">
          <thead><tr><th>Mes</th><th>Ingresos</th><th>Gastos</th><th>Neto</th><th>Ahorro</th></tr></thead>
          <tbody>
            ${history.map((m,i) => `
              <tr class="${i===history.length-1?'row-current':''}">
                <td class="col-month">${m.label}</td>
                <td class="col-income">${m.income?formatCOP(m.income):'—'}</td>
                <td class="col-expense">${m.expense?formatCOP(m.expense):'—'}</td>
                <td class="${m.net>=0?'col-income':'col-expense'}">${m.net?formatCOP(m.net):'—'}</td>
                <td class="col-pct">${m.income>0?m.savePct.toFixed(0)+'%':'—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <!-- Gastos por categoría -->
      ${cats.length ? `
        <div class="section-header">
          <span class="section-title">Gastos por categoría — ${now.toLocaleDateString('es-CO',{month:'long'})}</span>
        </div>
        <div class="card" style="padding:0;overflow:hidden">
          <table class="summary-table">
            <thead><tr><th>Categoría</th><th>Monto</th><th>%</th><th style="width:30%">Distribución</th></tr></thead>
            <tbody>
              ${cats.map(c=>`
                <tr>
                  <td><span style="margin-right:6px">${catIcon(c.cat)}</span>${c.cat}</td>
                  <td class="col-expense">${formatCOP(c.amt)}</td>
                  <td class="col-pct">${c.pct.toFixed(0)}%</td>
                  <td><div class="table-bar"><div class="table-bar-fill expense-bar" style="width:${c.pct.toFixed(1)}%"></div></div></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}

      <!-- Presupuesto mensual -->
      ${renderBudgetPanel()}

      <!-- Metas de ahorro -->
      ${state.savings.length ? `
        <div class="section-header">
          <span class="section-title">Metas de ahorro</span>
          <button class="section-link" onclick="navigate('savings')">Ver todo</button>
        </div>
        <div class="card" style="padding:0;overflow:hidden">
          <table class="summary-table">
            <thead><tr><th>Meta</th><th>Ahorrado</th><th>Objetivo</th><th style="width:25%">Progreso</th></tr></thead>
            <tbody>
              ${state.savings.map(s=>{
                const pct = s.goal>0?Math.min(s.current/s.goal*100,100):0;
                return `<tr>
                  <td>🎯 ${s.name}</td>
                  <td class="col-income">${formatCOP(s.current)}</td>
                  <td>${formatCOP(s.goal)}</td>
                  <td><div class="table-bar"><div class="table-bar-fill income-bar" style="width:${pct.toFixed(0)}%"></div></div><span style="font-size:11px;color:var(--muted)">${pct.toFixed(0)}%</span></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>` : ''}

      <!-- Portafolio -->
      ${renderPortfolioPanel()}

      <!-- Suscripciones próximas -->
      ${(() => {
        const upcomingSubs = getUpcomingSubscriptions(7);
        if (!upcomingSubs.length) return '';
        return `
          <div class="section-header">
            <span class="section-title">⚠️ Suscripciones próximas</span>
            <button class="section-link" onclick="setSavingsTab('subs');navigate('savings')">Ver todas</button>
          </div>
          <div class="card" style="padding:0;overflow:hidden">
            <table class="summary-table">
              <thead><tr><th>Nombre</th><th>Monto</th><th>Vence</th><th>Días</th></tr></thead>
              <tbody>
                ${upcomingSubs.map(s => {
                  const days = subDaysUntil(s.nextPaymentDate);
                  const isOverdue = days < 0;
                  return `<tr>
                    <td>${subIcon(s.category)} ${s.name}</td>
                    <td class="col-expense">${s.currency==='USD'?formatUSD(s.amount):formatCOP(s.amount)}</td>
                    <td>${dateStr(s.nextPaymentDate)}</td>
                    <td class="${isOverdue?'col-expense':'col-pct'}">${isOverdue?'Vencida':days===0?'Hoy':days===1?'Mañana':days+' días'}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>`;
      })()}

      ${!hasTx ? `<p class="empty-state">Sin datos todavía.<br>Toca + para agregar tu primera transacción.</p>` : ''}
    </div>`;
  requestAnimationFrame(initPatrimonioChart);
}

/* ════════════════════════════════════════════════════════════
   VIEW: TRANSACTIONS (toggle Gastos / Ingresos)
   ════════════════════════════════════════════════════════════ */
function setTxFilter(type)     { state.txFilter = type;         renderTransactions(); }
function setTxDateRange(range) { state.txDateRange = range;      renderTransactions(); }
function setTxSearch(val) {
  state.txSearch = val;
  renderTransactions();
  const inp = document.getElementById('tx-search-input');
  if (inp) { inp.value = val; inp.focus(); inp.setSelectionRange(val.length, val.length); }
}

function txInDateRange(tx) {
  if (state.txDateRange === 'all') return true;
  const d   = new Date(tx.date + 'T00:00:00');
  const now = new Date();
  if (state.txDateRange === 'month') {
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }
  const cutoff = new Date();
  if (state.txDateRange === '3m')   { cutoff.setMonth(cutoff.getMonth() - 3);           return d >= cutoff; }
  if (state.txDateRange === '6m')   { cutoff.setMonth(cutoff.getMonth() - 6);           return d >= cutoff; }
  if (state.txDateRange === 'year') { cutoff.setFullYear(cutoff.getFullYear(), 0, 1);   return d >= cutoff; }
  return true;
}

function renderTransactions() {
  const filter = state.txFilter;
  const dr     = state.txDateRange;

  const dateRanges = [
    { key: 'month', label: 'Este mes' },
    { key: '3m',    label: '3 meses'  },
    { key: '6m',    label: '6 meses'  },
    { key: 'year',  label: 'Este año' },
    { key: 'all',   label: 'Todo'     },
  ];

  // Apply date range first, then search
  const inRange   = state.transactions.filter(txInDateRange);
  const allGasto  = inRange.filter(t => t.type === 'Gasto');
  const allIngreso= inRange.filter(t => t.type === 'Ingreso');
  const totalGasto  = allGasto.reduce((a,t)  => a + Number(t.amount), 0);
  const totalIngreso= allIngreso.reduce((a,t) => a + Number(t.amount), 0);

  const base     = filter === 'Gasto' ? allGasto : allIngreso;
  const filtered = base.filter(t =>
    !state.txSearch ||
    t.description.toLowerCase().includes(state.txSearch.toLowerCase()) ||
    t.category.toLowerCase().includes(state.txSearch.toLowerCase())
  );

  // Group by month
  const groups = {};
  [...filtered].sort((a,b) => b.date.localeCompare(a.date)).forEach(t => {
    const d   = new Date(t.date + 'T00:00:00');
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const lbl = d.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
    if (!groups[key]) groups[key] = { label: lbl, txs: [], total: 0 };
    groups[key].txs.push(t);
    groups[key].total += Number(t.amount);
  });

  const filteredCount = filtered.length;
  const totalCount    = base.length;
  const isFiltered    = state.txSearch || dr !== 'all';

  document.getElementById('app-content').innerHTML = `
    <div class="content-inner">
      <!-- Búsqueda -->
      <div class="tx-search-wrap">
        <input id="tx-search-input" class="tx-search-input" type="text"
          placeholder="🔍 Buscar por descripción o categoría…"
          value="${state.txSearch}" oninput="setTxSearch(this.value)">
        ${state.txSearch ? `<button class="tx-search-clear" onclick="setTxSearch('')">✕</button>` : ''}
      </div>

      <!-- Filtro de rango de fechas -->
      <div class="tx-date-chips">
        ${dateRanges.map(r => `
          <button class="tx-date-chip${dr === r.key ? ' active' : ''}"
            onclick="setTxDateRange('${r.key}')">${r.label}</button>`).join('')}
      </div>

      <!-- Toggle Gastos / Ingresos -->
      <div class="tx-type-tabs">
        <button class="tx-tab ${filter==='Gasto'?'active-tab expense-tab':''}" onclick="setTxFilter('Gasto')">
          <span class="tx-tab-label">Gastos</span>
          <span class="tx-tab-total expense">${formatCOP(totalGasto)}</span>
        </button>
        <button class="tx-tab ${filter==='Ingreso'?'active-tab income-tab':''}" onclick="setTxFilter('Ingreso')">
          <span class="tx-tab-label">Ingresos</span>
          <span class="tx-tab-total income">${formatCOP(totalIngreso)}</span>
        </button>
      </div>

      <!-- Summary bar -->
      <div class="tx-summary-bar">
        <span>${isFiltered ? `${filteredCount} de ${totalCount}` : `${totalCount}`} ${filter==='Gasto'?'gastos':'ingresos'}</span>
        <strong class="${filter==='Gasto'?'expense':'income'}">${formatCOP(filter==='Gasto'?totalGasto:totalIngreso)}</strong>
      </div>

      <!-- Grouped list -->
      ${Object.keys(groups).length === 0
        ? `<p class="empty-state">Sin ${filter==='Gasto'?'gastos':'ingresos'} en este período.<br>${dr!=='all'?`<button class="section-link" style="margin-top:8px" onclick="setTxDateRange('all')">Ver todo el historial</button>`:'Toca + para agregar.'}</p>`
        : Object.entries(groups).map(([key, grp]) => `
            <div class="month-group">
              <div class="month-header">
                <span>${grp.label.charAt(0).toUpperCase() + grp.label.slice(1)}</span>
                <span class="month-total ${filter==='Gasto'?'expense':'income'}">${formatCOP(grp.total)}</span>
              </div>
              <div class="tx-list">${grp.txs.map(t => txCard(t, true)).join('')}</div>
            </div>`).join('')}
    </div>`;
}

function txCard(t, showActions=false) {
  const isExp = t.type==='Gasto';
  const payBadge = t.paymentMethod==='Tarjeta' ? '<span class="pay-badge card">💳</span>' : t.paymentMethod==='Efectivo' ? '<span class="pay-badge cash">💵</span>' : '';
  return `
    <div class="tx-card">
      <div class="tx-icon">${catIcon(t.category)}</div>
      <div class="tx-info">
        <div class="tx-desc">${t.description}${payBadge}</div>
        <div class="tx-meta">${t.category} · ${dateStr(t.date)}</div>
      </div>
      <div class="tx-right">
        <div class="tx-amount ${isExp?'expense':'income'}">${isExp?'-':'+'}${formatCOP(t.amount)}</div>
        ${showActions?`<div class="tx-actions">
          <button class="action-btn" onclick="editTransaction('${t.id}')">✏️</button>
          <button class="action-btn danger" onclick="confirmDelete('tx','${t.id}')">🗑️</button>
        </div>`:''}
      </div>
    </div>`;
}

/* ════════════════════════════════════════════════════════════
   VIEW: SAVINGS
   ════════════════════════════════════════════════════════════ */
function setSavingsTab(tab) { state.savingsSubTab = tab; renderSavings(); }

function renderSavings() {
  const tab = state.savingsSubTab;
  const totalGoal    = state.savings.reduce((a,s)=>a+s.goal,0);
  const totalCurrent = state.savings.reduce((a,s)=>a+s.current,0);
  const monthlySubs  = getMonthlySubscriptionCost();
  const upcoming7    = getUpcomingSubscriptions(7).length;

  document.getElementById('app-content').innerHTML = `
    <div class="content-inner">
      <div class="savings-tabs">
        <button class="savings-tab ${tab==='goals'?'active':''}" onclick="setSavingsTab('goals')">
          🎯 Metas${state.savings.length ? ` <span class="tab-badge">${state.savings.length}</span>` : ''}
        </button>
        <button class="savings-tab ${tab==='subs'?'active':''}" onclick="setSavingsTab('subs')">
          🔄 Suscripciones${upcoming7 ? ` <span class="tab-badge urgent">${upcoming7}</span>` : ''}
        </button>
      </div>
      ${tab === 'goals' ? `
        <div class="balance-card">
          <div class="balance-label">Total ahorrado</div>
          <div class="balance-amount">${formatCOP(totalCurrent)}</div>
          <div class="balance-sub">de ${formatCOP(totalGoal)} en metas</div>
        </div>
        <div class="section-header">
          <span class="section-title">Mis metas</span>
          <button class="section-link" onclick="openSavingsModal()">+ Nueva</button>
        </div>
        ${state.savings.length===0 ? `<p class="empty-state">Sin metas de ahorro.<br>Toca + para crear una.</p>` : state.savings.map(savingsCard).join('')}
      ` : `
        <div class="balance-card" style="background:linear-gradient(135deg,#AF52DE,#7B2FBE)">
          <div class="balance-label">Gasto mensual en suscripciones</div>
          <div class="balance-amount">${formatCOP(monthlySubs)}</div>
          <div class="balance-sub">${state.subscriptions.length!==1?state.subscriptions.length+' suscripciones':'1 suscripción'} · ${upcoming7} por vencer en 7 días</div>
        </div>
        <div class="section-header">
          <span class="section-title">Mis suscripciones</span>
          <button class="section-link" onclick="openSubscriptionModal()">+ Nueva</button>
        </div>
        ${(typeof Notification === 'undefined' || Notification.permission !== 'granted') ? `
        <div class="notif-banner">
          <span>🔔 Activa recordatorios para recibir alertas un día antes de cada cobro.</span>
          <button class="btn-small" onclick="enableNotifications()">Activar</button>
        </div>` : ''}
        ${state.subscriptions.length===0
          ? `<p class="empty-state">Sin suscripciones registradas.<br>Toca + para agregar.</p>`
          : state.subscriptions
              .slice().sort((a,b)=>a.nextPaymentDate.localeCompare(b.nextPaymentDate))
              .map(subscriptionCard).join('')}
      `}
    </div>`;
}
function savingsCard(s) {
  const pct = s.goal>0?Math.min(s.current/s.goal*100,100):0;
  const left = Math.max(s.goal-s.current,0);
  const daysLeft = s.deadline ? Math.ceil((new Date(s.deadline)-new Date())/86400000) : null;
  return `
    <div class="savings-card">
      <div class="savings-header">
        <div>
          <div class="savings-name">🎯 ${s.name}</div>
          ${s.deadline?`<div class="savings-deadline">${daysLeft!==null&&daysLeft>=0?daysLeft+' días restantes':'Vencida'} · ${dateStr(s.deadline)}</div>`:''}
        </div>
        <div style="display:flex;gap:4px">
          <button class="action-btn" onclick="editSavings('${s.id}')">✏️</button>
          <button class="action-btn danger" onclick="confirmDelete('savings','${s.id}')">🗑️</button>
        </div>
      </div>
      <div class="savings-amounts">${formatCOP(s.current)}<span class="savings-goal"> / ${formatCOP(s.goal)}</span></div>
      <div class="progress-bar large"><div class="progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="savings-footer">
        <span>${pct.toFixed(0)}% · Faltan ${formatCOP(left)}</span>
        <button class="btn-small" onclick="openAddProgressModal('${s.id}')">+ Abonar</button>
      </div>
      ${s.notes?`<div class="savings-notes">${s.notes}</div>`:''}
    </div>`;
}

/* ════════════════════════════════════════════════════════════
   VIEW: INVESTMENTS (live prices)
   ════════════════════════════════════════════════════════════ */
function renderInvestments() {
  const lastUpd = state.pricesLastUpdated
    ? state.pricesLastUpdated.toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit',second:'2-digit'})
    : null;

  // Portfolio totals in USD
  let totalInvUSD = 0, totalCurUSD = 0;
  state.investments.forEach(i => {
    const invUSD = i.shares>0&&i.purchasePrice>0 ? i.shares*i.purchasePrice : Number(i.invested);
    const curUSD = i.shares>0&&i.marketPrice ? i.shares*i.marketPrice : i.shares>0&&i.purchasePrice>0 ? i.shares*i.purchasePrice : Number(i.currentValue);
    totalInvUSD += invUSD; totalCurUSD += curUSD;
  });
  const pnlUSD = totalCurUSD - totalInvUSD;
  const pctUSD = totalInvUSD>0 ? (pnlUSD/totalInvUSD*100) : 0;

  const isCOP = state.invCurrency === 'COP';
  const rate  = state.usdCopRate || 4200;

  document.getElementById('app-content').innerHTML = `
    <div class="content-inner">
      <div class="balance-card ${pnlUSD<0?'negative':''}">
        <div class="balance-label">Portafolio total</div>
        <div class="balance-amount">${fmtInv(totalCurUSD)}</div>
        <div class="balance-cop-equiv">${isCOP ? `≈ ${formatUSD(totalCurUSD)}` : `≈ ${formatCOP(totalCurUSD * rate)}`}</div>
        <div class="balance-sub">Invertido: ${fmtInv(totalInvUSD)} · P&L: ${pnlUSD>=0?'+':''}${fmtInv(pnlUSD)} (${pctUSD>=0?'+':''}${pctUSD.toFixed(2)}%)</div>
      </div>

      <!-- Market info bar -->
      <div class="market-info-bar">
        <span>USD/COP: <strong>${Math.round(rate).toLocaleString('es-CO')}</strong></span>
        ${lastUpd?`<span>Precios: <strong>${lastUpd}</strong></span>`:'<span style="color:var(--muted)">Cargando precios…</span>'}
        <div class="inv-currency-toggle">
          <button class="inv-cur-btn${!isCOP?' active':''}" onclick="setInvCurrency('USD')">USD</button>
          <button class="inv-cur-btn${isCOP?' active':''}" onclick="setInvCurrency('COP')">COP</button>
        </div>
        <button class="refresh-btn" onclick="manualRefreshPrices()">↻ Actualizar</button>
      </div>

      <div class="section-header">
        <span class="section-title">Mis inversiones</span>
        <button class="section-link" onclick="openInvestmentModal()">+ Nueva</button>
      </div>

      ${!navigator.onLine && state.pricesLastUpdated ? `
        <div class="offline-banner">
          <span>📡 Sin conexión — mostrando precios de ${state.pricesLastUpdated.toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'})}</span>
        </div>` : ''}

      ${state.investments.length===0
        ?`<p class="empty-state">Sin inversiones.<br>Toca + para agregar. Puedes buscar cualquier acción de NYSE, NASDAQ y más.</p>`
        :`<div class="inv-grid">${state.investments.map(investmentCard).join('')}</div>`}
    </div>`;

  // Load sparklines async after DOM is ready (only for investments with live price)
  state.investments.forEach(inv => {
    if (inv.ticker && inv.marketPrice != null) {
      loadSparkline(inv.id, inv.ticker);
    }
  });
}

function purchaseHistorySection(inv) {
  const purchases = state.investmentPurchases.filter(p=>p.investmentId===inv.id)
    .sort((a,b)=>a.date.localeCompare(b.date));
  const totalShares = purchases.reduce((a,p)=>a+p.shares,0);
  const weightedAvg = totalShares>0 ? purchases.reduce((a,p)=>a+p.shares*p.priceUSD,0)/totalShares : 0;
  const livePrice   = inv.marketPrice || 0;
  const isCrypto    = inv.type === 'Criptomoneda';
  const unitLabel   = isCrypto ? 'uds.' : 'acc.';

  const rows = purchases.map(p=>{
    const costUSD   = p.shares * p.priceUSD;
    const lotValUSD = livePrice>0 ? p.shares*livePrice : costUSD;
    const lotPnlUSD = lotValUSD - costUSD;
    const lotPct    = costUSD>0 ? (lotPnlUSD/costUSD*100) : 0;
    return `
      <div class="ph-row">
        <span class="ph-date">${dateStr(p.date)}</span>
        <span class="ph-shares">${p.shares} ${unitLabel}</span>
        <span class="ph-price">${fmtInv(p.priceUSD)}</span>
        <span class="ph-usd">${fmtInv(p.amountUSD||costUSD)}</span>
        ${livePrice>0?`<span class="ph-pnl ${lotPnlUSD>=0?'profit':'loss'}">${lotPnlUSD>=0?'+':''}${fmtInv(lotPnlUSD)}<br><small>${lotPct>=0?'+':''}${lotPct.toFixed(1)}%</small></span>`:''}
        <button class="ph-del-btn" onclick="openEditPurchaseModal('${p.id}')" title="Editar lote">✏️</button>
        <button class="ph-del-btn" onclick="confirmDelete('purchase','${p.id}')" title="Eliminar lote">🗑️</button>
      </div>`;
  }).join('');

  const startExpanded = false;
  const curLabel = state.invCurrency === 'COP' ? 'Total COP' : 'Total USD';
  return `
    <div class="ph-container">
      <div class="ph-header" onclick="togglePurchaseHistory('${inv.id}')">
        <span>📋 Historial de compras${purchases.length>0?` (${purchases.length} lotes)`:''}</span>
        <span id="ph-arrow-${inv.id}">${startExpanded?'▼':'▶'}</span>
      </div>
      <div class="ph-list ${startExpanded?'':'hidden'}" id="ph-${inv.id}">
        ${purchases.length>0?`
          <div class="ph-summary">
            <span>Total: <strong>${totalShares} ${unitLabel}</strong></span>
            ${weightedAvg>0?`<span>Precio promedio entrada: <strong>${fmtInv(weightedAvg)}</strong></span>`:''}
            ${livePrice>0&&weightedAvg>0?`<span class="${livePrice>=weightedAvg?'profit':'loss'}">Precio actual ${fmtInv(livePrice)} · ${((livePrice-weightedAvg)/weightedAvg*100)>=0?'+':''}${((livePrice-weightedAvg)/weightedAvg*100).toFixed(2)}% vs entrada</span>`:''}
          </div>
          <div class="ph-cols-header">
            <span>Fecha</span><span>Unidades</span><span>Precio entrada</span><span>${curLabel}</span>${livePrice>0?'<span>P&L lote</span>':''}
          </div>
          ${rows}`:'<p class="ph-empty">Sin compras registradas.</p>'}
        <button class="btn-small" style="margin-top:10px" onclick="openAddPurchaseModal('${inv.id}')">+ Registrar compra</button>
      </div>
    </div>`;
}

function investmentCard(inv) {
  const hasLive = inv.ticker && inv.marketPrice != null;
  const changeUp = (inv.marketChangePct||0) >= 0;
  const hasShares = inv.shares > 0 && inv.purchasePrice > 0;

  // USD calculations
  const purchases   = state.investmentPurchases.filter(p=>p.investmentId===inv.id);
  const totalShPur  = purchases.reduce((a,p)=>a+p.shares,0);
  const avgCost     = totalShPur>0 ? purchases.reduce((a,p)=>a+p.shares*p.priceUSD,0)/totalShPur : (inv.purchasePrice||0);
  const investedUSD = purchases.length>0 ? purchases.reduce((a,p)=>a+p.amountUSD,0) : (hasShares ? inv.shares * inv.purchasePrice : Number(inv.invested));
  // If we have live price + shares → use market value. If shares=0 but invested > 0 → use invested as base until user fixes data
  const currentUSD  = hasShares && hasLive && inv.shares > 0 ? inv.shares * inv.marketPrice
                    : hasShares && inv.shares > 0 ? inv.shares * (avgCost||inv.purchasePrice)
                    : investedUSD > 0 ? investedUSD
                    : Number(inv.currentValue);
  const pnlUSD = currentUSD - investedUSD;
  const pct    = investedUSD > 0 ? (pnlUSD / investedUSD * 100) : 0;
  const isCrypto = inv.type === 'Criptomoneda';
  const unitLabel = isCrypto ? 'uds.' : 'acc.';

  // Weight in portfolio (use USD)
  let totalCurUSD = 0;
  state.investments.forEach(i => {
    totalCurUSD += i.shares>0&&i.marketPrice ? i.shares*i.marketPrice : i.shares>0&&i.purchasePrice>0 ? i.shares*i.purchasePrice : Number(i.currentValue);
  });
  const weight = totalCurUSD > 0 ? (currentUSD / totalCurUSD * 100) : 0;

  return `
    <div class="inv-card ${pnlUSD>=0?'pnl-positive':'pnl-negative'}">
      <div class="inv-header">
        <div>
          <div class="inv-name">
            ${inv.ticker?`<span class="inv-ticker">${inv.ticker}</span> `:''}${inv.name}
          </div>
          <div class="inv-type">${inv.type} · ${weight.toFixed(1)}% del portafolio${inv.shares?` · ${inv.shares} ${inv.type==='Criptomoneda'?'uds.':'acc.'}`:''}</div>
        </div>
        <div style="display:flex;gap:4px">
          ${inv.ticker ? `<button class="action-btn alert-btn ${state.alerts.some(a=>a.invId===inv.id&&a.active&&!a.triggered)?'has-alert':''}" onclick="openAlertModal('${inv.id}')" title="Alertas de precio" data-tip="Configurar alertas">🔔</button>` : ''}
          <button class="action-btn" onclick="editInvestment('${inv.id}')" data-tip="Editar">✏️</button>
          <button class="action-btn danger" onclick="confirmDelete('inv','${inv.id}')" data-tip="Eliminar">🗑️</button>
        </div>
      </div>

      ${hasLive ? `
        <div class="live-price-row">
          <span class="live-price ${changeUp?'price-up':'price-down'}">${fmtInv(inv.marketPrice)}</span>
          <span class="live-change ${changeUp?'up':'down'}">
            ${changeUp?'▲':'▼'} ${Math.abs(inv.marketChangePct||0).toFixed(2)}%
            (${changeUp?'+':''}${fmtInv(inv.marketChange||0)})
          </span>
          <span class="live-label">${inv.marketExchange||'Mercado'} · Precio en vivo</span>
        </div>
        <div id="sparkline-${inv.id}" class="sparkline-loading">
          <span>Cargando gráfico…</span>
        </div>
      ` : inv.ticker ? `<div class="live-price-row"><span style="color:var(--muted);font-size:13px">⏳ Cargando precio para ${inv.ticker}…</span></div>` : ''}

      ${avgCost>0?`<div class="inv-cost-basis">Precio prom. entrada: <strong>${fmtInv(avgCost)}</strong>${hasLive&&avgCost>0?` · <span class="${inv.marketPrice>=avgCost?'profit':'loss'}">${((inv.marketPrice-avgCost)/avgCost*100)>=0?'+':''}${((inv.marketPrice-avgCost)/avgCost*100).toFixed(2)}% vs precio actual</span>`:''}
      </div>`:''}
      <div class="pnl-row">
        <div class="pnl-item">
          <div class="pnl-label">Invertido</div>
          <div class="pnl-value">${fmtInv(investedUSD)}</div>
        </div>
        <div class="pnl-item">
          <div class="pnl-label">Valor actual</div>
          <div class="pnl-value">${fmtInv(currentUSD)}</div>
        </div>
        <div class="pnl-item">
          <div class="pnl-label">P&L total</div>
          <div class="pnl-value ${pnlUSD>=0?'profit':'loss'}">${pnlUSD>=0?'+':''}${fmtInv(pnlUSD)}<br><small>${pct>=0?'+':''}${pct.toFixed(2)}%</small></div>
        </div>
      </div>

      ${inv.notes?`<div class="savings-notes">${inv.notes}</div>`:''}

      ${inv.shares === 0 && investedUSD > 0 ? `
        <div class="inv-repair-banner">
          <div>
            <strong>⚠️ Precio de compra sin registrar</strong><br>
            <span>Invertiste ${fmtInv(investedUSD)}${hasLive ? ` · precio hoy: ${fmtInv(inv.marketPrice)}` : ''}. Ingresa el precio que pagaste para ver tu ganancia real.</span>
          </div>
          <button class="inv-repair-btn" onclick="openEditPurchaseModal('${(purchases[0]||{}).id||''}')">Corregir ✏️</button>
        </div>
      ` : ''}

      ${purchaseHistorySection(inv)}
    </div>`;
}

async function manualRefreshPrices() {
  const bar = document.querySelector('.market-info-bar span:nth-child(2)');
  if (bar) bar.textContent = 'Actualizando…';
  await refreshInvestmentPrices();
  if (state.view==='investments') renderView();
  const count = state.investments.filter(i => i.ticker && i.marketPrice != null).length;
  if (count > 0) showToast(`Precios actualizados (${count} activos)`, 'success', 2500);
}

/* ════════════════════════════════════════════════════════════
   VIEW: PROJECTION
   ════════════════════════════════════════════════════════════ */
function renderProjection() {
  const months = getMonthlyHistory(6);
  const avgInc = getAvgMonthlyIncome();
  const subCost = getMonthlySubscriptionCost();
  const avgExp = getAvgMonthlyExpense() + subCost;
  const avgNet = avgInc-avgExp;
  const balance = getBalance();
  const maxVal = Math.max(...months.map(m=>Math.max(m.income,m.expense)),1);
  const fwd = Array.from({length:6},(_,i)=>{
    const d = new Date(); d.setMonth(d.getMonth()+i+1);
    return { label:d.toLocaleDateString('es-CO',{month:'short'}), val: balance+avgNet*(i+1) };
  });
  document.getElementById('app-content').innerHTML = `
    <div class="content-inner">
      <div class="stats-grid">
        <div class="stat-card income"><div class="stat-label">Ingreso promedio</div><div class="stat-value">${formatCOP(avgInc)}</div></div>
        <div class="stat-card expense"><div class="stat-label">Gasto promedio</div><div class="stat-value">${formatCOP(avgExp)}</div></div>
        <div class="stat-card ${avgNet>=0?'income':'expense'}"><div class="stat-label">Ahorro promedio</div><div class="stat-value">${formatCOP(avgNet)}</div></div>
        <div class="stat-card"><div class="stat-label">Tasa ahorro</div><div class="stat-value">${avgInc>0?(avgNet/avgInc*100).toFixed(0):0}%</div></div>
      </div>
      <div class="section-header"><span class="section-title">Histórico 6 meses</span></div>
      <div class="card">
        <div class="bar-chart">
          ${months.map(m=>`
            <div class="bar-group">
              <div class="bar-pair">
                <div class="bar income-bar" style="height:${m.income?(m.income/maxVal*120).toFixed(0):2}px"></div>
                <div class="bar expense-bar" style="height:${m.expense?(m.expense/maxVal*120).toFixed(0):2}px"></div>
              </div>
              <div class="bar-label">${m.label}</div>
            </div>`).join('')}
        </div>
        <div class="chart-legend"><span class="legend-dot income"></span> Ingresos &nbsp;<span class="legend-dot expense"></span> Gastos</div>
      </div>
      <div class="section-header"><span class="section-title">Proyección 6 meses</span></div>
      <div class="card">
        ${fwd.map(m=>`
          <div class="proj-row">
            <span class="proj-month">${m.label}</span>
            <div class="progress-bar" style="flex:1;margin:0 12px">
              <div class="progress-fill ${m.val>=0?'':'negative'}" style="width:${Math.min(Math.abs(m.val)/Math.max(...fwd.map(x=>Math.abs(x.val)),1)*100,100).toFixed(0)}%"></div>
            </div>
            <span class="proj-value ${m.val>=0?'income':'expense'}">${formatCOP(m.val)}</span>
          </div>`).join('')}
        <div class="proj-note">Basado en promedios de los últimos 6 meses.</div>
      </div>
      ${avgExp>0?`
        <div class="section-header"><span class="section-title">Runway sin ingresos</span></div>
        <div class="card">
          <div class="runway-display">
            <span class="runway-number">${(balance/avgExp).toFixed(1)}</span>
            <span class="runway-unit">meses</span>
          </div>
          <p class="proj-note">Con ${formatCOP(balance)} y gastos promedio ${formatCOP(avgExp)}/mes.</p>
        </div>`:''}
    </div>`;
}

/* ════════════════════════════════════════════════════════════
   WEB NOTIFICATIONS — recordatorios de suscripciones
   ════════════════════════════════════════════════════════════ */

function checkSubscriptionNotifications() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const today = todayISO();
  const tomorrow = (() => { const d = new Date(today+'T00:00:00'); d.setDate(d.getDate()+1); return d.toISOString().slice(0,10); })();

  state.subscriptions.forEach(sub => {
    const days = subDaysUntil(sub.nextPaymentDate);
    if (days > 1) return; // solo hoy, mañana o vencidas

    const notifKey = `notif_${sub.id}_${sub.nextPaymentDate}`;
    if (localStorage.getItem(notifKey)) return; // ya notificada

    const amtStr = sub.currency==='USD' ? formatUSD(sub.amount) : formatCOP(sub.amount);
    let title, body;
    if (days < 0) {
      title = '⚠️ Suscripción vencida';
      body  = `${sub.name} — pago pendiente de ${amtStr}`;
    } else if (days === 0) {
      title = '🔴 Cobro hoy';
      body  = `${sub.name} se cobra hoy por ${amtStr}`;
    } else {
      title = '⏰ Cobro mañana';
      body  = `${sub.name} se cobra mañana por ${amtStr}`;
    }

    showNotif(title, body, notifKey).then(() => localStorage.setItem(notifKey, '1')).catch(()=>{});
  });
}

async function enableNotifications() {
  const granted = await requestNotificationPermission();
  if (granted) {
    checkSubscriptionNotifications();
    renderView();
  } else {
    alert('No se pudo activar las notificaciones. Revisa los permisos del navegador para este sitio.');
  }
}

// Pull-to-refresh eliminado — el auto-refresh cada 60s lo cubre

/* ════════════════════════════════════════════════════════════
   VOICE COMMAND SYSTEM
   Web Speech API → /api/parse-voice (Claude Haiku) → auto-fill modals
   ════════════════════════════════════════════════════════════ */
let _recognition = null;
let _voiceActive = false;

function toggleVoice() {
  if (_voiceActive) { stopVoice(); return; }
  if (!document.getElementById('modal-overlay').classList.contains('hidden')) {
    showToast('Cierra el formulario antes de usar la voz.', 'info', 2500);
    return;
  }
  startVoice();
}

function startVoice() {
  if (!navigator.onLine) {
    showToast('La voz requiere conexión a internet.', 'warning', 3500);
    return;
  }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast('Tu navegador no soporta entrada de voz. Usa Chrome o Edge.', 'warning', 4000);
    return;
  }

  _voiceActive = true;
  document.getElementById('voice-btn').classList.add('listening');
  document.getElementById('voice-overlay').classList.remove('hidden');
  setVoiceUI('listening', 'Escuchando…', '');

  _recognition = new SpeechRecognition();
  _recognition.lang = 'es-CO';
  _recognition.interimResults = true;
  _recognition.maxAlternatives = 1;

  _recognition.onresult = e => {
    const interim = Array.from(e.results).map(r => r[0].transcript).join('');
    document.getElementById('voice-transcript').textContent = `"${interim}"`;
  };

  _recognition.onspeechend = () => _recognition.stop();

  _recognition.onend = async () => {
    if (!_voiceActive) return; // onerror or stopVoice already handled this session
    const transcript = document.getElementById('voice-transcript').textContent.replace(/^"|"$/g, '').trim();
    if (!transcript) { stopVoice(); return; }
    setVoiceUI('processing', 'Procesando…', `"${transcript}"`);
    await parseVoiceCommand(transcript);
  };

  _recognition.onerror = e => {
    stopVoice();
    if (e.error !== 'no-speech') showToast(`Error de micrófono: ${e.error}`, 'error', 3000);
  };

  _recognition.start();
}

function stopVoice() {
  _voiceActive = false;
  if (_recognition) { try { _recognition.abort(); } catch(e) {} _recognition = null; }
  document.getElementById('voice-btn').classList.remove('listening');
  document.getElementById('voice-overlay').classList.add('hidden');
}

function setVoiceUI(mode, status, transcript) {
  const anim = document.getElementById('voice-anim');
  anim.className = `voice-anim${mode === 'processing' ? ' processing' : ''}`;
  document.getElementById('voice-status').textContent = status;
  document.getElementById('voice-transcript').textContent = transcript;
}

async function parseVoiceCommand(transcript) {
  try {
    const r = await fetch('/api/parse-voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: transcript })
    });
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'Error del servidor');
    stopVoice();
    handleVoiceResult(data.result, transcript);
  } catch(e) {
    stopVoice();
    showToast(`No se pudo interpretar: ${e.message}`, 'error', 4000);
  }
}

function handleVoiceResult(result, transcript) {
  switch(result.action) {
    case 'transaction':
      openVoiceTransactionModal(result);
      break;
    case 'investment':
      openVoiceInvestmentModal(result);
      break;
    case 'alert':
      openVoiceAlertModal(result);
      break;
    case 'query':
      handleVoiceQuery(result);
      break;
    case 'unknown':
    default:
      showToast(result.suggestion || 'No entendí el comando. Intenta de nuevo.', 'warning', 4500);
      break;
  }
}

function openVoiceTransactionModal(r) {
  const amtCOP = r.currency === 'USD'
    ? Math.round(r.amount * (state.usdCopRate || 4200))
    : r.amount;

  // Update global type/payment state so the modal renders correctly
  state.addType = r.type;
  state.addPaymentMethod = r.paymentMethod || 'Efectivo';

  showToast(`✅ Reconocido: ${r.type === 'Gasto' ? '📤' : '📥'} ${r.currency === 'COP' ? formatCOP(r.amount) : formatUSD(r.amount)} — ${r.description}`, 'success', 3000);

  // Open transaction modal pre-filled (no id = new transaction)
  openTransactionModal({
    type: r.type,
    category: r.category,
    description: r.description,
    amount: amtCOP,
    paymentMethod: r.paymentMethod || 'Efectivo',
    date: todayISO()
  });
}

function openVoiceInvestmentModal(r) {
  showToast(`📈 Reconocido: compra de ${r.ticker} — $${r.amountUSD} USD`, 'info', 4000);
  openInvestmentModal({ ticker: r.ticker, amountUSD: r.amountUSD });
}

function openVoiceAlertModal(r) {
  showToast(`🔔 Alerta para ${r.ticker}: ${r.condition === 'above' ? '▲ sobre' : '▼ bajo'} $${r.targetPrice}`, 'info', 4000);
  // Find investment by ticker and open alert modal
  const inv = state.investments.find(i => i.ticker && i.ticker.toUpperCase() === r.ticker.toUpperCase());
  if (inv) {
    openAlertModal(inv.id, { condition: r.condition, targetPrice: r.targetPrice });
  } else {
    showToast(`No tienes ${r.ticker} en tu portafolio. Agrégala primero.`, 'warning', 4000);
  }
}

function handleVoiceQuery(r) {
  if (r.subject === 'portfolio') {
    navigate('investments');
    showToast('Aquí está tu portafolio', 'info', 2500);
  } else if (r.ticker) {
    navigate('investments');
    showToast(`Buscando ${r.ticker} en tu portafolio…`, 'info', 2500);
  }
}

/* ── Boot ────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  // Render cached data immediately while GAPI loads
  loadLocal().then(() => {
    renderView();
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      checkSubscriptionNotifications();
    }
  });
  // Re-render on connectivity change so offline banner appears/disappears reactively
  window.addEventListener('online',  () => renderView());
  window.addEventListener('offline', () => renderView());
});
