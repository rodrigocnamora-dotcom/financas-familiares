// ============================================================
// FINANCAS FAMILIARES -- logica principal
// Sincronizacao em tempo real via Supabase
// ============================================================

const CATS = ['Alimentação','Habitação','Transportes','Saúde','Poupanças','Lazer','Outros'];
const CAT_COLOR_VAR = {
  'Alimentação':'--c-alimentacao','Habitação':'--c-habitacao','Transportes':'--c-transportes',
  'Saúde':'--c-saude','Poupanças':'--c-poupancas','Lazer':'--c-lazer','Outros':'--c-outros'
};
const CAT_ICONS = {
  'Alimentação':'ti-shopping-cart','Habitação':'ti-home','Transportes':'ti-car',
  'Saúde':'ti-heart','Poupanças':'ti-piggy-bank','Lazer':'ti-device-gamepad','Outros':'ti-dots'
};
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

const BANK_HINTS = {
  revolut: 'Revolut: Conta → Extrato → Exportar CSV',
  santander: 'Santander: Movimentos → Exportar → CSV',
  millennium: 'Millennium: Consultas → Movimentos → Exportar'
};
const BANK_COLS = {
  revolut: { date: 'Started Date', desc: 'Description', amount: 'Amount' },
  santander: { date: 'Data mov.', desc: 'Descrição', amount: 'Valor' },
  millennium: { date: 'Data', desc: 'Descrição', amount: 'Valor' }
};

function cssColor(cat) {
  return getComputedStyle(document.documentElement).getPropertyValue(CAT_COLOR_VAR[cat] || '--c-outros').trim();
}

// ---------------- Estado em memoria (espelha a Supabase) ----------------

let session = null;
let isAdmin = false;
let transactions = [];
let rules = {};
let budgets = {};
let ownAccounts = []; // { id, label, iban_fragment }
let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();
let activeScreen = 'resumo';
let selectedBank = 'revolut';
let connectionOk = false;
let channelsSubscribed = false;

// ---------------- Arranque ----------------

async function init() {
  renderLoading();
  const { data: { session: s } } = await supabaseClient.auth.getSession();
  session = s;

  supabaseClient.auth.onAuthStateChange(async (_event, s2) => {
    session = s2;
    if (session) {
      await checkAdminStatus();
      await loadAllData();
      subscribeRealtime();
      renderApp();
    } else {
      isAdmin = false;
      transactions = []; rules = {}; budgets = {}; ownAccounts = [];
      renderApp();
    }
  });

  if (session) {
    await checkAdminStatus();
    await loadAllData();
    subscribeRealtime();
  }
  renderApp();
}

async function checkAdminStatus() {
  if (!session) { isAdmin = false; return; }
  try {
    const { data, error } = await supabaseClient.from('admins').select('email').eq('email', session.user.email).maybeSingle();
    isAdmin = !error && !!data;
  } catch (e) {
    isAdmin = false;
  }
}

async function loadAllData() {
  try {
    const [txRes, rulesRes, budgetsRes, accountsRes] = await Promise.all([
      supabaseClient.from('transactions').select('*').order('date', { ascending: false }),
      supabaseClient.from('rules').select('*'),
      supabaseClient.from('budgets').select('*'),
      supabaseClient.from('own_accounts').select('*')
    ]);
    if (txRes.error) throw txRes.error;
    if (rulesRes.error) throw rulesRes.error;
    if (budgetsRes.error) throw budgetsRes.error;
    if (accountsRes.error) throw accountsRes.error;

    transactions = txRes.data.map(rowToTx);
    rules = {};
    rulesRes.data.forEach(r => rules[r.keyword] = r.category);
    budgets = {};
    budgetsRes.data.forEach(b => budgets[b.category] = b.monthly_amount);
    ownAccounts = accountsRes.data;

    connectionOk = true;
  } catch (e) {
    console.error('Erro ao carregar dados da Supabase', e);
    connectionOk = false;
    showToast('Não foi possível ligar à base de dados. Verifica a tua ligação.');
  }
}

function rowToTx(row) {
  return {
    id: row.id, date: row.date, desc: row.description, amount: row.amount,
    bank: row.bank, cat: row.category, autocat: row.auto_categorized,
    fingerprint: row.fingerprint, isInternal: !!row.is_internal_transfer
  };
}

function subscribeRealtime() {
  if (channelsSubscribed) return;
  channelsSubscribed = true;

  supabaseClient.channel('public:transactions')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, payload => {
      handleRealtimeChange('transactions', payload);
    }).subscribe();

  supabaseClient.channel('public:rules')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rules' }, payload => {
      handleRealtimeChange('rules', payload);
    }).subscribe();

  supabaseClient.channel('public:budgets')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'budgets' }, payload => {
      handleRealtimeChange('budgets', payload);
    }).subscribe();

  supabaseClient.channel('public:own_accounts')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'own_accounts' }, payload => {
      handleRealtimeChange('own_accounts', payload);
    }).subscribe();
}

function handleRealtimeChange(table, payload) {
  if (table === 'transactions') {
    if (payload.eventType === 'INSERT') {
      if (!transactions.some(t => t.id === payload.new.id)) {
        transactions.unshift(rowToTx(payload.new));
      }
    } else if (payload.eventType === 'UPDATE') {
      const idx = transactions.findIndex(t => t.id === payload.new.id);
      if (idx !== -1) transactions[idx] = rowToTx(payload.new);
    } else if (payload.eventType === 'DELETE') {
      transactions = transactions.filter(t => t.id !== payload.old.id);
    }
  } else if (table === 'rules') {
    if (payload.eventType === 'DELETE') {
      delete rules[payload.old.keyword];
    } else {
      rules[payload.new.keyword] = payload.new.category;
    }
  } else if (table === 'budgets') {
    if (payload.eventType !== 'DELETE') {
      budgets[payload.new.category] = payload.new.monthly_amount;
    }
  } else if (table === 'own_accounts') {
    if (payload.eventType === 'DELETE') {
      ownAccounts = ownAccounts.filter(a => a.id !== payload.old.id);
    } else if (payload.eventType === 'INSERT') {
      if (!ownAccounts.some(a => a.id === payload.new.id)) ownAccounts.push(payload.new);
    } else if (payload.eventType === 'UPDATE') {
      const idx = ownAccounts.findIndex(a => a.id === payload.new.id);
      if (idx !== -1) ownAccounts[idx] = payload.new;
    }
  }
  if (['resumo','graficos','transacoes','regras'].includes(activeScreen)) {
    renderScreen(activeScreen);
  }
}

// ---------------- Fingerprint / duplicados ----------------

function txFingerprint(tx) {
  return [tx.date, tx.desc.trim().toLowerCase().replace(/\s+/g,' '), tx.amount.toFixed(2), tx.bank].join('|');
}

// ---------------- Categorizacao ----------------

function matchRule(desc) {
  const d = desc.toLowerCase();
  for (const [kw, cat] of Object.entries(rules)) {
    if (d.includes(kw)) return { cat, kw };
  }
  return null;
}

function detectInternalTransfer(desc) {
  const cleaned = desc.replace(/\s+/g, '').toUpperCase();
  return ownAccounts.some(acc => cleaned.includes(acc.iban_fragment.replace(/\s+/g,'').toUpperCase()));
}

// ---------------- CSV ----------------

function parseCSV(text, bank) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { error: 'Ficheiro vazio ou inválido.' };
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const cols = BANK_COLS[bank];
  const dateIdx = headers.indexOf(cols.date);
  const descIdx = headers.indexOf(cols.desc);
  const amountIdx = headers.indexOf(cols.amount);

  if (dateIdx === -1 || descIdx === -1 || amountIdx === -1) {
    return { error: `Não encontrei as colunas esperadas para ${bank} ("${cols.date}", "${cols.desc}", "${cols.amount}"). Confirma se selecionaste o banco certo ou se o formato de exportação mudou.` };
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = splitCSVLine(lines[i]);
    const rawAmount = (vals[amountIdx] || '0').replace(/[€\s]/g, '').replace(',', '.');
    const amount = parseFloat(rawAmount);
    const desc = (vals[descIdx] || '').trim();
    const date = normalizeDate((vals[dateIdx] || '').trim());
    if (!desc || isNaN(amount) || amount === 0) continue;
    rows.push({ date, desc, amount, bank: bank.charAt(0).toUpperCase() + bank.slice(1) });
  }
  return rows;
}

function splitCSVLine(line) {
  const result = []; let cur = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === ',' && !inQuotes) { result.push(cur); cur = ''; continue; }
    cur += c;
  }
  result.push(cur);
  return result;
}

function normalizeDate(raw) {
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0,10);
  const m1 = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m1) return `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
  const m2 = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2,'0')}-${m2[1].padStart(2,'0')}`;
  return raw || new Date().toISOString().slice(0,10);
}

const SAMPLE_TX = [
  { date: '2025-06-01', desc: 'RENDA JUNHO', amount: -750, bank: 'Millennium' },
  { date: '2025-06-02', desc: 'CONTINENTE MATOSINHOS', amount: -134.50, bank: 'Millennium' },
  { date: '2025-06-03', desc: 'GALP 1247 PORTO', amount: -65, bank: 'Revolut' },
  { date: '2025-06-05', desc: 'FARMACIA CENTRAL LDA', amount: -28.90, bank: 'Santander' },
  { date: '2025-06-07', desc: 'UBER *TRIP 3X9A', amount: -12.40, bank: 'Revolut' },
  { date: '2025-06-10', desc: 'PINGO DOCE PORTO', amount: -89.30, bank: 'Santander' },
  { date: '2025-06-11', desc: 'CLINICA DR SANTOS', amount: -55, bank: 'Revolut' },
  { date: '2025-06-12', desc: 'TRANSFERENCIA POUPANCA', amount: -300, bank: 'Millennium' },
  { date: '2025-06-14', desc: 'WORTEN BRAGA', amount: -199, bank: 'Santander' },
];

async function importTransactions(rows) {
  if (!isAdmin) { showToast('Só o administrador pode importar despesas.'); return; }
  if (!rows.length) { showToast('Nenhuma transação válida encontrada no ficheiro.'); return; }

  const existingFingerprints = new Set(transactions.map(txFingerprint));
  const fresh = [];
  let dupeCount = 0;

  rows.forEach(r => {
    const fp = txFingerprint(r);
    if (existingFingerprints.has(fp)) { dupeCount++; return; }
    existingFingerprints.add(fp);
    const isInternal = detectInternalTransfer(r.desc);
    const m = isInternal ? null : matchRule(r.desc);
    fresh.push({
      date: r.date, description: r.desc, amount: r.amount, bank: r.bank,
      category: isInternal ? null : (m ? m.cat : null),
      auto_categorized: !!m, fingerprint: fp,
      is_internal_transfer: isInternal
    });
  });

  if (!fresh.length) {
    showToast(`Nenhuma transação nova (${dupeCount} já existiam).`);
    return;
  }

  const { data, error } = await supabaseClient.from('transactions').insert(fresh).select();
  if (error) {
    console.error(error);
    showToast('Erro ao guardar transações na base de dados.');
    return;
  }

  data.forEach(row => { if (!transactions.some(t => t.id === row.id)) transactions.unshift(rowToTx(row)); });

  const auto = fresh.filter(t => t.auto_categorized).length;
  const pending = fresh.filter(t => !t.category && !t.is_internal_transfer).length;
  const internal = fresh.filter(t => t.is_internal_transfer).length;
  renderImportResult({ total: fresh.length, auto, pending, dupes: dupeCount, internal });
  showToast(`${fresh.length} novas transações importadas` + (internal ? `, ${internal} marcadas como transferência entre contas` : '') + (dupeCount ? `, ${dupeCount} duplicados ignorados` : ''));
}

// ---------------- Calculos ----------------

function getMonthExpenses(m, y) {
  return transactions.filter(e => {
    const d = new Date(e.date);
    return d.getMonth() === m && d.getFullYear() === y && !e.isInternal && e.amount < 0;
  });
}
function getMonthIncome(m, y) {
  return transactions.filter(e => {
    const d = new Date(e.date);
    return d.getMonth() === m && d.getFullYear() === y && !e.isInternal && e.amount > 0;
  });
}
function getMonthInternalTransfers(m, y) {
  return transactions.filter(e => {
    const d = new Date(e.date);
    return d.getMonth() === m && d.getFullYear() === y && e.isInternal;
  });
}
function catTotal(exps, cat) {
  return exps.filter(e => e.cat === cat).reduce((s,e) => s + Math.abs(e.amount), 0);
}

// ---------------- Render: Loading ----------------

function renderLoading() {
  document.getElementById('app').innerHTML = `
    <div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;">
      <div class="spinner" style="width:22px;height:22px;border-color:rgba(128,128,128,0.3);border-top-color:var(--text-primary);"></div>
      <div style="font-size:13px;color:var(--text-secondary);">A ligar à base de dados...</div>
    </div>`;
}

// ---------------- Render: Auth (login admin) ----------------

function renderAuthScreen() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-logo">💶</div>
      <div class="auth-title">Finanças Familiares</div>
      <div class="auth-sub">Inicia sessão com a conta que te foi criada para ver o dashboard da família.</div>
      <div class="auth-error" id="auth-error"></div>
      <div class="form-row">
        <label class="form-label">Email</label>
        <input class="form-input" id="auth-email" type="email" placeholder="o-teu-email@exemplo.com" autocomplete="username">
      </div>
      <div class="form-row">
        <label class="form-label">Password</label>
        <input class="form-input" id="auth-password" type="password" placeholder="••••••••" autocomplete="current-password">
      </div>
      <button class="btn-primary" id="auth-submit" onclick="handleLogin()">Iniciar sessão</button>
    </div>`;
}

async function handleLogin() {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl = document.getElementById('auth-error');
  const btn = document.getElementById('auth-submit');
  errEl.style.display = 'none';

  if (!email || !password) {
    errEl.textContent = 'Preenche o email e a password.';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>A entrar...';

  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });

  btn.disabled = false;
  btn.textContent = 'Iniciar sessão';

  if (error) {
    errEl.textContent = 'Email ou password incorretos.';
    errEl.style.display = 'block';
    return;
  }
}

async function handleLogout() {
  await supabaseClient.auth.signOut();
  showToast('Sessão terminada.');
}

// ---------------- Render: App shell ----------------

function renderApp() {
  if (!session) { renderAuthScreen(); return; }
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-row">
        <div>
          <div class="app-title">Finanças Familiares</div>
          <div class="app-sub">
            <span class="sync-dot ${connectionOk ? '' : 'offline'}"></span>
            ${MONTHS[currentMonth]} ${currentYear} ${isAdmin ? '· admin' : '· só leitura'}
          </div>
        </div>
        <button class="icon-btn" onclick="handleLogout()">
          <i class="ti ti-logout" aria-hidden="true"></i>
        </button>
      </div>
    </div>
    <div class="content" id="content"></div>
    ${isAdmin ? `<button class="fab" onclick="openExpenseModal()"><i class="ti ti-plus" aria-hidden="true"></i></button>` : ''}
    <div class="bottom-nav">
      <button class="nav-btn" id="nav-resumo" onclick="goTo('resumo')"><i class="ti ti-layout-dashboard nav-icon" aria-hidden="true"></i>Resumo</button>
      <button class="nav-btn" id="nav-graficos" onclick="goTo('graficos')"><i class="ti ti-chart-pie nav-icon" aria-hidden="true"></i>Gráficos</button>
      <button class="nav-btn" id="nav-transacoes" onclick="goTo('transacoes')"><i class="ti ti-list nav-icon" aria-hidden="true"></i>Despesas</button>
      <button class="nav-btn" id="nav-transferencias" onclick="goTo('transferencias')"><i class="ti ti-arrows-exchange nav-icon" aria-hidden="true"></i>Transf.</button>
      ${isAdmin ? `<button class="nav-btn" id="nav-importar" onclick="goTo('importar')"><i class="ti ti-upload nav-icon" aria-hidden="true"></i>Importar</button>
      <button class="nav-btn" id="nav-regras" onclick="goTo('regras')"><i class="ti ti-settings nav-icon" aria-hidden="true"></i>Regras</button>` : ''}
    </div>
    <div class="modal-overlay" id="modal-overlay"></div>
    <div class="toast" id="toast"></div>
  `;
  goTo(activeScreen === 'importar' || activeScreen === 'regras' ? (isAdmin ? activeScreen : 'resumo') : activeScreen);
}

function goTo(screen) {
  activeScreen = screen;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const navBtn = document.getElementById('nav-' + screen);
  if (navBtn) navBtn.classList.add('active');
  renderScreen(screen);
}

function renderScreen(screen) {
  const renderers = { resumo: renderResumo, graficos: renderGraficos, transacoes: renderTransacoes, transferencias: renderTransferencias, importar: renderImportar, regras: renderRegras };
  if (renderers[screen]) renderers[screen]();
}

function changeMonth(dir) {
  currentMonth += dir;
  if (currentMonth > 11) { currentMonth = 0; currentYear++; }
  if (currentMonth < 0) { currentMonth = 11; currentYear--; }
  const sub = document.querySelector('.app-sub');
  if (sub) sub.innerHTML = `<span class="sync-dot ${connectionOk?'':'offline'}"></span>${MONTHS[currentMonth]} ${currentYear} ${isAdmin?'· admin':'· só leitura'}`;
  renderScreen(activeScreen);
}

// ---------------- Render: Resumo ----------------

function renderResumo() {
  const exps = getMonthExpenses(currentMonth, currentYear);
  const income = getMonthIncome(currentMonth, currentYear);
  const incomeTotal = income.reduce((s,e) => s + e.amount, 0);
  const total = exps.reduce((s,e) => s + Math.abs(e.amount), 0);
  const totalBudget = Object.values(budgets).reduce((s,v) => s+v, 0);
  const diff = totalBudget - total;
  const topCat = exps.length ? Object.entries(
      exps.reduce((acc,e) => { acc[e.cat||'Outros'] = (acc[e.cat||'Outros']||0) + Math.abs(e.amount); return acc; }, {})
    ).sort((a,b) => b[1]-a[1])[0][0] : '—';

  const budgetRows = CATS.map(cat => {
    const spent = catTotal(exps, cat);
    const budget = budgets[cat] || 0;
    const pct = budget > 0 ? Math.min(100, Math.round((spent/budget)*100)) : 0;
    const color = pct > 100 ? 'var(--danger)' : pct > 80 ? 'var(--warning)' : 'var(--success)';
    if (spent === 0 && budget === 0) return '';
    return `
      <div class="budget-row">
        <div class="budget-cat">${cat}</div>
        <div class="budget-bar-bg"><div class="budget-bar-fill" style="width:${pct}%;background:${color};"></div></div>
        <div class="budget-pct">${pct}%</div>
      </div>
      <div class="budget-detail"><span>€${spent.toFixed(0)} gasto</span><span>€${budget} orçamento</span></div>`;
  }).join('');

  document.getElementById('content').innerHTML = `
    <div class="month-nav">
      <button onclick="changeMonth(-1)"><i class="ti ti-chevron-left" aria-hidden="true"></i></button>
      <span class="month-label">${MONTHS[currentMonth]} ${currentYear}</span>
      <button onclick="changeMonth(1)"><i class="ti ti-chevron-right" aria-hidden="true"></i></button>
    </div>
    <div class="metric-grid">
      <div class="metric"><div class="metric-label">Gasto este mês</div><div class="metric-value">€${total.toFixed(0)}</div>
        <div class="metric-sub ${diff>=0?'ok':'over'}">${diff>=0?'▼':'▲'} €${Math.abs(diff).toFixed(0)} ${diff>=0?'em margem':'acima'}</div></div>
      <div class="metric"><div class="metric-label">Orçamento total</div><div class="metric-value">€${totalBudget.toFixed(0)}</div>
        <div class="metric-sub ok">${exps.length} transações</div></div>
      <div class="metric"><div class="metric-label">Maior categoria</div><div class="metric-value" style="font-size:16px;">${topCat}</div></div>
      <div class="metric"><div class="metric-label">Poupanças</div><div class="metric-value">€${catTotal(exps,'Poupanças').toFixed(0)}</div>
        <div class="metric-sub ok">este mês</div></div>
      <div class="metric"><div class="metric-label">Entradas externas</div><div class="metric-value" style="color:var(--success);">€${incomeTotal.toFixed(0)}</div>
        <div class="metric-sub ok">${income.length} entrada${income.length===1?'':'s'}</div></div>
      <div class="metric"><div class="metric-label">Saldo do mês</div><div class="metric-value">€${(incomeTotal-total).toFixed(0)}</div>
        <div class="metric-sub ${incomeTotal-total>=0?'ok':'over'}">entradas − gastos</div></div>
    </div>
    <div class="section-title">Orçamento vs gasto</div>
    <div class="card">${budgetRows || '<div class="empty-state">Sem despesas este mês ainda.</div>'}</div>
  `;
}

// ---------------- Render: Graficos ----------------

let barChartInstance, pieChartInstance;

function renderGraficos() {
  document.getElementById('content').innerHTML = `
    <div class="section-title" style="margin-top:4px;">Despesas por mês</div>
    <div class="card"><div class="legend" id="bar-legend"></div><div style="position:relative;height:220px;"><canvas id="barChart"></canvas></div></div>
    <div class="section-title">Distribuição por categoria</div>
    <div class="card"><div class="legend" id="pie-legend"></div><div style="position:relative;height:220px;"><canvas id="pieChart"></canvas></div></div>
  `;

  const months6 = [];
  for (let i = 5; i >= 0; i--) {
    let m = currentMonth - i, y = currentYear;
    if (m < 0) { m += 12; y--; }
    months6.push({ m, y, label: MONTHS[m].slice(0,3) });
  }

  const barData = CATS.map(cat => ({
    label: cat, data: months6.map(({m,y}) => catTotal(getMonthExpenses(m,y), cat)),
    backgroundColor: cssColor(cat), borderRadius: 4
  }));
  document.getElementById('bar-legend').innerHTML = CATS.map(c =>
    `<span><span class="legend-dot" style="background:${cssColor(c)};"></span>${c}</span>`).join('');

  if (barChartInstance) barChartInstance.destroy();
  const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();
  barChartInstance = new Chart(document.getElementById('barChart'), {
    type: 'bar',
    data: { labels: months6.map(m=>m.label), datasets: barData },
    options: {
      responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: textColor, font: { size: 11 } } },
        y: { stacked: true, grid: { color: 'rgba(128,128,128,0.15)' }, ticks: { color: textColor, font: { size: 11 }, callback: v => '€'+v } }
      }
    }
  });

  const currExps = getMonthExpenses(currentMonth, currentYear);
  const pieVals = CATS.map(c => catTotal(currExps, c));
  const pieTotal = pieVals.reduce((s,v)=>s+v,0);
  document.getElementById('pie-legend').innerHTML = CATS.map((c,i) =>
    `<span><span class="legend-dot" style="background:${cssColor(c)};"></span>${c} ${pieTotal?Math.round(pieVals[i]/pieTotal*100):0}%</span>`).join('');

  if (pieChartInstance) pieChartInstance.destroy();
  pieChartInstance = new Chart(document.getElementById('pieChart'), {
    type: 'doughnut',
    data: { labels: CATS, datasets: [{ data: pieVals, backgroundColor: CATS.map(cssColor), borderWidth: 2, borderColor: 'transparent' }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, cutout: '60%' }
  });
}

// ---------------- Render: Transacoes ----------------

function renderTransacoes() {
  const exps = getMonthExpenses(currentMonth, currentYear);
  const income = getMonthIncome(currentMonth, currentYear);
  const internalCount = getMonthInternalTransfers(currentMonth, currentYear).length;
  const pending = exps.filter(t => !t.cat);
  const sorted = [...exps].sort((a,b) => new Date(b.date) - new Date(a.date));
  const sortedIncome = [...income].sort((a,b) => new Date(b.date) - new Date(a.date));

  document.getElementById('content').innerHTML = `
    <div class="month-nav">
      <button onclick="changeMonth(-1)"><i class="ti ti-chevron-left" aria-hidden="true"></i></button>
      <span class="month-label">${MONTHS[currentMonth]} ${currentYear}</span>
      <button onclick="changeMonth(1)"><i class="ti ti-chevron-right" aria-hidden="true"></i></button>
    </div>
    ${internalCount ? `<div class="card-flat" style="background:var(--info-bg);margin-bottom:14px;cursor:pointer;" onclick="goTo('transferencias')">
      <div style="font-size:13px;color:var(--info);font-weight:600;display:flex;align-items:center;justify-content:space-between;">
        <span><i class="ti ti-arrows-exchange" aria-hidden="true"></i> ${internalCount} transferência${internalCount>1?'s':''} entre contas excluída${internalCount>1?'s':''} dos gastos</span>
        <i class="ti ti-chevron-right" aria-hidden="true"></i>
      </div>
    </div>` : ''}
    ${pending.length && isAdmin ? `<div class="section-title" style="margin-top:4px;color:var(--warning);">Precisam de categoria (${pending.length})</div><div class="card" id="tx-pending-card"></div>` : ''}
    <div class="section-title">Todas as despesas</div>
    <div class="card" id="tx-all-card"></div>
    ${income.length ? `<div class="section-title">Entradas (rendimento)</div><div class="card" id="tx-income-card"></div>` : ''}
  `;

  if (pending.length && isAdmin) {
    document.getElementById('tx-pending-card').innerHTML = '<ul class="tx-list">' + pending.map(tx => txHTML(tx)).join('') + '</ul>';
  }
  document.getElementById('tx-all-card').innerHTML = sorted.length
    ? '<ul class="tx-list">' + sorted.map(tx => txHTML(tx)).join('') + '</ul>'
    : '<div class="empty-state"><i class="ti ti-receipt-2"></i>Sem despesas registadas neste mês.</div>';

  if (income.length) {
    document.getElementById('tx-income-card').innerHTML = '<ul class="tx-list">' + sortedIncome.map(tx => incomeHTML(tx)).join('') + '</ul>';
  }
}

function incomeHTML(tx) {
  return `
    <li class="tx-item">
      <div class="tx-icon" style="background:var(--success-bg);"><i class="ti ti-arrow-down-left" style="color:var(--success);font-size:17px;" aria-hidden="true"></i></div>
      <div class="tx-info">
        <div class="tx-name">${escapeHtml(tx.desc)}</div>
        <div class="tx-meta">${tx.date} · ${tx.bank}</div>
      </div>
      <div class="tx-amount" style="color:var(--success);">+€${tx.amount.toFixed(2)}</div>
    </li>`;
}

function renderTransferencias() {
  const allInternal = transactions.filter(t => t.isInternal).sort((a,b) => new Date(b.date) - new Date(a.date));
  const balance = allInternal.reduce((s,t) => s + t.amount, 0);
  const balanced = Math.abs(balance) < 0.01;

  document.getElementById('content').innerHTML = `
    <div class="section-title" style="margin-top:4px;">Transferências entre contas próprias</div>
    <div class="card-flat" style="margin-bottom:14px;">
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.5;">
        Estas transações foram identificadas como movimentos entre as tuas próprias contas (Revolut, Santander, Millennium) e <strong>não contam</strong> para os gastos nem para os gráficos. Revê a lista e corrige se alguma estiver mal classificada.
      </div>
    </div>
    <div class="card" style="background:${balanced ? 'var(--success-bg)' : 'var(--warning-bg)'};border-color:transparent;margin-bottom:14px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <i class="ti ${balanced ? 'ti-circle-check' : 'ti-alert-triangle'}" style="font-size:22px;color:${balanced ? 'var(--success)' : 'var(--warning)'};" aria-hidden="true"></i>
        <div>
          <div style="font-size:14px;font-weight:600;color:${balanced ? 'var(--success)' : 'var(--warning)'};">
            ${balanced ? 'Saldo equilibrado' : 'Saldo por equilibrar'}
          </div>
          <div style="font-size:12px;color:${balanced ? 'var(--success)' : 'var(--warning)'};margin-top:2px;">
            ${balanced ? 'Soma de todas as transferências: €0,00 — cada saída tem a entrada correspondente.' : `Soma de todas as transferências: €${balance.toFixed(2)}. Falta importar ou marcar a transação correspondente num dos bancos.`}
          </div>
        </div>
      </div>
    </div>
    <div class="card" id="transfer-list"></div>
    ${isAdmin ? `<div class="section-title">Contas próprias configuradas</div><div class="card" id="own-accounts-card"></div>` : ''}
  `;

  document.getElementById('transfer-list').innerHTML = allInternal.length
    ? '<ul class="tx-list">' + allInternal.map(tx => transferHTML(tx)).join('') + '</ul>'
    : '<div class="empty-state"><i class="ti ti-arrows-exchange"></i>Nenhuma transferência detetada ainda.</div>';

  if (isAdmin) renderOwnAccountsCard();
}

function transferHTML(tx) {
  const revertBtn = isAdmin ? `<button class="btn-outline" style="padding:6px 10px;font-size:11px;" onclick="revertInternal('${tx.id}')">Não é transferência</button>` : '';
  const isCredit = tx.amount > 0;
  return `
    <li class="tx-item">
      <div class="tx-icon" style="background:var(--info-bg);"><i class="ti ${isCredit ? 'ti-arrow-down-left' : 'ti-arrow-up-right'}" style="color:var(--info);font-size:17px;" aria-hidden="true"></i></div>
      <div class="tx-info">
        <div class="tx-name">${escapeHtml(tx.desc)}</div>
        <div class="tx-meta">${tx.date} · ${tx.bank}</div>
        ${revertBtn}
      </div>
      <div class="tx-amount" style="color:${isCredit ? 'var(--success)' : 'var(--text-secondary)'};">${isCredit?'+':'-'}€${Math.abs(tx.amount).toFixed(2)}</div>
    </li>`;
}

async function revertInternal(id) {
  if (!isAdmin) return;
  const { error } = await supabaseClient.from('transactions').update({ is_internal_transfer: false }).eq('id', id);
  if (error) { showToast('Erro ao atualizar.'); return; }
  const tx = transactions.find(t => t.id === id);
  if (tx) tx.isInternal = false;
  renderTransferencias();
  showToast('Marcada como despesa normal. Categoriza-a em "Despesas".');
}

function renderOwnAccountsCard() {
  document.getElementById('own-accounts-card').innerHTML = `
    <ul class="tx-list" id="own-accounts-list">
      ${ownAccounts.map(a => `
        <li class="tx-item">
          <div class="tx-info"><div class="tx-name">${escapeHtml(a.label)}</div><div class="tx-meta">termina em ${escapeHtml(a.iban_fragment)}</div></div>
          <button class="btn-outline" style="padding:6px 10px;" onclick="deleteOwnAccount('${a.id}')"><i class="ti ti-trash" aria-hidden="true"></i></button>
        </li>`).join('')}
    </ul>
    <div style="display:flex;gap:8px;margin-top:12px;">
      <input class="form-input" id="new-acc-label" placeholder="Nome (ex: Revolut)" style="flex:1;">
      <input class="form-input" id="new-acc-iban" placeholder="Últimos dígitos IBAN" style="flex:1;">
    </div>
    <button class="btn-outline" style="width:100%;margin-top:8px;" onclick="addOwnAccount()"><i class="ti ti-plus" aria-hidden="true"></i> Adicionar conta</button>
  `;
}

async function addOwnAccount() {
  const label = document.getElementById('new-acc-label').value.trim();
  const iban = document.getElementById('new-acc-iban').value.trim();
  if (!label || !iban) { showToast('Preenche o nome e os dígitos do IBAN.'); return; }
  const { data, error } = await supabaseClient.from('own_accounts').insert({ label, iban_fragment: iban }).select().single();
  if (error) { showToast('Erro ao guardar (talvez já exista esse IBAN).'); return; }
  if (!ownAccounts.some(a => a.id === data.id)) ownAccounts.push(data);
  renderOwnAccountsCard();
  showToast(`Conta "${label}" adicionada. Novas importações vão detetar este IBAN.`);
}

async function deleteOwnAccount(id) {
  const { error } = await supabaseClient.from('own_accounts').delete().eq('id', id);
  if (error) { showToast('Erro ao remover conta.'); return; }
  ownAccounts = ownAccounts.filter(a => a.id !== id);
  renderOwnAccountsCard();
  showToast('Conta removida.');
}

function txHTML(tx) {
  const cat = tx.cat || 'Outros';
  const col = tx.cat ? cssColor(cat) : 'var(--text-tertiary)';
  const icon = tx.cat ? CAT_ICONS[cat] : 'ti-help';
  const badge = !tx.cat ? '<span class="badge badge-pending">pendente</span>' : (tx.autocat ? '<span class="badge badge-auto">auto</span>' : '');
  const catPicker = (!tx.cat && isAdmin) ? `
    <select class="cat-select" onchange="assignCategory('${tx.id}', this.value)">
      <option value="">Categorizar...</option>
      ${CATS.map(c => `<option>${c}</option>`).join('')}
    </select>` : '';
  return `
    <li class="tx-item">
      <div class="tx-icon" style="background:${col}22;"><i class="ti ${icon}" style="color:${col};font-size:17px;" aria-hidden="true"></i></div>
      <div class="tx-info">
        <div class="tx-name">${escapeHtml(tx.desc)}</div>
        <div class="tx-meta">${tx.date} · ${tx.bank} ${badge}</div>
        ${catPicker}
      </div>
      <div class="tx-amount">-€${Math.abs(tx.amount).toFixed(2)}</div>
    </li>`;
}

async function assignCategory(id, cat) {
  if (!cat || !isAdmin) return;
  const tx = transactions.find(t => t.id === id);
  if (!tx) return;

  const { error: updErr } = await supabaseClient.from('transactions')
    .update({ category: cat, auto_categorized: false }).eq('id', id);
  if (updErr) { showToast('Erro ao guardar categoria.'); return; }
  tx.cat = cat; tx.autocat = false;

  const desc = tx.desc.toLowerCase();
  const words = desc.split(/\s+/).filter(w => w.length > 3 && !/^\d+$/.test(w));
  if (words.length > 0) {
    const kw = words[0];
    if (!rules[kw]) {
      const { error: ruleErr } = await supabaseClient.from('rules').insert({ keyword: kw, category: cat });
      if (!ruleErr) {
        rules[kw] = cat;
        const toUpdate = transactions.filter(t => !t.cat && t.desc.toLowerCase().includes(kw));
        if (toUpdate.length) {
          await supabaseClient.from('transactions')
            .update({ category: cat, auto_categorized: true })
            .in('id', toUpdate.map(t => t.id));
          toUpdate.forEach(t => { t.cat = cat; t.autocat = true; });
        }
        showToast(`Regra criada: "${kw}" → ${cat}` + (toUpdate.length ? ` (aplicada a ${toUpdate.length+1} transações)` : ''));
      }
    }
  }
  renderScreen(activeScreen);
}

function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ---------------- Render: Importar ----------------

function renderImportar() {
  if (!isAdmin) { goTo('resumo'); return; }
  document.getElementById('content').innerHTML = `
    <div class="section-title" style="margin-top:4px;">Seleciona o banco</div>
    <div style="margin-bottom:18px;">
      <span class="bank-pill ${selectedBank==='revolut'?'selected':''}" onclick="selectBank('revolut')">Revolut</span>
      <span class="bank-pill ${selectedBank==='santander'?'selected':''}" onclick="selectBank('santander')">Santander</span>
      <span class="bank-pill ${selectedBank==='millennium'?'selected':''}" onclick="selectBank('millennium')">Millennium</span>
    </div>
    <div class="drop-zone" onclick="document.getElementById('csv-input').click()">
      <div class="drop-icon"><i class="ti ti-upload" aria-hidden="true"></i></div>
      <div class="drop-label">Carregar ficheiro CSV</div>
      <div class="drop-sub" id="bank-hint">${BANK_HINTS[selectedBank]}</div>
    </div>
    <div class="section-title">Ou experimenta com dados de exemplo</div>
    <button class="btn-outline" style="width:100%;" onclick="loadSample()"><i class="ti ti-database" aria-hidden="true"></i> Carregar transações de exemplo</button>
    <div id="import-result"></div>
  `;
  document.getElementById('csv-input').onchange = handleFile;
}

function selectBank(b) { selectedBank = b; renderImportar(); }

function handleFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const result = parseCSV(ev.target.result, selectedBank);
    if (result.error) { showToast(result.error); return; }
    importTransactions(result);
  };
  reader.onerror = () => showToast('Não foi possível ler o ficheiro.');
  reader.readAsText(file);
  e.target.value = '';
}

function loadSample() { importTransactions(SAMPLE_TX.map(t => ({...t}))); }

function renderImportResult({ total, auto, pending, dupes, internal }) {
  const el = document.getElementById('import-result');
  if (!el) return;
  el.innerHTML = `
    <div class="card" style="margin-top:16px;">
      <div class="stat-row">
        <div class="metric"><div class="metric-value">${total}</div><div class="metric-label">Novas transações</div></div>
        <div class="metric"><div class="metric-value">${auto}</div><div class="metric-label">Categorizadas auto.</div></div>
        <div class="metric"><div class="metric-value">${pending}</div><div class="metric-label">A precisar revisão</div></div>
        <div class="metric"><div class="metric-value">${dupes}</div><div class="metric-label">Duplicados ignorados</div></div>
      </div>
      ${internal ? `<div class="card-flat" style="margin-top:10px;background:var(--info-bg);">
        <div style="font-size:13px;color:var(--info);font-weight:600;">
          <i class="ti ti-arrows-exchange" aria-hidden="true"></i> ${internal} transação${internal>1?'ões':''} marcada${internal>1?'s':''} como transferência entre contas
        </div>
        <div style="font-size:12px;color:var(--info);margin-top:4px;">Não conta para os gastos. Revê em "Transferências".</div>
      </div>` : ''}
    </div>
    <button class="btn-primary" style="margin-top:12px;" onclick="goTo('transacoes')">Ver transações</button>
  `;
}

// ---------------- Render: Regras ----------------

function renderRegras() {
  if (!isAdmin) { goTo('resumo'); return; }
  const entries = Object.entries(rules);
  document.getElementById('content').innerHTML = `
    <div class="section-title" style="margin-top:4px;">Regras aprendidas (${entries.length})</div>
    <div class="card" id="rules-card"></div>
    <div class="section-title">Orçamentos mensais</div>
    <div class="card" id="budgets-card"></div>
  `;
  document.getElementById('rules-card').innerHTML = entries.length
    ? '<ul class="tx-list">' + entries.map(([kw,cat]) => `
        <li class="tx-item">
          <div style="width:9px;height:9px;border-radius:50%;background:${cssColor(cat)};flex-shrink:0;"></div>
          <div class="tx-info"><div class="tx-name">${escapeHtml(kw)}</div><div class="tx-meta">${cat}</div></div>
          <button class="btn-outline" style="padding:6px 10px;" onclick="deleteRule('${kw.replace(/'/g,"\\'")}')"><i class="ti ti-trash" aria-hidden="true"></i></button>
        </li>`).join('') + '</ul>'
    : '<div class="empty-state">Ainda sem regras. Categoriza uma despesa para criar a primeira.</div>';

  document.getElementById('budgets-card').innerHTML = CATS.map(cat => `
    <div class="form-row" style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
      <div style="flex:1;font-size:14px;font-weight:500;">${cat}</div>
      <input type="number" class="form-input" style="width:90px;text-align:right;" value="${budgets[cat]||0}" onchange="updateBudget('${cat}', this.value)">
    </div>`).join('');
}

async function deleteRule(kw) {
  const { error } = await supabaseClient.from('rules').delete().eq('keyword', kw);
  if (error) { showToast('Erro ao remover regra.'); return; }
  delete rules[kw];
  renderRegras();
  showToast('Regra removida.');
}

async function updateBudget(cat, val) {
  const n = parseFloat(val) || 0;
  const { error } = await supabaseClient.from('budgets').upsert({ category: cat, monthly_amount: n }, { onConflict: 'category' });
  if (error) { showToast('Erro ao guardar orçamento.'); return; }
  budgets[cat] = n;
}

// ---------------- Modal: Adicionar despesa manual ----------------

function openExpenseModal() {
  if (!isAdmin) return;
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('modal-overlay').innerHTML = `
    <div class="modal">
      <h3>Nova despesa</h3>
      <div class="form-row"><label class="form-label">Descrição</label>
        <input class="form-input" id="f-desc" placeholder="ex: Compras no Continente" type="text"></div>
      <div class="form-row"><label class="form-label">Valor (€)</label>
        <input class="form-input" id="f-val" placeholder="0.00" type="number" min="0" step="0.01"></div>
      <div class="form-row"><label class="form-label">Categoria</label>
        <select class="form-select" id="f-cat">${CATS.map(c => `<option>${c}</option>`).join('')}</select></div>
      <div class="form-row"><label class="form-label">Data</label>
        <input class="form-input" id="f-date" type="date" value="${today}"></div>
      <div class="btn-row">
        <button class="btn-cancel" onclick="closeModal()">Cancelar</button>
        <button class="btn-save" onclick="saveManualExpense()">Guardar</button>
      </div>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('modal-overlay').innerHTML = '';
}

async function saveManualExpense() {
  const desc = document.getElementById('f-desc').value.trim();
  const val = parseFloat(document.getElementById('f-val').value);
  const cat = document.getElementById('f-cat').value;
  const date = document.getElementById('f-date').value;
  if (!desc || isNaN(val) || val <= 0 || !date) { showToast('Preenche todos os campos.'); return; }

  const tx = { date, description: desc, amount: -Math.abs(val), bank: 'Manual', category: cat, auto_categorized: false, fingerprint: txFingerprint({date,desc,amount:-Math.abs(val),bank:'Manual'}) };
  const { data, error } = await supabaseClient.from('transactions').insert(tx).select().single();
  if (error) { showToast('Erro ao guardar despesa.'); return; }

  if (!transactions.some(t => t.id === data.id)) transactions.unshift(rowToTx(data));
  closeModal();
  renderScreen(activeScreen);
  showToast('Despesa adicionada.');
}

// ---------------- Toast ----------------

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  clearTimeout(toastTimer);
  t.textContent = msg;
  t.classList.add('show');
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ---------------- Inicio ----------------

init();
