// Sheet sync. The page keeps localStorage as the copy it edits.
// Posts use text/plain so the Apps Script web app does not require a CORS preflight.
// The deployed web app is the default, so a new phone syncs without pasting a URL.

import { priorityLabel } from './budget.js';
import { boughtAsLabel, figureTypeLabel, purchaseStatusLabel, saleStatusLabel } from './catalog.js';

export const DEFAULT_SYNC_URL = 'https://script.google.com/macros/s/AKfycbzyj824VHT6WrJLZhHw-ufaf4tAT6BkvqQa3Ck_VloV2kV5vnP8JPpr3XKrOeAdzfjX4g/exec';

// Shared with apps-script/Code.gs. Change both before you deploy if you want a different token.
export const SYNC_TOKEN = 'fc-sync-4e91c7b2';

export const QUEUE_KEY = 'figure-cap.sync-queue.v1';
export const CHECKS_KEY = 'figure-cap.price-checks.v1';
export const LOCAL_CHECKS_KEY = 'figure-cap.price-checks.local.v1';
const FULL_KEY = 'figure-cap.sync-full.v1';

export const PURCHASE_COLUMNS = [
  'id', 'date', 'name', 'series', 'brand', 'type', 'bought_as', 'condition',
  'original_amount', 'currency', 'fx_rate', 'fx_date', 'amount_rm', 'fx_overridden', 'fx_cached',
  'shop', 'status', 'notes',
  'est_full_original_amount', 'est_full_currency', 'est_full_fx_rate', 'est_full_fx_date', 'est_full_price', 'est_full_fx_overridden', 'est_full_fx_cached',
  'deposit_original_amount', 'deposit_currency', 'deposit_fx_rate', 'deposit_fx_date', 'deposit_amount_rm', 'deposit_fx_overridden', 'deposit_fx_cached', 'deposit_date',
  'balance_due_rm',
  'balance_paid_original_amount', 'balance_paid_currency', 'balance_paid_fx_rate', 'balance_paid_fx_date', 'balance_paid_rm', 'balance_paid_fx_overridden', 'balance_paid_fx_cached', 'balance_paid_date',
  'final_total_rm', 'preorder_status',
  'created_at', 'updated_at'
];

export const WISHLIST_COLUMNS = [
  'id', 'name', 'original_amount', 'currency', 'fx_rate', 'fx_date', 'amount_rm',
  'fx_overridden', 'fx_cached', 'priority', 'added_at', 'updated_at'
];

export const PRICE_CHECK_COLUMNS = [
  'for_sale_id', 'figure', 'rrp', 'rrp_source', 'condition',
  'low_rm', 'typical_rm', 'high_rm', 'listing_count', 'sample_links', 'sources', 'checked_at'
];

export const SALE_COLUMNS = [
  'id', 'name', 'brand', 'series', 'condition',
  'original_amount', 'currency', 'fx_rate', 'fx_date', 'amount_rm', 'fx_overridden', 'fx_cached',
  'notes', 'status',
  'sold_original_amount', 'sold_currency', 'sold_fx_rate', 'sold_fx_date', 'sold_amount_rm',
  'sold_fx_overridden', 'sold_fx_cached', 'sold_date', 'created_at', 'updated_at'
];

const listeners = new Set();
let storageImpl = null;
let phase = 'off';
let running = false;
let again = false;

export function isConfiguredUrl(value) {
  const text = String(value || '').trim();
  if (!text || text.includes('PASTE_')) return false;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function resolveSyncUrl(settings) {
  const custom = String(settings?.syncUrl || '').trim();
  if (custom) return isConfiguredUrl(custom) ? custom : '';
  return isConfiguredUrl(DEFAULT_SYNC_URL) ? DEFAULT_SYNC_URL : '';
}

function db() {
  if (storageImpl) return storageImpl;
  if (typeof localStorage !== 'undefined') return localStorage;
  storageImpl = memory();
  return storageImpl;
}

function memory() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

export function resetSyncForTests() {
  phase = 'off';
  running = false;
  again = false;
  storageImpl = memory();
  return storageImpl;
}

function notify() {
  const label = syncStatusLabel();
  for (const listener of listeners) listener(label);
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function needsFull() {
  return db().getItem(FULL_KEY) === '1';
}

function markFull() {
  db().setItem(FULL_KEY, '1');
}

function clearFull() {
  db().removeItem(FULL_KEY);
}

export function syncStatusLabel() {
  const pending = readQueue().length + (needsFull() ? 1 : 0);
  if (phase === 'syncing') return 'Syncing…';
  if (phase === 'off') return 'Sync off';
  if (phase === 'offline') return pending ? `Offline · ${pending} waiting` : 'Offline';
  if (phase === 'error' || pending) return 'Not synced · will retry';
  return 'Synced';
}

function setPhase(next) {
  phase = next;
  notify();
}

export function readQueue() {
  try {
    const parsed = JSON.parse(db().getItem(QUEUE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  db().setItem(QUEUE_KEY, JSON.stringify(queue));
  notify();
}

function opKey(op) {
  return JSON.stringify([op.op, op.sheet, op.id, op.row || null]);
}

export function enqueueUpsert(sheet, row) {
  const copy = JSON.parse(JSON.stringify(row));
  const queue = readQueue().filter((op) => !(op.sheet === sheet && op.id === copy.id));
  queue.push({ op: 'upsert', sheet, id: copy.id, row: copy });
  writeQueue(queue);
}

export function enqueueDelete(sheet, id) {
  const queue = readQueue().filter((op) => !(op.sheet === sheet && op.id === id));
  queue.push({ op: 'delete', sheet, id });
  writeQueue(queue);
}

export function enqueueAppendCheck(row) {
  const copy = JSON.parse(JSON.stringify(row));
  delete copy.local_id;
  const queue = readQueue();
  queue.push({ op: 'appendCheck', sheet: 'Price Checks', id: '', row: copy });
  writeQueue(queue);
}

export function clearQueue() {
  writeQueue([]);
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function rateCell(value) {
  return value == null || value === '' ? '' : value;
}

function ordered(columns, row) {
  return Object.fromEntries(columns.map((key) => [key, row[key] ?? '']));
}

export function purchaseRow(purchase) {
  return ordered(PURCHASE_COLUMNS, {
    id: purchase.id,
    date: purchase.date,
    name: purchase.name,
    series: purchase.series,
    brand: purchase.brand,
    type: purchase.figureType ? figureTypeLabel(purchase.figureType) : '',
    bought_as: boughtAsLabel(purchase.boughtAs),
    condition: purchase.condition,
    original_amount: purchase.originalAmount,
    currency: purchase.currency,
    fx_rate: rateCell(purchase.fxRate),
    fx_date: purchase.fxDate,
    amount_rm: purchase.price,
    fx_overridden: yesNo(purchase.fxOverridden),
    fx_cached: yesNo(purchase.fxCached),
    shop: purchase.shop,
    status: purchaseStatusLabel(purchase.status),
    notes: purchase.notes,
    ...preorderCells(purchase),
    created_at: purchase.createdAt,
    updated_at: purchase.updatedAt
  });
}

function cell(value) {
  return value == null || value === '' ? '' : value;
}

function flagCell(present, value) {
  return present ? yesNo(value) : '';
}

function preorderCells(purchase) {
  const preorder = purchase.boughtAs === 'preorder' && purchase.preorderStatus;
  const est = preorder && purchase.estFullPrice != null;
  const deposit = preorder && purchase.depositAmountRm != null;
  const balance = preorder && purchase.balancePaidRm != null;
  return {
    est_full_original_amount: est ? cell(purchase.estFullOriginalAmount) : '',
    est_full_currency: est ? cell(purchase.estFullCurrency) : '',
    est_full_fx_rate: est ? rateCell(purchase.estFullFxRate) : '',
    est_full_fx_date: est ? cell(purchase.estFullFxDate) : '',
    est_full_price: est ? purchase.estFullPrice : '',
    est_full_fx_overridden: flagCell(est, purchase.estFullFxOverridden),
    est_full_fx_cached: flagCell(est, purchase.estFullFxCached),
    deposit_original_amount: deposit ? cell(purchase.depositOriginalAmount) : '',
    deposit_currency: deposit ? cell(purchase.depositCurrency) : '',
    deposit_fx_rate: deposit ? rateCell(purchase.depositFxRate) : '',
    deposit_fx_date: deposit ? cell(purchase.depositFxDate) : '',
    deposit_amount_rm: deposit ? purchase.depositAmountRm : '',
    deposit_fx_overridden: flagCell(deposit, purchase.depositFxOverridden),
    deposit_fx_cached: flagCell(deposit, purchase.depositFxCached),
    deposit_date: deposit ? cell(purchase.depositDate) : '',
    balance_due_rm: preorder && purchase.balanceDueRm != null ? purchase.balanceDueRm : '',
    balance_paid_original_amount: balance ? cell(purchase.balancePaidOriginalAmount) : '',
    balance_paid_currency: balance ? cell(purchase.balancePaidCurrency) : '',
    balance_paid_fx_rate: balance ? rateCell(purchase.balancePaidFxRate) : '',
    balance_paid_fx_date: balance ? cell(purchase.balancePaidFxDate) : '',
    balance_paid_rm: balance ? purchase.balancePaidRm : '',
    balance_paid_fx_overridden: flagCell(balance, purchase.balancePaidFxOverridden),
    balance_paid_fx_cached: flagCell(balance, purchase.balancePaidFxCached),
    balance_paid_date: balance ? cell(purchase.balancePaidDate) : '',
    final_total_rm: preorder && purchase.finalTotalRm != null ? purchase.finalTotalRm : '',
    preorder_status: preorder ? purchase.preorderStatus : ''
  };
}

export function wishRow(item) {
  return ordered(WISHLIST_COLUMNS, {
    id: item.id,
    name: item.name,
    original_amount: item.originalAmount,
    currency: item.currency,
    fx_rate: rateCell(item.fxRate),
    fx_date: item.fxDate,
    amount_rm: item.price,
    fx_overridden: yesNo(item.fxOverridden),
    fx_cached: yesNo(item.fxCached),
    priority: priorityLabel(item.priority),
    added_at: item.addedAt,
    updated_at: item.updatedAt
  });
}

export function priceCheckRow(check) {
  return ordered(PRICE_CHECK_COLUMNS, {
    for_sale_id: check.for_sale_id || '',
    figure: check.figure || '',
    rrp: check.rrp || '',
    rrp_source: check.rrp_source || '',
    condition: check.condition || '',
    low_rm: cell(check.low_rm),
    typical_rm: cell(check.typical_rm),
    high_rm: cell(check.high_rm),
    listing_count: cell(check.listing_count),
    sample_links: check.sample_links || '',
    sources: check.sources || '',
    checked_at: check.checked_at || ''
  });
}

export function saleRow(item) {
  return ordered(SALE_COLUMNS, {
    id: item.id,
    name: item.name,
    brand: item.brand,
    series: item.series,
    condition: item.condition,
    original_amount: item.originalAmount,
    currency: item.currency,
    fx_rate: rateCell(item.fxRate),
    fx_date: item.fxDate,
    amount_rm: item.price,
    fx_overridden: yesNo(item.fxOverridden),
    fx_cached: yesNo(item.fxCached),
    notes: item.notes,
    status: saleStatusLabel(item.status),
    sold_original_amount: item.soldOriginalAmount ?? '',
    sold_currency: item.soldCurrency || '',
    sold_fx_rate: rateCell(item.soldFxRate),
    sold_fx_date: item.soldFxDate || '',
    sold_amount_rm: item.soldPrice ?? '',
    sold_fx_overridden: item.status === 'sold' ? yesNo(item.soldFxOverridden) : '',
    sold_fx_cached: item.status === 'sold' ? yesNo(item.soldFxCached) : '',
    sold_date: item.soldDate || '',
    created_at: item.createdAt,
    updated_at: item.updatedAt
  });
}

export function syncAllBody(data) {
  return {
    action: 'syncAll',
    purchases: (data.purchases || []).map(purchaseRow),
    wishlist: (data.wishlist || []).map(wishRow),
    forSale: (data.forSale || []).map(saleRow)
  };
}

function withToken(url) {
  const join = url.includes('?') ? '&' : '?';
  return `${url}${join}token=${encodeURIComponent(SYNC_TOKEN)}`;
}

async function postJson(url, body, fetchImpl) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: SYNC_TOKEN, ...body }),
    redirect: 'follow'
  });
  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new Error('The sheet did not return JSON.');
  }
  if (payload.ok === false) return payload;
  if (response.ok === false) throw new Error(`http ${response.status}`);
  return payload;
}

function offline(options) {
  if (options.online === false) return true;
  if (options.online === true) return false;
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function readList(key) {
  try {
    const parsed = JSON.parse(db().getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function checkAmount(value) {
  if (value === '' || value == null) return '';
  const number = Number(value);
  return Number.isFinite(number) ? number : String(value);
}

function sameCheck(a, b) {
  return String(a?.for_sale_id || '') === String(b?.for_sale_id || '')
    && String(a?.checked_at || '') === String(b?.checked_at || '')
    && checkAmount(a?.low_rm) === checkAmount(b?.low_rm)
    && checkAmount(a?.typical_rm) === checkAmount(b?.typical_rm)
    && checkAmount(a?.high_rm) === checkAmount(b?.high_rm);
}

export function rememberLocalCheck(row) {
  const local = readList(LOCAL_CHECKS_KEY);
  local.push(row);
  db().setItem(LOCAL_CHECKS_KEY, JSON.stringify(local));
}

export function cachedPriceChecks() {
  const merged = readList(CHECKS_KEY).slice();
  for (const row of readList(LOCAL_CHECKS_KEY)) {
    if (!merged.some((existing) => sameCheck(existing, row))) merged.push(row);
  }
  return merged;
}

function storePulledChecks(checks) {
  const remote = Array.isArray(checks) ? checks : [];
  const local = readList(LOCAL_CHECKS_KEY).filter((row) => !remote.some((existing) => sameCheck(existing, row)));
  db().setItem(CHECKS_KEY, JSON.stringify(remote));
  db().setItem(LOCAL_CHECKS_KEY, JSON.stringify(local));
}

export async function pullPriceChecks(settings, options = {}) {
  const url = resolveSyncUrl(settings);
  if (!url || offline(options)) return cachedPriceChecks();
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const response = await fetchFn(withToken(url), { method: 'GET', redirect: 'follow' });
  const payload = JSON.parse(await response.text());
  if (!payload || payload.ok === false) throw new Error(payload?.error || 'sync failed');
  const checks = Array.isArray(payload.priceChecks) ? payload.priceChecks : [];
  storePulledChecks(checks);
  return cachedPriceChecks();
}

export async function flushQueue(getData, options = {}) {
  const data = typeof getData === 'function' ? getData() : null;
  if (!data) return { ok: false, reason: 'nodata' };
  const url = resolveSyncUrl(data.settings);
  if (!url) {
    setPhase('off');
    return { ok: false, reason: 'off' };
  }
  if (offline(options)) {
    setPhase('offline');
    return { ok: false, reason: 'offline' };
  }
  if (needsFull()) return syncAllNow(data, options);
  const queue = readQueue();
  if (!queue.length) {
    setPhase('idle');
    return { ok: true };
  }
  setPhase('syncing');
  const posted = await postQueued(url, options);
  if (!posted.ok) return posted;
  if (!readQueue().length) {
    try {
      await pullPriceChecks(data.settings, options);
    } catch {
      // The rows were saved. Price checks can wait for the next pull.
    }
  }
  setPhase(readQueue().length ? 'error' : 'idle');
  return { ok: readQueue().length === 0 };
}

function postBody(op) {
  if (op.op === 'delete') return { action: 'delete', sheet: op.sheet, id: op.id };
  if (op.op === 'appendCheck') return { action: 'appendCheck', row: op.row };
  return { action: 'upsert', sheet: op.sheet, row: op.row };
}

async function postQueued(url, options) {
  for (const op of readQueue()) {
    try {
      const result = await postJson(url, postBody(op), options.fetchImpl);
      if (!result || result.ok === false) throw new Error(result?.error || 'sync failed');
      const key = opKey(op);
      writeQueue(readQueue().filter((item) => opKey(item) !== key));
    } catch {
      setPhase(offline(options) ? 'offline' : 'error');
      return { ok: false };
    }
  }
  return { ok: true };
}

export async function syncAllNow(data, options = {}) {
  const url = resolveSyncUrl(data?.settings);
  if (!url) {
    setPhase('off');
    return { ok: false, reason: 'off' };
  }
  if (offline(options)) {
    markFull();
    setPhase('offline');
    return { ok: false, reason: 'offline' };
  }
  const before = new Set(readQueue().map(opKey));
  setPhase('syncing');
  try {
    const result = await postJson(url, syncAllBody(data), options.fetchImpl);
    if (!result || result.ok === false) throw new Error(result?.error || 'sync failed');
    clearFull();
    writeQueue(readQueue().filter((op) => op.op === 'appendCheck' || !before.has(opKey(op))));
    const posted = await postQueued(url, options);
    if (!posted.ok) return posted;
    try {
      await pullPriceChecks(data.settings, options);
    } catch {
      // Full push succeeded even if the read failed.
    }
    setPhase(readQueue().length ? 'error' : 'idle');
    return { ok: true };
  } catch (error) {
    markFull();
    setPhase('error');
    return { ok: false, error: String(error.message || error) };
  }
}

export function refreshSyncStatus(getData) {
  const data = getData();
  if (!data || !resolveSyncUrl(data.settings)) {
    setPhase('off');
    return;
  }
  if (offline({})) setPhase('offline');
  else setPhase(readQueue().length || needsFull() ? 'error' : 'idle');
}

export function kickSync(getData) {
  again = true;
  if (running) return;
  running = true;
  (async () => {
    try {
      while (again) {
        again = false;
        await flushQueue(getData);
      }
    } finally {
      running = false;
      if (again) kickSync(getData);
    }
  })();
}

export function startAutoSync(getData) {
  refreshSyncStatus(getData);
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => kickSync(getData));
  window.addEventListener('offline', () => {
    if (resolveSyncUrl(getData()?.settings)) setPhase('offline');
  });
  setInterval(() => {
    if (readQueue().length || needsFull()) kickSync(getData);
  }, 30000);
  kickSync(getData);
}
