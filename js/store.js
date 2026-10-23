// All of Ian's data lives in localStorage. Nothing is sent anywhere.

import { parseMoney } from './money.js';
import { isMonth, isYMD } from './time.js';

export const STORAGE_KEY = 'figure-cap.v1';
export const MAX_MONEY = 1000000;
export const MAX_WAIT_HOURS = 720;

export const MOODS = [
  { value: '', label: 'None' },
  { value: 'excited', label: 'Excited' },
  { value: 'bored', label: 'Bored' },
  { value: 'stressed', label: 'Stressed' },
  { value: 'treat', label: 'A treat' }
];

export const PURCHASE_TYPES = [
  { value: 'bought', label: 'Bought' },
  { value: 'preorder', label: 'Pre-order paid in full' }
];

const MOOD_VALUES = new Set(MOODS.map((mood) => mood.value));

export function typeLabel(type) {
  return PURCHASE_TYPES.find((item) => item.value === type)?.label || 'Bought';
}

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
      trackingStart: todayYm
    },
    purchases: [],
    wishlist: []
  };
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
    trackingStart: isMonth(source?.trackingStart) ? source.trackingStart : todayYm
  };
}

function cleanPurchase(input, seen) {
  if (!input || typeof input !== 'object') return null;
  const name = String(input.name ?? '').trim();
  const price = parseMoney(input.price);
  const date = String(input.date ?? '');
  if (!name || price == null || price <= 0 || price > MAX_MONEY || !isYMD(date)) return null;
  if (input.type !== 'bought' && input.type !== 'preorder') return null;

  let id = String(input.id || uid());
  if (seen.has(id)) id = uid();
  seen.add(id);

  const created = Date.parse(input.createdAt);
  return {
    id,
    name: name.slice(0, 80),
    price,
    date,
    type: input.type,
    note: String(input.note ?? '').trim().slice(0, 280),
    mood: MOOD_VALUES.has(input.mood) ? input.mood : '',
    createdAt: Number.isNaN(created) ? new Date(0).toISOString() : new Date(created).toISOString()
  };
}

function cleanWish(input, seen) {
  if (!input || typeof input !== 'object') return null;
  const name = String(input.name ?? '').trim();
  const price = parseMoney(input.price);
  if (!name || price == null || price <= 0 || price > MAX_MONEY) return null;

  let id = String(input.id || uid());
  if (seen.has(id)) id = uid();
  seen.add(id);

  const priority = input.priority === 'must' || input.priority === 'nice' ? input.priority : 'really';
  const added = Date.parse(input.addedAt);
  return {
    id,
    name: name.slice(0, 80),
    price,
    priority,
    addedAt: Number.isNaN(added) ? new Date(0).toISOString() : new Date(added).toISOString()
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
  return {
    settings,
    purchases: (input?.purchases || []).map((item) => cleanPurchase(item, purchaseIds)).filter(Boolean),
    wishlist: (input?.wishlist || []).map((item) => cleanWish(item, wishIds)).filter(Boolean)
  };
}

export function exportPayload(data, exportedAt) {
  return {
    version: 1,
    exportedAt,
    settings: data.settings,
    purchases: data.purchases,
    wishlist: data.wishlist
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
    return { data: normalizeData(parsed, todayYm), corrupt: false };
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
