// Screens for Figure Cap. Money maths stay in budget.js. Rates stay in fx.js.

import {
  CAP_USED_MESSAGE,
  PRIORITY_OPTIONS,
  barWidth,
  fitFor,
  historyModel,
  homeModel,
  monthSnapshot,
  percentLabel,
  planModel,
  statusLine,
  wishlistModel
} from './budget.js';
import {
  BOUGHT_AS_OPTIONS,
  FIGURE_TYPES,
  PURCHASE_CONDITIONS,
  PURCHASE_STATUSES,
  SALE_CONDITIONS,
  SALE_STATUSES,
  boughtAsLabel,
  categoryTotals,
  distinctValues,
  figureAmount,
  figureTypeLabel,
  filterPurchases,
  latestPriceCheck,
  preorderStatusLabel,
  priceCheckAmount,
  purchaseStatusLabel,
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
import { formatRM, parseMoney } from './money.js';
import {
  MAX_FOREIGN,
  MAX_MONEY,
  clear,
  emptyPreorder,
  exportPayload,
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
  enqueueDelete,
  enqueueUpsert,
  isConfiguredUrl,
  kickSync,
  pullPriceChecks,
  purchaseRow,
  resolveSyncUrl,
  saleRow,
  subscribe,
  syncAllNow,
  syncStatusLabel,
  wishRow
} from './sync.js';
import {
  currentMonth,
  formatDay,
  formatFullDay,
  formatMonth,
  formatMonthShort,
  formatToday,
  isYMD,
  now,
  todayYMD
} from './time.js';

const ARROW = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const BACK = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TONES = ['yellow', 'mint', 'lilac', 'coral', 'sky'];
const MONTHS = [
  ['01', 'Jan'], ['02', 'Feb'], ['03', 'Mar'], ['04', 'Apr'],
  ['05', 'May'], ['06', 'Jun'], ['07', 'Jul'], ['08', 'Aug'],
  ['09', 'Sep'], ['10', 'Oct'], ['11', 'Nov'], ['12', 'Dec']
];

const planIds = new Set();
const filters = { year: '', month: '', brand: '', series: '', q: '' };
let undoItem = null;
let toastTimer = 0;
let pendingToastAction = null;
let pendingImport = null;
let lastRouteKey = '';
let saving = false;

export function start() {
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  window.addEventListener('hashchange', () => render());
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
  const routeKey = `${route.name}:${route.id || ''}`;
  const routeChanged = routeKey !== lastRouteKey;
  lastRouteKey = routeKey;

  const today = todayYMD();
  document.getElementById('today-line').textContent = formatToday(now());
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

  if (routeChanged) window.scrollTo(0, 0);
}

function parseRoute() {
  const hash = location.hash.replace(/^#/, '');
  if (hash === 'history') return { name: 'entries', id: null, redirect: '#entries' };
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
  if (route.name === 'entries') return logPage(data, 'entries', today);
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
  const wish = wishlistModel(data, now());
  const topWish = wish.items[0];
  const balances = model.balances;
  return `
    <section class="stack">
      <div class="lede">
        <h2 id="month-title">${esc(formatMonth(model.ym))}</h2>
        <p class="hero" id="left-value"><span class="hero-currency">RM</span> <span class="hero-num">${esc(heroAmount(month.room))}</span> <span class="hero-cap">/ ${esc(heroAmount(month.cap))}</span></p>
        <p class="hero-caption" id="cap-line">${esc(caption)}</p>
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
      ${latest ? latestCard(latest) : `
        <article class="block yellow">
          <div class="card-head" data-edge>
            <div class="tags"><span class="tag">Collection</span></div>
            <a class="arrow" href="#log" aria-label="Log a purchase">${ARROW}</a>
          </div>
          <h3 data-edge>No figures yet</h3>
          <p class="meta" data-edge>The log is the collection. The bar above is what is left of this month's cap.</p>
        </article>`}
      ${balances.count ? `
        <article class="block lilac" id="balances-card">
          <div class="card-head" data-edge>
            <div class="tags"><span class="tag">Balances coming</span></div>
            <a class="arrow" href="#entries" aria-label="Open open pre-orders">${ARROW}</a>
          </div>
          <p class="block-value" data-edge>${formatRM(balances.total)}</p>
          <p class="meta" data-edge>${balances.count === 1 ? '1 open pre-order' : `${balances.count} open pre-orders`}</p>
        </article>` : ''}
      <article class="block mint">
        <div class="card-head" data-edge>
          <div class="tags"><span class="tag">${esc(model.year)}</span></div>
          <a class="arrow" href="#entries" aria-label="Open the log">${ARROW}</a>
        </div>
        <p class="kicker" data-edge>Year to date</p>
        <p class="block-value" id="ytd-value" data-edge>${formatRM(model.ytd)}</p>
        ${breakdownStats(model.breakdown)}
      </article>
      <article class="block sky">
        <div class="card-head" data-edge>
          <div class="tags">${topWish ? `<span class="tag">${esc(topWish.priorityLabel)}</span>` : ''}</div>
          <a class="arrow" href="#wish" aria-label="Open wishlist">${ARROW}</a>
        </div>
        <p class="kicker" data-edge>Wishlist</p>
        <p class="block-value" data-edge>${formatRM(wish.total)}</p>
        <p class="meta" data-edge>${topWish ? `${esc(topWish.name)} · ${esc(topWish.fitLabel)}` : (wish.count === 1 ? '1 figure' : `${wish.count} figures`)}</p>
      </article>
      ${data.settings.rollover && month.rollover > 0 ? `
        <article class="block coral">
          <div class="stats" data-edge>
            <div data-stat="0"><p class="spec-label">Cap</p><p class="stat-v">${formatRM(data.settings.monthlyCap)}</p></div>
            <div data-stat="1"><p class="spec-label">Rolled over</p><p class="stat-v">${formatRM(month.rollover)}</p></div>
          </div>
        </article>` : ''}
    </section>
  `;
}

function capCaption(month) {
  const paidBack = month.payback > 0 && month.paybackMonth;
  if (month.over > 0 && paidBack) {
    return `RM ${heroAmount(month.over)} over · from ${monthName(month.paybackMonth)}`;
  }
  if (month.over > 0) return `RM ${heroAmount(month.over)} over`;
  if (paidBack) {
    return `cap RM ${heroAmount(month.cap)} · RM ${heroAmount(month.payback)} from ${monthName(month.paybackMonth)}`;
  }
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

function latestCard(purchase) {
  const bits = [formatRM(figureAmount(purchase)), formatDay(purchase.date), purchase.series, purchase.shop].filter(Boolean);
  return `
    <article class="block yellow">
      <div class="card-head" data-edge>
        <div class="tags">
          ${purchase.figureType ? `<span class="tag">${esc(figureTypeLabel(purchase.figureType))}</span>` : ''}
          ${purchase.condition ? `<span class="tag">${esc(purchase.condition)}</span>` : ''}
        </div>
        <a class="arrow" href="#edit/${encodeURIComponent(purchase.id)}" aria-label="Open ${esc(purchase.name)}">${ARROW}</a>
      </div>
      <p class="kicker" data-edge>Latest purchase</p>
      <h3 data-edge>${esc(purchase.name)}</h3>
      <p class="meta" data-edge>${bits.map(esc).join(' · ')}</p>
    </article>
  `;
}

function breakdownStats(breakdown) {
  const cells = breakdown.types.map((row, index) => `
    <div data-stat="${index}">
      <p class="spec-label">${esc(figureTypeLabel(row.figureType))}</p>
      <p class="stat-v">${formatRM(row.total)}</p>
    </div>
  `);
  cells.push(`
    <div data-stat="${cells.length}">
      <p class="spec-label">Figures</p>
      <p class="stat-v">${breakdown.count}</p>
    </div>
  `);
  return `<div class="stats" data-edge>${cells.join('')}</div>`;
}

function logPage(data, mode, today) {
  return `
    <section>
      <h2>Log</h2>
      <div class="chips segment" role="tablist" aria-label="Log">
        <a class="chip" href="#log" role="tab" aria-selected="${mode === 'add'}">Add</a>
        <a class="chip" href="#entries" role="tab" aria-selected="${mode === 'entries'}">Entries</a>
      </div>
      ${mode === 'entries' ? entriesView(data) : purchaseForm(null, today)}
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
  return purchaseForm(purchase, today);
}

function purchaseForm(purchase, today) {
  const editing = Boolean(purchase);
  const value = purchase || {
    name: '', series: '', brand: '', figureType: '', boughtAs: 'new', condition: '',
    originalAmount: '', currency: 'MYR', fxOverridden: false, price: '',
    date: today, shop: '', status: 'received', notes: ''
  };
  const preorder = (value.boughtAs || 'new') === 'preorder';
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
        <div class="group">
          <div class="row">
            <p class="kicker" data-edge>Bought as</p>
            ${chips('boughtAs', BOUGHT_AS_OPTIONS, value.boughtAs || 'new')}
            <p class="meta" data-edge data-preorder-note ${preorder ? '' : 'hidden'}>The deposit counts in the month you pay it. The balance counts in the month you pay that.</p>
          </div>
        </div>
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
        <div class="group">
          <div class="row">
            <p class="kicker" data-edge>Status</p>
            ${chips('status', PURCHASE_STATUSES, value.status || 'received')}
          </div>
        </div>
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
            <label class="field" data-edge for="field-type">Type
              <select id="field-type" name="figureType">${selectOptions(FIGURE_TYPES, value.figureType || '')}</select>
            </label>
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

function entriesView(data) {
  const history = historyModel(data, now());
  const filtered = filterPurchases(data.purchases, filters).slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
  const totals = categoryTotals(filtered);
  const chart = history.charts.map((snapshot) => `
    <div class="chart-row">
      <div class="chart-top">
        <span>${esc(formatMonthShort(snapshot.ym))}</span>
        <span>${formatRM(snapshot.spent)}</span>
      </div>
      <div class="bar" data-state="${snapshot.state}" aria-hidden="true">
        <div class="bar-fill" data-empty="${barWidth(snapshot) === 0}" style="width:${barWidth(snapshot).toFixed(2)}%"></div>
      </div>
      <p class="meta">Cap ${formatRM(snapshot.cap)}${snapshot.payback > 0 ? ` · ${formatRM(snapshot.payback)} carried from last month` : ''} · ${esc(statusLine(snapshot))}</p>
    </div>
  `).join('');
  const groups = groupByMonth(filtered);
  const active = activeFilters();
  return `
    <div class="tools">
      <label class="search">
        <span class="sr">Search</span>
        <input id="field-search" type="search" placeholder="Search figures" value="${esc(filters.q)}" autocomplete="off">
      </label>
      <button class="btn btn-ghost filter-btn" type="button" data-action="open-filters">Filter${active.length ? ` <span class="badge">${active.length}</span>` : ''}</button>
    </div>
    ${active.length ? `<div class="chips" aria-label="Active filters">${active.map(([key, label]) => `
      <button type="button" data-filter="${esc(key)}" data-value="">${esc(label)} <span aria-hidden="true">×</span></button>
    `).join('')}</div>` : ''}
    <section class="panel" id="chart">
      <h3>Monthly spend</h3>
      <p class="meta">Every purchase, measured against that month's cap.${history.truncated ? ' Latest 8 months.' : ''}</p>
      ${chart || '<p class="empty">No purchases yet.</p>'}
    </section>
    <article class="block lilac" id="category-totals">
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
    ${groups.length ? groups.map(groupHtml).join('') : `<p class="empty">${data.purchases.length ? 'Nothing matches these filters.' : 'No purchases yet.'}</p>`}
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
    filters.series && ['series', filters.series]
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
    <button class="btn btn-ghost" type="button" data-action="close-dialog">Done</button>
  `);
}

function groupHtml(group, groupIndex) {
  const cents = group.purchases.reduce((sum, item) => sum + Math.round(Number(figureAmount(item) || 0) * 100), 0);
  return `
    <section class="month-group">
      <header class="item-top">
        <h3>${esc(formatMonth(group.ym))}</h3>
        <p>${formatRM(cents / 100)}</p>
      </header>
      ${group.purchases.map((purchase, index) => purchaseCard(purchase, groupIndex + index)).join('')}
    </section>
  `;
}

function purchaseCard(purchase, index) {
  const bits = [
    formatDay(purchase.date),
    boughtAsLabel(purchase.boughtAs),
    purchaseStatusLabel(purchase.status)
  ];
  if (purchase.brand) bits.push(purchase.brand);
  if (purchase.series) bits.push(purchase.series);
  const foreign = foreignNote(purchase);
  const preorder = preorderNote(purchase);
  const pay = purchase.boughtAs === 'preorder' && purchase.preorderStatus === 'deposit paid'
    ? `<a class="btn btn-primary" href="#edit/${encodeURIComponent(purchase.id)}">Pay balance</a>`
    : `<a class="btn btn-ghost" href="#edit/${encodeURIComponent(purchase.id)}">Edit</a>`;
  return `
    <article class="block ${TONES[index % TONES.length]}" data-id="${esc(purchase.id)}">
      <div class="card-head" data-edge>
        <div class="tags">
          ${purchase.figureType ? `<span class="tag">${esc(figureTypeLabel(purchase.figureType))}</span>` : ''}
          ${purchase.condition ? `<span class="tag">${esc(purchase.condition)}</span>` : ''}
          ${purchase.preorderStatus ? `<span class="tag">${esc(preorderStatusLabel(purchase.preorderStatus))}</span>` : ''}
        </div>
        <a class="arrow" href="#edit/${encodeURIComponent(purchase.id)}" aria-label="Edit ${esc(purchase.name)}">${ARROW}</a>
      </div>
      <h3 data-edge>${esc(purchase.name)}</h3>
      <p class="block-value" data-edge>${formatRM(figureAmount(purchase))}</p>
      <p class="meta" data-edge>${bits.map(esc).join(' · ')}</p>
      ${foreign ? `<p class="meta" data-edge>${esc(foreign)}</p>` : ''}
      ${preorder ? `<p class="meta" data-edge>${esc(preorder)}</p>` : ''}
      ${purchase.shop ? `<p class="meta" data-edge>${esc(purchase.shop)}</p>` : ''}
      ${purchase.notes ? `<p class="note" data-edge>${esc(purchase.notes)}</p>` : ''}
      <div class="btn-row">
        ${pay}
        <button class="btn btn-ghost" type="button" data-action="delete-purchase" data-id="${esc(purchase.id)}">Delete</button>
      </div>
    </article>
  `;
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
    <article class="block ${TONES[index % TONES.length]}" data-id="${esc(item.id)}">
      <div class="card-head" data-edge>
        <div class="tags"><span class="tag">${esc(item.priorityLabel)}</span></div>
      </div>
      <h3 data-edge>${esc(item.name)}</h3>
      <p class="block-value" data-edge>${formatRM(item.price)}</p>
      <p class="meta" data-edge>${esc(item.fitLabel)}</p>
      ${foreignNote(item) ? `<p class="meta" data-edge>${esc(foreignNote(item))}</p>` : ''}
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
        <span class="meta">${esc(item.priorityLabel)} · ${esc(item.fitLabel)}</span>
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
  return `
    <p class="meta">Left this month: ${formatRM(model.room)}${esc(overNote)}${esc(payNote)}</p>
    <p class="plan-headline">${plan.count === 0 ? 'Nothing picked' : `${formatRM(plan.total)} selected`}</p>
    <p id="plan-detail">${esc(detail)}</p>
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
    ${editing ? `<div class="check" data-check-for="${esc(item.id)}">${priceCheckInner(item, cachedPriceChecks())}</div>` : ''}
    ${editing ? `<button class="btn danger" type="button" data-action="delete-sale" data-id="${esc(item.id)}">Delete listing</button>` : ''}
  `;
}

function saleCard(item, index) {
  const foreign = foreignNote(item);
  const soldForeign = item.status === 'sold' ? foreignNote({
    currency: item.soldCurrency,
    originalAmount: item.soldOriginalAmount,
    fxOverridden: item.soldFxOverridden,
    fxCached: item.soldFxCached
  }) : '';
  return `
    <article class="block ${TONES[index % TONES.length]}" data-id="${esc(item.id)}">
      <div class="card-head" data-edge>
        <div class="tags"><span class="tag">${esc(item.condition)}</span><span class="tag">${esc(saleStatusLabel(item.status))}</span></div>
        <a class="arrow" href="#edit-sale/${encodeURIComponent(item.id)}" aria-label="Edit ${esc(item.name)}">${ARROW}</a>
      </div>
      <h3 data-edge>${esc(item.name)}</h3>
      <p class="block-value" data-edge>${formatRM(item.price)}</p>
      <p class="meta" data-edge>${[item.brand, item.series].filter(Boolean).map(esc).join(' · ') || 'Asking price'}</p>
      ${foreign ? `<p class="meta" data-edge>${esc(foreign)}</p>` : ''}
      ${item.status === 'sold' ? `<p class="meta" data-edge>Sold ${item.soldPrice != null ? formatRM(item.soldPrice) : ''}${item.soldDate ? ` · ${esc(formatDay(item.soldDate))}` : ''}${soldForeign ? ` · ${esc(soldForeign)}` : ''}</p>` : ''}
      ${item.notes ? `<p class="note" data-edge>${esc(item.notes)}</p>` : ''}
      <div class="check" data-check-for="${esc(item.id)}">${priceCheckInner(item, cachedPriceChecks())}</div>
      <div class="btn-row">
        <a class="btn btn-ghost" href="#edit-sale/${encodeURIComponent(item.id)}">Edit</a>
        <button class="btn btn-ghost" type="button" data-action="delete-sale" data-id="${esc(item.id)}">Delete</button>
      </div>
    </article>
  `;
}

function priceCheckInner(item, checks) {
  const check = latestPriceCheck(item, checks);
  if (!check) return '<p class="spec-label">Price check</p><p class="check-empty">No price check yet.</p>';
  const rrp = String(check.rrp || '').trim();
  const source = String(check.rrp_source || '').trim();
  const listings = check.listing_count === '' || check.listing_count == null ? '—' : String(check.listing_count);
  return `
    <p class="spec-label">Price check</p>
    <div class="spec-grid">
      <div><p class="spec-label">Low</p><p class="spec-value">${rmOrDash(check.low_rm)}</p></div>
      <div><p class="spec-label">Typical</p><p class="spec-value">${rmOrDash(check.typical_rm)}</p></div>
      <div><p class="spec-label">High</p><p class="spec-value">${rmOrDash(check.high_rm)}</p></div>
      <div><p class="spec-label">Listings</p><p class="spec-value">${esc(listings)}</p></div>
    </div>
    ${rrp ? `<p class="meta">RRP ${esc(rrp)}${source ? ` · ${esc(source)}` : ''}</p>` : ''}
    ${check.sources ? `<p class="meta">${esc(check.sources)}</p>` : ''}
    ${linkList(check.sample_links)}
    ${check.checked_at ? `<p class="meta">Checked ${esc(check.checked_at)}</p>` : ''}
  `;
}

function settingsView(data, corrupt) {
  const settings = data.settings;
  const preview = corrupt
    ? 'Saved data could not be read. Import a backup, or erase the unreadable copy.'
    : settingsPreview(settings, data.purchases);
  return `
    <section>
      <h2>Settings</h2>
      ${corrupt ? '<p class="banner" id="corrupt-note">Saved data on this device could not be read.</p>' : ''}
      <form class="panel" id="settings-form" novalidate>
        <label class="field" data-edge for="field-cap">Monthly cap (RM)
          <input id="field-cap" name="cap" inputmode="decimal" autocomplete="off" value="${esc(settings.monthlyCap.toFixed(2))}">
          <span class="meta">The limit for each calendar month, in Malaysia time. It starts at RM 400.00.</span>
        </label>
        <label class="checkline" data-edge>
          <input id="field-rollover" name="rollover" type="checkbox" ${settings.rollover ? 'checked' : ''}>
          <span>
            <span class="check-title">Unspent money rolls over</span>
            <span class="meta">Adds whatever you did not spend last month to this month's cap. Off by default.</span>
          </span>
        </label>
        <label class="checkline" data-edge>
          <input id="field-payback" name="payback" type="checkbox" ${settings.overspendPayback ? 'checked' : ''}>
          <span>
            <span class="check-title">Overspend comes out of next month</span>
            <span class="meta">If a month ends over the cap, that amount lowers the next month. The cap does not go below RM 0.00. On by default.</span>
          </span>
        </label>
        <label class="field" data-edge for="field-sync">Sheet sync URL
          <input id="field-sync" name="syncUrl" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/DEPLOYMENT_ID/exec" value="${esc(syncFieldValue(settings))}">
          <span class="meta">Leave blank to use the built-in sheet. A different web app URL replaces it. Rates come from the European Central Bank via Frankfurter, with a cached rate when you are offline.</span>
        </label>
        <p class="meta" id="settings-preview">${esc(preview)}</p>
        <p class="form-error" role="alert" hidden></p>
        <button class="btn btn-primary" type="submit">Save settings</button>
      </form>
      <button class="btn btn-ghost" id="sync-all" type="button" data-action="sync-all">Sync all now</button>
      <section class="panel">
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
      <label class="checkline">
        <input type="checkbox" name="${names.override}" data-fx-override ${override ? 'checked' : ''}>
        <span>
          <span class="check-title">Use statement amount</span>
          <span class="meta">The ringgit charged on your card. Totals use this instead of the estimate.</span>
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

function chips(name, options, selected) {
  return `<div class="chips" data-edge role="radiogroup" aria-label="${esc(name)}">${options.map((option) => `
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

function rmOrDash(value) {
  const amount = priceCheckAmount(value);
  return amount == null ? '—' : formatRM(amount);
}

function linkList(value) {
  const parts = String(value || '').split(/[\s,]+/).filter(Boolean);
  const links = parts.filter((part) => /^https?:\/\//i.test(part));
  if (!links.length) return value ? `<p class="meta">${esc(value)}</p>` : '';
  return `<ul class="links">${links.map((href) => `<li><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(href)}</a></li>`).join('')}</ul>`;
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
  if (action === 'open-filters') {
    const loaded = currentData();
    if (!loaded.corrupt) openFilters(loaded.data);
  }
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
  const status = form.elements.namedItem('status');
  if (status) {
    if (preorder && status.value === 'received') status.value = 'preordered';
    if (!preorder && status.value === 'preordered') status.value = 'received';
  }
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

async function updateFxHint(block) {
  const token = (block._fxToken || 0) + 1;
  block._fxToken = token;
  const form = block.closest('form');
  const hint = block.querySelector('[data-fx-hint]');
  if (!form || !hint) return;
  const names = moneyNames(block.dataset.prefix || '');
  const original = parseMoney(fieldValue(form, names.amount));
  const currency = (fieldValue(form, names.currency) || 'MYR').toUpperCase();
  const dateName = block.dataset.dateField || 'date';
  const date = block.dataset.historical === 'true' ? fieldValue(form, dateName) : todayYMD();
  const showCap = (price) => {
    block._rm = price;
    refreshMoneyNotes(form);
  };
  if (original == null || original <= 0) {
    hint.textContent = '';
    block._quote = null;
    showCap(null);
    return;
  }
  const override = fieldChecked(form, names.override);
  const manual = parseMoney(fieldValue(form, names.rm));
  if (currency === 'MYR') {
    hint.textContent = '';
    block._quote = { currency: 'MYR', rate: 1, fxDate: date, cached: false, historical: true, requestedDate: date };
    showCap(override && manual != null ? manual : original);
    return;
  }
  hint.textContent = 'Checking the rate…';
  try {
    const quote = await loadQuote(currency, date);
    if (block._fxToken !== token || !block.isConnected) return;
    block._quote = { ...quote, requestedDate: date };
    hint.textContent = conversionText({
      amount: original,
      currency,
      rate: quote.rate,
      cached: quote.cached,
      historical: quote.historical
    });
    showCap(override && manual != null ? manual : moneyToMyr(original, quote.rate));
  } catch {
    if (block._fxToken !== token || !block.isConnected) return;
    block._quote = null;
    hint.textContent = 'Rate unavailable. Enter the statement amount in RM.';
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
    if (slot) slot.textContent = describeCap(price, date, form.dataset.id || '');
    return;
  }
  const est = form.querySelector('[data-prefix="est"]')?._rm ?? null;
  const deposit = form.querySelector('[data-prefix="deposit"]')?._rm ?? null;
  if (due) {
    due.textContent = est == null || deposit == null
      ? ''
      : `Balance due ${formatRM(settlePreorder(est, deposit, null).balanceDueRm)}`;
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
  if (slot) slot.textContent = describePayments(payments, form.dataset.id || '');
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
  const status = fieldValue(form, 'status');
  const figureType = fieldValue(form, 'figureType');
  const condition = fieldValue(form, 'condition');
  const notes = fieldValue(form, 'notes').trim();
  if (!name) return { error: 'Enter a figure name.' };
  if (name.length > 80) return { error: 'Use a shorter name.' };
  if (!isYMD(date)) return { error: 'Choose a valid date.' };
  if (!['new', 'preorder', 'second-hand'].includes(boughtAs)) return { error: 'Choose how you bought it.' };
  if (!['preordered', 'received'].includes(status)) return { error: 'Choose a status.' };
  if (notes.length > 280) return { error: 'Use a shorter note.' };
  const types = FIGURE_TYPES.map((item) => item.value);
  const conditions = PURCHASE_CONDITIONS.map((item) => item.value);
  return {
    detail: {
      name,
      date,
      series: fieldValue(form, 'series').trim().slice(0, 80),
      brand: fieldValue(form, 'brand').trim().slice(0, 80),
      shop: fieldValue(form, 'shop').trim().slice(0, 80),
      figureType: types.includes(figureType) ? figureType : '',
      boughtAs,
      condition: conditions.includes(condition) ? condition : '',
      status,
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
    slot.textContent = 'Enter a cap of RM 0.00 or more.';
    return;
  }
  const loaded = currentData();
  if (loaded.corrupt) return;
  slot.textContent = settingsPreview({
    ...loaded.data.settings,
    monthlyCap: cap,
    rollover: fieldChecked(form, 'rollover'),
    overspendPayback: fieldChecked(form, 'payback')
  }, loaded.data.purchases);
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
  const warning = fit.fits ? '' : `<p class="form-error">This would go past what's left by ${formatRM(fit.short)}.</p>`;
  const foreign = foreignNote(item);
  openDialog(`
    <h2 id="dialog-title">${fit.fits ? 'Log this figure?' : 'This goes past the cap'}</h2>
    <p><strong>${esc(item.name)}</strong></p>
    <p>${formatRM(item.price)} · ${esc(formatFullDay(today))} · New</p>
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
    boughtAs: 'new',
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
    <p><strong>${esc(purchase.name)}</strong> · ${formatRM(purchase.price)} will leave the log. This month's totals will update.</p>
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
    if (item) slot.innerHTML = priceCheckInner(item, checks);
  });
}

function showFormError(form, message) {
  const slot = form.querySelector('.form-error');
  if (!slot) return;
  slot.hidden = false;
  slot.textContent = message;
}

function clearFormError(form) {
  const slot = form.querySelector('.form-error');
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
