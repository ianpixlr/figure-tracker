// Purchase filters, category totals, and the latest price check for a sale.

import { capPayments } from './budget.js';
import { fromCents, parseMoney, toCents } from './money.js';
import { isYMD, todayYMD } from './time.js';

// Built-in types, in the order the chips show them. Add a type by appending one
// entry here. Not set is the empty default and stays first.
export const FIGURE_TYPES = [
  { value: '', label: 'Not set' },
  { value: 'transformers', label: 'Transformers' },
  { value: '1-12', label: '1/12' },
  { value: '1-6', label: '1/6' },
  { value: 'other', label: 'Other' },
  { value: 'model-kit', label: 'Model Kit' }
];

export const CATEGORY_MAX = 20;

// Older logs used these names. Current values are recognised before this map,
// so a new built-in type is not folded into Other on the next load.
const LEGACY_FIGURE_TYPES = {
  figma: '1-12',
  scale: 'other',
  nendoroid: 'other',
  prize: 'other',
  unknown: 'other'
};

export const BOUGHT_AS_OPTIONS = [
  { value: 'purchased', label: 'Purchased' },
  { value: 'preorder', label: 'Pre-ordered' }
];

export const PURCHASE_CONDITIONS = [
  { value: '', label: 'Not set' },
  { value: 'MISB', label: 'MISB' },
  { value: 'MIB', label: 'MIB' },
  { value: 'BIB', label: 'BIB' },
  { value: 'Loose', label: 'Loose' },
  { value: 'Other', label: 'Other' }
];

export const PURCHASE_STATUSES = [
  { value: 'received', label: 'Received' },
  { value: 'preordered', label: 'Pre-ordered' }
];

export const SALE_CONDITIONS = [
  { value: 'MISB', label: 'MISB' },
  { value: 'MIB', label: 'MIB' },
  { value: 'BIB', label: 'BIB' },
  { value: 'Loose', label: 'Loose' }
];

export const SALE_STATUSES = [
  { value: 'listed', label: 'Listed' },
  { value: 'sold', label: 'Sold' }
];

export function figureTypeLabel(value) {
  if (!value) return 'Not set';
  return FIGURE_TYPES.find((item) => item.value === value)?.label || String(value);
}

function categoryKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function normalizeFigureType(value, customCategories = []) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const direct = FIGURE_TYPES.find((item) => item.value && item.value === raw);
  if (direct) return direct.value;
  const key = categoryKey(raw);
  const byLabel = FIGURE_TYPES.find((item) => item.value && item.label.toLowerCase() === key);
  if (byLabel) return byLabel.value;
  const slug = key.replace(/[\s_]+/g, '-');
  const bySlug = FIGURE_TYPES.find((item) => item.value === slug);
  if (bySlug) return bySlug.value;
  if (LEGACY_FIGURE_TYPES[slug]) return LEGACY_FIGURE_TYPES[slug];
  const custom = customCategories.find((name) => categoryKey(name) === key);
  if (custom) return String(custom).trim();
  // Sheets turns a scale such as 1/6 into a date. Jan 6 is 1/6, Jan 12 is 1/12.
  const fromDate = figureTypeFromSheetDate(value);
  if (fromDate) return fromDate;
  return 'other';
}

// Scale chips whose label is N/M, so a future 1/4 or 1/10 is recovered the same way.
function scaleFromMonthDay(month, day) {
  const label = `${Number(month)}/${Number(day)}`;
  return FIGURE_TYPES.find((item) => item.value && item.label === label)?.value || '';
}

// Calendar dates stay as written. Instants (a trailing T) are read in Malaysia,
// so 16:00Z the day before is the next morning there.
function figureTypeFromSheetDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const parts = todayYMD(value).split('-').map(Number);
    return scaleFromMonthDay(parts[1], parts[2]);
  }
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return '';
    const parts = todayYMD(parsed).split('-').map(Number);
    return scaleFromMonthDay(parts[1], parts[2]);
  }
  const calendar = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (calendar) return scaleFromMonthDay(calendar[2], calendar[3]);
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (us) return scaleFromMonthDay(us[1], us[2]);
  return '';
}

function foldText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function searchHaystack(purchase) {
  const type = purchase.figureType ? figureTypeLabel(purchase.figureType) : '';
  return foldText([
    purchase.name,
    purchase.brand,
    purchase.series,
    purchase.shop,
    purchase.notes,
    purchase.condition,
    type
  ].join(' '));
}

export function categoryError(name, customCategories = []) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return 'Enter a category name.';
  if (trimmed.length > CATEGORY_MAX) return 'Use 20 characters or fewer.';
  const key = categoryKey(trimmed);
  const slug = key.replace(/[\s_]+/g, '-');
  const builtIn = FIGURE_TYPES.some((item) => {
    const label = item.label.toLowerCase();
    if (label === key || label.replace(/[\s_]+/g, '-') === slug) return true;
    return Boolean(item.value) && (item.value.toLowerCase() === key || item.value === slug);
  });
  if (builtIn || LEGACY_FIGURE_TYPES[slug]) return 'That category already exists.';
  if (customCategories.some((item) => categoryKey(item) === key)) return 'That category already exists.';
  return '';
}

export function cleanCategories(list) {
  const names = [];
  for (const item of Array.isArray(list) ? list : []) {
    const name = String(item ?? '').trim();
    if (categoryError(name, names)) continue;
    names.push(name);
  }
  return names;
}

export function boughtAsLabel(value) {
  return BOUGHT_AS_OPTIONS.find((item) => item.value === value)?.label || 'Purchased';
}

// Older logs used New and Second-hand. Both are purchases; condition covers used figures.
export function normalizeBoughtAs(value, legacyType) {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (raw === 'preorder' || raw === 'pre-order' || raw === 'preordered' || raw === 'pre-ordered') return 'preorder';
  if (raw === 'purchased' || raw === 'new' || raw === 'second-hand' || raw === 'secondhand') return 'purchased';
  if (legacyType === 'preorder') return 'preorder';
  return 'purchased';
}

// Purchased figures are received. A pre-order stays pre-ordered until the balance is fully paid.
export function derivedPurchaseStatus(boughtAs, preorderStatus) {
  if (normalizeBoughtAs(boughtAs) === 'preorder' && preorderStatus !== 'fully paid') return 'preordered';
  return 'received';
}

export function purchaseStatusLabel(value) {
  return PURCHASE_STATUSES.find((item) => item.value === value)?.label || 'Received';
}

export function saleStatusLabel(value) {
  return SALE_STATUSES.find((item) => item.value === value)?.label || 'Listed';
}

export function figureAmount(purchase) {
  if ((purchase.boughtAs === 'preorder' || purchase.type === 'preorder') && purchase.preorderStatus === 'fully paid' && purchase.finalTotalRm != null) {
    return purchase.finalTotalRm;
  }
  if ((purchase.boughtAs === 'preorder' || purchase.type === 'preorder') && purchase.estFullPrice != null) {
    return purchase.estFullPrice;
  }
  return purchase.price;
}

export function preorderStatusLabel(value) {
  if (value === 'deposit paid') return 'Deposit paid';
  if (value === 'fully paid') return 'Fully paid';
  return '';
}

export function filterPurchases(purchases, filters = {}) {
  const year = String(filters.year || '');
  const month = String(filters.month || '');
  const brand = String(filters.brand || '');
  const series = String(filters.series || '');
  const type = String(filters.type || '');
  const words = foldText(filters.q).trim().split(/\s+/).filter(Boolean);
  return purchases.filter((purchase) => {
    if (!isYMD(purchase.date)) return false;
    if (year && purchase.date.slice(0, 4) !== year) return false;
    if (month && purchase.date.slice(5, 7) !== month) return false;
    if (brand && purchase.brand !== brand) return false;
    if (series && purchase.series !== series) return false;
    if (type && (purchase.figureType || '') !== type) return false;
    if (words.length) {
      const haystack = searchHaystack(purchase);
      if (!words.every((word) => haystack.includes(word))) return false;
    }
    return true;
  });
}

// Chips are rebuilt from the purchases on screen, so a figure saved a moment
// ago shows up the next time Filter is opened. A chosen year (or any other
// active filter) drops options that would match nothing.
export function purchaseFilterOptions(purchases, filters = {}) {
  const list = Array.isArray(purchases) ? purchases : [];
  const pick = (skip) => filterPurchases(list, { ...filters, q: '', [skip]: '' });
  const years = [...new Set(pick('year').map((purchase) => purchase.date.slice(0, 4)))]
    .sort((a, b) => (a < b ? 1 : -1));
  const months = [...new Set(pick('month').map((purchase) => purchase.date.slice(5, 7)))].sort();
  const brands = distinctValues(pick('brand'), 'brand');
  const series = distinctValues(pick('series'), 'series');
  const rank = new Map(FIGURE_TYPES.map((item, index) => [item.value, index]));
  const types = [...new Set(pick('type').map((purchase) => purchase.figureType || '').filter(Boolean))]
    .sort((a, b) => {
      const left = rank.has(a) ? rank.get(a) : FIGURE_TYPES.length;
      const right = rank.has(b) ? rank.get(b) : FIGURE_TYPES.length;
      if (left !== right) return left - right;
      return figureTypeLabel(a).localeCompare(figureTypeLabel(b));
    })
    .map((value) => ({ value, label: figureTypeLabel(value) }));
  return { years, months, brands, series, types };
}

// Money actually paid on these purchases. A year or month keeps each payment
// in the month it was paid, so an October balance is not September spend.
export function categoryTotals(purchases, range = {}) {
  const year = String(range.year || '');
  const month = String(range.month || '');
  const map = new Map();
  for (const purchase of purchases) {
    const key = purchase.figureType || '';
    const row = map.get(key) || { figureType: key, count: 0, cents: 0 };
    row.count += 1;
    for (const payment of capPayments(purchase)) {
      if (!isYMD(payment.date)) continue;
      if (year && payment.date.slice(0, 4) !== year) continue;
      if (month && payment.date.slice(5, 7) !== month) continue;
      row.cents += toCents(payment.amount) ?? 0;
    }
    map.set(key, row);
  }
  return [...map.values()]
    .map((row) => ({
      figureType: row.figureType,
      label: figureTypeLabel(row.figureType),
      count: row.count,
      total: fromCents(row.cents)
    }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

export function distinctValues(purchases, key) {
  return [...new Set(purchases.map((purchase) => String(purchase[key] || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function stamp(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!match) return 0;
  const parsed = Date.parse(`${match[1]}T${match[2] || '00'}:${match[3] || '00'}:00Z`);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function newest(checks) {
  return checks.slice().sort((a, b) => stamp(b.checked_at) - stamp(a.checked_at))[0] || null;
}

// Prefer a row that names this listing. Otherwise match the figure and condition.
export function latestPriceCheck(item, checks) {
  if (!item || !Array.isArray(checks) || !checks.length) return null;
  const id = String(item.id || '');
  const byId = checks.filter((check) => String(check?.for_sale_id || '') === id && id);
  if (byId.length) return newest(byId);
  const name = String(item.name || '').trim().toLowerCase();
  const condition = String(item.condition || '').trim().toLowerCase();
  const byName = checks.filter((check) => {
    if (!check || typeof check !== 'object') return false;
    return String(check.figure || '').trim().toLowerCase() === name
      && String(check.condition || '').trim().toLowerCase() === condition;
  });
  return newest(byName);
}

export function priceCheckAmount(value) {
  return parseMoney(value);
}

const FIVE_CENTS = 500;

function nearestFive(amount) {
  const cents = toCents(amount);
  if (cents == null) return null;
  return fromCents(Math.round(cents / FIVE_CENTS) * FIVE_CENTS);
}

function downFive(amount) {
  const cents = toCents(amount);
  if (cents == null) return null;
  return fromCents(Math.floor(cents / FIVE_CENTS) * FIVE_CENTS);
}

function listingCount(check) {
  const raw = check?.listing_count;
  if (raw == null || String(raw).trim() === '') return null;
  const count = Number(raw);
  if (!Number.isFinite(count)) return null;
  return count;
}

function checksForSale(item, checks) {
  const id = String(item?.id || '');
  const name = String(item?.name || '').trim().toLowerCase();
  return (Array.isArray(checks) ? checks : []).filter((check) => {
    if (!check || typeof check !== 'object') return false;
    if (id && String(check.for_sale_id || '') === id) return true;
    return name && String(check.figure || '').trim().toLowerCase() === name;
  });
}

// The listing's own condition first. Otherwise the latest check for this figure.
function suggestionCheck(item, checks) {
  const mine = checksForSale(item, checks);
  const condition = String(item?.condition || '').trim().toLowerCase();
  const matched = mine.filter((check) => String(check.condition || '').trim().toLowerCase() === condition);
  return newest(matched.length ? matched : mine);
}

function textKey(value) {
  return String(value || '').trim().toLowerCase();
}

function paidRm(purchase) {
  const cents = capPayments(purchase).reduce((sum, payment) => sum + (toCents(payment.amount) ?? 0), 0);
  return cents > 0 ? fromCents(cents) : null;
}

// Same figure name. Brand and series count only when the listing has them.
function paidForSale(item, purchases) {
  const name = textKey(item?.name);
  if (!name) return null;
  const brand = textKey(item?.brand);
  const series = textKey(item?.series);
  const matches = (Array.isArray(purchases) ? purchases : []).filter((purchase) => {
    if (textKey(purchase?.name) !== name) return false;
    if (brand && textKey(purchase.brand) !== brand) return false;
    if (series && textKey(purchase.series) !== series) return false;
    return paidRm(purchase) != null;
  });
  matches.sort((a, b) => (
    String(b.date || '').localeCompare(String(a.date || ''))
    || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  ));
  return matches.length ? paidRm(matches[0]) : null;
}

// List / drop / floor from one price check. Null when the check cannot be used.
export function saleSuggestion(item, checks, purchases = []) {
  const check = suggestionCheck(item, checks);
  if (!check) return null;
  const count = listingCount(check);
  if (count === 0) return null;
  const typical = priceCheckAmount(check.typical_rm);
  if (typical == null || typical <= 0) return null;
  const low = priceCheckAmount(check.low_rm);
  const hasLow = low != null && low > 0;
  const fewListings = count == null || count < 3 || !hasLow;
  const listAt = Math.max(5, nearestFive(typical));
  const mid = hasLow ? (typical + low) / 2 : typical * 0.925;
  const dropTo = Math.min(listAt, nearestFive(mid));
  const eightyFive = Math.floor(toCents(typical) * 85 / 100);
  const rawFloor = fewListings ? fromCents(Math.floor(eightyFive / FIVE_CENTS) * FIVE_CENTS) : downFive(low);
  const floor = Math.min(dropTo, rawFloor);
  const asking = priceCheckAmount(item?.price);
  const paid = paidForSale(item, purchases);
  const abovePaid = paid != null && toCents(listAt) * 5 >= toCents(paid) * 6;
  let headsUp = '';
  if (asking != null && asking < dropTo) {
    headsUp = 'Market is above your asking price. You could list higher.';
  } else if (abovePaid) {
    headsUp = 'Market is above what you paid. You could list higher.';
  }
  return {
    listAt,
    dropTo,
    floor,
    fewListings,
    listingCount: count,
    condition: String(check.condition || '').trim(),
    headsUp
  };
}

// Asking totals and money already received. A listing with no price is left out.
export function saleTotals(items) {
  let asking = 0;
  let earned = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.price != null && item.price !== '') {
      const cents = toCents(item.price);
      if (cents != null && cents > 0) asking += cents;
    }
    if (item?.status === 'sold' && item?.soldPrice != null && item.soldPrice !== '') {
      const cents = toCents(item.soldPrice);
      if (cents != null && cents > 0) earned += cents;
    }
  }
  return { asking: fromCents(asking), earned: fromCents(earned) };
}

// Name, then series, unless the series is already written in the name.
function figureSearchQuery(name, series) {
  const figure = String(name || '').trim();
  const line = String(series || '').trim();
  if (!line || figure.toLowerCase().includes(line.toLowerCase())) return figure;
  return [figure, line].filter(Boolean).join(' ');
}

export function carousellSearchUrl(name, series) {
  return `https://www.carousell.com.my/search/${encodeURIComponent(figureSearchQuery(name, series))}`;
}

export function rrpSearchUrl(name, series) {
  const query = [figureSearchQuery(name, series), 'RRP'].filter(Boolean).join(' ');
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}
