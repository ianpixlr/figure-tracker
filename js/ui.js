// Screens for Figure Cap. Money maths stay in budget.js. Rates stay in fx.js.

import {
  CAP_USED_MESSAGE,
  PRIORITY_OPTIONS,
  barWidth,
  fitFor,
  historyModel,
  homeModel,
  monthSnapshot,
  monthSpent,
  openPreorders,
  percentLabel,
  planModel,
  statusLine,
  wishlistModel
} from './budget.js';
import {
  BOUGHT_AS_OPTIONS,
  FIGURE_TYPES,
  PURCHASE_CONDITIONS,
  SALE_CONDITIONS,
  SALE_STATUSES,
  categoryError,
  derivedPurchaseStatus,
  normalizeFigureType,
  carousellSearchUrl,
  categoryTotals,
  distinctValues,
  figureAmount,
  figureTypeLabel,
  filterPurchases,
  latestPriceCheck,
  preorderStatusLabel,
  rrpSearchUrl,
  priceCheckAmount,
  saleStatusLabel
} from './catalog.js';
import {
  OTHER_CURRENCIES,
  QUICK_CURRENCIES,
  conversionText,
  fetchMyrRate,
  formatForeign,
  loadFxCache,
  moneyToMyr,
  saveFxCache
} from './fx.js';
import { formatRM, parseMoney, withAmounts } from './money.js';
import {
  MAX_FOREIGN,
  MAX_MONEY,
  clear,
  emptyPreorder,
  exportPayload,
  forgetCategory,
  load,
  looksLikeData,
  normalizeData,
  save,
  settlePreorder,
  uid
} from './store.js';
import {
  DEFAULT_SYNC_URL,
  cachedPriceChecks,
  clearQueue,
  enqueueAppendCheck,
  enqueueDelete,
  enqueueUpsert,
  isConfiguredUrl,
  kickSync,
  priceCheckRow,
  pullPriceChecks,
  purchaseRow,
  rememberLocalCheck,
  resolveSyncUrl,
  saleRow,
  subscribe,
  syncAllNow,
  syncStatusLabel,
  wishRow
} from './sync.js';
import { applyTheme, readTheme, writeTheme } from './theme.js';
import {
  currentMonth,
  formatDay,
  formatFullDay,
  formatMonth,
  formatMonthShort,
  isYMD,
  now,
  todayStamp,
  todayYMD
} from './time.js';

const ARROW = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SEARCH_ICON = '<svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"></circle><path d="M16 16.5 20.5 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>';
const BACK = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MONTHS = [
  ['01', 'Jan'], ['02', 'Feb'], ['03', 'Mar'], ['04', 'Apr'],
  ['05', 'May'], ['06', 'Jun'], ['07', 'Jul'], ['08', 'Aug'],
  ['09', 'Sep'], ['10', 'Oct'], ['11', 'Nov'], ['12', 'Dec']
];

const planIds = new Set();
const filters = { year: '', month: '', brand: '', series: '', type: '', q: '' };
const CHART_PREVIEW = 3;
let chartExpanded = false;
let undoItem = null;
let toastTimer = 0;
let pendingToastAction = null;
let pendingImport = null;
let lastRouteKey = '';
let saving = false;

export function start() {
  bindTheme();
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('focusin', onFieldFocus);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('hashchange', () => render());
  window.addEventListener('resize', refreshShellDiag);
  window.addEventListener('orientationchange', refreshShellDiag);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', refreshShellDiag);
  const dialog = document.getElementById('dialog');
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog();
  });
  subscribe((label) => {
    const slot = document.getElementById('sync-status');
    if (slot) slot.textContent = label;
  });
  if (!location.hash) location.hash = '#home';
  render();
}

export function render() {
  const route = parseRoute();
  if (route.redirect && location.hash !== route.redirect) {
    location.replace(route.redirect);
    return;
  }
  const routeKey = `${route.name}:${route.id || ''}:${route.list || ''}:${route.focus || ''}`;
  const routeChanged = routeKey !== lastRouteKey;
  lastRouteKey = routeKey;

  const today = todayYMD();
  const sync = document.getElementById('sync-status');
  if (sync) sync.textContent = syncStatusLabel();
  setNav(route.name);

  const main = document.getElementById('main');
  const loaded = load(currentMonth());
  if (loaded.corrupt && route.name !== 'settings') main.innerHTML = corruptView();
  else if (loaded.corrupt) main.innerHTML = settingsView(loaded.data, true);
  else main.innerHTML = viewFor(route, loaded.data, today);

  document.querySelectorAll('[data-money]').forEach((block) => updateFxHint(block));
  if (route.name === 'sell' || route.name === 'edit-sale') queueCheckRefresh();

  if (routeChanged) {
    chartExpanded = false;
    scrollPageToTop();
    if (route.focus) scrollIntoView(route.focus);
  }
  refreshShellDiag();
}

function scrollPageToTop() {
  const main = document.getElementById('main');
  if (main) main.scrollTop = 0;
  window.scrollTo(0, 0);
}

function scrollIntoView(id) {
  const scroller = document.getElementById('main');
  const target = document.getElementById(id);
  if (!scroller || !target) return;
  const origin = scroller.getBoundingClientRect().top;
  scroller.scrollTop = Math.max(0, target.getBoundingClientRect().top - origin + scroller.scrollTop - 8);
}

function prefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function bindTheme() {
  applyTheme(readTheme(localStorage), prefersDark());
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const follow = () => {
    if (readTheme(localStorage) !== 'system') return;
    applyTheme('system', media.matches);
  };
  if (media.addEventListener) media.addEventListener('change', follow);
  else media.addListener(follow);
}

function onFieldFocus(event) {
  const el = event.target;
  if (!(el instanceof HTMLElement)) return;
  if (!el.matches('input, select, textarea')) return;
  if (el.matches('[type="checkbox"], [type="radio"], [type="file"], [type="hidden"]')) return;
  const scroller = document.getElementById('main');
  if (!scroller || !scroller.contains(el)) return;
  const reveal = () => {
    if (!el.isConnected) return;
    const rect = el.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    const navTop = document.querySelector('.nav')?.getBoundingClientRect().top ?? window.innerHeight;
    const visibleBottom = Math.min(navTop - 12, box.bottom);
    if (rect.bottom > visibleBottom) scroller.scrollTop += rect.bottom - visibleBottom + 12;
    else if (rect.top < box.top + 8) scroller.scrollTop -= (box.top + 8) - rect.top;
  };
  requestAnimationFrame(reveal);
  window.setTimeout(reveal, 300);
}

function parseRoute() {
  const hash = location.hash.replace(/^#/, '');
  if (hash === 'history') return { name: 'entries', id: null, redirect: '#entries' };
  if (hash === 'entries/preorders') return { name: 'entries', id: null, list: 'preorders' };
  if (hash === 'entries/types') return { name: 'entries', id: null, focus: 'category-totals' };
  if (hash.startsWith('edit-sale/')) {
    return { name: 'edit-sale', id: decodeURIComponent(hash.slice('edit-sale/'.length)) };
  }
  if (hash.startsWith('edit/')) return { name: 'edit', id: decodeURIComponent(hash.slice(5)) };
  if (['home', 'log', 'entries', 'wish', 'plan', 'sell', 'settings'].includes(hash)) {
    return { name: hash, id: null };
  }
  return { name: 'home', id: null };
}

function setNav(name) {
  const current = name === 'plan' ? 'wish'
    : (name === 'log' || name === 'entries' || name === 'edit') ? 'log'
      : name === 'edit-sale' ? 'sell'
        : name;
  document.querySelectorAll('.nav a').forEach((link) => {
    const on = link.dataset.route === current;
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function viewFor(route, data, today) {
  if (route.name === 'log') return logPage(data, 'add', today);
  if (route.name === 'entries') return logPage(data, 'entries', today, route);
  if (route.name === 'edit') return editPurchaseView(data, route.id, today);
  if (route.name === 'wish' || route.name === 'plan') return wishView(data, route.name);
  if (route.name === 'sell') return sellPage(data, null);
  if (route.name === 'edit-sale') return sellPage(data, route.id);
  if (route.name === 'settings') return settingsView(data, false);
  return homeView(data);
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function currentData() {
  return load(currentMonth());
}

function syncSource() {
  const loaded = currentData();
  return loaded.corrupt ? null : loaded.data;
}

function persist(data) {
  try {
    save(data);
    return true;
  } catch {
    showToast('Could not save on this device.');
    return false;
  }
}

function heroAmount(value) {
  const text = formatRM(value).replace('-', '').replace(/^RM\s/, '');
  return text.endsWith('.00') ? text.slice(0, -3) : text;
}

function monthName(ym) {
  return formatMonth(ym).replace(/\s+\d{4}$/, '');
}

function homeView(data) {
  const model = homeModel(data, now());
  const month = model.month;
  const caption = capCaption(month);
  const width = barWidth(month);
  const latest = latestPurchase(data.purchases);
  const balances = model.balances;
  return `
    <section class="stack">
      <div class="lede">
        <h2 id="month-title">${esc(formatMonth(model.ym))}</h2>
        <p class="hero" id="left-value"><span class="hero-currency">RM</span> <span class="hero-num">${esc(heroAmount(month.room))}</span> <span class="hero-cap">/ ${esc(heroAmount(month.cap))}</span></p>
        <p class="hero-caption" id="cap-line">${withAmounts(caption)}</p>
      </div>
      <div>
        <div class="progress-meta">
          <span id="cap-status" class="status" data-state="${month.state}">${esc(spentStatus(month))}</span>
          <span id="spent-value">${formatRM(month.spent)}</span>
        </div>
        <div class="bar" id="budget-bar" data-state="${month.state}" role="progressbar"
          aria-valuemin="0" aria-valuemax="${Math.max(month.cap, month.spent, 0)}"
          aria-valuenow="${month.spent}" aria-label="Ringgit left this month">
          <div class="bar-fill" data-empty="${width === 0}" style="width:${width.toFixed(2)}%"></div>
        </div>
      </div>
      ${month.usedUp ? `<p class="banner" id="cap-message">${esc(CAP_USED_MESSAGE)}</p>` : ''}
      <a class="btn btn-primary" id="log-link" href="#log">Log a purchase</a>
      ${latest ? purchaseCard(latest, 0, { home: true }) : `
        <article class="block">
          <div class="card-head" data-edge>
            <div class="tags"><span class="tag">Collection</span></div>
            <a class="arrow" href="#log" aria-label="Log a purchase">${ARROW}</a>
          </div>
          <h3 data-edge>No figures yet</h3>
          <p class="meta" data-edge>The log is the collection. The bar above is what is left of this month's cap.</p>
        </article>`}
      ${balances.count ? `
        <article class="block yellow" id="balances-card">
          <div class="card-head" data-edge>
            <div class="tags"><span class="tag">Balances coming</span></div>
            <a class="arrow" href="#entries/preorders" aria-label="Open open pre-orders">${ARROW}</a>
          </div>
          <p class="block-value" data-edge>${formatRM(balances.total)}</p>
          <p class="meta" data-edge>${balances.count === 1 ? '1 open pre-order' : `${balances.count} open pre-orders`}</p>
        </article>` : ''}
      <article class="block yellow">
        <div class="card-head" data-edge>
          <div class="tags"><span class="tag">${esc(model.year)}</span></div>
          <a class="arrow" href="#entries/types" aria-label="Open spending by type">${ARROW}</a>
        </div>
        <p class="kicker" data-edge>Year to date</p>
        <p class="block-value" id="ytd-value" data-edge>${formatRM(model.ytd)}</p>
        ${breakdownStats(model.breakdown)}
      </article>
    </section>
  `;
}

function capCaption(month) {
  const paidBack = month.payback > 0 && month.paybackMonth;
  const rolled = month.rollover > 0;
  if (month.over > 0) {
    const bits = [`RM ${heroAmount(month.over)} over`];
    if (rolled) bits.push(`RM ${heroAmount(month.rollover)} rolled over`);
    if (paidBack) bits.push(`RM ${heroAmount(month.payback)} from ${monthName(month.paybackMonth)}`);
    return bits.join(' · ');
  }
  if (paidBack) {
    const bits = [
      `cap RM ${heroAmount(month.cap)}`,
      `RM ${heroAmount(month.payback)} from ${monthName(month.paybackMonth)}`
    ];
    if (rolled) bits.push(`RM ${heroAmount(month.rollover)} rolled over`);
    return bits.join(' · ');
  }
  if (rolled) return `cap RM ${heroAmount(month.cap)} · RM ${heroAmount(month.rollover)} rolled over`;
  return 'left this month';
}

function spentStatus(month) {
  if (percentLabel(month) === 'Over') return statusLine(month);
  const label = statusLine(month).split(' · ').pop();
  return `Spent ${percentLabel(month)} · ${label}`;
}

function latestPurchase(purchases) {
  return purchases.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  })[0] || null;
}

function breakdownStats(breakdown) {
  return `
    <div class="ytd-count" data-edge>
      <p class="spec-label">Purchases</p>
      <p class="stat-v">${breakdown.count}</p>
    </div>
  `;
}

function logPage(data, mode, today, route) {
  return `
    <section>
      <h2>Log</h2>
      <div class="chips segment" role="tablist" aria-label="Log">
        <a class="chip" href="#log" role="tab" aria-selected="${mode === 'add'}">Add</a>
        <a class="chip" href="#entries" role="tab" aria-selected="${mode === 'entries'}">Entries</a>
      </div>
      ${mode === 'entries' ? entriesView(data, route) : purchaseForm(null, today, data.settings.categories)}
    </section>
  `;
}

function editPurchaseView(data, id, today) {
  const purchase = data.purchases.find((item) => item.id === id);
  if (!purchase) {
    return `
      <section>
        <h2>Purchase not found</h2>
        <p>That entry is not in the log.</p>
        <p><a href="#entries">Back to entries</a></p>
      </section>
    `;
  }
  return purchaseForm(purchase, today, data.settings.categories);
}

function purchaseForm(purchase, today, categories = []) {
  const editing = Boolean(purchase);
  const value = purchase || {
    name: '', series: '', brand: '', figureType: '', boughtAs: 'purchased', condition: '',
    originalAmount: '', currency: 'MYR', fxOverridden: false, price: '',
    date: today, shop: '', notes: ''
  };
  const preorder = (value.boughtAs || 'purchased') === 'preorder';
  const showPay = Boolean(purchase && purchase.balancePaidRm != null);
  const openMore = Boolean(value.series || value.brand || value.figureType || value.condition || value.shop || value.notes);
  const canPay = editing && preorder && purchase.preorderStatus === 'deposit paid';
  return `
    <section>
      ${editing ? `<div class="title-row"><a class="icon-btn" href="#entries" aria-label="Back to entries">${BACK}</a><h2>Edit</h2></div>` : ''}
      <form id="${editing ? 'edit-form' : 'log-form'}" ${editing ? `data-id="${esc(purchase.id)}"` : ''} novalidate>
        <div class="group">
          <div class="row">
            <label class="field" data-edge for="field-name">Figure
              <input id="field-name" name="name" maxlength="80" autocomplete="off" autocapitalize="words" value="${esc(value.name)}" required>
            </label>
          </div>
          <div class="row">
            <p class="kicker" data-edge>Order type</p>
            ${chips('boughtAs', BOUGHT_AS_OPTIONS, value.boughtAs || 'purchased', 'Order type')}
            <p class="meta" data-edge data-preorder-note ${preorder ? '' : 'hidden'}>The deposit counts in the month you pay it. The balance counts in the month you pay that.</p>
          </div>
        </div>
        <div class="group">
          <div class="row" data-standard ${preorder ? 'hidden' : ''}>
            ${moneyFields({
              label: 'Price',
              amount: amountValue(value.originalAmount),
              currency: value.currency || 'MYR',
              override: Boolean(value.fxOverridden),
              amountRm: value.fxOverridden ? amountValue(value.price) : '',
              historical: true,
              amountId: 'field-price'
            })}
          </div>
          <div class="row" data-preorder ${preorder ? '' : 'hidden'}>
            ${moneyFields({
              prefix: 'est',
              label: 'Estimated full price',
              amount: amountValue(value.estFullOriginalAmount),
              currency: value.estFullCurrency || 'MYR',
              override: Boolean(value.estFullFxOverridden),
              amountRm: value.estFullFxOverridden ? amountValue(value.estFullPrice) : '',
              historical: true,
              amountId: 'field-est'
            })}
          </div>
          <div class="row" data-preorder ${preorder ? '' : 'hidden'}>
            ${moneyFields({
              prefix: 'deposit',
              label: 'Deposit',
              amount: amountValue(value.depositOriginalAmount),
              currency: value.depositCurrency || 'MYR',
              override: Boolean(value.depositFxOverridden),
              amountRm: value.depositFxOverridden ? amountValue(value.depositAmountRm) : '',
              historical: true,
              amountId: 'field-deposit'
            })}
            <p class="meta" data-balance-due></p>
          </div>
          <div class="row">
            <label class="field" data-edge for="field-date"><span data-date-label>${preorder ? 'Deposit date' : 'Date'}</span>
              <input id="field-date" name="date" type="date" value="${esc(value.date)}" required>
            </label>
          </div>
        </div>
        <p class="cap-note" data-cap-note></p>
        <div data-pay-box ${showPay ? '' : 'hidden'}>
          <div class="group">
            <div class="row">
              ${moneyFields({
                prefix: 'balance',
                label: 'Balance paid',
                amount: amountValue(value.balancePaidOriginalAmount),
                currency: value.balancePaidCurrency || 'MYR',
                override: Boolean(value.balancePaidFxOverridden),
                amountRm: value.balancePaidFxOverridden ? amountValue(value.balancePaidRm) : '',
                historical: true,
                dateField: 'balanceDate',
                amountId: 'field-balance'
              })}
            </div>
            <div class="row">
              <label class="field" data-edge for="field-balance-date">Balance date
                <input id="field-balance-date" name="balanceDate" type="date" value="${esc(value.balancePaidDate || today)}">
              </label>
            </div>
          </div>
        </div>
        ${canPay ? '<button class="btn btn-ghost" type="button" data-action="show-pay">Pay balance</button>' : ''}
        <details class="group more" ${openMore ? 'open' : ''}>
          <summary data-edge>
            <span class="more-copy">
              <strong>More details</strong>
              <span class="meta">Series, brand, type, condition, shop, notes</span>
            </span>
            <svg class="chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>
          </summary>
          <div class="more-body">
            <label class="field" data-edge for="field-series">Series
              <input id="field-series" name="series" maxlength="80" autocomplete="off" value="${esc(value.series || '')}">
            </label>
            <label class="field" data-edge for="field-brand">Brand
              <input id="field-brand" name="brand" maxlength="80" autocomplete="off" value="${esc(value.brand || '')}">
            </label>
            ${typePicker(value.figureType || '', categories)}
            <label class="field" data-edge for="field-condition">Condition
              <select id="field-condition" name="condition">${selectOptions(PURCHASE_CONDITIONS, value.condition || '')}</select>
            </label>
            <label class="field" data-edge for="field-shop">Shop
              <input id="field-shop" name="shop" maxlength="80" autocomplete="off" value="${esc(value.shop || '')}">
            </label>
            <label class="field" data-edge for="field-notes">Notes
              <textarea id="field-notes" name="notes" maxlength="280" rows="3">${esc(value.notes || '')}</textarea>
            </label>
          </div>
        </details>
        <p class="form-error" role="alert" hidden></p>
        <button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Save purchase'}</button>
      </form>
      ${editing ? `<button class="btn danger" type="button" data-action="delete-purchase" data-id="${esc(purchase.id)}">Delete purchase</button>` : ''}
    </section>
  `;
}

function entriesView(data, route = {}) {
  const history = historyModel(data, now());
  const filtered = filterPurchases(data.purchases, filters).slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
  const totals = categoryTotals(filtered, { year: filters.year, month: filters.month });
  const shownCharts = chartExpanded || history.charts.length <= CHART_PREVIEW
    ? history.charts
    : history.charts.slice(-CHART_PREVIEW);
  const chart = shownCharts.map((snapshot) => `
    <div class="chart-row">
      <div class="chart-top">
        <span>${esc(formatMonthShort(snapshot.ym))}</span>
        <span>${formatRM(snapshot.spent)}</span>
      </div>
      <div class="bar" data-state="${snapshot.state}" aria-hidden="true">
        <div class="bar-fill" data-empty="${barWidth(snapshot) === 0}" style="width:${barWidth(snapshot).toFixed(2)}%"></div>
      </div>
      <p class="meta">${withAmounts(`Cap ${formatRM(snapshot.cap)}${snapshot.payback > 0 ? ` · ${formatRM(snapshot.payback)} carried from last month` : ''} · ${statusLine(snapshot)}`)}</p>
    </div>
  `).join('');
  const chartToggle = history.charts.length > CHART_PREVIEW
    ? `<button class="text-btn" type="button" data-action="toggle-chart" aria-expanded="${chartExpanded ? 'true' : 'false'}">${chartExpanded ? 'Show less' : 'Show all'}</button>`
    : '';
  const preordersOnly = route.list === 'preorders';
  const listed = preordersOnly ? openPreorders(filtered) : filtered;
  const groups = groupByMonth(listed);
  const active = activeFilters();
  const preorderBar = preordersOnly ? `
    <div class="tools" id="preorder-filter">
      <p class="meta">Open pre-orders</p>
      <a class="text-btn" href="#entries">Show all</a>
    </div>
  ` : '';
  const empty = preordersOnly
    ? 'No open pre-orders.'
    : (data.purchases.length ? 'Nothing matches these filters.' : 'No purchases yet.');
  return `
    <div class="tools">
      <label class="search">
        ${SEARCH_ICON}
        <input id="field-search" type="search" inputmode="search" enterkeyhint="search" placeholder="Search purchases" aria-label="Search purchases" value="${esc(filters.q)}" autocomplete="off" autocapitalize="off" spellcheck="false">
      </label>
      <button class="btn btn-ghost filter-btn" type="button" data-action="open-filters">Filter${active.length ? ` <span class="badge">${active.length}</span>` : ''}</button>
    </div>
    ${active.length ? `<div class="chips" aria-label="Active filters">${active.map(([key, label]) => `
      <button type="button" data-filter="${esc(key)}" data-value="">${esc(label)} <span aria-hidden="true">×</span></button>
    `).join('')}</div>` : ''}
    <section class="panel" id="chart">
      <h3>Monthly spend</h3>
      <p class="meta">Every purchase, measured against that month's cap.</p>
      ${chart || '<p class="empty">No purchases yet.</p>'}
      ${chartToggle}
    </section>
    <article class="block yellow" id="category-totals">
      <p class="kicker" data-edge>By type</p>
      <div class="stats" data-edge>
        ${(totals.length ? totals : [{ label: 'Total', count: 0, total: 0 }]).map((row, index) => `
          <div data-stat="${index}">
            <p class="spec-label">${esc(row.label)}</p>
            <p class="stat-v">${formatRM(row.total)}</p>
          </div>
        `).join('')}
      </div>
    </article>
    ${preorderBar}
    ${groups.length ? renderGroups(groups, data.purchases) : `<p class="empty">${empty}</p>`}
  `;
}

function groupByMonth(purchases) {
  const map = new Map();
  for (const purchase of purchases) {
    const ym = purchase.date.slice(0, 7);
    if (!map.has(ym)) map.set(ym, []);
    map.get(ym).push(purchase);
  }
  return [...map.keys()].sort((a, b) => (a < b ? 1 : -1)).map((ym) => ({ ym, purchases: map.get(ym) }));
}

function activeFilters() {
  return [
    filters.year && ['year', filters.year],
    filters.month && ['month', MONTHS.find((item) => item[0] === filters.month)?.[1] || filters.month],
    filters.brand && ['brand', filters.brand],
    filters.series && ['series', filters.series],
    filters.type && ['type', figureTypeLabel(filters.type)]
  ].filter(Boolean);
}

function openFilters(data) {
  const years = [...new Set([
    ...data.purchases.map((item) => item.date.slice(0, 4)),
    todayYMD().slice(0, 4)
  ])].sort((a, b) => (a < b ? 1 : -1));
  openDialog(`
    <h2 id="dialog-title">Filter</h2>
    ${filterChips('Year', 'year', [['', 'All'], ...years.map((year) => [year, year])])}
    ${filterChips('Month', 'month', [['', 'All'], ...MONTHS])}
    ${filterChips('Brand', 'brand', [['', 'All'], ...distinctValues(data.purchases, 'brand').map((value) => [value, value])])}
    ${filterChips('Series', 'series', [['', 'All'], ...distinctValues(data.purchases, 'series').map((value) => [value, value])])}
    ${filterChips('Type', 'type', typeFilterOptions(data))}
    <button class="btn btn-ghost" type="button" data-action="close-dialog">Done</button>
  `);
}

function renderGroups(groups, purchases) {
  let offset = 0;
  return groups.map((group) => {
    const html = groupHtml(group, offset, purchases);
    offset += group.purchases.length;
    return html;
  }).join('');
}

function groupHtml(group, offset, purchases) {
  // Same number as the Monthly spend chart: money paid in this month, across the log.
  // Entries stay grouped by purchase date, so the cards underneath can be a different set.
  const total = monthSpent(purchases, group.ym);
  return `
    <section class="month-group">
      <header class="item-top">
        <h3>${esc(formatMonth(group.ym))}</h3>
        <p>${formatRM(total)}</p>
      </header>
      ${group.purchases.map((purchase, index) => purchaseCard(purchase, offset + index)).join('')}
    </section>
  `;
}

function purchaseCard(purchase, index, options = {}) {
  const preorder = preorderNote(purchase);
  const pay = purchase.boughtAs === 'preorder' && purchase.preorderStatus === 'deposit paid'
    ? `<a class="btn btn-primary" href="#edit/${encodeURIComponent(purchase.id)}">Pay balance</a>`
    : `<a class="btn btn-ghost" href="#edit/${encodeURIComponent(purchase.id)}">Edit</a>`;
  const remove = options.home
    ? ''
    : `<button class="btn btn-ghost" type="button" data-action="delete-purchase" data-id="${esc(purchase.id)}">Delete</button>`;
  return `
    <article class="block" data-id="${esc(purchase.id)}">
      <div class="card-head" data-edge>
        <div class="tags">
          ${purchase.figureType ? `<span class="tag tag-type">${esc(figureTypeLabel(purchase.figureType))}</span>` : ''}
          ${purchase.condition ? `<span class="tag">${esc(purchase.condition)}</span>` : ''}
          ${purchase.preorderStatus ? `<span class="tag">${esc(preorderStatusLabel(purchase.preorderStatus))}</span>` : ''}
        </div>
      </div>
      ${identityMeta([formatDay(purchase.date), purchase.brand, purchase.series])}
      <h3 data-edge>${esc(purchase.name)}</h3>
      <p class="block-value" data-edge>${formatRM(figureAmount(purchase))}</p>
      ${sourceLine(purchase)}
      ${preorder ? `<p class="meta money-note" data-edge>${withAmounts(preorder)}</p>` : ''}
      ${purchase.notes ? `<p class="note" data-edge>${withAmounts(purchase.notes)}</p>` : ''}
      <div class="btn-row${options.home ? ' solo' : ''}">
        ${pay}
        ${remove}
      </div>
    </article>
  `;
}

function identityMeta(parts) {
  const bits = parts.map((part) => String(part || '').trim()).filter(Boolean);
  if (!bits.length) return '';
  return `<p class="meta" data-edge>${withAmounts(bits.join(' · '))}</p>`;
}

function sourceLine(item) {
  const bits = [foreignNote(item), String(item?.shop || '').trim()].filter(Boolean);
  if (!bits.length) return '';
  return `<p class="meta" data-edge>${nowrapForeign(withAmounts(bits.join(' · ')))}</p>`;
}

function nowrapForeign(html) {
  return html.replace(
    /(CN¥|HK\$|US\$|S\$|¥|₩|€|£)[\d,]+(?:\.\d+)?|\b[A-Z]{3} [\d,]+(?:\.\d+)?/g,
    (match) => `<span class="amt">${match}</span>`
  );
}

function preorderNote(purchase) {
  if (purchase.boughtAs !== 'preorder') return '';
  const parts = [];
  if (purchase.depositAmountRm != null) parts.push(`Deposit ${formatRM(purchase.depositAmountRm)}`);
  if (purchase.preorderStatus === 'deposit paid') parts.push(`Balance due ${formatRM(purchase.balanceDueRm || 0)}`);
  if (purchase.preorderStatus === 'fully paid' && purchase.finalTotalRm != null && purchase.estFullPrice != null) {
    const gap = Math.round((purchase.finalTotalRm - purchase.estFullPrice) * 100) / 100;
    if (gap > 0) parts.push(`${formatRM(gap)} over the estimate`);
    else if (gap < 0) parts.push(`${formatRM(-gap)} under the estimate`);
  }
  return parts.join(' · ');
}

function wishView(data, mode) {
  const model = wishlistModel(data, now());
  for (const id of planIds) {
    if (!data.wishlist.some((item) => item.id === id)) planIds.delete(id);
  }
  const countLabel = model.count === 1 ? '1 figure' : `${model.count} figures`;
  return `
    <section>
      <h2>${mode === 'plan' ? 'Plan' : 'Wishlist'}</h2>
      <p class="hero">
        <span class="hero-currency">RM</span>
        <span class="hero-num" id="wish-total">${esc(heroAmount(model.total))}</span>
      </p>
      <p class="hero-caption" id="wish-count">${esc(countLabel)} on the list</p>
      <div class="chips segment" role="tablist" aria-label="Wishlist views">
        <a class="chip" href="#wish" role="tab" aria-selected="${mode === 'wish'}">Items</a>
        <a class="chip" href="#plan" role="tab" aria-selected="${mode === 'plan'}">Plan the month</a>
      </div>
      ${mode === 'plan' ? `<div class="panel plan-summary" id="plan-summary">${planSummary(data)}</div>` : wishForm()}
      <div class="stack" id="wish-list">${mode === 'plan' ? planList(model) : wishList(model)}</div>
    </section>
  `;
}

function wishForm() {
  return `
    <form class="panel" id="wish-form" novalidate>
      <label class="field" data-edge for="wish-name">Figure name
        <input id="wish-name" name="name" maxlength="80" autocomplete="off" autocapitalize="words">
      </label>
      ${moneyFields({ amountId: 'wish-price' })}
      <label class="field" data-edge for="wish-priority">Priority
        <select id="wish-priority" name="priority">
          ${PRIORITY_OPTIONS.map((option) => `
            <option value="${option.value}" ${option.value === 'really' ? 'selected' : ''}>${esc(option.label)}</option>
          `).join('')}
        </select>
      </label>
      <p class="form-error" role="alert" hidden></p>
      <button class="btn btn-primary" type="submit">Add to wishlist</button>
    </form>
  `;
}

function wishList(model) {
  if (!model.items.length) return '<p class="empty">No figures here yet. Add one with a name and a price.</p>';
  return model.items.map((item, index) => `
    <article class="block" data-id="${esc(item.id)}">
      <div class="card-head" data-edge>
        <div class="tags"><span class="tag">${esc(item.priorityLabel)}</span></div>
      </div>
      <h3 data-edge>${esc(item.name)}</h3>
      <p class="block-value" data-edge>${formatRM(item.price)}</p>
      ${sourceLine(item)}
      <p class="meta" data-edge>${withAmounts(item.fitLabel)}</p>
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-action="log-wish" data-id="${esc(item.id)}">Log purchase</button>
        <button class="btn btn-ghost" type="button" data-action="remove-wish" data-id="${esc(item.id)}" aria-label="Remove ${esc(item.name)}">Remove</button>
      </div>
    </article>
  `).join('');
}

function planList(model) {
  if (!model.items.length) return '<p class="empty">Your wishlist is empty, so there is nothing to plan yet.</p>';
  return model.items.map((item) => `
    <label class="pick">
      <input type="checkbox" data-action="plan-toggle" data-id="${esc(item.id)}" ${planIds.has(item.id) ? 'checked' : ''}>
      <span class="pick-body">
        <span class="pick-top">
          <span class="pick-name">${esc(item.name)}</span>
          <span class="pick-price">${formatRM(item.price)}</span>
        </span>
        <span class="meta">${withAmounts(`${item.priorityLabel} · ${item.fitLabel}`)}</span>
      </span>
    </label>
  `).join('');
}

function planSummary(data) {
  const model = wishlistModel(data, now());
  const plan = planModel(model.items, planIds, model.room);
  let detail = 'Pick figures to see the total against what is left.';
  if (plan.count > 0 && plan.fits) detail = `${formatRM(plan.remaining)} would still be left.`;
  if (plan.count > 0 && !plan.fits) detail = `${formatRM(plan.over)} over what's left this month.`;
  const overNote = model.over > 0 ? ` · already ${formatRM(model.over)} over the cap` : '';
  const payNote = model.month.payback > 0 ? ` · cap ${formatRM(model.month.cap)} after ${formatRM(model.month.payback)} overspend` : '';
  const headline = plan.count === 0 ? 'Nothing picked' : `${formatRM(plan.total)} selected`;
  return `
    <p class="meta">${withAmounts(`Left this month: ${formatRM(model.room)}${overNote}${payNote}`)}</p>
    <p class="plan-headline">${withAmounts(headline)}</p>
    <p id="plan-detail">${withAmounts(detail)}</p>
  `;
}

function sellPage(data, id) {
  if (id) {
    const item = data.forSale.find((sale) => sale.id === id);
    if (!item) {
      return `<section><h2>Listing not found</h2><p><a href="#sell">Back to sell</a></p></section>`;
    }
    return `<section><div class="title-row"><a class="icon-btn" href="#sell" aria-label="Back to sell">${BACK}</a><h2>Edit sale</h2></div>${saleForm(item)}</section>`;
  }
  return `
    <section class="stack">
      <h2>Sell</h2>
      ${saleForm(null)}
      ${data.forSale.length ? data.forSale.map((item, index) => saleCard(item, index)).join('') : '<p class="empty">Nothing listed yet.</p>'}
    </section>
  `;
}

function saleForm(item) {
  const value = item || {
    name: '', brand: '', series: '', condition: 'MISB', notes: '', status: 'listed',
    originalAmount: '', currency: 'MYR', fxOverridden: false, price: '',
    soldOriginalAmount: '', soldCurrency: 'MYR', soldFxOverridden: false, soldPrice: '', soldDate: ''
  };
  const editing = Boolean(item);
  return `
    <form class="panel" id="sale-form" ${editing ? `data-id="${esc(item.id)}"` : ''} novalidate>
      <label class="field" data-edge for="sale-name">Figure name
        <input id="sale-name" name="name" maxlength="80" autocomplete="off" value="${esc(value.name)}">
      </label>
      <label class="field" data-edge for="sale-brand">Brand
        <input id="sale-brand" name="brand" maxlength="80" autocomplete="off" value="${esc(value.brand || '')}">
      </label>
      <label class="field" data-edge for="sale-series">Series
        <input id="sale-series" name="series" maxlength="80" autocomplete="off" value="${esc(value.series || '')}">
      </label>
      <p class="spec-label" data-edge>Condition</p>
      ${chips('condition', SALE_CONDITIONS, value.condition || 'MISB')}
      <p class="spec-label" data-edge>Asking price</p>
      ${moneyFields({
        amount: amountValue(value.originalAmount),
        currency: value.currency || 'MYR',
        override: Boolean(value.fxOverridden),
        amountRm: value.fxOverridden ? amountValue(value.price) : '',
        amountId: 'sale-price'
      })}
      <label class="field" data-edge for="sale-notes">Notes
        <textarea id="sale-notes" name="notes" maxlength="280" rows="3">${esc(value.notes || '')}</textarea>
      </label>
      <p class="spec-label" data-edge>Status</p>
      ${chips('status', SALE_STATUSES, value.status || 'listed')}
      <div data-sold-box ${value.status === 'sold' ? '' : 'hidden'}>
        <p class="spec-label">Sold price</p>
        ${moneyFields({
          prefix: 'sold',
          amount: amountValue(value.soldOriginalAmount),
          currency: value.soldCurrency || 'MYR',
          override: Boolean(value.soldFxOverridden),
          amountRm: value.soldFxOverridden ? amountValue(value.soldPrice) : '',
          amountId: 'sold-price'
        })}
        <label class="field" data-edge for="sold-date">Sold date
          <input id="sold-date" name="soldDate" type="date" value="${esc(value.soldDate || '')}">
        </label>
      </div>
      <p class="form-error" role="alert" hidden></p>
      <button class="btn btn-primary" type="submit">${editing ? 'Save listing' : 'Add listing'}</button>
    </form>
    ${editing ? `<div class="panel">${saleEditResearch(item)}</div>` : ''}
    ${editing ? `<button class="btn danger" type="button" data-action="delete-sale" data-id="${esc(item.id)}">Delete listing</button>` : ''}
  `;
}

function saleCard(item, index) {
  return `
    <article class="block" data-id="${esc(item.id)}">
      <div class="card-head" data-edge>
        <div class="tags"><span class="tag">${esc(item.condition)}</span><span class="tag">${esc(saleStatusLabel(item.status))}</span></div>
      </div>
      ${identityMeta([item.brand, item.series])}
      <h3 data-edge>${esc(item.name)}</h3>
      <p class="block-value" data-edge>${formatRM(item.price)}</p>
      ${sourceLine(item)}
      ${searchPills(item)}
      <div class="check" data-check-for="${esc(item.id)}">${priceCheckLine(item, cachedPriceChecks())}</div>
      <div class="btn-row">
        <a class="btn btn-ghost" href="#edit-sale/${encodeURIComponent(item.id)}">Edit</a>
        <button class="btn btn-ghost" type="button" data-action="delete-sale" data-id="${esc(item.id)}">Delete</button>
      </div>
    </article>
  `;
}

function searchPills(item) {
  return `
    <div class="search-pills" data-edge>
      <a class="btn btn-primary" href="${esc(carousellSearchUrl(item.name, item.condition))}" target="_blank" rel="noopener noreferrer">Search Carousell</a>
      <a class="btn btn-primary" href="${esc(rrpSearchUrl(item.name))}" target="_blank" rel="noopener noreferrer">Search RRP</a>
    </div>
  `;
}

function saleEditResearch(item) {
  return `
    ${searchPills(item)}
    <div class="check" data-check-for="${esc(item.id)}">${priceCheckLine(item, cachedPriceChecks())}</div>
    ${priceCheckForm(item)}
  `;
}

function priceCheckForm(item) {
  return `
    <form class="check-form" data-check-form data-sale-id="${esc(item.id)}" novalidate>
      <div class="check-prices" data-edge>
        <label class="field">Low
          <input name="low" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="Low price">
        </label>
        <label class="field">Typical
          <input name="typical" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="Typical price">
        </label>
        <label class="field">High
          <input name="high" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="High price">
        </label>
      </div>
      <div class="check-pair" data-edge>
        <label class="field">RRP
          <input name="rrp" maxlength="80" autocomplete="off" placeholder="Optional" aria-label="RRP">
        </label>
        <label class="field">Source
          <input name="source" maxlength="80" autocomplete="off" value="Carousell" aria-label="Source">
        </label>
      </div>
      <p class="form-error" role="alert" hidden></p>
      <button class="btn btn-primary" type="submit">Save price check</button>
    </form>
  `;
}

function ringgitCompact(value) {
  const amount = priceCheckAmount(value);
  if (amount == null) return '';
  const text = formatRM(amount);
  return text.endsWith('.00') ? text.slice(0, -3) : text;
}

function checkDay(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match || !isYMD(match[1])) return '';
  return formatDay(match[1]);
}

function priceCheckLine(item, checks) {
  const check = latestPriceCheck(item, checks);
  if (!check) return '<p class="check-empty" data-edge>No price check yet.</p>';
  const prices = [check.low_rm, check.typical_rm, check.high_rm].map((value) => ringgitCompact(value).replace(/^RM\s/, '')).filter(Boolean);
  const rrpAmount = ringgitCompact(check.rrp);
  const rrpRaw = String(check.rrp || '').trim();
  const rrp = rrpAmount || rrpRaw;
  const parts = [];
  if (prices.length) parts.push(`Market RM ${prices.join(' / ')}`);
  if (rrp) parts.push(`RRP ${rrpAmount ? rrpAmount : rrp}`);
  const source = String(check.sources || '').trim() || String(check.rrp_source || '').trim();
  const when = checkDay(check.checked_at);
  const detail = [source, when].filter(Boolean).join(' · ');
  if (!parts.length && !detail) return '<p class="check-empty" data-edge>No price check yet.</p>';
  return `
    ${parts.length ? `<p class="check-line" data-edge>${withAmounts(parts.join(' · '))}</p>` : ''}
    ${detail ? `<p class="check-sub" data-edge>${esc(detail)}</p>` : ''}
  `;
}

function settingsView(data, corrupt) {
  const settings = data.settings;
  const preview = corrupt
    ? 'Saved data could not be read. Import a backup, or erase the unreadable copy.'
    : settingsPreview(settings, data.purchases);
  return `
    <section class="settings-page">
      <h2>Settings</h2>
      ${shellDiagSlot()}
      ${corrupt ? '<p class="banner" id="corrupt-note">Saved data on this device could not be read.</p>' : ''}
      <form class="panel" id="settings-form" novalidate>
        <div class="setting" data-edge>
          <p class="kicker" id="theme-label">Theme</p>
          ${chips('theme', [
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'system', label: 'Match phone' }
          ], readTheme(localStorage), 'Theme')}
        </div>
        <label class="field setting" data-edge for="field-cap">Monthly cap (RM)
          <input id="field-cap" name="cap" inputmode="decimal" autocomplete="off" value="${esc(settings.monthlyCap.toFixed(2))}">
          <span class="meta">${withAmounts('The limit for each calendar month, in Malaysia time. It starts at RM 400.00.')}</span>
        </label>
        <div class="setting checks" data-edge>
          <label class="checkline">
            <input id="field-rollover" name="rollover" type="checkbox" ${settings.rollover ? 'checked' : ''}>
            <span>
              <span class="check-title">Unspent money rolls over</span>
              <span class="meta">Adds whatever you did not spend last month to this month's cap. Off by default.</span>
            </span>
          </label>
          <label class="checkline">
            <input id="field-payback" name="payback" type="checkbox" ${settings.overspendPayback ? 'checked' : ''}>
            <span>
              <span class="check-title">Overspend comes out of next month</span>
              <span class="meta">${withAmounts("If a month ends over the cap, that amount lowers the next month. The cap does not go below RM 0.00. On by default.")}</span>
            </span>
          </label>
        </div>
        <label class="field setting" data-edge for="field-sync">Sheet sync URL
          <input id="field-sync" name="syncUrl" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/DEPLOYMENT_ID/exec" value="${esc(syncFieldValue(settings))}">
          <span class="meta">Leave blank to use the built-in sheet. A different web app URL replaces it. Rates come from the European Central Bank via Frankfurter, with a cached rate when you are offline.</span>
        </label>
        <p class="meta" id="settings-preview">${withAmounts(preview)}</p>
        <p class="form-error" role="alert" hidden></p>
        <button class="btn btn-primary" type="submit">Save settings</button>
      </form>
      <button class="btn btn-ghost" id="sync-all" type="button" data-action="sync-all">Sync all now</button>
      <section class="panel" id="backup">
        <h3>Backup</h3>
        <p class="meta">Export a JSON file of purchases, the wishlist, listings, and settings. Import replaces what is on this device.</p>
        <div class="btn-row">
          <button class="btn btn-ghost" type="button" data-action="export" ${corrupt ? 'disabled' : ''}>Export JSON</button>
          <button class="btn btn-ghost" type="button" data-action="pick-import">Import JSON</button>
        </div>
        <input id="import-file" type="file" accept="application/json,.json">
        ${corrupt ? '<button class="btn danger" type="button" data-action="reset-corrupt">Erase unreadable data</button>' : ''}
      </section>
    </section>
  `;
}

function shellDiagSlot() {
  if (new URLSearchParams(location.search).get('diag') !== '1') return '';
  return '<p class="meta" id="shell-diag"></p>';
}

function shellDiagText() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const insets = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
    .map((value) => String(Math.round(parseFloat(value) || 0)));
  probe.remove();
  const nav = document.querySelector('.nav');
  const navBottom = nav ? Math.round(nav.getBoundingClientRect().bottom) : 0;
  const vv = window.visualViewport ? Math.round(window.visualViewport.height) : 0;
  return `inner ${window.innerHeight} · client ${document.documentElement.clientHeight} · screen ${window.screen.height} · vv ${vv} · safe ${insets.join('/')} · nav ${navBottom}`;
}

function refreshShellDiag() {
  const slot = document.getElementById('shell-diag');
  if (!slot) return;
  slot.textContent = shellDiagText();
}

function settingsPreview(settings, purchases) {
  const month = homeModel({ settings, purchases, wishlist: [] }, now()).month;
  let text = `This month's cap would be ${formatRM(month.cap)}.`;
  if (settings.rollover && month.rollover > 0) {
    text = `This month's cap would be ${formatRM(month.cap)}, including ${formatRM(month.rollover)} rolled over.`;
  }
  if (month.payback > 0) text += ` ${formatRM(month.payback)} comes off for last month's overspend.`;
  return text;
}

function corruptView() {
  return `
    <section>
      <h2>Saved data could not be read</h2>
      <p>The copy on this device is not a Figure Cap backup. You can import a file, or erase the unreadable copy and start again.</p>
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-action="pick-import">Import JSON</button>
        <button class="btn danger" type="button" data-action="reset-corrupt">Erase unreadable data</button>
      </div>
      <input id="import-file" type="file" accept="application/json,.json">
    </section>
  `;
}

function syncFieldValue(settings) {
  if (settings.syncUrl) return settings.syncUrl;
  if (isConfiguredUrl(DEFAULT_SYNC_URL)) return DEFAULT_SYNC_URL;
  return '';
}

function moneyNames(prefix) {
  if (!prefix) {
    return { amount: 'originalAmount', currency: 'currency', override: 'fxOverride', rm: 'amountRm' };
  }
  return {
    amount: `${prefix}OriginalAmount`,
    currency: `${prefix}Currency`,
    override: `${prefix}FxOverride`,
    rm: `${prefix}AmountRm`
  };
}

function moneyFields({
  prefix = '',
  label = 'Price',
  amount = '',
  currency = 'MYR',
  override = false,
  amountRm = '',
  historical = false,
  dateField = 'date',
  amountId = 'field-price'
} = {}) {
  const names = moneyNames(prefix);
  return `
    <div class="money" data-edge data-money data-prefix="${esc(prefix)}" ${historical ? 'data-historical="true"' : ''} data-date-field="${esc(dateField)}">
      <div class="money-row">
        <label class="field" for="${esc(amountId)}">${esc(label)}
          <input id="${esc(amountId)}" name="${names.amount}" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(amount)}">
        </label>
        <label class="field" for="${esc(amountId)}-currency">Currency
          <select id="${esc(amountId)}-currency" name="${names.currency}">${currencyOptions(currency)}</select>
        </label>
      </div>
      <p class="fx-hint" data-fx-hint></p>
      <label class="checkline" data-fx-toggle ${(currency || 'MYR').toUpperCase() === 'MYR' && !override ? 'hidden' : ''}>
        <input type="checkbox" name="${names.override}" data-fx-override ${override ? 'checked' : ''}>
        <span>
          <span class="check-title">Use statement amount</span>
          <span class="meta">Use the RM amount on your card statement</span>
        </span>
      </label>
      <label class="field" for="${esc(amountId)}-rm" data-fx-rm ${override ? '' : 'hidden'}>Statement amount (RM)
        <input id="${esc(amountId)}-rm" name="${names.rm}" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(amountRm)}">
      </label>
    </div>
  `;
}

function currencyOptions(selected) {
  const current = selected || 'MYR';
  const option = (code) => `<option value="${code}" ${code === current ? 'selected' : ''}>${code}</option>`;
  const extras = OTHER_CURRENCIES.filter((code) => !QUICK_CURRENCIES.includes(code));
  const known = QUICK_CURRENCIES.includes(current) || extras.includes(current);
  return `<optgroup label="Common">${QUICK_CURRENCIES.map(option).join('')}</optgroup><optgroup label="Other">${extras.map(option).join('')}${known ? '' : option(current)}</optgroup>`;
}

function selectOptions(options, selected) {
  return options.map((option) => `<option value="${esc(option.value)}" ${option.value === selected ? 'selected' : ''}>${esc(option.label)}</option>`).join('');
}

function typeOptions(categories = []) {
  return [
    ...FIGURE_TYPES,
    ...categories.map((name) => ({ value: name, label: name }))
  ];
}

function typeFilterOptions(data) {
  return [['', 'All'], ...typeOptions(data.settings.categories || []).filter((item) => item.value).map((item) => [item.value, item.label])];
}

function typeChip(option, selected, removable) {
  return `
    <label class="chip">
      <input type="radio" name="figureType" value="${esc(option.value)}" ${option.value === selected ? 'checked' : ''}>
      <span>${esc(option.label)}</span>
      ${removable ? `<button class="chip-x" type="button" data-action="remove-category" data-name="${esc(option.value)}" aria-label="Remove ${esc(option.label)}">×</button>` : ''}
    </label>`;
}

function typePicker(selected, categories = []) {
  return `
    <div class="type-field" data-edge>
      <p class="kicker">Type</p>
      <div class="chips" data-type-chips>
        <div class="chip-set" role="radiogroup" aria-label="Type">
          ${FIGURE_TYPES.map((option) => typeChip(option, selected, false)).join('')}
          ${categories.map((name) => typeChip({ value: name, label: name }, selected, true)).join('')}
        </div>
        <button class="chip" type="button" data-action="new-category">+ New</button>
      </div>
      <div class="new-category" data-new-category hidden>
        <input id="field-new-category" name="newCategory" maxlength="20" autocomplete="off" placeholder="Category" aria-label="New category">
        <button class="btn btn-primary" type="button" data-action="add-category">Add</button>
        <p class="category-error" data-category-error role="alert" hidden></p>
      </div>
    </div>
  `;
}

function chips(name, options, selected, label = name) {
  return `<div class="chips" data-edge role="radiogroup" aria-label="${esc(label)}">${options.map((option) => `
    <label class="chip">
      <input type="radio" name="${esc(name)}" value="${esc(option.value)}" ${option.value === selected ? 'checked' : ''}>
      <span>${esc(option.label)}</span>
    </label>
  `).join('')}</div>`;
}

function filterChips(label, key, pairs) {
  return `
    <p class="spec-label">${esc(label)}</p>
    <div class="chips" role="group" aria-label="${esc(label)}">
      ${pairs.map(([value, text]) => `
        <button type="button" data-filter="${esc(key)}" data-value="${esc(value)}" aria-pressed="${filters[key] === value}">${esc(text)}</button>
      `).join('')}
    </div>
  `;
}

function foreignNote(item) {
  if (!item?.currency || item.currency === 'MYR') return '';
  let text = formatForeign(item.originalAmount, item.currency);
  if (item.fxOverridden) text += ' · statement amount';
  else if (item.fxCached) text += ' · cached rate';
  return text;
}

function amountValue(value) {
  if (value == null || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return Number.isInteger(number) ? String(number) : number.toFixed(2);
}

async function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (saving) return;
  saving = true;
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    if (form.id === 'log-form' || form.id === 'edit-form') await savePurchase(form, form.dataset.id || '');
    if (form.id === 'wish-form') await addWish(form);
    if (form.id === 'sale-form') await saveSale(form, form.dataset.id || '');
    if (form.matches('[data-check-form]')) savePriceCheck(form);
    if (form.id === 'settings-form') await saveSettings(form);
  } finally {
    saving = false;
    if (button?.isConnected) button.disabled = false;
  }
}

function onInput(event) {
  if (event.target.id === 'field-search') {
    filters.q = event.target.value;
    const pos = event.target.selectionStart;
    render();
    const input = document.getElementById('field-search');
    if (input) {
      input.focus();
      const caret = pos ?? input.value.length;
      input.setSelectionRange(caret, caret);
    }
    return;
  }
  const form = event.target.form;
  if (form?.id === 'settings-form') updateSettingsPreview(form);
  const block = event.target.closest('[data-money]');
  if (block) scheduleFx(block);
  if ((event.target.name === 'date' || event.target.name === 'balanceDate') && form) {
    form.querySelectorAll('[data-historical="true"]').forEach((block) => scheduleFx(block));
  }
}

function onChange(event) {
  const target = event.target;
  if (target.name === 'theme' && target.form?.id === 'settings-form') {
    writeTheme(localStorage, target.value);
    applyTheme(target.value, prefersDark());
    return;
  }
  if (target.matches?.('[data-action="plan-toggle"]')) {
    if (target.checked) planIds.add(target.dataset.id);
    else planIds.delete(target.dataset.id);
    const slot = document.getElementById('plan-summary');
    const loaded = currentData();
    if (slot && !loaded.corrupt) slot.innerHTML = planSummary(loaded.data);
    return;
  }
  if (target.id === 'import-file') {
    const file = target.files && target.files[0];
    target.value = '';
    if (file) stageImport(file);
    return;
  }
  if (target.name === 'status' && target.form?.id === 'sale-form') {
    const box = target.form.querySelector('[data-sold-box]');
    if (box) box.hidden = fieldValue(target.form, 'status') !== 'sold';
  }
  if (target.name === 'boughtAs' && target.form) suggestStatus(target.form);
  if (target.matches?.('[data-fx-override]')) {
    const block = target.closest('[data-money]');
    const rm = block?.querySelector('[data-fx-rm]');
    if (rm) rm.hidden = !target.checked;
    if (block) scheduleFx(block);
  }
  const block = target.closest('[data-money]');
  if (block) scheduleFx(block);
  if ((target.name === 'date' || target.name === 'balanceDate') && target.form) {
    target.form.querySelectorAll('[data-historical="true"]').forEach((block) => scheduleFx(block));
  }
  if (target.form?.id === 'settings-form') updateSettingsPreview(target.form);
}

function onClick(event) {
  const filter = event.target.closest('[data-filter]');
  if (filter && filter.dataset.filter) {
    filters[filter.dataset.filter] = filter.dataset.value || '';
    const dialog = document.getElementById('dialog');
    if (dialog?.open) {
      dialog.close();
      dialog.innerHTML = '';
    }
    render();
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'toast-action') {
    const run = pendingToastAction;
    hideToast();
    if (run) run();
    return;
  }
  if (action === 'close-dialog') {
    closeDialog();
    return;
  }
  if (action === 'remove-wish') removeWish(button.dataset.id);
  if (action === 'log-wish') askLogWish(button.dataset.id);
  if (action === 'confirm-log') confirmLogWish(button.dataset.id);
  if (action === 'delete-purchase') askDelete(button.dataset.id);
  if (action === 'confirm-delete') confirmDelete(button.dataset.id);
  if (action === 'delete-sale') askDeleteSale(button.dataset.id);
  if (action === 'confirm-delete-sale') confirmDeleteSale(button.dataset.id);
  if (action === 'export') exportJson();
  if (action === 'pick-import') document.getElementById('import-file')?.click();
  if (action === 'confirm-import') confirmImport();
  if (action === 'reset-corrupt') resetCorrupt();
  if (action === 'sync-all') onSyncAll();
  if (action === 'show-pay') {
    const form = button.closest('form') || document.querySelector('#edit-form');
    const box = form?.querySelector('[data-pay-box]');
    if (box) {
      box.hidden = false;
      box.querySelectorAll('[data-money]').forEach((block) => scheduleFx(block));
    }
    button.hidden = true;
  }
  if (action === 'toggle-chart') {
    chartExpanded = !chartExpanded;
    const scroller = document.getElementById('main');
    const top = scroller ? scroller.scrollTop : 0;
    render();
    const next = document.getElementById('main');
    if (next) next.scrollTop = top;
    return;
  }
  if (action === 'open-filters') {
    const loaded = currentData();
    if (!loaded.corrupt) openFilters(loaded.data);
  }
  if (action === 'new-category') showNewCategory(button);
  if (action === 'add-category') addCategoryFromForm(button);
  if (action === 'remove-category') {
    event.preventDefault();
    askRemoveCategory(button.dataset.name || '');
  }
  if (action === 'confirm-remove-category') confirmRemoveCategory(button.dataset.name || '');
}

function onKeyDown(event) {
  if (event.key !== 'Enter') return;
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.name !== 'newCategory') return;
  event.preventDefault();
  addCategoryFromForm(input);
}

function showNewCategory(button) {
  const form = button.closest('form');
  const box = form?.querySelector('[data-new-category]');
  if (!box) return;
  box.hidden = false;
  const error = box.querySelector('[data-category-error]');
  if (error) error.hidden = true;
  box.querySelector('input')?.focus();
}

function addCategoryFromForm(source) {
  const form = source.closest('form');
  const input = form?.querySelector('[name="newCategory"]');
  const error = form?.querySelector('[data-category-error]');
  if (!form || !input) return;
  const loaded = currentData();
  if (loaded.corrupt) return;
  const name = input.value.trim();
  const categories = loaded.data.settings.categories || [];
  const problem = categoryError(name, categories);
  if (problem) {
    if (error) {
      error.hidden = false;
      error.textContent = problem;
    }
    return;
  }
  loaded.data.settings.categories = [...categories, name];
  if (!persist(loaded.data)) return;
  const set = form.querySelector('[data-type-chips] .chip-set');
  const existing = set?.querySelector(`input[name="figureType"][value="${CSS.escape(name)}"]`);
  if (set && !existing) {
    const label = document.createElement('label');
    label.className = 'chip';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'figureType';
    radio.value = name;
    const text = document.createElement('span');
    text.textContent = name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chip-x';
    remove.dataset.action = 'remove-category';
    remove.dataset.name = name;
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.textContent = '×';
    label.append(radio, text, remove);
    set.append(label);
    radio.checked = true;
  } else if (existing) {
    existing.checked = true;
  }
  input.value = '';
  if (error) error.hidden = true;
  const box = form.querySelector('[data-new-category]');
  if (box) box.hidden = true;
}

function askRemoveCategory(name) {
  if (!name) return;
  openDialog(`
    <h2 id="dialog-title">Remove ${esc(name)}?</h2>
    <p>Figures in ${esc(name)} move to Other.</p>
    <div class="btn-row">
      <button class="btn btn-primary" type="button" data-action="confirm-remove-category" data-name="${esc(name)}">Remove</button>
      <button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button>
    </div>
  `);
}

function confirmRemoveCategory(name) {
  const loaded = currentData();
  if (loaded.corrupt) return;
  const changed = forgetCategory(loaded.data, name);
  const stamp = now().toISOString();
  for (const purchase of changed) purchase.updatedAt = stamp;
  if (!persist(loaded.data)) return;
  for (const purchase of changed) enqueueUpsert('Purchases', purchaseRow(purchase));
  if (changed.length) kickSync(syncSource);
  closeDialog();
  showToast(`Removed ${name}.`);
  render();
}

function fieldValue(form, name) {
  const field = form.elements.namedItem(name);
  return field ? String(field.value ?? '') : '';
}

function fieldChecked(form, name) {
  const field = form.elements.namedItem(name);
  return Boolean(field && field.checked);
}

function suggestStatus(form) {
  const bought = fieldValue(form, 'boughtAs');
  const preorder = bought === 'preorder';
  form.querySelectorAll('[data-standard]').forEach((el) => { el.hidden = preorder; });
  form.querySelectorAll('[data-preorder]').forEach((el) => { el.hidden = !preorder; });
  const note = form.querySelector('[data-preorder-note]');
  if (note) note.hidden = !preorder;
  const dateLabel = form.querySelector('[data-date-label]');
  if (dateLabel) dateLabel.textContent = preorder ? 'Deposit date' : 'Date';
  if (preorder) {
    copyMoney(form, '', 'est');
    copyMoney(form, '', 'deposit');
    form.querySelectorAll('[data-preorder] [data-money]').forEach((block) => scheduleFx(block));
  }
}

function copyMoney(form, fromPrefix, toPrefix) {
  const from = moneyNames(fromPrefix);
  const to = moneyNames(toPrefix);
  const target = form.elements.namedItem(to.amount);
  const source = fieldValue(form, from.amount);
  if (!target || target.value || !source) return;
  target.value = source;
  const currency = form.elements.namedItem(to.currency);
  const sourceCurrency = form.elements.namedItem(from.currency);
  if (currency && sourceCurrency) currency.value = sourceCurrency.value;
}

function scheduleFx(block) {
  clearTimeout(block._fxTimer);
  block._fxTimer = setTimeout(() => updateFxHint(block), 280);
}

async function loadQuote(currency, date) {
  const cache = loadFxCache(localStorage);
  const quote = await fetchMyrRate({
    currency,
    date,
    today: todayYMD(),
    cache,
    online: navigator.onLine
  });
  saveFxCache(localStorage, cache);
  return quote;
}

function syncStatementLine(block, currency, override) {
  const line = block.querySelector('[data-fx-toggle]');
  if (!line) return;
  line.hidden = currency === 'MYR' && !override;
}

async function updateFxHint(block) {
  const token = (block._fxToken || 0) + 1;
  block._fxToken = token;
  const form = block.closest('form');
  const hint = block.querySelector('[data-fx-hint]');
  if (!form || !hint) return;
  const names = moneyNames(block.dataset.prefix || '');
  const original = parseMoney(fieldValue(form, names.amount));
  const currency = (fieldValue(form, names.currency) || 'MYR').toUpperCase();
  const overrideOn = fieldChecked(form, names.override);
  syncStatementLine(block, currency, overrideOn);
  const dateName = block.dataset.dateField || 'date';
  const date = block.dataset.historical === 'true' ? fieldValue(form, dateName) : todayYMD();
  const showCap = (price) => {
    block._rm = price;
    refreshMoneyNotes(form);
  };
  if (original == null || original <= 0) {
    showMoney(hint, '');
    block._quote = null;
    showCap(null);
    return;
  }
  const override = fieldChecked(form, names.override);
  const manual = parseMoney(fieldValue(form, names.rm));
  if (currency === 'MYR') {
    showMoney(hint, '');
    block._quote = { currency: 'MYR', rate: 1, fxDate: date, cached: false, historical: true, requestedDate: date };
    showCap(override && manual != null ? manual : original);
    return;
  }
  showMoney(hint, 'Checking the rate…');
  try {
    const quote = await loadQuote(currency, date);
    if (block._fxToken !== token || !block.isConnected) return;
    block._quote = { ...quote, requestedDate: date };
    showMoney(hint, conversionText({
      amount: original,
      currency,
      rate: quote.rate,
      cached: quote.cached,
      historical: quote.historical
    }));
    showCap(override && manual != null ? manual : moneyToMyr(original, quote.rate));
  } catch {
    if (block._fxToken !== token || !block.isConnected) return;
    block._quote = null;
    showMoney(hint, 'Rate unavailable. Enter the statement amount in RM.');
    showCap(override && manual != null ? manual : null);
  }
}

function describeCap(price, date, excludeId) {
  if (price == null || !isYMD(date)) return '';
  return describePayments([{ price, date }], excludeId);
}

function describePayments(payments, excludeId) {
  if (!payments.length) return '';
  const loaded = currentData();
  if (loaded.corrupt) return '';
  const rest = loaded.data.purchases.filter((item) => item.id !== excludeId);
  const notes = [];
  for (const ym of [...new Set(payments.map((payment) => payment.date.slice(0, 7)))]) {
    const after = monthSnapshot(loaded.data.settings, rest.concat(payments), ym);
    if (after.left < 0) notes.push(`${formatMonth(ym)} would be ${formatRM(after.over)} over the cap. You can still save it.`);
    else if (after.usedUp) notes.push(`${formatMonth(ym)} would use the whole cap. You can still save it.`);
  }
  return notes.join(' ');
}

function refreshMoneyNotes(form) {
  const slot = form.querySelector('[data-cap-note]');
  const due = form.querySelector('[data-balance-due]');
  const preorder = fieldValue(form, 'boughtAs') === 'preorder';
  if (!preorder) {
    const block = form.querySelector('[data-standard] [data-money]');
    const price = block?._rm ?? null;
    const date = fieldValue(form, 'date');
    showMoney(slot, describeCap(price, date, form.dataset.id || ''));
    return;
  }
  const est = form.querySelector('[data-prefix="est"]')?._rm ?? null;
  const deposit = form.querySelector('[data-prefix="deposit"]')?._rm ?? null;
  if (due) {
    showMoney(due, est == null || deposit == null
      ? ''
      : `Balance due ${formatRM(settlePreorder(est, deposit, null).balanceDueRm)}`);
  }
  const payments = [];
  const depositDate = fieldValue(form, 'date');
  if (deposit != null && isYMD(depositDate)) payments.push({ price: deposit, date: depositDate });
  const pay = form.querySelector('[data-pay-box]');
  if (pay && !pay.hidden) {
    const balance = form.querySelector('[data-prefix="balance"]')?._rm ?? null;
    const balanceDate = fieldValue(form, 'balanceDate');
    if (balance != null && isYMD(balanceDate)) payments.push({ price: balance, date: balanceDate });
  }
  showMoney(slot, describePayments(payments, form.dataset.id || ''));
}

function matchingQuote(block, currency, date) {
  const quote = block._quote;
  if (!quote || quote.currency !== currency || (quote.requestedDate || '') !== (date || '')) return null;
  return quote;
}

async function resolveMoney(block) {
  const form = block.closest('form');
  const names = moneyNames(block.dataset.prefix || '');
  const original = parseMoney(fieldValue(form, names.amount));
  const currency = (fieldValue(form, names.currency) || 'MYR').toUpperCase();
  const override = fieldChecked(form, names.override);
  const manual = parseMoney(fieldValue(form, names.rm));
  const dateName = block.dataset.dateField || 'date';
  const date = block.dataset.historical === 'true' ? fieldValue(form, dateName) : todayYMD();
  if (original == null || original <= 0) return { error: 'Enter an amount above 0.' };
  if (original > MAX_FOREIGN) return { error: 'Enter a smaller amount.' };
  if (override) {
    if (manual == null || manual <= 0) return { error: 'Enter the statement amount in RM.' };
    if (manual > MAX_MONEY) return { error: `Enter a statement amount of ${formatRM(MAX_MONEY)} or less.` };
    let quote = currency === 'MYR'
      ? { rate: 1, fxDate: date, cached: false }
      : matchingQuote(block, currency, date);
    if (!quote && currency !== 'MYR') {
      try { quote = await loadQuote(currency, date); } catch { quote = null; }
    }
    return {
      originalAmount: original,
      currency,
      fxRate: quote ? quote.rate : null,
      fxDate: quote?.fxDate || (currency === 'MYR' && isYMD(date) ? date : ''),
      fxCached: Boolean(quote?.cached),
      fxOverridden: true,
      price: manual
    };
  }
  if (currency === 'MYR') {
    if (original > MAX_MONEY) return { error: `Enter a price of ${formatRM(MAX_MONEY)} or less.` };
    return {
      originalAmount: original,
      currency: 'MYR',
      fxRate: 1,
      fxDate: isYMD(date) ? date : todayYMD(),
      fxCached: false,
      fxOverridden: false,
      price: original
    };
  }
  let quote = matchingQuote(block, currency, date);
  if (!quote) {
    try {
      quote = await loadQuote(currency, date);
      block._quote = { ...quote, requestedDate: date };
    } catch {
      return { error: 'No exchange rate for that currency. Enter the statement amount in RM, or try again when you are online.' };
    }
  }
  const price = moneyToMyr(original, quote.rate);
  if (price == null || price <= 0) return { error: 'Could not convert that amount.' };
  if (price > MAX_MONEY) return { error: `The RM amount is above ${formatRM(MAX_MONEY)}.` };
  return {
    originalAmount: original,
    currency,
    fxRate: quote.rate,
    fxDate: quote.fxDate,
    fxCached: Boolean(quote.cached),
    fxOverridden: false,
    price
  };
}

function readPurchaseDetails(form) {
  const name = fieldValue(form, 'name').trim();
  const date = fieldValue(form, 'date');
  const boughtAs = fieldValue(form, 'boughtAs');
  const figureType = fieldValue(form, 'figureType');
  const condition = fieldValue(form, 'condition');
  const notes = fieldValue(form, 'notes').trim();
  if (!name) return { error: 'Enter a figure name.' };
  if (name.length > 80) return { error: 'Use a shorter name.' };
  if (!isYMD(date)) return { error: 'Choose a valid date.' };
  if (!['purchased', 'preorder'].includes(boughtAs)) return { error: 'Choose an order type.' };
  if (notes.length > 280) return { error: 'Use a shorter note.' };
  const loaded = currentData();
  const categories = loaded.corrupt ? [] : (loaded.data.settings.categories || []);
  const conditions = PURCHASE_CONDITIONS.map((item) => item.value);
  return {
    detail: {
      name,
      date,
      series: fieldValue(form, 'series').trim().slice(0, 80),
      brand: fieldValue(form, 'brand').trim().slice(0, 80),
      shop: fieldValue(form, 'shop').trim().slice(0, 80),
      figureType: normalizeFigureType(figureType, categories),
      boughtAs,
      condition: conditions.includes(condition) ? condition : '',
      notes
    }
  };
}

async function savePurchase(form, id) {
  clearFormError(form);
  const details = readPurchaseDetails(form);
  if (details.error) {
    showFormError(form, details.error);
    return;
  }
  const preorder = details.detail.boughtAs === 'preorder';
  let money;
  let extra = emptyPreorder();
  if (!preorder) {
    money = await resolveMoney(form.querySelector('[data-standard] [data-money]'));
    if (!form.isConnected) return;
    if (money.error) {
      showFormError(form, money.error);
      return;
    }
  } else {
    const est = await resolveMoney(form.querySelector('[data-prefix="est"]'));
    if (!form.isConnected) return;
    if (est.error) {
      showFormError(form, est.error);
      return;
    }
    const deposit = await resolveMoney(form.querySelector('[data-prefix="deposit"]'));
    if (!form.isConnected) return;
    if (deposit.error) {
      showFormError(form, deposit.error);
      return;
    }
    let balance = null;
    let balanceDate = '';
    const pay = form.querySelector('[data-pay-box]');
    if (pay && !pay.hidden) {
      balanceDate = fieldValue(form, 'balanceDate');
      if (!isYMD(balanceDate)) {
        showFormError(form, 'Choose the date you paid the balance.');
        return;
      }
      balance = await resolveMoney(form.querySelector('[data-prefix="balance"]'));
      if (!form.isConnected) return;
      if (balance.error) {
        showFormError(form, balance.error);
        return;
      }
    }
    const settled = settlePreorder(est.price, deposit.price, balance ? balance.price : null);
    money = {
      originalAmount: est.originalAmount,
      currency: est.currency,
      fxRate: est.fxRate,
      fxDate: est.fxDate,
      fxOverridden: est.fxOverridden,
      fxCached: est.fxCached,
      price: settled.finalTotalRm ?? est.price
    };
    extra = {
      estFullOriginalAmount: est.originalAmount,
      estFullCurrency: est.currency,
      estFullFxRate: est.fxRate,
      estFullFxDate: est.fxDate,
      estFullPrice: est.price,
      estFullFxOverridden: est.fxOverridden,
      estFullFxCached: est.fxCached,
      depositOriginalAmount: deposit.originalAmount,
      depositCurrency: deposit.currency,
      depositFxRate: deposit.fxRate,
      depositFxDate: deposit.fxDate,
      depositAmountRm: deposit.price,
      depositFxOverridden: deposit.fxOverridden,
      depositFxCached: deposit.fxCached,
      depositDate: details.detail.date,
      balanceDueRm: settled.balanceDueRm,
      balancePaidOriginalAmount: balance ? balance.originalAmount : null,
      balancePaidCurrency: balance ? balance.currency : '',
      balancePaidFxRate: balance ? balance.fxRate : null,
      balancePaidFxDate: balance ? balance.fxDate : '',
      balancePaidRm: balance ? balance.price : null,
      balancePaidFxOverridden: balance ? balance.fxOverridden : false,
      balancePaidFxCached: balance ? balance.fxCached : false,
      balancePaidDate: balance ? balanceDate : '',
      finalTotalRm: settled.finalTotalRm,
      preorderStatus: settled.preorderStatus
    };
  }
  const loaded = currentData();
  if (loaded.corrupt) return;
  const data = loaded.data;
  const existing = id ? data.purchases.find((item) => item.id === id) : null;
  if (id && !existing) {
    showFormError(form, 'That purchase is no longer in the log.');
    return;
  }
  const purchase = {
    id: existing?.id || uid(),
    ...details.detail,
    ...money,
    ...extra,
    status: derivedPurchaseStatus(details.detail.boughtAs, extra.preorderStatus),
    createdAt: existing?.createdAt || now().toISOString(),
    updatedAt: now().toISOString()
  };
  if (existing) {
    const index = data.purchases.findIndex((item) => item.id === id);
    data.purchases[index] = purchase;
  } else data.purchases.push(purchase);
  if (!persist(data)) return;
  enqueueUpsert('Purchases', purchaseRow(purchase));
  kickSync(syncSource);
  showToast(existing ? 'Purchase updated.' : `Logged ${purchase.name}.`);
  go(existing ? '#entries' : '#home');
}

async function addWish(form) {
  clearFormError(form);
  const name = fieldValue(form, 'name').trim();
  const priorityValue = fieldValue(form, 'priority');
  const priority = ['must', 'really', 'nice'].includes(priorityValue) ? priorityValue : 'really';
  if (!name) {
    showFormError(form, 'Enter a figure name.');
    return;
  }
  const money = await resolveMoney(form.querySelector('[data-money]'));
  if (!form.isConnected) return;
  if (money.error) {
    showFormError(form, money.error);
    return;
  }
  const loaded = currentData();
  if (loaded.corrupt) return;
  const item = {
    id: uid(),
    name: name.slice(0, 80),
    ...money,
    priority,
    addedAt: now().toISOString(),
    updatedAt: now().toISOString()
  };
  loaded.data.wishlist.push(item);
  if (!persist(loaded.data)) return;
  enqueueUpsert('Wishlist', wishRow(item));
  kickSync(syncSource);
  showToast(`Added ${item.name}.`);
  render();
}

async function saveSale(form, id) {
  clearFormError(form);
  const name = fieldValue(form, 'name').trim();
  const condition = fieldValue(form, 'condition');
  const status = fieldValue(form, 'status') === 'sold' ? 'sold' : 'listed';
  const notes = fieldValue(form, 'notes').trim();
  if (!name) {
    showFormError(form, 'Enter a figure name.');
    return;
  }
  if (!SALE_CONDITIONS.some((item) => item.value === condition)) {
    showFormError(form, 'Choose a condition.');
    return;
  }
  if (notes.length > 280) {
    showFormError(form, 'Use a shorter note.');
    return;
  }
  const asking = await resolveMoney(form.querySelector('[data-money]:not([data-prefix="sold"])'));
  if (!form.isConnected) return;
  if (asking.error) {
    showFormError(form, asking.error);
    return;
  }
  let sold = null;
  let soldDate = '';
  if (status === 'sold') {
    soldDate = fieldValue(form, 'soldDate');
    if (!isYMD(soldDate)) {
      showFormError(form, 'Choose the date it sold.');
      return;
    }
    sold = await resolveMoney(form.querySelector('[data-money][data-prefix="sold"]'));
    if (!form.isConnected) return;
    if (sold.error) {
      showFormError(form, sold.error);
      return;
    }
  }
  const loaded = currentData();
  if (loaded.corrupt) return;
  const existing = id ? loaded.data.forSale.find((item) => item.id === id) : null;
  if (id && !existing) {
    showFormError(form, 'That listing is no longer here.');
    return;
  }
  const item = {
    id: existing?.id || uid(),
    name: name.slice(0, 80),
    brand: fieldValue(form, 'brand').trim().slice(0, 80),
    series: fieldValue(form, 'series').trim().slice(0, 80),
    condition,
    ...asking,
    notes,
    status,
    soldOriginalAmount: sold ? sold.originalAmount : null,
    soldCurrency: sold ? sold.currency : '',
    soldFxRate: sold ? sold.fxRate : null,
    soldFxDate: sold ? sold.fxDate : '',
    soldFxOverridden: sold ? sold.fxOverridden : false,
    soldFxCached: sold ? sold.fxCached : false,
    soldPrice: sold ? sold.price : null,
    soldDate: sold ? soldDate : '',
    createdAt: existing?.createdAt || now().toISOString(),
    updatedAt: now().toISOString()
  };
  if (existing) {
    const index = loaded.data.forSale.findIndex((sale) => sale.id === id);
    loaded.data.forSale[index] = item;
  } else loaded.data.forSale.push(item);
  if (!persist(loaded.data)) return;
  enqueueUpsert('For Sale', saleRow(item));
  kickSync(syncSource);
  showToast(existing ? 'Listing updated.' : `Listed ${item.name}.`);
  go('#sell');
}

function savePriceCheck(form) {
  clearFormError(form);
  const loaded = currentData();
  if (loaded.corrupt) return;
  const item = loaded.data.forSale.find((sale) => sale.id === form.dataset.saleId);
  if (!item) {
    showFormError(form, 'That listing is no longer here.');
    return;
  }
  const amounts = {};
  for (const name of ['low', 'typical', 'high']) {
    const raw = fieldValue(form, name).trim();
    if (!raw) {
      amounts[name] = '';
      continue;
    }
    const parsed = parseMoney(raw);
    if (parsed == null || parsed <= 0) {
      showFormError(form, 'Enter prices in ringgit.');
      return;
    }
    if (parsed > MAX_MONEY) {
      showFormError(form, `Enter a price of ${formatRM(MAX_MONEY)} or less.`);
      return;
    }
    amounts[name] = parsed;
  }
  if (amounts.low === '' && amounts.typical === '' && amounts.high === '') {
    showFormError(form, 'Enter a low, typical, or high price.');
    return;
  }
  const rrp = fieldValue(form, 'rrp').trim().slice(0, 80);
  const source = fieldValue(form, 'source').trim().slice(0, 80) || 'Carousell';
  const row = priceCheckRow({
    for_sale_id: item.id,
    figure: item.name,
    condition: item.condition,
    rrp,
    rrp_source: rrp ? source : '',
    low_rm: amounts.low,
    typical_rm: amounts.typical,
    high_rm: amounts.high,
    listing_count: '',
    sample_links: '',
    sources: source,
    checked_at: todayStamp()
  });
  rememberLocalCheck(row);
  enqueueAppendCheck(row);
  kickSync(syncSource);
  showToast('Price check saved.');
  render();
}

async function saveSettings(form) {
  clearFormError(form);
  const cap = parseMoney(fieldValue(form, 'cap'));
  const syncText = fieldValue(form, 'syncUrl').trim();
  if (cap == null || cap < 0) {
    showFormError(form, 'Enter a cap of RM 0.00 or more.');
    return;
  }
  if (cap > MAX_MONEY) {
    showFormError(form, `Enter a cap of ${formatRM(MAX_MONEY)} or less.`);
    return;
  }
  if (syncText && !isConfiguredUrl(syncText)) {
    showFormError(form, 'Enter a web app URL starting with https://, or leave it blank.');
    return;
  }
  const loaded = currentData();
  if (loaded.corrupt) return;
  const previous = loaded.data.settings.syncUrl;
  loaded.data.settings.monthlyCap = cap;
  loaded.data.settings.rollover = fieldChecked(form, 'rollover');
  loaded.data.settings.overspendPayback = fieldChecked(form, 'payback');
  loaded.data.settings.syncUrl = syncText;
  if (!persist(loaded.data)) return;
  if (resolveSyncUrl(loaded.data.settings) && syncText !== previous) {
    const result = await syncAllNow(loaded.data);
    if (!form.isConnected && result) {
      showToast(result.ok ? 'Settings saved.' : 'Settings saved. The sheet will retry.');
      return;
    }
    showToast(result.ok ? 'Settings saved.' : 'Settings saved. The sheet did not update yet.');
  } else showToast('Settings saved.');
  render();
}

function updateSettingsPreview(form) {
  const slot = document.getElementById('settings-preview');
  if (!slot) return;
  const cap = parseMoney(fieldValue(form, 'cap'));
  if (cap == null || cap < 0 || cap > MAX_MONEY) {
    showMoney(slot, 'Enter a cap of RM 0.00 or more.');
    return;
  }
  const loaded = currentData();
  if (loaded.corrupt) return;
  showMoney(slot, settingsPreview({
    ...loaded.data.settings,
    monthlyCap: cap,
    rollover: fieldChecked(form, 'rollover'),
    overspendPayback: fieldChecked(form, 'payback')
  }, loaded.data.purchases));
}

function removeWish(id) {
  const loaded = currentData();
  if (loaded.corrupt) return;
  const item = loaded.data.wishlist.find((entry) => entry.id === id);
  if (!item) return;
  loaded.data.wishlist = loaded.data.wishlist.filter((entry) => entry.id !== id);
  planIds.delete(id);
  if (!persist(loaded.data)) return;
  enqueueDelete('Wishlist', id);
  kickSync(syncSource);
  undoItem = item;
  showToast(`Removed ${item.name}.`, 'Undo', () => {
    const itemToRestore = undoItem;
    undoItem = null;
    if (!itemToRestore) return;
    const latest = currentData();
    if (latest.corrupt) return;
    if (!latest.data.wishlist.some((entry) => entry.id === itemToRestore.id)) {
      latest.data.wishlist.push(itemToRestore);
      if (!persist(latest.data)) return;
      enqueueUpsert('Wishlist', wishRow(itemToRestore));
      kickSync(syncSource);
    }
    render();
  });
  render();
}

function askLogWish(id) {
  const loaded = currentData();
  if (loaded.corrupt) return;
  const item = loaded.data.wishlist.find((entry) => entry.id === id);
  if (!item) return;
  const today = todayYMD();
  const room = homeModel(loaded.data, now()).month.room;
  const fit = fitFor(item.price, room);
  const warning = fit.fits ? '' : `<p class="form-error">${withAmounts(`This would go past what's left by ${formatRM(fit.short)}.`)}</p>`;
  const foreign = foreignNote(item);
  openDialog(`
    <h2 id="dialog-title">${fit.fits ? 'Log this figure?' : 'This goes past the cap'}</h2>
    <p><strong>${esc(item.name)}</strong></p>
    <p>${withAmounts(`${formatRM(item.price)} · ${formatFullDay(today)} · Purchased`)}</p>
    ${foreign ? `<p class="meta">${esc(foreign)}</p>` : ''}
    ${warning}
    <p class="meta">You can change the date and details later in the log.</p>
    <div class="btn-row">
      <button class="btn btn-primary" type="button" data-action="confirm-log" data-id="${esc(item.id)}">${fit.fits ? 'Log purchase' : 'Log it anyway'}</button>
      <button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button>
    </div>
  `);
}

function confirmLogWish(id) {
  const loaded = currentData();
  if (loaded.corrupt) return;
  const item = loaded.data.wishlist.find((entry) => entry.id === id);
  if (!item) {
    closeDialog();
    return;
  }
  const purchase = {
    id: uid(),
    name: item.name,
    series: '',
    brand: '',
    figureType: '',
    boughtAs: 'purchased',
    condition: '',
    originalAmount: item.originalAmount,
    currency: item.currency,
    fxRate: item.fxRate,
    fxDate: item.fxDate,
    fxOverridden: item.fxOverridden,
    fxCached: item.fxCached,
    price: item.price,
    date: todayYMD(),
    shop: '',
    status: 'received',
    notes: '',
    ...emptyPreorder(),
    createdAt: now().toISOString(),
    updatedAt: now().toISOString()
  };
  loaded.data.purchases.push(purchase);
  loaded.data.wishlist = loaded.data.wishlist.filter((entry) => entry.id !== id);
  planIds.delete(id);
  if (undoItem && undoItem.id === id) undoItem = null;
  if (!persist(loaded.data)) return;
  enqueueDelete('Wishlist', id);
  enqueueUpsert('Purchases', purchaseRow(purchase));
  kickSync(syncSource);
  closeDialog();
  showToast(`Logged ${item.name}.`);
  go('#home');
}

function askDelete(id) {
  const loaded = currentData();
  if (loaded.corrupt) return;
  const purchase = loaded.data.purchases.find((item) => item.id === id);
  if (!purchase) return;
  openDialog(`
    <h2 id="dialog-title">Delete this purchase?</h2>
    <p><strong>${esc(purchase.name)}</strong> · ${withAmounts(`${formatRM(purchase.price)} will leave the log.`)} This month's totals will update.</p>
    <div class="btn-row">
      <button class="btn btn-primary" type="button" data-action="confirm-delete" data-id="${esc(id)}">Delete</button>
      <button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button>
    </div>
  `);
}

function confirmDelete(id) {
  const loaded = currentData();
  if (loaded.corrupt) return;
  loaded.data.purchases = loaded.data.purchases.filter((item) => item.id !== id);
  if (!persist(loaded.data)) return;
  enqueueDelete('Purchases', id);
  kickSync(syncSource);
  closeDialog();
  showToast('Purchase deleted.');
  go('#entries');
}

function askDeleteSale(id) {
  const loaded = currentData();
  if (loaded.corrupt) return;
  const item = loaded.data.forSale.find((sale) => sale.id === id);
  if (!item) return;
  openDialog(`
    <h2 id="dialog-title">Delete this listing?</h2>
    <p><strong>${esc(item.name)}</strong> will leave Sell. A later sync removes it from the sheet.</p>
    <div class="btn-row">
      <button class="btn btn-primary" type="button" data-action="confirm-delete-sale" data-id="${esc(id)}">Delete</button>
      <button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button>
    </div>
  `);
}

function confirmDeleteSale(id) {
  const loaded = currentData();
  if (loaded.corrupt) return;
  loaded.data.forSale = loaded.data.forSale.filter((item) => item.id !== id);
  if (!persist(loaded.data)) return;
  enqueueDelete('For Sale', id);
  kickSync(syncSource);
  closeDialog();
  showToast('Listing deleted.');
  go('#sell');
}

async function onSyncAll() {
  const loaded = currentData();
  if (loaded.corrupt) return;
  if (!resolveSyncUrl(loaded.data.settings)) {
    showToast('Sync is off until a web app URL is set.');
    return;
  }
  const result = await syncAllNow(loaded.data);
  if (result.ok) {
    showToast('Synced.');
    fillCheckSlots();
  } else if (result.reason === 'offline') showToast('You are offline. The sheet will update when you are back.');
  else showToast('Not synced · will retry');
}

function exportJson() {
  const loaded = currentData();
  if (loaded.corrupt) {
    showToast('Unreadable data cannot be exported.');
    return;
  }
  const payload = exportPayload(loaded.data, now().toISOString());
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `figure-cap-${todayYMD()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function stageImport(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(String(reader.result));
    } catch {
      showToast('That file is not valid JSON.');
      return;
    }
    if (!looksLikeData(parsed)) {
      showToast('That file is not a Figure Cap backup.');
      return;
    }
    pendingImport = parsed;
    openDialog(`
      <h2 id="dialog-title">Replace data on this device?</h2>
      <p>This replaces purchases, the wishlist, listings, and settings with the file.</p>
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-action="confirm-import">Replace</button>
        <button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button>
      </div>
    `);
  };
  reader.onerror = () => showToast('That file could not be read.');
  reader.readAsText(file);
}

async function confirmImport() {
  if (!pendingImport) {
    closeDialog();
    return;
  }
  const data = normalizeData(pendingImport, currentMonth());
  pendingImport = null;
  planIds.clear();
  undoItem = null;
  clearQueue();
  if (!persist(data)) return;
  closeDialog();
  if (resolveSyncUrl(data.settings)) {
    const result = await syncAllNow(data);
    showToast(result.ok ? 'Backup imported.' : 'Backup imported. The sheet will retry.');
  } else showToast('Backup imported.');
  go('#home');
}

function resetCorrupt() {
  try {
    clear();
  } catch {
    showToast('Could not erase the stored data.');
    return;
  }
  planIds.clear();
  undoItem = null;
  showToast('Stored data was erased.');
  go('#home');
}

function queueCheckRefresh() {
  const loaded = currentData();
  if (loaded.corrupt || !resolveSyncUrl(loaded.data.settings)) return;
  pullPriceChecks(loaded.data.settings).then(() => {
    if (!location.hash.startsWith('#sell') && !location.hash.startsWith('#edit-sale')) return;
    fillCheckSlots();
  }).catch(() => {});
}

function fillCheckSlots() {
  const loaded = currentData();
  if (loaded.corrupt) return;
  const checks = cachedPriceChecks();
  document.querySelectorAll('[data-check-for]').forEach((slot) => {
    const item = loaded.data.forSale.find((sale) => sale.id === slot.dataset.checkFor);
    if (item) slot.innerHTML = priceCheckLine(item, checks);
  });
}

function showMoney(el, text) {
  if (!el) return;
  el.innerHTML = withAmounts(text || '');
}

function formErrorSlot(form) {
  return form.querySelector(':scope > .form-error');
}

function showFormError(form, message) {
  const slot = formErrorSlot(form);
  if (!slot) return;
  slot.hidden = false;
  showMoney(slot, message);
}

function clearFormError(form) {
  const slot = formErrorSlot(form);
  if (!slot) return;
  slot.hidden = true;
  slot.textContent = '';
}

function openDialog(html) {
  const dialog = document.getElementById('dialog');
  dialog.innerHTML = html;
  if (!dialog.open) dialog.showModal();
}

function closeDialog() {
  const dialog = document.getElementById('dialog');
  pendingImport = null;
  if (dialog.open) dialog.close();
  dialog.innerHTML = '';
}

function showToast(message, actionLabel, onAction) {
  const toast = document.getElementById('toast');
  toast.hidden = false;
  toast.replaceChildren();
  const text = document.createElement('p');
  text.textContent = message;
  toast.append(text);
  pendingToastAction = onAction || null;
  if (actionLabel && onAction) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn toast-btn';
    button.dataset.action = 'toast-action';
    button.textContent = actionLabel;
    toast.append(button);
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideToast(), actionLabel ? 4000 : 1500);
}

function hideToast() {
  const toast = document.getElementById('toast');
  toast.hidden = true;
  toast.replaceChildren();
  pendingToastAction = null;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}
