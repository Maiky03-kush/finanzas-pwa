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
  view: 'dashboard', syncing: false,
  gapiReady: false, gisReady: false, tokenClient: null,
  addType: 'Gasto', addPaymentMethod: 'Efectivo',
  txFilter: 'Gasto',
  usdCopRate: 4200,
  priceRefreshTimer: null,
  pricesLastUpdated: null,
  categories: {
    Gasto:   ['Vehículo','SimRacing','Alimentación','Transporte','Servicios','Entretenimiento','Salud','Educación','Hogar','Otros'],
    Ingreso: ['Salario','Freelance','Inversiones','Arriendos','Bonos','Otros']
  }
};

/* ── Service Worker ──────────────────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}

/* ── localStorage ────────────────────────────────────────── */
function saveLocal() {
  localStorage.setItem('finanzas_transactions', JSON.stringify(state.transactions));
  localStorage.setItem('finanzas_savings',      JSON.stringify(state.savings));
  // Strip runtime market data before saving
  const invToSave = state.investments.map(({ marketPrice, marketChange, marketChangePct, marketCurrency, ...rest }) => rest);
  localStorage.setItem('finanzas_investments',  JSON.stringify(invToSave));
  if (state.spreadsheetId) localStorage.setItem('finanzas_sheetId', state.spreadsheetId);
  localStorage.setItem('finanzas_inv_purchases', JSON.stringify(state.investmentPurchases));
}

function loadLocal() {
  try {
    state.transactions       = JSON.parse(localStorage.getItem('finanzas_transactions')   || '[]');
    state.savings            = JSON.parse(localStorage.getItem('finanzas_savings')        || '[]');
    state.investments        = JSON.parse(localStorage.getItem('finanzas_investments')    || '[]');
    state.investmentPurchases= JSON.parse(localStorage.getItem('finanzas_inv_purchases') || '[]');
    state.spreadsheetId      = localStorage.getItem('finanzas_sheetId') || null;
  } catch(e) { state.transactions = []; state.savings = []; state.investments = []; }
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
  const invested = state.investments.reduce((a,i)=>a+Number(i.invested),0);
  const current  = state.investments.reduce((a,i)=>a+Number(i.currentValue),0);
  const pnl = current-invested;
  return { invested, current, pnl, pct: invested?(pnl/invested*100):0 };
}

/* ══════════════════════════════════════════════════════════
   MARKET DATA — Yahoo Finance via local proxy
   ══════════════════════════════════════════════════════════ */
async function fetchQuote(ticker) {
  try {
    const r = await fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}`);
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

async function fetchSearch(query) {
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await r.json();
    return (data?.quotes || [])
      .filter(q => ['EQUITY','ETF','MUTUALFUND'].includes(q.quoteType))
      .slice(0, 7);
  } catch(e) { return []; }
}

async function fetchExchangeRate() {
  const q = await fetchQuote('USDCOP=X');
  if (q && q.price > 100) state.usdCopRate = q.price;
}

async function refreshInvestmentPrices() {
  await fetchExchangeRate();
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
    // Auto-update currentValue when shares are tracked
    if (Number(inv.shares) > 0) {
      const valueUSD = Number(inv.shares) * q.price;
      const valueCOP = q.currency === 'USD' ? Math.round(valueUSD * state.usdCopRate) : Math.round(valueUSD);
      inv.currentValue = valueCOP;
      updated = true;
    }
  }
  state.pricesLastUpdated = new Date();
  if (updated) saveLocal();
}

/* ── Navigation ──────────────────────────────────────────── */
function navigate(view) {
  // Stop investment price refresh when leaving
  if (state.view === 'investments' && view !== 'investments') {
    clearInterval(state.priceRefreshTimer);
    state.priceRefreshTimer = null;
  }
  state.view = view;
  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.view === view));

  if (view === 'investments') {
    // Refresh prices immediately then every 60s
    refreshInvestmentPrices().then(() => { if (state.view==='investments') renderView(); });
    if (!state.priceRefreshTimer) {
      state.priceRefreshTimer = setInterval(() => {
        refreshInvestmentPrices().then(() => { if (state.view==='investments') renderView(); });
      }, 60000);
    }
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
  gapi.load('client', async () => {
    await gapi.client.init({ apiKey: CONFIG.API_KEY, discoveryDocs: CONFIG.DISCOVERY_DOCS });
    state.gapiReady = true; checkReady();
  });
}
function gisLoaded() {
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID, scope: CONFIG.SCOPES, callback: handleTokenResponse
  });
  state.gisReady = true; checkReady();
}
function checkReady() { if (state.gapiReady && state.gisReady) { loadLocal(); renderView(); } }

async function handleTokenResponse(resp) {
  if (resp.error) { console.error(resp); return; }
  state.accessToken = resp.access_token;
  updateAuthUI(true);
  updateSyncBadge('Sincronizando…','syncing');
  await ensureSpreadsheet();
  await syncFromSheets();
  updateSyncBadge('Sincronizado ✓','synced');
  renderView();
}
function toggleAuth() {
  if (state.accessToken) {
    google.accounts.oauth2.revoke(state.accessToken, ()=>{});
    state.accessToken = null; state.user = null;
    updateAuthUI(false); updateSyncBadge('Local'); renderView();
  } else {
    if (!state.tokenClient) { alert('Google aún no cargó, espera un segundo.'); return; }
    state.tokenClient.requestAccessToken({ prompt:'' });
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
    try { await gapi.client.sheets.spreadsheets.get({spreadsheetId:state.spreadsheetId}); return; }
    catch(e) { state.spreadsheetId = null; }
  }
  const driveResp = await gapi.client.request({
    path:'https://www.googleapis.com/drive/v3/files',
    params:{ q:`name='${CONFIG.SHEET_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`, fields:'files(id,name)' }
  });
  const files = driveResp.result.files || [];
  if (files.length > 0) { state.spreadsheetId = files[0].id; localStorage.setItem('finanzas_sheetId', state.spreadsheetId); return; }
  const createResp = await gapi.client.sheets.spreadsheets.create({
    resource:{ properties:{title:CONFIG.SHEET_NAME}, sheets:[
      {properties:{title:'Transacciones'}},{properties:{title:'Ahorro'}},
      {properties:{title:'Inversiones'}},{properties:{title:'Compras_Inv'}}
    ]}
  });
  state.spreadsheetId = createResp.result.spreadsheetId;
  localStorage.setItem('finanzas_sheetId', state.spreadsheetId);
  await gapi.client.sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: state.spreadsheetId,
    resource:{ valueInputOption:'RAW', data:[
      { range:'Transacciones!A1:G1', values:[['ID','Fecha','Tipo','Categoría','Descripción','Monto','Pago']] },
      { range:'Ahorro!A1:F1',        values:[['ID','Nombre','Meta','Actual','Fecha Límite','Notas']] },
      { range:'Inversiones!A1:I1',   values:[['ID','Nombre','Ticker','Tipo','Invertido','Valor Actual','Acciones','Precio Compra','Notas']] },
      { range:'Compras_Inv!A1:F1',   values:[['ID','InvID','Fecha','Acciones','PrecioUSD','MontoCOP']] }
    ]}
  });
}

async function ensureComprasInvSheet() {
  if (!state.spreadsheetId) return;
  try {
    const meta = await gapi.client.sheets.spreadsheets.get({spreadsheetId:state.spreadsheetId});
    const exists = meta.result.sheets.some(s=>s.properties.title==='Compras_Inv');
    if (!exists) {
      await gapi.client.sheets.spreadsheets.batchUpdate({
        spreadsheetId:state.spreadsheetId,
        resource:{requests:[{addSheet:{properties:{title:'Compras_Inv'}}}]}
      });
      await gapi.client.sheets.spreadsheets.values.update({
        spreadsheetId:state.spreadsheetId, range:'Compras_Inv!A1:F1',
        valueInputOption:'RAW', resource:{values:[['ID','InvID','Fecha','Acciones','PrecioUSD','MontoCOP']]}
      });
    }
  } catch(e) {}
}

async function syncFromSheets() {
  if (!state.spreadsheetId || !state.accessToken) return;
  try {
    const resp = await gapi.client.sheets.spreadsheets.values.batchGet({
      spreadsheetId: state.spreadsheetId,
      ranges:['Transacciones!A2:G','Ahorro!A2:F','Inversiones!A2:I']
    });
    const vrs = resp.result.valueRanges;
    state.transactions = (vrs[0].values||[]).map(r=>({ id:r[0]||uid(), date:r[1]||'', type:r[2]||'Gasto', category:r[3]||'Otros', description:r[4]||'', amount:Number(r[5])||0, paymentMethod:r[6]||'' })).filter(t=>t.date);
    state.savings      = (vrs[1].values||[]).map(r=>({ id:r[0]||uid(), name:r[1]||'', goal:Number(r[2])||0, current:Number(r[3])||0, deadline:r[4]||'', notes:r[5]||'' })).filter(s=>s.name);
    state.investments  = (vrs[2].values||[]).map(r=>({ id:r[0]||uid(), name:r[1]||'', ticker:r[2]||'', type:r[3]||'', invested:Number(r[4])||0, currentValue:Number(r[5])||0, shares:Number(r[6])||0, purchasePrice:Number(r[7])||0, notes:r[8]||'' })).filter(i=>i.name);
    try {
      const purResp = await gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId:state.spreadsheetId, range:'Compras_Inv!A2:F'
      });
      state.investmentPurchases = (purResp.result.values||[]).map(r=>({ id:r[0]||uid(), investmentId:r[1]||'', date:r[2]||'', shares:Number(r[3])||0, priceUSD:Number(r[4])||0, amountCOP:Number(r[5])||0 })).filter(p=>p.investmentId);
    } catch(e) { await ensureComprasInvSheet(); }
    saveLocal();
  } catch(e) { console.error('syncFromSheets', e); }
}

/* ── Sheets write helpers ────────────────────────────────── */
async function appendRow(sheet, values) {
  if (!state.spreadsheetId || !state.accessToken) return;
  await gapi.client.sheets.spreadsheets.values.append({ spreadsheetId:state.spreadsheetId, range:`${sheet}!A1`, valueInputOption:'RAW', insertDataOption:'INSERT_ROWS', resource:{values:[values]} });
}
async function deleteRowById(sheet, id) {
  if (!state.spreadsheetId || !state.accessToken) return;
  const resp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId:state.spreadsheetId, range:`${sheet}!A:A` });
  const rows = resp.result.values || [];
  const rowIndex = rows.findIndex(r=>r[0]===id);
  if (rowIndex < 1) return;
  const meta = await gapi.client.sheets.spreadsheets.get({spreadsheetId:state.spreadsheetId});
  const sh = meta.result.sheets.find(s=>s.properties.title===sheet);
  if (!sh) return;
  await gapi.client.sheets.spreadsheets.batchUpdate({ spreadsheetId:state.spreadsheetId, resource:{requests:[{deleteDimension:{range:{sheetId:sh.properties.sheetId,dimension:'ROWS',startIndex:rowIndex,endIndex:rowIndex+1}}}]} });
}
async function updateRowById(sheet, id, values) {
  if (!state.spreadsheetId || !state.accessToken) return;
  const resp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId:state.spreadsheetId, range:`${sheet}!A:A` });
  const rows = resp.result.values || [];
  const rowIndex = rows.findIndex(r=>r[0]===id);
  if (rowIndex < 1) return;
  await gapi.client.sheets.spreadsheets.values.update({ spreadsheetId:state.spreadsheetId, range:`${sheet}!A${rowIndex+1}`, valueInputOption:'RAW', resource:{values:[values]} });
}

/* ── CRUD: Transactions ──────────────────────────────────── */
async function addTransaction(tx) {
  tx.id = uid(); state.transactions.unshift(tx); saveLocal(); renderView();
  try { await appendRow('Transacciones',[tx.id,tx.date,tx.type,tx.category,tx.description,tx.amount,tx.paymentMethod||'']); updateSyncBadge('Sincronizado ✓','synced'); } catch(e) { updateSyncBadge('Error sync','error'); }
}
async function deleteTransaction(id) {
  state.transactions = state.transactions.filter(t=>t.id!==id); saveLocal(); renderView();
  try { await deleteRowById('Transacciones',id); } catch(e) {}
}

/* ── CRUD: Savings ───────────────────────────────────────── */
async function addSavingsGoal(goal) {
  goal.id = uid(); goal.current = 0; state.savings.push(goal); saveLocal(); renderView();
  try { await appendRow('Ahorro',[goal.id,goal.name,goal.goal,0,goal.deadline,goal.notes||'']); } catch(e) {}
}
async function updateSavingsProgress(id, addAmount) {
  const g = state.savings.find(s=>s.id===id); if (!g) return;
  g.current = Math.min(g.current+Number(addAmount), g.goal); saveLocal(); renderView();
  try { await updateRowById('Ahorro',id,[id,g.name,g.goal,g.current,g.deadline,g.notes||'']); } catch(e) {}
}
async function deleteSavingsGoal(id) {
  state.savings = state.savings.filter(s=>s.id!==id); saveLocal(); renderView();
  try { await deleteRowById('Ahorro',id); } catch(e) {}
}

/* ── CRUD: Investments ───────────────────────────────────── */
async function addInvestment(inv) {
  inv.id = uid();
  if (!inv.currentValue) inv.currentValue = inv.invested;
  state.investments.push(inv); saveLocal(); renderView();
  try { await appendRow('Inversiones',[inv.id,inv.name,inv.ticker||'',inv.type||'',inv.invested,inv.currentValue,inv.shares||0,inv.purchasePrice||0,inv.notes||'']); } catch(e) {}
}
async function updateInvestmentValue(id, newValue) {
  const inv = state.investments.find(i=>i.id===id); if (!inv) return;
  inv.currentValue = Number(newValue); saveLocal(); renderView();
  try { await updateRowById('Inversiones',id,[id,inv.name,inv.ticker||'',inv.type||'',inv.invested,inv.currentValue,inv.shares||0,inv.purchasePrice||0,inv.notes||'']); } catch(e) {}
}
async function deleteInvestment(id) {
  const relPurchases = state.investmentPurchases.filter(p=>p.investmentId===id);
  state.investments = state.investments.filter(i=>i.id!==id);
  state.investmentPurchases = state.investmentPurchases.filter(p=>p.investmentId!==id);
  saveLocal(); renderView();
  try { await deleteRowById('Inversiones',id); } catch(e) {}
  for (const p of relPurchases) { try { await deleteRowById('Compras_Inv',p.id); } catch(e) {} }
}

async function addInvestmentPurchase(purchase) {
  purchase.id = uid();
  state.investmentPurchases.push(purchase);
  const inv = state.investments.find(i=>i.id===purchase.investmentId);
  if (inv) {
    const allP = state.investmentPurchases.filter(p=>p.investmentId===inv.id);
    inv.shares        = allP.reduce((a,p)=>a+p.shares, 0);
    inv.invested      = allP.reduce((a,p)=>a+p.amountCOP, 0);
    const totalShares = inv.shares;
    inv.purchasePrice = totalShares>0 ? allP.reduce((a,p)=>a+p.shares*p.priceUSD,0)/totalShares : 0;
    if (!inv.ticker) inv.currentValue = inv.invested;
  }
  saveLocal(); renderView();
  try {
    await appendRow('Compras_Inv',[purchase.id,purchase.investmentId,purchase.date,purchase.shares,purchase.priceUSD,purchase.amountCOP]);
    if (inv) await updateRowById('Inversiones',inv.id,[inv.id,inv.name,inv.ticker||'',inv.type||'',inv.invested,inv.currentValue,inv.shares||0,inv.purchasePrice||0,inv.notes||'']);
  } catch(e) {}
}

/* ── Modal ───────────────────────────────────────────────── */
function openModal(html) { document.getElementById('modal-content').innerHTML=html; document.getElementById('modal-overlay').classList.remove('hidden'); }
function closeModal()    { document.getElementById('modal-overlay').classList.add('hidden'); }
function handleOverlayClick(e) { if (e.target===document.getElementById('modal-overlay')) closeModal(); }
function openAddModal() {
  ({ dashboard:openTransactionModal, transactions:openTransactionModal, savings:openSavingsModal, investments:openInvestmentModal, projection:openTransactionModal }[state.view]||openTransactionModal)();
}

/* ── Transaction Modal ───────────────────────────────────── */
function openTransactionModal(tx) {
  const editing = !!tx;
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
        <select class="form-input" id="tx-cat">
          ${cats.map(c=>`<option value="${c}" ${tx?.category===c?'selected':''}>${catIcon(c)} ${c}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Descripción</label>
        <input class="form-input" type="text" id="tx-desc" placeholder="Ej: Gasolina" value="${tx?.description||''}" required>
      </div>
      <div class="form-group">
        <label class="form-label">Monto (COP)</label>
        <input class="form-input" type="number" id="tx-amount" placeholder="0" min="0" value="${tx?.amount||''}" required>
      </div>
      ${type==='Gasto'?`
      <div class="form-group">
        <label class="form-label">Método de pago</label>
        <div class="pay-toggle">
          <button type="button" class="pay-btn ${(tx?.paymentMethod||state.addPaymentMethod)==='Efectivo'?'active':''}" onclick="switchPayMethod('Efectivo')">💵 Efectivo</button>
          <button type="button" class="pay-btn ${(tx?.paymentMethod||state.addPaymentMethod)==='Tarjeta'?'active':''}" onclick="switchPayMethod('Tarjeta')">💳 Tarjeta</button>
        </div>
      </div>`:''}
      <button type="submit" class="btn-primary">${editing?'Guardar cambios':'Agregar'}</button>
    </form>`);
}
function switchModalType(type) { state.addType=type; state.addPaymentMethod='Efectivo'; openTransactionModal(); }
function switchPayMethod(method) { state.addPaymentMethod=method; document.querySelectorAll('.pay-btn').forEach(b=>b.classList.toggle('active',b.textContent.includes(method))); }
async function submitTransaction(e, editId) {
  e.preventDefault();
  const paymentMethod = state.addType==='Gasto' ? state.addPaymentMethod : '';
  const tx = { date:document.getElementById('tx-date').value, type:state.addType, category:document.getElementById('tx-cat').value, description:document.getElementById('tx-desc').value.trim(), amount:Number(document.getElementById('tx-amount').value), paymentMethod };
  closeModal();
  if (editId) {
    const idx = state.transactions.findIndex(t=>t.id===editId);
    if (idx>=0) state.transactions[idx] = {...state.transactions[idx],...tx};
    saveLocal(); renderView();
    try { await updateRowById('Transacciones',editId,[editId,tx.date,tx.type,tx.category,tx.description,tx.amount,tx.paymentMethod||'']); } catch(e) {}
  } else { await addTransaction(tx); }
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

/* ── Investment Modal (with ticker search) ───────────────── */
function openInvestmentModal() {
  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">Nueva Inversión</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>

    <div class="form-group">
      <label class="form-label">Buscar acción / ETF</label>
      <div class="search-box">
        <input class="form-input" type="text" id="inv-search" placeholder="Ej: Apple, AAPL, S&P 500..." autocomplete="off" oninput="searchTicker(this.value)">
        <div id="search-results" class="search-dropdown hidden"></div>
      </div>
    </div>

    <form onsubmit="submitInvestment(event)">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Ticker</label>
          <input class="form-input" type="text" id="inv-ticker" placeholder="Ej: AAPL" style="text-transform:uppercase">
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
      </div>

      <div class="shares-section">
        <label class="form-label" style="margin-bottom:10px;display:block;">Seguimiento por acciones (opcional — para precios en vivo)</label>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">N° de acciones</label>
            <input class="form-input" type="number" id="inv-shares" placeholder="0" min="0" step="any" oninput="calcInvestedFromShares()">
          </div>
          <div class="form-group">
            <label class="form-label">Precio compra (USD)</label>
            <input class="form-input" type="number" id="inv-purchase-price" placeholder="0.00" min="0" step="any" oninput="calcInvestedFromShares()">
          </div>
        </div>
        <div class="calc-hint" id="inv-calc-hint"></div>
      </div>

      <div class="form-group">
        <label class="form-label">Total invertido (COP) <span id="inv-cop-label" style="color:var(--muted)"></span></label>
        <input class="form-input" type="number" id="inv-invested" placeholder="0" min="0" required>
      </div>
      <div class="form-group">
        <label class="form-label">Valor actual (COP) — dejar en blanco si igual al invertido</label>
        <input class="form-input" type="number" id="inv-current" placeholder="Igual al invertido">
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
  const typeMap = { EQUITY:'Acciones', ETF:'ETF', MUTUALFUND:'Fondo de inversión' };
  const sel = document.getElementById('inv-type');
  if (sel && typeMap[type]) {
    Array.from(sel.options).forEach(o => { if (o.value===typeMap[type]) o.selected=true; });
  }
  document.getElementById('search-results').classList.add('hidden');
}
function calcInvestedFromShares() {
  const shares = Number(document.getElementById('inv-shares')?.value)||0;
  const price  = Number(document.getElementById('inv-purchase-price')?.value)||0;
  const hint   = document.getElementById('inv-calc-hint');
  const copLabel = document.getElementById('inv-cop-label');
  if (shares>0 && price>0) {
    const cop = Math.round(shares * price * state.usdCopRate);
    document.getElementById('inv-invested').value = cop;
    if (hint) hint.textContent = `${shares} × ${formatUSD(price)} × ${Math.round(state.usdCopRate).toLocaleString('es-CO')} COP/USD = ${formatCOP(cop)}`;
    if (copLabel) copLabel.textContent = '(calculado automáticamente)';
  } else { if (hint) hint.textContent=''; if (copLabel) copLabel.textContent=''; }
}
async function submitInvestment(e) {
  e.preventDefault();
  const invested = Number(document.getElementById('inv-invested').value);
  const current  = Number(document.getElementById('inv-current').value)||invested;
  const inv = {
    name:          document.getElementById('inv-name').value.trim(),
    ticker:        document.getElementById('inv-ticker').value.trim().toUpperCase(),
    type:          document.getElementById('inv-type').value,
    invested, currentValue: current,
    shares:        Number(document.getElementById('inv-shares').value)||0,
    purchasePrice: Number(document.getElementById('inv-purchase-price').value)||0,
    notes:         document.getElementById('inv-notes').value.trim()
  };
  closeModal();
  await addInvestment(inv);
  if (shares > 0 && purchasePrice > 0) {
    await addInvestmentPurchase({ investmentId:inv.id, date:todayISO(), shares, priceUSD:purchasePrice, amountCOP:invested });
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
          <label class="form-label">N° acciones</label>
          <input class="form-input" type="number" id="pur-shares" placeholder="0" min="0" step="any" oninput="calcPurchaseAmount()" required>
        </div>
        <div class="form-group">
          <label class="form-label">Precio USD</label>
          <input class="form-input" type="number" id="pur-price" placeholder="0.00" min="0" step="any" value="${inv.marketPrice||inv.purchasePrice||''}" oninput="calcPurchaseAmount()">
        </div>
      </div>
      <div class="calc-hint" id="pur-calc-hint"></div>
      <div class="form-group">
        <label class="form-label">Monto COP</label>
        <input class="form-input" type="number" id="pur-amount" placeholder="0" min="0" required>
      </div>
      <button type="submit" class="btn-primary">Registrar compra</button>
    </form>`);
}
function calcPurchaseAmount() {
  const shares = Number(document.getElementById('pur-shares')?.value)||0;
  const price  = Number(document.getElementById('pur-price')?.value)||0;
  const hint   = document.getElementById('pur-calc-hint');
  if (shares>0 && price>0) {
    const cop = Math.round(shares*price*state.usdCopRate);
    document.getElementById('pur-amount').value = cop;
    if (hint) hint.textContent = `${shares} × ${formatUSD(price)} × ${Math.round(state.usdCopRate).toLocaleString('es-CO')} = ${formatCOP(cop)}`;
  } else { if (hint) hint.textContent=''; }
}
async function submitAddPurchase(e, invId) {
  e.preventDefault();
  const purchase = { investmentId:invId, date:document.getElementById('pur-date').value, shares:Number(document.getElementById('pur-shares').value)||0, priceUSD:Number(document.getElementById('pur-price').value)||0, amountCOP:Number(document.getElementById('pur-amount').value)||0 };
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
      <div class="form-group"><label class="form-label">Nuevo valor actual (COP)</label>
        <input class="form-input" type="number" id="inv-newval" value="${inv.currentValue}" min="0" required></div>
      <button type="submit" class="btn-primary">Actualizar</button>
    </form>`);
}
async function submitUpdateValue(e, id) {
  e.preventDefault();
  const val = Number(document.getElementById('inv-newval').value);
  closeModal(); await updateInvestmentValue(id, val);
}

/* ── Confirm delete ──────────────────────────────────────── */
function confirmDelete(entity, id) {
  openModal(`
    <div class="modal-header">
      <h2 class="modal-title">¿Eliminar?</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <p style="color:var(--text-secondary);margin-bottom:24px">Esta acción no se puede deshacer.</p>
    <div style="display:flex;gap:12px">
      <button class="btn-secondary" style="flex:1" onclick="closeModal()">Cancelar</button>
      <button class="btn-danger"    style="flex:1" onclick="doDelete('${entity}','${id}')">Eliminar</button>
    </div>`);
}
async function doDelete(entity, id) {
  closeModal();
  if (entity==='tx')      await deleteTransaction(id);
  if (entity==='savings') await deleteSavingsGoal(id);
  if (entity==='inv')     await deleteInvestment(id);
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
      ${state.investments.length ? `
        <div class="section-header">
          <span class="section-title">Portafolio</span>
          <button class="section-link" onclick="navigate('investments')">Ver todo</button>
        </div>
        <div class="card" style="padding:0;overflow:hidden">
          <table class="summary-table">
            <thead><tr><th>Activo</th><th>Invertido</th><th>Valor actual</th><th>P&L</th></tr></thead>
            <tbody>
              ${state.investments.map(i=>{
                const pnl = i.currentValue-i.invested;
                const pct = i.invested>0?(pnl/i.invested*100):0;
                return `<tr>
                  <td><strong>${i.ticker||'—'}</strong> <span style="font-size:12px;color:var(--muted)">${i.name}</span></td>
                  <td>${formatCOP(i.invested)}</td>
                  <td>${formatCOP(i.currentValue)}</td>
                  <td class="${pnl>=0?'col-income':'col-expense'}">${pnl>=0?'+':''}${formatCOP(pnl)}<br><small>${pct>=0?'+':''}${pct.toFixed(1)}%</small></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>` : ''}

      ${!hasTx ? `<p class="empty-state">Sin datos todavía.<br>Toca + para agregar tu primera transacción.</p>` : ''}
    </div>`;
}

/* ════════════════════════════════════════════════════════════
   VIEW: TRANSACTIONS (toggle Gastos / Ingresos)
   ════════════════════════════════════════════════════════════ */
function setTxFilter(type) { state.txFilter = type; renderTransactions(); }

function renderTransactions() {
  const filter   = state.txFilter;
  const allGasto  = state.transactions.filter(t=>t.type==='Gasto');
  const allIngreso= state.transactions.filter(t=>t.type==='Ingreso');
  const totalGasto  = allGasto.reduce((a,t)=>a+Number(t.amount),0);
  const totalIngreso= allIngreso.reduce((a,t)=>a+Number(t.amount),0);
  const filtered = filter==='Gasto' ? allGasto : allIngreso;

  // Group by month
  const groups = {};
  [...filtered].sort((a,b)=>b.date.localeCompare(a.date)).forEach(t => {
    const d   = new Date(t.date+'T00:00:00');
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const lbl = d.toLocaleDateString('es-CO',{month:'long',year:'numeric'});
    if (!groups[key]) groups[key] = { label:lbl, txs:[], total:0 };
    groups[key].txs.push(t);
    groups[key].total += Number(t.amount);
  });

  document.getElementById('app-content').innerHTML = `
    <div class="content-inner">
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
        <span>${filter==='Gasto'?'Total gastos':'Total ingresos'} registrados</span>
        <strong class="${filter==='Gasto'?'expense':'income'}">${formatCOP(filter==='Gasto'?totalGasto:totalIngreso)}</strong>
      </div>

      <!-- Grouped list -->
      ${Object.keys(groups).length === 0
        ? `<p class="empty-state">Sin ${filter==='Gasto'?'gastos':'ingresos'} registrados.<br>Toca + para agregar.</p>`
        : Object.entries(groups).map(([key, grp]) => `
            <div class="month-group">
              <div class="month-header">
                <span>${grp.label.charAt(0).toUpperCase()+grp.label.slice(1)}</span>
                <span class="month-total ${filter==='Gasto'?'expense':'income'}">${formatCOP(grp.total)}</span>
              </div>
              <div class="tx-list">${grp.txs.map(t=>txCard(t,true)).join('')}</div>
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
          <button class="action-btn" onclick='openTransactionModal(${JSON.stringify(t)})'>✏️</button>
          <button class="action-btn danger" onclick="confirmDelete('tx','${t.id}')">🗑️</button>
        </div>`:''}
      </div>
    </div>`;
}

/* ════════════════════════════════════════════════════════════
   VIEW: SAVINGS
   ════════════════════════════════════════════════════════════ */
function renderSavings() {
  const totalGoal    = state.savings.reduce((a,s)=>a+s.goal,0);
  const totalCurrent = state.savings.reduce((a,s)=>a+s.current,0);
  document.getElementById('app-content').innerHTML = `
    <div class="content-inner">
      <div class="balance-card">
        <div class="balance-label">Total ahorrado</div>
        <div class="balance-amount">${formatCOP(totalCurrent)}</div>
        <div class="balance-sub">de ${formatCOP(totalGoal)} en metas</div>
      </div>
      <div class="section-header">
        <span class="section-title">Mis metas</span>
        <button class="section-link" onclick="openSavingsModal()">+ Nueva</button>
      </div>
      ${state.savings.length===0?`<p class="empty-state">Sin metas de ahorro.<br>Toca + para crear una.</p>`:state.savings.map(savingsCard).join('')}
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
        <button class="action-btn danger" onclick="confirmDelete('savings','${s.id}')">🗑️</button>
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
  const { invested, current, pnl, pct } = getPortfolioSummary();
  const lastUpd = state.pricesLastUpdated
    ? state.pricesLastUpdated.toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit',second:'2-digit'})
    : null;
  const hasLive = state.investments.some(i=>i.ticker && i.marketPrice);

  document.getElementById('app-content').innerHTML = `
    <div class="content-inner">
      <div class="balance-card ${pnl<0?'negative':''}">
        <div class="balance-label">Portafolio total</div>
        <div class="balance-amount">${formatCOP(current)}</div>
        <div class="balance-sub">Invertido: ${formatCOP(invested)} · P&L: ${pnl>=0?'+':''}${formatCOP(pnl)} (${pct>=0?'+':''}${pct.toFixed(2)}%)</div>
      </div>

      <!-- Market info bar -->
      <div class="market-info-bar">
        <span>USD/COP: <strong>${Math.round(state.usdCopRate).toLocaleString('es-CO')}</strong></span>
        ${lastUpd?`<span>Precios: <strong>${lastUpd}</strong></span>`:'<span style="color:var(--muted)">Cargando precios…</span>'}
        <button class="refresh-btn" onclick="manualRefreshPrices()">↻ Actualizar</button>
      </div>

      <div class="section-header">
        <span class="section-title">Mis inversiones</span>
        <button class="section-link" onclick="openInvestmentModal()">+ Nueva</button>
      </div>

      ${state.investments.length===0
        ?`<p class="empty-state">Sin inversiones.<br>Toca + para agregar. Puedes buscar cualquier acción de NYSE, NASDAQ y más.</p>`
        :state.investments.map(investmentCard).join('')}
    </div>`;
}

function purchaseHistorySection(inv) {
  const purchases = state.investmentPurchases.filter(p=>p.investmentId===inv.id)
    .sort((a,b)=>a.date.localeCompare(b.date));
  const totalShares = purchases.reduce((a,p)=>a+p.shares,0);
  const weightedAvg = totalShares>0 ? purchases.reduce((a,p)=>a+p.shares*p.priceUSD,0)/totalShares : 0;
  const livePrice   = inv.marketPrice || 0;

  const rows = purchases.map(p=>{
    const lotVal = livePrice>0 ? p.shares*livePrice*state.usdCopRate : 0;
    const lotPnl = lotVal - p.amountCOP;
    const lotPct = p.amountCOP>0 ? (lotPnl/p.amountCOP*100) : 0;
    return `
      <div class="ph-row">
        <span class="ph-date">${dateStr(p.date)}</span>
        <span class="ph-shares">${p.shares} acc.</span>
        <span class="ph-price">${formatUSD(p.priceUSD)}</span>
        <span class="ph-cop">${formatCOP(p.amountCOP)}</span>
        ${livePrice>0?`<span class="ph-pnl ${lotPnl>=0?'profit':'loss'}">${lotPnl>=0?'+':''}${formatCOP(lotPnl)}<br><small>${lotPct>=0?'+':''}${lotPct.toFixed(1)}%</small></span>`:''}
      </div>`;
  }).join('');

  return `
    <div class="ph-container">
      <div class="ph-header" onclick="togglePurchaseHistory('${inv.id}')">
        <span>📋 Historial de compras${purchases.length>0?` (${purchases.length})`:''}</span>
        <span id="ph-arrow-${inv.id}">${purchases.length>0?'▼':'▶'}</span>
      </div>
      <div class="ph-list ${purchases.length===0?'hidden':''}" id="ph-${inv.id}">
        ${purchases.length>0?`
          <div class="ph-summary">
            <span>Total: <strong>${totalShares} acc.</strong></span>
            ${weightedAvg>0?`<span>Precio prom: <strong>${formatUSD(weightedAvg)}</strong></span>`:''}
            ${livePrice>0&&weightedAvg>0?`<span class="${livePrice>=weightedAvg?'profit':'loss'}">vs actual ${formatUSD(livePrice)} (${((livePrice-weightedAvg)/weightedAvg*100)>=0?'+':''}${((livePrice-weightedAvg)/weightedAvg*100).toFixed(1)}%)</span>`:''}
          </div>
          <div class="ph-cols-header">
            <span>Fecha</span><span>Acciones</span><span>Precio</span><span>COP</span>${livePrice>0?'<span>P&L</span>':''}
          </div>
          ${rows}`:'<p class="ph-empty">Sin compras registradas.</p>'}
        <button class="btn-small" style="margin-top:10px" onclick="openAddPurchaseModal('${inv.id}')">+ Agregar compra</button>
      </div>
    </div>`;
}

function investmentCard(inv) {
  const pnl = inv.currentValue - inv.invested;
  const pct = inv.invested>0?(pnl/inv.invested*100):0;
  const port = getPortfolioSummary();
  const weight = port.current>0?(inv.currentValue/port.current*100):0;
  const hasLive = inv.ticker && inv.marketPrice != null;
  const changeUp = (inv.marketChangePct||0) >= 0;

  return `
    <div class="inv-card">
      <div class="inv-header">
        <div>
          <div class="inv-name">
            ${inv.ticker?`<span class="inv-ticker">${inv.ticker}</span> `:''}${inv.name}
          </div>
          <div class="inv-type">${inv.type} · ${weight.toFixed(1)}% del portafolio${inv.shares?` · ${inv.shares} acciones`:''}</div>
        </div>
        <button class="action-btn danger" onclick="confirmDelete('inv','${inv.id}')">🗑️</button>
      </div>

      ${hasLive ? `
        <div class="live-price-row">
          <span class="live-price">${formatUSD(inv.marketPrice)}</span>
          <span class="live-change ${changeUp?'up':'down'}">
            ${changeUp?'▲':'▼'} ${Math.abs(inv.marketChangePct||0).toFixed(2)}%
            (${changeUp?'+':''}${formatUSD(inv.marketChange||0)})
          </span>
          <span class="live-label">NYSE · Precio en vivo</span>
        </div>
      ` : inv.ticker ? `<div class="live-price-row"><span style="color:var(--muted);font-size:13px">⏳ Cargando precio para ${inv.ticker}…</span></div>` : ''}

      <div class="pnl-row">
        <div class="pnl-item">
          <div class="pnl-label">Invertido</div>
          <div class="pnl-value">${formatCOP(inv.invested)}</div>
        </div>
        <div class="pnl-item">
          <div class="pnl-label">Valor actual</div>
          <div class="pnl-value">${formatCOP(inv.currentValue)}</div>
        </div>
        <div class="pnl-item">
          <div class="pnl-label">P&L total</div>
          <div class="pnl-value ${pnl>=0?'profit':'loss'}">${pnl>=0?'+':''}${formatCOP(pnl)}<br><small>${pct>=0?'+':''}${pct.toFixed(2)}%</small></div>
        </div>
      </div>

      ${inv.notes?`<div class="savings-notes">${inv.notes}</div>`:''}
      ${!inv.shares?`<button class="btn-small" onclick="openUpdateValueModal('${inv.id}')">Actualizar valor manual</button>`:''}

      ${purchaseHistorySection(inv)}
    </div>`;
}

async function manualRefreshPrices() {
  const bar = document.querySelector('.market-info-bar span:nth-child(2)');
  if (bar) bar.textContent = 'Actualizando…';
  await refreshInvestmentPrices();
  if (state.view==='investments') renderView();
}

/* ════════════════════════════════════════════════════════════
   VIEW: PROJECTION
   ════════════════════════════════════════════════════════════ */
function renderProjection() {
  const months = getMonthlyHistory(6);
  const avgInc = getAvgMonthlyIncome(), avgExp = getAvgMonthlyExpense(), avgNet = avgInc-avgExp;
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

/* ── Boot ────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => { loadLocal(); renderView(); });
