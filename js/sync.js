// Sheet sync. The page keeps localStorage as the copy it edits.
// A full sync deletes sheet rows that are missing from the payload, so the app
// pulls purchases, the wishlist, and listings first and keeps the newer updated_at.
// Posts use text/plain so the Apps Script web app does not require a CORS preflight.
// The deployed web app is the default, so a new phone syncs without pasting a URL.

import { PRIORITY_OPTIONS, priorityLabel } from './budget.js';
import { SALE_STATUSES, boughtAsLabel, derivedPurchaseStatus, figureTypeLabel, normalizeBoughtAs, normalizeFigureType, purchaseStatusLabel, saleStatusLabel } from './catalog.js';
import { parseMoney } from './money.js';
import { looksLikeData, normalizeData, save } from './store.js';
import { TZ, currentMonth, todayYMD } from './time.js';

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
let mergeListener = null;
let dataSource = () => null;
let gate = Promise.resolve();

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
  mergeListener = null;
  dataSource = () => null;
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

export function onSheetMerge(listener) {
  mergeListener = listener;
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
    original_amount: item.price == null ? '' : item.originalAmount,
    currency: item.price == null ? '' : item.currency,
    fx_rate: item.price == null ? '' : rateCell(item.fxRate),
    fx_date: item.price == null ? '' : item.fxDate,
    amount_rm: item.price == null ? '' : item.price,
    fx_overridden: item.price == null ? '' : yesNo(item.fxOverridden),
    fx_cached: item.price == null ? '' : yesNo(item.fxCached),
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

function isBlank(value) {
  return value == null || String(value).trim() === '';
}

function isYes(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return value === true || text === 'yes' || text === 'true';
}

function amountValue(value) {
  if (isBlank(value)) return null;
  const parsed = parseMoney(value);
  return parsed == null ? null : parsed;
}

function rateValue(value) {
  if (isBlank(value)) return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

function moneyCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : '';
}

function ymdValue(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return todayYMD(value);
  }
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

// Sheet datetimes are Malaysia wall time (yyyy-MM-dd HH:mm). Instants stay instants.
function sheetInstant(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }
  const text = String(value ?? '').trim();
  if (!text) return 0;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) || /[zZ]$/.test(text) || /[+-]\d{2}:\d{2}$/.test(text)) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return zonedUtc(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4] || 0),
    Number(match[5] || 0),
    Number(match[6] || 0),
    TZ
  );
}

function zonedUtc(year, month, day, hour, minute, second, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date(utcGuess));
  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  let wallHour = Number(map.hour);
  if (wallHour === 24) wallHour = 0;
  const asUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), wallHour, Number(map.minute), Number(map.second));
  return utcGuess - (asUtc - utcGuess);
}

function fromSheetTime(value) {
  return new Date(sheetInstant(value)).toISOString();
}

function priorityValue(value) {
  const key = String(value ?? '').trim().toLowerCase();
  const match = PRIORITY_OPTIONS.find((item) => item.value === key || item.label.toLowerCase() === key);
  return match ? match.value : 'really';
}

function saleStatusValue(value) {
  const key = String(value ?? '').trim().toLowerCase();
  const match = SALE_STATUSES.find((item) => item.value === key || item.label.toLowerCase() === key);
  return match ? match.value : 'listed';
}

function preorderStatusValue(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'deposit paid' || key === 'fully paid') return key;
  return '';
}

function rowId(row) {
  const id = String(row?.id ?? '').trim();
  return id;
}

// Inverse of purchaseRow. Sheet scales that became dates (2026-01-12, 2026-01-06)
// map back through normalizeFigureType. Amounts are numbers; blank money stays null.
export function purchaseFromRow(row, categories = []) {
  if (!row || typeof row !== 'object') return null;
  const id = rowId(row);
  if (!id) return null;
  const boughtAs = normalizeBoughtAs(row.bought_as ?? row.boughtAs, '');
  const preorderStatus = preorderStatusValue(row.preorder_status ?? row.preorderStatus);
  return {
    id,
    date: ymdValue(row.date),
    name: String(row.name ?? ''),
    series: String(row.series ?? ''),
    brand: String(row.brand ?? ''),
    figureType: normalizeFigureType(row.type ?? row.figureType ?? '', categories),
    boughtAs,
    condition: String(row.condition ?? ''),
    originalAmount: amountValue(row.original_amount ?? row.originalAmount),
    currency: moneyCode(row.currency),
    fxRate: rateValue(row.fx_rate ?? row.fxRate),
    fxDate: ymdValue(row.fx_date ?? row.fxDate),
    price: amountValue(row.amount_rm ?? row.price),
    fxOverridden: isYes(row.fx_overridden ?? row.fxOverridden),
    fxCached: isYes(row.fx_cached ?? row.fxCached),
    shop: String(row.shop ?? ''),
    status: derivedPurchaseStatus(boughtAs, preorderStatus),
    notes: String(row.notes ?? row.note ?? ''),
    estFullOriginalAmount: amountValue(row.est_full_original_amount),
    estFullCurrency: moneyCode(row.est_full_currency),
    estFullFxRate: rateValue(row.est_full_fx_rate),
    estFullFxDate: ymdValue(row.est_full_fx_date),
    estFullPrice: amountValue(row.est_full_price),
    estFullFxOverridden: isYes(row.est_full_fx_overridden),
    estFullFxCached: isYes(row.est_full_fx_cached),
    depositOriginalAmount: amountValue(row.deposit_original_amount),
    depositCurrency: moneyCode(row.deposit_currency),
    depositFxRate: rateValue(row.deposit_fx_rate),
    depositFxDate: ymdValue(row.deposit_fx_date),
    depositAmountRm: amountValue(row.deposit_amount_rm),
    depositFxOverridden: isYes(row.deposit_fx_overridden),
    depositFxCached: isYes(row.deposit_fx_cached),
    depositDate: ymdValue(row.deposit_date),
    balanceDueRm: amountValue(row.balance_due_rm),
    balancePaidOriginalAmount: amountValue(row.balance_paid_original_amount),
    balancePaidCurrency: moneyCode(row.balance_paid_currency),
    balancePaidFxRate: rateValue(row.balance_paid_fx_rate),
    balancePaidFxDate: ymdValue(row.balance_paid_fx_date),
    balancePaidRm: amountValue(row.balance_paid_rm),
    balancePaidFxOverridden: isYes(row.balance_paid_fx_overridden),
    balancePaidFxCached: isYes(row.balance_paid_fx_cached),
    balancePaidDate: ymdValue(row.balance_paid_date),
    finalTotalRm: amountValue(row.final_total_rm),
    preorderStatus,
    createdAt: fromSheetTime(row.created_at ?? row.createdAt),
    updatedAt: fromSheetTime(row.updated_at ?? row.updatedAt)
  };
}

export function wishFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  const id = rowId(row);
  if (!id) return null;
  return {
    id,
    name: String(row.name ?? ''),
    originalAmount: amountValue(row.original_amount ?? row.originalAmount),
    currency: moneyCode(row.currency),
    fxRate: rateValue(row.fx_rate ?? row.fxRate),
    fxDate: ymdValue(row.fx_date ?? row.fxDate),
    price: amountValue(row.amount_rm ?? row.price),
    fxOverridden: isYes(row.fx_overridden ?? row.fxOverridden),
    fxCached: isYes(row.fx_cached ?? row.fxCached),
    priority: priorityValue(row.priority),
    addedAt: fromSheetTime(row.added_at ?? row.addedAt),
    updatedAt: fromSheetTime(row.updated_at ?? row.updatedAt)
  };
}

export function saleFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  const id = rowId(row);
  if (!id) return null;
  return {
    id,
    name: String(row.name ?? ''),
    brand: String(row.brand ?? ''),
    series: String(row.series ?? ''),
    condition: String(row.condition ?? ''),
    originalAmount: amountValue(row.original_amount ?? row.originalAmount),
    currency: moneyCode(row.currency),
    fxRate: rateValue(row.fx_rate ?? row.fxRate),
    fxDate: ymdValue(row.fx_date ?? row.fxDate),
    price: amountValue(row.amount_rm ?? row.price),
    fxOverridden: isYes(row.fx_overridden ?? row.fxOverridden),
    fxCached: isYes(row.fx_cached ?? row.fxCached),
    notes: String(row.notes ?? ''),
    status: saleStatusValue(row.status),
    soldOriginalAmount: amountValue(row.sold_original_amount ?? row.soldOriginalAmount),
    soldCurrency: moneyCode(row.sold_currency ?? row.soldCurrency),
    soldFxRate: rateValue(row.sold_fx_rate ?? row.soldFxRate),
    soldFxDate: ymdValue(row.sold_fx_date ?? row.soldFxDate),
    soldFxOverridden: isYes(row.sold_fx_overridden ?? row.soldFxOverridden),
    soldFxCached: isYes(row.sold_fx_cached ?? row.soldFxCached),
    soldPrice: amountValue(row.sold_amount_rm ?? row.soldPrice),
    soldDate: ymdValue(row.sold_date ?? row.soldDate),
    createdAt: fromSheetTime(row.created_at ?? row.createdAt),
    updatedAt: fromSheetTime(row.updated_at ?? row.updatedAt)
  };
}

function replaceRow(rows, row) {
  const index = rows.findIndex((item) => item.id === row.id);
  if (index === -1) rows.push(row);
  else rows[index] = row;
}

// Queued upserts are part of this phone's sync even when the loaded table does
// not have them yet. Queued deletes remove those ids from a non-empty table.
export function syncTables(data, queue = []) {
  const tables = {
    Purchases: (data.purchases || []).map(purchaseRow),
    Wishlist: (data.wishlist || []).map(wishRow),
    'For Sale': (data.forSale || []).map(saleRow)
  };
  for (const op of queue) {
    const rows = tables[op.sheet];
    if (!rows || (op.op !== 'upsert' && op.op !== 'delete')) continue;
    if (op.op === 'delete') {
      const index = rows.findIndex((row) => row.id === op.id);
      if (index !== -1) rows.splice(index, 1);
      continue;
    }
    if (op.row && op.row.id) replaceRow(rows, op.row);
  }
  return tables;
}

export function syncAllBody(data, queue = []) {
  const tables = syncTables(data, queue);
  return {
    action: 'syncAll',
    purchases: tables.Purchases,
    wishlist: tables.Wishlist,
    forSale: tables['For Sale']
  };
}

const MERGE_TABLES = [
  { key: 'purchases', sheet: 'Purchases', fromRow: purchaseFromRow },
  { key: 'wishlist', sheet: 'Wishlist', fromRow: wishFromRow },
  { key: 'forSale', sheet: 'For Sale', fromRow: saleFromRow }
];

function adoptRow(key, parsed, settings, month) {
  const input = { settings, purchases: [], wishlist: [], forSale: [] };
  input[key] = [parsed];
  return normalizeData(input, month)[key][0] || null;
}

function newestMs(values) {
  let max = 0;
  for (const value of values) {
    const ms = sheetInstant(value);
    if (ms > max) max = ms;
  }
  return max;
}

function mergeTable(localRows, remoteRows, spec, queue, settings, month, dropped) {
  const local = (localRows || []).slice();
  if (!Array.isArray(remoteRows)) return { rows: localRows || [], changed: false };
  const indexById = new Map(local.map((item, index) => [String(item.id), index]));
  const queued = new Map();
  const deleted = new Set();
  for (const op of queue) {
    if (op.sheet !== spec.sheet || op.id == null) continue;
    if (op.op === 'delete') deleted.add(String(op.id));
    if (op.op === 'upsert' && op.row) queued.set(String(op.id), op.row);
  }
  let changed = false;
  const categories = settings.categories || [];
  for (const raw of remoteRows) {
    const parsed = spec.fromRow(raw, categories);
    if (!parsed?.id) continue;
    const id = String(parsed.id);
    if (deleted.has(id)) continue;
    const adopted = adoptRow(spec.key, parsed, settings, month);
    if (!adopted) continue;
    const index = indexById.get(id);
    const existing = index == null ? null : local[index];
    const queuedRow = queued.get(id);
    if (!existing && !queuedRow) {
      indexById.set(id, local.length);
      local.push(adopted);
      changed = true;
      continue;
    }
    const localMs = newestMs([existing?.updatedAt, queuedRow?.updated_at, queuedRow?.updatedAt]);
    if (sheetInstant(adopted.updatedAt) > localMs) {
      if (index == null) {
        indexById.set(id, local.length);
        local.push(adopted);
      } else local[index] = adopted;
      if (queuedRow) dropped.add(`${spec.sheet}\0${id}`);
      changed = true;
    }
  }
  return { rows: changed ? local : (localRows || []), changed };
}

// Remote rows join local rows by id. The newer updated_at wins. Local-only rows
// stay. A queued delete blocks that id, so a sheet row cannot bring it back.
// A payload that omits a table (for example a price-check read) is not an empty tab.
export function mergeSheet(data, payload, queue = []) {
  const settings = data?.settings || {};
  const month = currentMonth();
  const source = payload || {};
  const dropped = new Set();
  const merged = {};
  let changed = false;
  for (const spec of MERGE_TABLES) {
    const table = mergeTable(data?.[spec.key], source[spec.key], spec, queue, settings, month, dropped);
    merged[spec.key] = table.rows;
    if (table.changed) changed = true;
  }
  const nextQueue = dropped.size
    ? queue.filter((op) => !(op.op === 'upsert' && dropped.has(`${op.sheet}\0${String(op.id)}`)))
    : queue;
  if (!changed) return { data, queue: nextQueue, changed: false };
  return {
    data: normalizeData({ ...data, settings, ...merged }, month),
    queue: nextQueue,
    changed: true
  };
}

// An empty table is not authority to erase the sheet. The matching guard in
// apps-script/Code.gs is what stops a device that has no rows for a tab.
export function fullSyncCovers(op, tables) {
  if (op.op !== 'upsert' && op.op !== 'delete') return false;
  const rows = tables[op.sheet];
  if (!rows || !rows.length) return false;
  const present = rows.some((row) => row.id === op.id);
  return op.op === 'upsert' ? present : !present;
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

async function fetchSheet(url, options) {
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const response = await fetchFn(withToken(url), { method: 'GET', redirect: 'follow' });
  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new Error('The sheet did not return JSON.');
  }
  if (!payload || payload.ok === false) throw new Error(payload?.error || 'sync failed');
  if (response.ok === false) throw new Error(`http ${response.status}`);
  return payload;
}

function latestData(fallback) {
  try {
    const fresh = dataSource();
    if (fresh && looksLikeData(fresh)) return fresh;
  } catch {
    // The copy the caller already loaded is still safe to merge into.
  }
  return fallback;
}

function notifyMerge() {
  if (typeof mergeListener !== 'function') return;
  try {
    mergeListener();
  } catch {
    // A redraw problem must not skip the push that keeps sheet-only rows.
  }
}

function sameOps(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyPayload(data, payload) {
  const merged = mergeSheet(data, payload, readQueue());
  if (!sameOps(merged.queue, readQueue())) writeQueue(merged.queue);
  if (!merged.changed) return data;
  try {
    save(merged.data);
  } catch {
    return merged.data;
  }
  notifyMerge();
  return merged.data;
}

function exclusive(task) {
  const run = gate.then(task, task);
  gate = run.then(() => {}, () => {});
  return run;
}

async function pullAndApply(data, options) {
  const url = resolveSyncUrl(data?.settings);
  const payload = await fetchSheet(url, options);
  storePulledChecks(payload.priceChecks);
  return applyPayload(latestData(data) || data, payload);
}

export async function pullPriceChecks(settings, options = {}) {
  const url = resolveSyncUrl(settings);
  if (!url || offline(options)) return cachedPriceChecks();
  const payload = await fetchSheet(url, options);
  storePulledChecks(payload.priceChecks);
  return cachedPriceChecks();
}

export function refreshFromSheet(getData, options = {}) {
  return exclusive(() => refreshFromSheetBody(getData, options));
}

async function refreshFromSheetBody(getData, options) {
  const read = () => (typeof getData === 'function' ? getData() : getData);
  const initial = read();
  if (!initial) return { ok: false, reason: 'nodata' };
  const url = resolveSyncUrl(initial.settings);
  if (!url) return { ok: false, reason: 'off' };
  if (offline(options)) return { ok: false, reason: 'offline' };
  try {
    const payload = await fetchSheet(url, options);
    storePulledChecks(payload.priceChecks);
    applyPayload(latestData(read() || initial) || initial, payload);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
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
  return exclusive(() => syncAllNowBody(data, options));
}

async function syncAllNowBody(data, options) {
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
  setPhase('syncing');
  let current = data;
  try {
    current = await pullAndApply(data, options);
  } catch (error) {
    // Leave the queue and any pending full sync. Pushing now would delete sheet-only rows.
    setPhase(offline(options) ? 'offline' : 'error');
    return { ok: false, error: String(error.message || error) };
  }
  const pending = readQueue();
  const tables = syncTables(current, pending);
  const covered = new Set(pending.filter((op) => fullSyncCovers(op, tables)).map(opKey));
  try {
    const result = await postJson(url, syncAllBody(current, pending), options.fetchImpl);
    if (!result || result.ok === false) throw new Error(result?.error || 'sync failed');
    clearFull();
    writeQueue(readQueue().filter((op) => !covered.has(opKey(op))));
    const posted = await postQueued(url, options);
    if (!posted.ok) return posted;
    try {
      await pullPriceChecks(current.settings, options);
    } catch {
      // Full push succeeded even if the read failed.
    }
    setPhase(readQueue().length ? 'error' : 'idle');
    return { ok: true, data: current };
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
  dataSource = typeof getData === 'function' ? getData : () => getData;
  refreshSyncStatus(getData);
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => kickSync(getData));
  window.addEventListener('offline', () => {
    if (resolveSyncUrl(getData()?.settings)) setPhase('offline');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshFromSheet(getData);
  });
  setInterval(() => {
    if (readQueue().length || needsFull()) kickSync(getData);
  }, 30000);
  refreshFromSheet(getData);
  kickSync(getData);
}
