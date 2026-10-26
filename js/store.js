// Purchases, the wishlist, and figures for sale live in localStorage.
// When a sheet web app URL is set, js/sync.js also sends those records.
// Existing saves used `type` and `note`. Loading rewrites them into the
// current shape and keeps the ringgit amount the cap already used.

import { parseMoney } from './money.js';
import { isMonth, isYMD } from './time.js';

export const STORAGE_KEY = 'figure-cap.v1';
export const MAX_MONEY = 1000000;
export const MAX_FOREIGN = 100000000;
export const MAX_WAIT_HOURS = 720;

export const MOODS = [
  { value: '', label: 'None' },
  { value: 'excited', label: 'Excited' },
  { value: 'bored', label: 'Bored' },
  { value: 'stressed', label: 'Stressed' },
  { value: 'treat', label: 'A treat' }
];

const MOOD_VALUES = new Set(MOODS.map((mood) => mood.value));
const FIGURE_TYPES = new Set(['', 'scale', 'nendoroid', 'figma', 'prize', 'model-kit', 'other']);
const BOUGHT_AS = new Set(['new', 'preorder', 'second-hand']);
const PURCHASE_CONDITIONS = new Set(['', 'MISB', 'MIB', 'BIB', 'Loose', 'Other']);
const SALE_CONDITIONS = new Set(['MISB', 'MIB', 'BIB', 'Loose']);

export function moodLabel(mood) {
  if (!mood) return '';
  return MOODS.find((item) => item.value === mood)?.label || '';
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function emptyData(todayYm) {
  return {
    settings: {
      monthlyCap: 400,
      waitHours: 0,
      rollover: false,
      trackingStart: todayYm,
      syncUrl: ''
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

  let wait = Number(source?.waitHours);
  if (!Number.isFinite(wait) || wait < 0) wait = 0;
  wait = Math.round(wait);
  if (wait > MAX_WAIT_HOURS) wait = MAX_WAIT_HOURS;

  return {
    monthlyCap: cap,
    waitHours: wait,
    rollover: Boolean(source?.rollover),
    trackingStart: isMonth(source?.trackingStart) ? source.trackingStart : todayYm,
    syncUrl: clip(source?.syncUrl, 500)
  };
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

function cleanPurchase(input, seen) {
  if (!input || typeof input !== 'object') return null;
  const name = clip(input.name, 80);
  const date = String(input.date ?? '');
  if (!name || !isYMD(date)) return null;

  let boughtAs = BOUGHT_AS.has(input.boughtAs) ? input.boughtAs : '';
  if (!boughtAs) boughtAs = input.type === 'preorder' ? 'preorder' : 'new';
  let status = input.status === 'preordered' || input.status === 'received' ? input.status : '';
  if (!status) status = boughtAs === 'preorder' ? 'preordered' : 'received';

  let figureType = FIGURE_TYPES.has(input.figureType) ? input.figureType : '';
  if (!figureType && FIGURE_TYPES.has(input.type) && input.type) figureType = input.type;

  const money = cleanMoney(input, date, ['amountRm', 'amount_rm', 'price']);
  if (!money) return null;

  const createdAt = stamp(input.createdAt, 0);
  return {
    id: takeId(input, seen),
    name,
    series: clip(input.series, 80),
    brand: clip(input.brand, 80),
    figureType,
    boughtAs,
    condition: PURCHASE_CONDITIONS.has(input.condition) ? input.condition : '',
    ...money,
    date,
    shop: clip(input.shop, 80),
    status,
    notes: clip(input.notes ?? input.note, 280),
    mood: MOOD_VALUES.has(input.mood) ? input.mood : '',
    createdAt,
    updatedAt: stamp(input.updatedAt, createdAt)
  };
}

function cleanWish(input, seen) {
  if (!input || typeof input !== 'object') return null;
  const name = clip(input.name, 80);
  if (!name) return null;
  const addedAt = stamp(input.addedAt, 0);
  const money = cleanMoney(input, addedAt, ['amountRm', 'amount_rm', 'price']);
  if (!money) return null;
  const priority = input.priority === 'must' || input.priority === 'nice' ? input.priority : 'really';
  return {
    id: takeId(input, seen),
    name,
    ...money,
    priority,
    addedAt,
    updatedAt: stamp(input.updatedAt, addedAt)
  };
}

function cleanSale(input, seen) {
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
  return {
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
  };
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
    purchases: (input?.purchases || []).map((item) => cleanPurchase(item, purchaseIds)).filter(Boolean),
    wishlist: (input?.wishlist || []).map((item) => cleanWish(item, wishIds)).filter(Boolean),
    forSale: (input?.forSale || []).map((item) => cleanSale(item, saleIds)).filter(Boolean)
  };
}

export function exportPayload(data, exportedAt) {
  return {
    version: 2,
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
