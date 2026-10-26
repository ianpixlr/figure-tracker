// Purchases, the wishlist, and figures for sale live in localStorage.
// When a sheet web app URL is set, js/sync.js also sends those records.
// Existing saves used `type` and `note`. Loading rewrites them into the
// current shape and keeps the ringgit amount the cap already used.

import { cleanCategories, derivedPurchaseStatus, normalizeBoughtAs, normalizeFigureType } from './catalog.js';
import { fromCents, parseMoney, toCents } from './money.js';
import { isMonth, isYMD } from './time.js';

export const STORAGE_KEY = 'figure-cap.v1';
export const MAX_MONEY = 1000000;
export const MAX_FOREIGN = 100000000;

const PURCHASE_CONDITIONS = new Set(['', 'MISB', 'MIB', 'BIB', 'Loose', 'Other']);
const ORDER_TYPES = new Set(['preorder', 'bought', 'purchased', 'new', 'second-hand', 'secondhand']);
const SALE_CONDITIONS = new Set(['MISB', 'MIB', 'BIB', 'Loose']);
const PREORDER_STATUS = new Set(['deposit paid', 'fully paid']);

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function emptyData(todayYm) {
  return {
    settings: {
      monthlyCap: 400,
      rollover: false,
      overspendPayback: true,
      trackingStart: todayYm,
      syncUrl: '',
      categories: []
    },
    purchases: [],
    wishlist: [],
    forSale: []
  };
}

function clip(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanSettings(source, todayYm) {
  let cap = parseMoney(source?.monthlyCap);
  if (cap == null || cap < 0) cap = 400;
  if (cap > MAX_MONEY) cap = MAX_MONEY;

  return {
    monthlyCap: cap,
    rollover: Boolean(source?.rollover),
    overspendPayback: source?.overspendPayback !== false,
    trackingStart: isMonth(source?.trackingStart) ? source.trackingStart : todayYm,
    syncUrl: clip(source?.syncUrl, 500),
    categories: cleanCategories(source?.categories)
  };
}

function rawFigureType(input) {
  const explicit = input?.figureType ?? input?.figure_type;
  if (explicit != null && String(explicit).trim() !== '') return explicit;
  const legacy = String(input?.type ?? '').trim();
  const legacyKey = legacy.toLowerCase().replace(/[\s_]+/g, '-');
  if (!legacy || ORDER_TYPES.has(legacyKey)) return explicit == null ? '' : explicit;
  return legacy;
}

export function forgetCategory(data, name) {
  const key = String(name || '').trim().toLowerCase();
  const changed = [];
  data.settings.categories = (data.settings.categories || []).filter((item) => String(item).trim().toLowerCase() !== key);
  for (const purchase of data.purchases || []) {
    if (String(purchase.figureType || '').trim().toLowerCase() === key) {
      purchase.figureType = 'other';
      changed.push(purchase);
    }
  }
  for (const item of [...(data.wishlist || []), ...(data.forSale || [])]) {
    if (String(item.figureType || '').trim().toLowerCase() === key) item.figureType = 'other';
  }
  return changed;
}

function flag(value) {
  return value === true || value === 'yes' || value === 'true';
}

function currencyOf(input) {
  const code = String(input?.currency || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : '';
}

function dateOrBlank(value) {
  const text = String(value || '');
  if (isYMD(text)) return text;
  const day = text.slice(0, 10);
  return isYMD(day) ? day : '';
}

function cleanMoney(input, fallbackDate, rmKeys) {
  if (!input || typeof input !== 'object') return null;
  const currency = currencyOf(input) || 'MYR';
  const originalAmount = parseMoney(input.originalAmount ?? input.original_amount);
  let price = null;
  for (const key of rmKeys) {
    price = parseMoney(input[key]);
    if (price != null) break;
  }
  let original = originalAmount;
  if (original == null && !currencyOf(input)) original = price;
  if (price == null && currency === 'MYR') price = original;
  if (original == null) original = currency === 'MYR' ? price : null;

  if (original == null || original <= 0 || original > MAX_FOREIGN) return null;
  if (price == null || price <= 0 || price > MAX_MONEY) return null;

  const fxOverridden = flag(input.fxOverridden ?? input.fx_overridden);
  let fxRate = Number(input.fxRate ?? input.fx_rate);
  if (!Number.isFinite(fxRate) || fxRate <= 0) fxRate = currency === 'MYR' ? 1 : null;
  if (currency === 'MYR' && !fxOverridden) fxRate = 1;

  return {
    originalAmount: original,
    currency,
    fxRate,
    fxDate: dateOrBlank(input.fxDate ?? input.fx_date) || dateOrBlank(fallbackDate),
    fxOverridden,
    fxCached: flag(input.fxCached ?? input.fx_cached),
    price
  };
}

function stamp(value, fallback) {
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  const backup = Date.parse(fallback);
  if (!Number.isNaN(backup)) return new Date(backup).toISOString();
  return new Date(0).toISOString();
}

function takeId(input, seen) {
  let id = String(input.id || uid());
  if (seen.has(id)) id = uid();
  seen.add(id);
  return id;
}

function present(input, keys) {
  for (const key of keys) {
    if (input[key] != null && input[key] !== '') return input[key];
  }
  return undefined;
}

function sideMoney(input, spec, fallbackDate) {
  const source = {
    originalAmount: present(input, spec.original),
    currency: present(input, spec.currency),
    fxRate: present(input, spec.rate),
    fxDate: present(input, spec.fxDate),
    fxOverridden: present(input, spec.over),
    fxCached: present(input, spec.cached),
    price: present(input, spec.price)
  };
  if (source.originalAmount == null && source.price == null && !source.currency) return null;
  return cleanMoney(source, fallbackDate, ['price']);
}

const EST_SPEC = {
  original: ['estFullOriginalAmount', 'est_full_original_amount'],
  currency: ['estFullCurrency', 'est_full_currency'],
  rate: ['estFullFxRate', 'est_full_fx_rate'],
  fxDate: ['estFullFxDate', 'est_full_fx_date'],
  over: ['estFullFxOverridden', 'est_full_fx_overridden'],
  cached: ['estFullFxCached', 'est_full_fx_cached'],
  price: ['estFullPrice', 'est_full_price']
};

const DEPOSIT_SPEC = {
  original: ['depositOriginalAmount', 'deposit_original_amount'],
  currency: ['depositCurrency', 'deposit_currency'],
  rate: ['depositFxRate', 'deposit_fx_rate'],
  fxDate: ['depositFxDate', 'deposit_fx_date'],
  over: ['depositFxOverridden', 'deposit_fx_overridden'],
  cached: ['depositFxCached', 'deposit_fx_cached'],
  price: ['depositAmountRm', 'deposit_amount_rm']
};

const BALANCE_SPEC = {
  original: ['balancePaidOriginalAmount', 'balance_paid_original_amount'],
  currency: ['balancePaidCurrency', 'balance_paid_currency'],
  rate: ['balancePaidFxRate', 'balance_paid_fx_rate'],
  fxDate: ['balancePaidFxDate', 'balance_paid_fx_date'],
  over: ['balancePaidFxOverridden', 'balance_paid_fx_overridden'],
  cached: ['balancePaidFxCached', 'balance_paid_fx_cached'],
  price: ['balancePaidRm', 'balance_paid_rm']
};

export function emptyPreorder() {
  return {
    estFullOriginalAmount: null,
    estFullCurrency: '',
    estFullFxRate: null,
    estFullFxDate: '',
    estFullPrice: null,
    estFullFxOverridden: false,
    estFullFxCached: false,
    depositOriginalAmount: null,
    depositCurrency: '',
    depositFxRate: null,
    depositFxDate: '',
    depositAmountRm: null,
    depositFxOverridden: false,
    depositFxCached: false,
    depositDate: '',
    balanceDueRm: null,
    balancePaidOriginalAmount: null,
    balancePaidCurrency: '',
    balancePaidFxRate: null,
    balancePaidFxDate: '',
    balancePaidRm: null,
    balancePaidFxOverridden: false,
    balancePaidFxCached: false,
    balancePaidDate: '',
    finalTotalRm: null,
    preorderStatus: ''
  };
}

function packSide(prefix, money) {
  if (prefix === 'est') {
    return {
      estFullOriginalAmount: money.originalAmount,
      estFullCurrency: money.currency,
      estFullFxRate: money.fxRate,
      estFullFxDate: money.fxDate,
      estFullPrice: money.price,
      estFullFxOverridden: money.fxOverridden,
      estFullFxCached: money.fxCached
    };
  }
  if (prefix === 'deposit') {
    return {
      depositOriginalAmount: money.originalAmount,
      depositCurrency: money.currency,
      depositFxRate: money.fxRate,
      depositFxDate: money.fxDate,
      depositAmountRm: money.price,
      depositFxOverridden: money.fxOverridden,
      depositFxCached: money.fxCached
    };
  }
  return {
    balancePaidOriginalAmount: money.originalAmount,
    balancePaidCurrency: money.currency,
    balancePaidFxRate: money.fxRate,
    balancePaidFxDate: money.fxDate,
    balancePaidRm: money.price,
    balancePaidFxOverridden: money.fxOverridden,
    balancePaidFxCached: money.fxCached
  };
}

// Balance is omitted when balanceRm is null. A deposit that already covers
// the estimate is fully paid, with no separate balance payment.
export function settlePreorder(estRm, depositRm, balanceRm) {
  const est = toCents(estRm) ?? 0;
  const deposit = toCents(depositRm) ?? 0;
  const due = Math.max(0, est - deposit);
  const recorded = balanceRm != null && balanceRm !== '';
  const paid = recorded ? (toCents(balanceRm) ?? 0) : 0;
  const fully = recorded || due === 0;
  const finalCents = fully ? deposit + (recorded ? paid : 0) : null;
  return {
    balanceDueRm: fromCents(fully ? 0 : due),
    finalTotalRm: finalCents == null ? null : fromCents(finalCents),
    preorderStatus: fully ? 'fully paid' : 'deposit paid',
    differenceRm: finalCents == null ? null : fromCents(finalCents - est)
  };
}

function hasPreorderDetail(input) {
  return present(input, [
    'preorderStatus', 'preorder_status', 'estFullPrice', 'est_full_price',
    'depositAmountRm', 'deposit_amount_rm', 'finalTotalRm', 'final_total_rm'
  ]) != null;
}

function cleanPurchase(input, seen, categories = []) {
  if (!input || typeof input !== 'object') return null;
  const name = clip(input.name, 80);
  const date = String(input.date ?? '');
  if (!name || !isYMD(date)) return null;

  const boughtAs = normalizeBoughtAs(input.boughtAs, input.type);
  const status = derivedPurchaseStatus(boughtAs, '');
  const figureType = normalizeFigureType(rawFigureType(input), categories);

  const money = cleanMoney(input, date, ['amountRm', 'amount_rm', 'price']);
  if (!money && boughtAs !== 'preorder') return null;

  const createdAt = stamp(input.createdAt, 0);
  const base = {
    id: takeId(input, seen),
    name,
    series: clip(input.series, 80),
    brand: clip(input.brand, 80),
    figureType,
    boughtAs,
    condition: PURCHASE_CONDITIONS.has(input.condition) ? input.condition : '',
    date,
    shop: clip(input.shop, 80),
    status,
    notes: clip(input.notes ?? input.note, 280),
    createdAt,
    updatedAt: stamp(input.updatedAt, createdAt)
  };

  if (boughtAs !== 'preorder') {
    if (!money) return null;
    return { ...base, ...money, ...emptyPreorder() };
  }

  const depositDate = dateOrBlank(input.depositDate ?? input.deposit_date) || date;
  let est = sideMoney(input, EST_SPEC, depositDate);
  let deposit = sideMoney(input, DEPOSIT_SPEC, depositDate);
  const balanceDate = dateOrBlank(input.balancePaidDate ?? input.balance_paid_date);
  let balance = balanceDate ? sideMoney(input, BALANCE_SPEC, balanceDate) : null;

  if (!hasPreorderDetail(input)) {
    if (!money) return null;
    est = money;
    deposit = money;
  }
  if (!est || !deposit) return null;

  const settled = settlePreorder(est.price, deposit.price, balance ? balance.price : null);
  if (!PREORDER_STATUS.has(settled.preorderStatus)) return null;
  const shown = settled.finalTotalRm ?? est.price;
  return {
    ...base,
    originalAmount: est.originalAmount,
    currency: est.currency,
    fxRate: est.fxRate,
    fxDate: est.fxDate,
    fxOverridden: est.fxOverridden,
    fxCached: est.fxCached,
    price: shown,
    date: depositDate,
    ...packSide('est', est),
    ...packSide('deposit', deposit),
    depositDate,
    balanceDueRm: settled.balanceDueRm,
    ...(balance ? packSide('balance', balance) : packSide('balance', {
      originalAmount: null,
      currency: '',
      fxRate: null,
      fxDate: '',
      price: null,
      fxOverridden: false,
      fxCached: false
    })),
    balancePaidDate: balance ? balanceDate : '',
    finalTotalRm: settled.finalTotalRm,
    preorderStatus: settled.preorderStatus,
    status: derivedPurchaseStatus(boughtAs, settled.preorderStatus)
  };
}

function keptFigureType(record, input, categories) {
  if (!input || (input.figureType == null && input.figure_type == null)) return record;
  return { ...record, figureType: normalizeFigureType(input.figureType ?? input.figure_type, categories) };
}

function cleanWish(input, seen, categories = []) {
  if (!input || typeof input !== 'object') return null;
  const name = clip(input.name, 80);
  if (!name) return null;
  const addedAt = stamp(input.addedAt, 0);
  const money = cleanMoney(input, addedAt, ['amountRm', 'amount_rm', 'price']);
  if (!money) return null;
  const priority = input.priority === 'must' || input.priority === 'nice' ? input.priority : 'really';
  return keptFigureType({
    id: takeId(input, seen),
    name,
    ...money,
    priority,
    addedAt,
    updatedAt: stamp(input.updatedAt, addedAt)
  }, input, categories);
}

function cleanSale(input, seen, categories = []) {
  if (!input || typeof input !== 'object') return null;
  const name = clip(input.name, 80);
  if (!name) return null;
  const condition = SALE_CONDITIONS.has(input.condition) ? input.condition : '';
  if (!condition) return null;
  const asking = cleanMoney({
    ...input,
    price: input.price ?? input.askingPrice ?? input.asking_price_rm
  }, input.createdAt, ['amountRm', 'amount_rm', 'price', 'askingPrice', 'asking_price_rm']);
  if (!asking) return null;

  let status = input.status === 'sold' ? 'sold' : 'listed';
  const soldDate = dateOrBlank(input.soldDate ?? input.sold_date);
  let sold = null;
  if (status === 'sold') {
    sold = cleanMoney({
      originalAmount: input.soldOriginalAmount ?? input.sold_original_amount,
      currency: input.soldCurrency ?? input.sold_currency,
      fxRate: input.soldFxRate ?? input.sold_fx_rate,
      fxDate: input.soldFxDate ?? input.sold_fx_date,
      fxOverridden: input.soldFxOverridden ?? input.sold_fx_overridden,
      fxCached: input.soldFxCached ?? input.sold_fx_cached,
      price: input.soldPrice ?? input.soldAmountRm ?? input.sold_amount_rm ?? input.sold_price_rm
    }, soldDate, ['price']);
    if (!sold) status = 'listed';
  }

  const createdAt = stamp(input.createdAt, 0);
  return keptFigureType({
    id: takeId(input, seen),
    name,
    brand: clip(input.brand, 80),
    series: clip(input.series, 80),
    condition,
    ...asking,
    notes: clip(input.notes, 280),
    status,
    soldOriginalAmount: sold ? sold.originalAmount : null,
    soldCurrency: sold ? sold.currency : '',
    soldFxRate: sold ? sold.fxRate : null,
    soldFxDate: sold ? sold.fxDate : '',
    soldFxOverridden: sold ? sold.fxOverridden : false,
    soldFxCached: sold ? sold.fxCached : false,
    soldPrice: sold ? sold.price : null,
    soldDate: status === 'sold' ? soldDate : '',
    createdAt,
    updatedAt: stamp(input.updatedAt, createdAt)
  }, input, categories);
}

export function looksLikeData(input) {
  return Boolean(input)
    && typeof input === 'object'
    && !Array.isArray(input)
    && input.settings
    && typeof input.settings === 'object'
    && Array.isArray(input.purchases)
    && Array.isArray(input.wishlist);
}

export function normalizeData(input, todayYm) {
  const settings = cleanSettings(input?.settings, todayYm);
  const purchaseIds = new Set();
  const wishIds = new Set();
  const saleIds = new Set();
  return {
    settings,
    purchases: (input?.purchases || []).map((item) => cleanPurchase(item, purchaseIds, settings.categories)).filter(Boolean),
    wishlist: (input?.wishlist || []).map((item) => cleanWish(item, wishIds, settings.categories)).filter(Boolean),
    forSale: (input?.forSale || []).map((item) => cleanSale(item, saleIds, settings.categories)).filter(Boolean)
  };
}

export function exportPayload(data, exportedAt) {
  return {
    version: 3,
    exportedAt,
    settings: data.settings,
    purchases: data.purchases,
    wishlist: data.wishlist,
    forSale: data.forSale || []
  };
}

function memoryFallback() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

function storageOrDefault(storage) {
  return storage || globalThis.localStorage || memoryFallback();
}

export function load(todayYm, storage) {
  const store = storageOrDefault(storage);
  const raw = store.getItem(STORAGE_KEY);
  if (!raw) {
    const data = emptyData(todayYm);
    store.setItem(STORAGE_KEY, JSON.stringify(data));
    return { data, corrupt: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!looksLikeData(parsed)) return { data: emptyData(todayYm), corrupt: true };
    const data = normalizeData(parsed, todayYm);
    const next = JSON.stringify(data);
    if (next !== raw) store.setItem(STORAGE_KEY, next);
    return { data, corrupt: false };
  } catch {
    return { data: emptyData(todayYm), corrupt: true };
  }
}

export function save(data, storage) {
  storageOrDefault(storage).setItem(STORAGE_KEY, JSON.stringify(data));
}

export function clear(storage) {
  storageOrDefault(storage).removeItem(STORAGE_KEY);
}
