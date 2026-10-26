// Purchase filters, category totals, and the latest price check for a sale.

import { fromCents, parseMoney, toCents } from './money.js';
import { isYMD } from './time.js';

export const FIGURE_TYPES = [
  { value: '', label: 'Not set' },
  { value: 'scale', label: 'Scale' },
  { value: 'nendoroid', label: 'Nendoroid' },
  { value: 'figma', label: 'Figma' },
  { value: 'prize', label: 'Prize' },
  { value: 'model-kit', label: 'Model kit' },
  { value: 'other', label: 'Other' }
];

export const BOUGHT_AS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'preorder', label: 'Pre-order' },
  { value: 'second-hand', label: 'Second-hand' }
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
  if (!value) return 'Other';
  return FIGURE_TYPES.find((item) => item.value === value)?.label || 'Other';
}

export function boughtAsLabel(value) {
  return BOUGHT_AS_OPTIONS.find((item) => item.value === value)?.label || 'New';
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
  const query = String(filters.q || '').trim().toLowerCase();
  return purchases.filter((purchase) => {
    if (!isYMD(purchase.date)) return false;
    if (year && purchase.date.slice(0, 4) !== year) return false;
    if (month && purchase.date.slice(5, 7) !== month) return false;
    if (brand && purchase.brand !== brand) return false;
    if (series && purchase.series !== series) return false;
    if (query && !String(purchase.name || '').toLowerCase().includes(query)) return false;
    return true;
  });
}

export function categoryTotals(purchases) {
  const map = new Map();
  for (const purchase of purchases) {
    const key = purchase.figureType || '';
    const row = map.get(key) || { figureType: key, count: 0, cents: 0 };
    row.count += 1;
    row.cents += toCents(figureAmount(purchase)) ?? 0;
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
