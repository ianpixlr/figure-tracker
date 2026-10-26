// Convert a typed amount into ringgit.
// Purchases use the rate for the purchase date. Everything else uses today's rate.
// Frankfurter (European Central Bank) is tried first. open.er-api.com is the fallback.
// The last good rate for each currency is kept in localStorage for offline use.

import { formatRM, toCents } from './money.js';
import { isYMD, todayYMD } from './time.js';

export const FX_CACHE_KEY = 'figure-cap.fx.v1';
export const FRANKFURTER_URL = 'https://api.frankfurter.app';
export const ER_API_URL = 'https://open.er-api.com/v6/latest';

export const QUICK_CURRENCIES = ['MYR', 'JPY', 'USD', 'CNY', 'HKD', 'SGD', 'KRW', 'EUR'];

export const OTHER_CURRENCIES = [
  'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CZK', 'DKK', 'GBP', 'HUF', 'IDR',
  'ILS', 'INR', 'ISK', 'MXN', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK',
  'THB', 'TRY', 'ZAR'
];

const SYMBOLS = {
  MYR: 'RM ',
  JPY: '¥',
  USD: 'US$',
  CNY: 'CN¥',
  HKD: 'HK$',
  SGD: 'S$',
  KRW: '₩',
  EUR: '€',
  GBP: '£'
};

const ZERO_DECIMAL = new Set(['JPY', 'KRW']);

export function moneyToMyr(amount, rate) {
  const cents = toCents(amount);
  const numericRate = Number(rate);
  if (cents == null || !Number.isFinite(numericRate) || numericRate <= 0) return null;
  return Math.round(cents * numericRate) / 100;
}

export function formatForeign(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '';
  const code = String(currency || '').toUpperCase();
  const digits = ZERO_DECIMAL.has(code) && Number.isInteger(value) ? 0 : 2;
  const formatted = new Intl.NumberFormat('en-MY', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
  const symbol = SYMBOLS[code];
  if (symbol) return `${symbol}${formatted}`;
  return `${code} ${formatted}`;
}

export function conversionText({ amount, currency, rate, cached, historical }) {
  const code = String(currency || '').toUpperCase();
  if (!code || code === 'MYR') return '';
  const rm = moneyToMyr(amount, rate);
  if (rm == null) return '';
  const line = `${formatForeign(amount, code)} ≈ ${formatRM(rm)}`;
  if (cached) return `${line} · cached rate`;
  if (!historical) return `${line} · today's rate`;
  return line;
}

export function loadFxCache(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(FX_CACHE_KEY) || '');
    if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
      return { entries: {} };
    }
    return { entries: parsed.entries };
  } catch {
    return { entries: {} };
  }
}

export function saveFxCache(storage, cache) {
  storage.setItem(FX_CACHE_KEY, JSON.stringify({ entries: cache?.entries || {} }));
}

function cacheKey(currency, date) {
  return `${currency}|${date || 'latest'}`;
}

function remember(cache, currency, date, quote) {
  if (!cache.entries) cache.entries = {};
  cache.entries[cacheKey(currency, date)] = {
    rate: quote.rate,
    fxDate: quote.fxDate,
    source: quote.source
  };
}

function recall(cache, currency, date) {
  const hit = cache?.entries?.[cacheKey(currency, date)];
  if (!hit || !Number.isFinite(Number(hit.rate)) || Number(hit.rate) <= 0) return null;
  return {
    rate: Number(hit.rate),
    fxDate: isYMD(hit.fxDate) ? hit.fxDate : '',
    source: hit.source || 'cache',
    exact: Boolean(date)
  };
}

function dateFromStamp(value) {
  const text = String(value || '');
  const match = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (match && isYMD(match[1])) return match[1];
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return '';
  return todayYMD(new Date(parsed));
}

async function readJson(response) {
  if (!response || response.ok === false) throw new Error('rate request failed');
  if (typeof response.json === 'function') return response.json();
  return JSON.parse(await response.text());
}

async function frankfurter(fetchImpl, currency, date) {
  const url = date
    ? `${FRANKFURTER_URL}/${date}?from=${encodeURIComponent(currency)}&to=MYR`
    : `${FRANKFURTER_URL}/latest?from=${encodeURIComponent(currency)}&to=MYR`;
  const body = await readJson(await fetchImpl(url));
  const rate = Number(body?.rates?.MYR);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('missing rate');
  return {
    rate,
    fxDate: isYMD(body.date) ? body.date : (date || ''),
    source: 'frankfurter'
  };
}

async function erApi(fetchImpl, currency) {
  const body = await readJson(await fetchImpl(`${ER_API_URL}/${encodeURIComponent(currency)}`));
  if (body?.result && body.result !== 'success') throw new Error('er-api');
  const rate = Number(body?.rates?.MYR);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('missing rate');
  return {
    rate,
    fxDate: dateFromStamp(body.time_last_update_utc || body.time_last_update_unix),
    source: 'er-api'
  };
}

function finish(currency, quote, extra) {
  return {
    currency,
    rate: quote.rate,
    fxDate: quote.fxDate,
    source: quote.source,
    cached: Boolean(extra.cached),
    historical: Boolean(extra.historical)
  };
}

// `date` is the purchase date, or empty/today for a live rate.
// `today` is the Malaysia calendar day the app is using.
export async function fetchMyrRate({
  currency,
  date = '',
  today,
  cache = { entries: {} },
  fetchImpl = globalThis.fetch,
  online = true
}) {
  const code = String(currency || 'MYR').trim().toUpperCase();
  const todayYmd = isYMD(today) ? today : todayYMD();
  const wanted = isYMD(date) && date <= todayYmd ? date : '';
  const past = Boolean(wanted && wanted < todayYmd);
  const future = isYMD(date) && date > todayYmd;

  if (code === 'MYR') {
    return finish(code, { rate: 1, fxDate: wanted || todayYmd, source: 'identity' }, {
      cached: false,
      historical: true
    });
  }

  const cachedExact = past ? recall(cache, code, wanted) : null;
  const cachedLatest = recall(cache, code, '');

  if (!online) {
    const hit = cachedExact || cachedLatest;
    if (!hit) {
      const error = new Error('offline');
      error.code = 'offline';
      throw error;
    }
    return finish(code, hit, { cached: true, historical: Boolean(cachedExact) });
  }

  if (past) {
    try {
      const quote = await frankfurter(fetchImpl, code, wanted);
      remember(cache, code, wanted, quote);
      if (quote.fxDate && quote.fxDate !== wanted) remember(cache, code, quote.fxDate, quote);
      return finish(code, quote, { cached: false, historical: true });
    } catch {
      // A saved rate for that day is closer than today's rate.
      if (cachedExact) return finish(code, cachedExact, { cached: true, historical: true });
    }
  }

  try {
    const quote = await frankfurter(fetchImpl, code, '');
    remember(cache, code, '', quote);
    return finish(code, quote, { cached: false, historical: past ? false : !future });
  } catch {
    // Try the fallback provider below.
  }

  try {
    const quote = await erApi(fetchImpl, code);
    remember(cache, code, '', quote);
    return finish(code, quote, { cached: false, historical: past ? false : !future });
  } catch {
    if (cachedLatest) return finish(code, cachedLatest, { cached: true, historical: false });
    const error = new Error('rate unavailable');
    error.code = 'unavailable';
    throw error;
  }
}
