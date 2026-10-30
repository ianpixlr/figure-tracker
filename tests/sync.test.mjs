import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { normalizeData } from '../js/store.js';

import {
  DEFAULT_SYNC_URL,
  PURCHASE_COLUMNS,
  SALE_COLUMNS,
  SYNC_TOKEN,
  WISHLIST_COLUMNS,
  PRICE_CHECK_COLUMNS,
  cachedPriceChecks,
  enqueueAppendCheck,
  enqueueDelete,
  enqueueUpsert,
  flushQueue,
  isConfiguredUrl,
  mergeSheet,
  onSheetMerge,
  priceCheckRow,
  purchaseFromRow,
  purchaseRow,
  rememberLocalCheck,
  resolveSyncUrl,
  readQueue,
  resetSyncForTests,
  saleFromRow,
  saleRow,
  syncAllBody,
  syncAllNow,
  syncStatusLabel,
  wishFromRow,
  wishRow
} from '../js/sync.js';

const script = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

function headers(name) {
  const match = script.match(new RegExp(`${name}':\\s*\\[([\\s\\S]*?)\\]`));
  assert.ok(match, name);
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}

function samplePurchase() {
  return {
    id: 'p1',
    date: '2026-09-15',
    name: 'Asuka',
    series: 'Eva',
    brand: 'Good Smile',
    figureType: 'transformers',
    boughtAs: 'preorder',
    condition: 'MISB',
    originalAmount: 12800,
    currency: 'JPY',
    fxRate: 0.03055,
    fxDate: '2026-09-15',
    price: 391.04,
    fxOverridden: true,
    fxCached: false,
    shop: 'AmiAmi',
    status: 'preordered',
    notes: 'shelf',
    createdAt: '2026-09-15T04:00:00.000Z',
    updatedAt: '2026-09-15T04:00:00.000Z'
  };
}

test('the deployed web app is the default sync address', () => {
  assert.equal(
    DEFAULT_SYNC_URL,
    'https://script.google.com/macros/s/AKfycbzyj824VHT6WrJLZhHw-ufaf4tAT6BkvqQa3Ck_VloV2kV5vnP8JPpr3XKrOeAdzfjX4g/exec'
  );
  assert.equal(isConfiguredUrl(DEFAULT_SYNC_URL), true);
  assert.equal(resolveSyncUrl({ syncUrl: '' }), DEFAULT_SYNC_URL);
  assert.equal(isConfiguredUrl(''), false);
  assert.equal(isConfiguredUrl('PASTE_WEB_APP_URL'), false);
  assert.equal(isConfiguredUrl('https://script.google.com/macros/s/abc/exec'), true);
  assert.match(script, new RegExp(`var SYNC_TOKEN = '${SYNC_TOKEN}'`));
  assert.match(script, /1T6r59M_WNSqRt6nfQhOyVwyHVuQtlvi6JabgwLnfk60/);
});

test('scale labels are written to the sheet as plain text', () => {
  const textColumns = script.slice(script.indexOf('var TEXT_COLUMNS'), script.indexOf('function json'));
  for (const header of ['name', 'series', 'brand', 'type', 'condition']) {
    assert.match(textColumns, new RegExp(`${header}:\\s*true`));
  }
  const formats = script.slice(script.indexOf('function applyFormats'), script.indexOf('function ensureRow'));
  assert.match(formats, /getMaxRows\(\)/);
  assert.match(formats, /sheet\.getRange\(2, index \+ 1, rows, 1\)/);
  assert.match(formats, /TEXT_COLUMNS\[header\]/);
  assert.match(formats, /setNumberFormat\('@'\)/);
  const write = script.slice(script.indexOf('function writeRow'), script.indexOf('function asDateOnly'));
  assert.match(write, /setNumberFormat\('@'\)/);
  const flushAt = write.indexOf('SpreadsheetApp.flush()');
  const valueAt = write.lastIndexOf('setValue');
  assert.ok(flushAt !== -1 && valueAt > flushAt, 'text values are written after the @ format is flushed');
  assert.match(script, /function ensureRow/);
});

test('sheet headers match the rows the app sends', () => {
  assert.equal(PURCHASE_COLUMNS.includes('mood'), false);
  assert.deepEqual(headers('Purchases'), PURCHASE_COLUMNS);
  assert.deepEqual(headers('Wishlist'), WISHLIST_COLUMNS);
  assert.deepEqual(headers('For Sale'), SALE_COLUMNS);
  assert.deepEqual(headers('Price Checks'), [
    'for_sale_id', 'figure', 'rrp', 'rrp_source', 'condition',
    'low_rm', 'typical_rm', 'high_rm', 'listing_count', 'sample_links', 'sources', 'checked_at'
  ]);
  assert.deepEqual(Object.keys(purchaseRow(samplePurchase())), PURCHASE_COLUMNS);
  const row = purchaseRow(samplePurchase());
  assert.equal(row.original_amount, 12800);
  assert.equal(row.currency, 'JPY');
  assert.equal(row.fx_rate, 0.03055);
  assert.equal(row.fx_date, '2026-09-15');
  assert.equal(row.amount_rm, 391.04);
  assert.equal(row.fx_overridden, 'yes');
  assert.equal(row.type, 'Transformers');
  assert.equal(purchaseRow({ ...samplePurchase(), figureType: '1-6' }).type, '1/6');
  assert.equal(purchaseRow({ ...samplePurchase(), figureType: '1-12' }).type, '1/12');
  assert.equal(purchaseRow({ ...samplePurchase(), figureType: 'model-kit' }).type, 'Model Kit');
  assert.equal(purchaseRow({ ...samplePurchase(), figureType: 'Movie' }).type, 'Movie');
  assert.equal(purchaseRow({ ...samplePurchase(), figureType: '' }).type, '');
  assert.equal(row.bought_as, 'Pre-ordered');
  assert.equal(row.status, 'Pre-ordered');
  const purchased = purchaseRow({ ...samplePurchase(), boughtAs: 'purchased', status: 'received' });
  assert.equal(purchased.bought_as, 'Purchased');
  assert.equal(purchased.status, 'Received');
  const sixth = purchaseRow({
    ...samplePurchase(),
    figureType: '1-6',
    boughtAs: 'purchased',
    status: 'received',
    originalAmount: 40,
    currency: 'MYR',
    fxRate: 1,
    price: 40,
    fxOverridden: false
  });
  assert.equal(sixth.type, '1/6');
  const roundTrip = normalizeData({
    settings: { monthlyCap: 400, trackingStart: '2026-09', categories: [] },
    purchases: [sixth],
    wishlist: [],
    forSale: []
  }, '2026-10');
  assert.equal(roundTrip.purchases.length, 1);
  assert.equal(roundTrip.purchases[0].figureType, '1-6');
  assert.equal(roundTrip.purchases[0].boughtAs, 'purchased');
  assert.equal(purchaseRow(roundTrip.purchases[0]).type, '1/6');
  const healed = normalizeData({
    settings: { monthlyCap: 400, trackingStart: '2026-09', categories: [] },
    purchases: [{ ...sixth, type: '2026-01-06' }, { ...sixth, id: 'us', type: '1/6/2026' }],
    wishlist: [],
    forSale: []
  }, '2026-10');
  assert.deepEqual(healed.purchases.map((item) => purchaseRow(item).type), ['1/6', '1/6']);
  assert.equal(row.preorder_status, '');
  assert.equal(row.mood, undefined);
  const open = purchaseRow({
    id: 'po',
    date: '2026-10-02',
    name: 'Rei',
    series: 'Eva',
    brand: 'Good Smile',
    figureType: '1-6',
    boughtAs: 'preorder',
    condition: 'MISB',
    originalAmount: 200,
    currency: 'MYR',
    fxRate: 1,
    fxDate: '2026-10-02',
    price: 200,
    fxOverridden: false,
    fxCached: false,
    shop: '',
    status: 'preordered',
    notes: '',
    estFullOriginalAmount: 200,
    estFullCurrency: 'MYR',
    estFullFxRate: 1,
    estFullFxDate: '2026-10-02',
    estFullPrice: 200,
    estFullFxOverridden: false,
    estFullFxCached: false,
    depositOriginalAmount: 40,
    depositCurrency: 'MYR',
    depositFxRate: 1,
    depositFxDate: '2026-10-02',
    depositAmountRm: 40,
    depositFxOverridden: false,
    depositFxCached: false,
    depositDate: '2026-10-02',
    balanceDueRm: 160,
    balancePaidOriginalAmount: null,
    balancePaidRm: null,
    finalTotalRm: null,
    preorderStatus: 'deposit paid',
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z'
  });
  assert.equal(open.type, '1/6');
  assert.equal(open.est_full_price, 200);
  assert.equal(open.deposit_amount_rm, 40);
  assert.equal(open.deposit_date, '2026-10-02');
  assert.equal(open.balance_due_rm, 160);
  assert.equal(open.balance_paid_rm, '');
  assert.equal(open.final_total_rm, '');
  assert.equal(open.preorder_status, 'deposit paid');
  const wish = wishRow({
    id: 'w1',
    name: 'Rei',
    originalAmount: 80,
    currency: 'MYR',
    fxRate: 1,
    fxDate: '2026-10-02',
    price: 80,
    fxOverridden: false,
    fxCached: false,
    priority: 'really',
    addedAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z'
  });
  assert.deepEqual(Object.keys(wish), WISHLIST_COLUMNS);
  assert.equal(wish.amount_rm, 80);
  const sale = saleRow({
    id: 's1',
    name: 'Rei',
    brand: 'Bandai',
    series: 'Eva',
    condition: 'Loose',
    originalAmount: 50,
    currency: 'MYR',
    fxRate: 1,
    fxDate: '2026-10-02',
    price: 50,
    fxOverridden: false,
    fxCached: false,
    notes: '',
    status: 'listed',
    soldOriginalAmount: null,
    soldCurrency: '',
    soldFxRate: null,
    soldFxDate: '',
    soldFxOverridden: false,
    soldFxCached: false,
    soldPrice: null,
    soldDate: '',
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z'
  });
  assert.deepEqual(Object.keys(sale), SALE_COLUMNS);
  assert.equal(sale.amount_rm, 50);
  const unpriced = saleRow({
    ...{
      id: 's2',
      name: 'Mindwipe',
      brand: 'Hasbro',
      series: 'Titans Return',
      condition: 'Loose',
      originalAmount: null,
      currency: '',
      fxRate: null,
      fxDate: '',
      price: null,
      fxOverridden: false,
      fxCached: false,
      notes: '',
      status: 'listed',
      soldOriginalAmount: null,
      soldCurrency: '',
      soldFxRate: null,
      soldFxDate: '',
      soldFxOverridden: false,
      soldFxCached: false,
      soldPrice: null,
      soldDate: '',
      createdAt: '2026-10-02T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z'
    }
  });
  assert.equal(unpriced.amount_rm, '');
  assert.equal(unpriced.original_amount, '');
  assert.equal(unpriced.fx_rate, '');
  assert.notEqual(unpriced.amount_rm, 0);
  const reloaded = normalizeData({
    settings: { monthlyCap: 400, trackingStart: '2026-10', categories: [] },
    purchases: [],
    wishlist: [],
    forSale: [unpriced]
  }, '2026-10');
  assert.equal(reloaded.forSale.length, 1);
  assert.equal(reloaded.forSale[0].price, null);
  assert.equal(saleRow(reloaded.forSale[0]).amount_rm, '');
  const outgoing = script.slice(script.indexOf('function outgoing'), script.indexOf('function findRow'));
  assert.match(outgoing, /String\(value\)\.trim\(\) === ''/);
  assert.ok(outgoing.indexOf("return ''") < outgoing.indexOf('Number(value)'));
});

test('the queue keeps the latest upsert and lets a delete replace it', () => {
  resetSyncForTests();
  enqueueUpsert('Purchases', { id: 'a', name: 'One' });
  enqueueUpsert('Purchases', { id: 'a', name: 'Two' });
  enqueueUpsert('Wishlist', { id: 'a', name: 'Wish' });
  assert.equal(readQueue().length, 2);
  assert.equal(readQueue().find((op) => op.sheet === 'Purchases').row.name, 'Two');
  enqueueDelete('Purchases', 'a');
  const purchase = readQueue().find((op) => op.sheet === 'Purchases');
  assert.equal(purchase.op, 'delete');
  assert.equal(purchase.row, undefined);
  assert.equal(readQueue().some((op) => op.sheet === 'Wishlist'), true);
});

test('posts are text/plain and a full sync does not send price checks', async () => {
  resetSyncForTests();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === 'GET') {
      return {
        ok: true,
        text: async () => JSON.stringify({
          ok: true,
          priceChecks: [{ for_sale_id: 's1', figure: 'Asuka', condition: 'MISB', low_rm: 20, checked_at: '2026-10-01' }]
        })
      };
    }
    return { ok: true, text: async () => JSON.stringify({ ok: true }) };
  };
  const data = {
    settings: { syncUrl: 'https://example.com/exec' },
    purchases: [samplePurchase()],
    wishlist: [],
    forSale: []
  };
  enqueueUpsert('Purchases', purchaseRow(samplePurchase()));
  const flushed = await flushQueue(() => data, { fetchImpl, online: true });
  assert.equal(flushed.ok, true);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'text/plain;charset=utf-8');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.token, SYNC_TOKEN);
  assert.equal(body.action, 'upsert');
  assert.equal(body.row.amount_rm, 391.04);
  assert.equal(body.row.currency, 'JPY');
  assert.equal(readQueue().length, 0);
  assert.equal(cachedPriceChecks()[0].low_rm, 20);

  calls.length = 0;
  enqueueUpsert('Purchases', purchaseRow(samplePurchase()));
  const offline = await flushQueue(() => data, { fetchImpl, online: false });
  assert.equal(offline.ok, false);
  assert.equal(calls.length, 0);
  assert.match(syncStatusLabel(), /Offline · 1 waiting/);

  const all = await syncAllNow(data, { fetchImpl, online: true });
  assert.equal(all.ok, true);
  const posted = JSON.parse(calls.find((call) => call.init.method === 'POST').init.body);
  assert.equal(posted.action, 'syncAll');
  assert.equal(posted.purchases[0].original_amount, 12800);
  assert.equal(posted.priceChecks, undefined);
  assert.deepEqual(syncAllBody(data).purchases[0].currency, 'JPY');
  assert.equal(syncStatusLabel(), 'Synced');
});

test('a full sync keeps a queued wishlist add that this device has not stored', async () => {
  resetSyncForTests();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === 'GET') return { ok: true, text: async () => JSON.stringify({ ok: true, priceChecks: [] }) };
    return { ok: true, text: async () => JSON.stringify({ ok: true }) };
  };
  const wish = wishRow({
    id: 'wish-1',
    name: 'Grail',
    originalAmount: 80,
    currency: 'MYR',
    fxRate: 1,
    fxDate: '2026-10-26',
    price: 80,
    fxOverridden: false,
    fxCached: false,
    priority: 'must',
    addedAt: '2026-10-26T03:00:00.000Z',
    updatedAt: '2026-10-26T03:00:00.000Z'
  });
  assert.deepEqual(Object.keys(wish), WISHLIST_COLUMNS);
  assert.deepEqual(Object.keys(wish), headers('Wishlist'));
  assert.equal(wish.id, 'wish-1');
  assert.equal(wish.priority, 'Must have');
  assert.equal(wish.amount_rm, 80);
  enqueueUpsert('Wishlist', wish);
  const data = {
    settings: { syncUrl: 'https://example.com/exec' },
    purchases: [samplePurchase()],
    wishlist: [],
    forSale: [{ id: 'sale-1', name: 'Mindwipe', brand: 'Hasbro', series: 'Titans Return', condition: 'Loose', originalAmount: 60, currency: 'MYR', fxRate: 1, fxDate: '2026-10-26', price: 60, fxOverridden: false, fxCached: false, notes: '', status: 'listed', createdAt: '2026-10-26T03:00:00.000Z', updatedAt: '2026-10-26T03:00:00.000Z' }]
  };
  const result = await syncAllNow(data, { fetchImpl, online: true });
  assert.equal(result.ok, true);
  const posted = JSON.parse(calls.find((call) => call.init?.method === 'POST').init.body);
  assert.equal(posted.action, 'syncAll');
  assert.equal(posted.wishlist.length, 1);
  assert.equal(posted.wishlist[0].id, 'wish-1');
  assert.equal(posted.wishlist[0].name, 'Grail');
  assert.equal(posted.purchases.length, 1);
  assert.equal(posted.forSale.length, 1);
  assert.equal(readQueue().length, 0);
  assert.match(script, /if \(!incoming\.length && sheetHasIds\(repaired\.sheet, idIndex\)\) return;/);
});

test('a full sync does not treat an empty wishlist as deleting the last wish', async () => {
  resetSyncForTests();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === 'GET') return { ok: true, text: async () => JSON.stringify({ ok: true, priceChecks: [] }) };
    return { ok: true, text: async () => JSON.stringify({ ok: true }) };
  };
  enqueueDelete('Wishlist', 'wish-1');
  const data = {
    settings: { syncUrl: 'https://example.com/exec' },
    purchases: [],
    wishlist: [],
    forSale: []
  };
  const result = await syncAllNow(data, { fetchImpl, online: true });
  assert.equal(result.ok, true);
  const bodies = calls.filter((call) => call.init?.method === 'POST').map((call) => JSON.parse(call.init.body));
  assert.equal(bodies[0].action, 'syncAll');
  assert.deepEqual(bodies[0].wishlist, []);
  assert.equal(bodies[1].action, 'delete');
  assert.equal(bodies[1].sheet, 'Wishlist');
  assert.equal(bodies[1].id, 'wish-1');
  assert.equal(readQueue().length, 0);
});

test('adding a wish posts a Wishlist upsert', async () => {
  resetSyncForTests();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === 'GET') return { ok: true, text: async () => JSON.stringify({ ok: true, priceChecks: [] }) };
    return { ok: true, text: async () => JSON.stringify({ ok: true }) };
  };
  const wish = wishRow({
    id: 'wish-2',
    name: 'Seeker',
    originalAmount: 40,
    currency: 'MYR',
    fxRate: 1,
    fxDate: '2026-10-26',
    price: 40,
    fxOverridden: false,
    fxCached: false,
    priority: 'really',
    addedAt: '2026-10-26T04:00:00.000Z',
    updatedAt: '2026-10-26T04:00:00.000Z'
  });
  enqueueUpsert('Wishlist', wish);
  const data = { settings: { syncUrl: 'https://example.com/exec' }, purchases: [], wishlist: [ {
    id: 'wish-2', name: 'Seeker', originalAmount: 40, currency: 'MYR', fxRate: 1, fxDate: '2026-10-26', price: 40, fxOverridden: false, fxCached: false, priority: 'really', addedAt: '2026-10-26T04:00:00.000Z', updatedAt: '2026-10-26T04:00:00.000Z'
  } ], forSale: [] };
  const flushed = await flushQueue(() => data, { fetchImpl, online: true });
  assert.equal(flushed.ok, true);
  const posted = JSON.parse(calls.find((call) => call.init?.method === 'POST').init.body);
  assert.equal(posted.action, 'upsert');
  assert.equal(posted.sheet, 'Wishlist');
  assert.equal(posted.row.id, 'wish-2');
  assert.equal(posted.row.name, 'Seeker');
  assert.equal(posted.row.priority, 'Really want');
  assert.equal(posted.row.amount_rm, 40);
  assert.equal(readQueue().length, 0);
});

test('a manual price check appends to Price Checks and stays on the phone', async () => {
  resetSyncForTests();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === 'GET') {
      return { ok: true, text: async () => JSON.stringify({ ok: true, priceChecks: [] }) };
    }
    return { ok: true, text: async () => JSON.stringify({ ok: true }) };
  };
  const row = priceCheckRow({
    for_sale_id: 's1',
    figure: 'Mari',
    condition: 'MISB',
    rrp: 'RM 90',
    rrp_source: 'Carousell',
    low_rm: 40,
    typical_rm: 55,
    high_rm: 80,
    sources: 'Carousell',
    checked_at: '2026-10-26 11:00'
  });
  assert.deepEqual(Object.keys(row), PRICE_CHECK_COLUMNS);
  assert.deepEqual(Object.keys(row), headers('Price Checks'));
  assert.equal(row.listing_count, '');
  assert.equal(row.sample_links, '');
  rememberLocalCheck(row);
  enqueueAppendCheck(row);
  const data = { settings: { syncUrl: 'https://example.com/exec' }, purchases: [], wishlist: [], forSale: [] };
  const flushed = await flushQueue(() => data, { fetchImpl, online: true });
  assert.equal(flushed.ok, true);
  const posted = JSON.parse(calls.find((call) => call.init.method === 'POST').init.body);
  assert.equal(posted.action, 'appendCheck');
  assert.equal(posted.row.low_rm, 40);
  assert.equal(posted.row.typical_rm, 55);
  assert.equal(posted.row.high_rm, 80);
  assert.equal(posted.row.sources, 'Carousell');
  assert.equal(posted.row.rrp, 'RM 90');
  assert.equal(posted.row.for_sale_id, 's1');
  assert.equal(posted.sheet, undefined);
  assert.equal(cachedPriceChecks()[0].low_rm, 40);
  assert.match(script, /body\.action === 'appendCheck'/);
});

function syncData(overrides = {}) {
  return {
    settings: {
      monthlyCap: 400,
      rollover: false,
      overspendPayback: true,
      trackingStart: '2026-10',
      syncUrl: 'https://example.com/exec',
      categories: []
    },
    purchases: [],
    wishlist: [],
    forSale: [],
    ...overrides
  };
}

function bought(overrides = {}) {
  return {
    id: 'p1',
    date: '2026-10-02',
    name: 'Phone',
    series: 'Eva',
    brand: 'Good Smile',
    figureType: 'transformers',
    boughtAs: 'purchased',
    condition: 'MISB',
    originalAmount: 40,
    currency: 'MYR',
    fxRate: 1,
    fxDate: '2026-10-02',
    price: 40,
    fxOverridden: false,
    fxCached: false,
    shop: '',
    status: 'received',
    notes: '',
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T04:00:00.000Z',
    ...overrides
  };
}

function sheetPurchase(overrides = {}) {
  return {
    id: 'p1',
    date: '2026-10-02',
    name: 'Sheet',
    series: 'Eva',
    brand: 'Good Smile',
    type: 'Transformers',
    bought_as: 'Purchased',
    condition: 'MISB',
    original_amount: '40',
    currency: 'MYR',
    fx_rate: '1',
    fx_date: '2026-10-02',
    amount_rm: '40',
    fx_overridden: 'no',
    fx_cached: 'no',
    shop: '',
    status: 'Received',
    notes: '',
    created_at: '2026-10-02 08:00',
    updated_at: '2026-10-02 12:00',
    ...overrides
  };
}

test('sheet rows map back to app objects', () => {
  const sixth = purchaseFromRow({
    id: 'scale',
    date: '2026-01-12',
    name: 'Sixth',
    series: '1/6',
    brand: 'Good Smile',
    type: '2026-01-06',
    bought_as: 'Purchased',
    condition: 'MISB',
    original_amount: '12800',
    currency: 'JPY',
    fx_rate: '0.03055',
    fx_date: '2026-01-12',
    amount_rm: '391.04',
    fx_overridden: 'yes',
    fx_cached: 'no',
    shop: 'AmiAmi',
    status: 'Received',
    notes: '',
    created_at: '2026-10-02 08:00',
    updated_at: '2026-10-02 08:00'
  });
  assert.equal(sixth.date, '2026-01-12');
  assert.equal(sixth.series, '1/6');
  assert.equal(sixth.figureType, '1-6');
  assert.equal(purchaseRow(sixth).type, '1/6');
  assert.equal(sixth.originalAmount, 12800);
  assert.equal(sixth.price, 391.04);
  assert.equal(sixth.fxRate, 0.03055);
  assert.equal(sixth.fxOverridden, true);
  assert.equal(sixth.currency, 'JPY');
  assert.equal(sixth.boughtAs, 'purchased');
  assert.equal(sixth.updatedAt, '2026-10-02T00:00:00.000Z');
  assert.equal(purchaseFromRow({ ...sheetPurchase(), type: '2026-01-12' }).figureType, '1-12');
  assert.equal(purchaseFromRow({ ...sheetPurchase(), type: '1/12' }).figureType, '1-12');
  assert.equal(purchaseFromRow({ ...sheetPurchase(), type: '1/6' }).figureType, '1-6');
  assert.equal(purchaseRow(purchaseFromRow({ ...sheetPurchase(), type: '2026-01-12' })).type, '1/12');

  const open = purchaseFromRow({
    id: 'po',
    date: '2026-10-02',
    name: 'Rei',
    type: '2026-01-12',
    bought_as: 'Pre-ordered',
    original_amount: '200',
    currency: 'MYR',
    fx_rate: '1',
    amount_rm: '200',
    est_full_price: '200',
    est_full_original_amount: '200',
    est_full_currency: 'MYR',
    est_full_fx_rate: '1',
    deposit_amount_rm: '40',
    deposit_original_amount: '40',
    deposit_currency: 'MYR',
    deposit_fx_rate: '1',
    deposit_date: '2026-10-02',
    balance_due_rm: '160',
    balance_paid_rm: '',
    preorder_status: 'deposit paid',
    updated_at: '2026-10-02 12:00'
  });
  assert.equal(open.figureType, '1-12');
  assert.equal(open.boughtAs, 'preorder');
  assert.equal(open.estFullPrice, 200);
  assert.equal(open.depositAmountRm, 40);
  assert.equal(open.balanceDueRm, 160);
  assert.equal(open.balancePaidRm, null);
  assert.equal(open.preorderStatus, 'deposit paid');

  const wish = wishFromRow({
    id: 'w1',
    name: 'Grail',
    original_amount: '80',
    currency: 'MYR',
    fx_rate: '1',
    fx_date: '2026-10-02',
    amount_rm: '80.00',
    fx_overridden: 'yes',
    fx_cached: 'no',
    priority: 'Must have',
    added_at: '2026-10-02 12:00',
    updated_at: '2026-10-02 12:00'
  });
  assert.equal(wish.priority, 'must');
  assert.equal(wish.price, 80);
  assert.equal(wish.originalAmount, 80);
  assert.equal(wish.fxOverridden, true);
  assert.equal(wish.addedAt, '2026-10-02T04:00:00.000Z');
  assert.equal(wishFromRow({ ...wish, priority: 'Nice to have', id: 'w2' }).priority, 'nice');
  assert.equal(wishRow(wish).priority, 'Must have');

  const sale = saleFromRow({
    id: 's1',
    name: 'Mindwipe',
    brand: 'Hasbro',
    series: 'Titans Return',
    condition: 'Loose',
    status: 'Listed',
    original_amount: '',
    amount_rm: '',
    currency: '',
    fx_rate: '',
    sold_amount_rm: '',
    updated_at: '2026-10-02 12:00',
    created_at: '2026-10-02 12:00'
  });
  assert.equal(sale.price, null);
  assert.equal(sale.originalAmount, null);
  assert.notEqual(sale.price, 0);
  assert.equal(sale.status, 'listed');
  const sold = saleFromRow({
    ...sale,
    status: 'Sold',
    original_amount: '50',
    amount_rm: '50',
    currency: 'MYR',
    fx_rate: '1',
    sold_original_amount: '40',
    sold_currency: 'MYR',
    sold_fx_rate: '1',
    sold_amount_rm: '40.00',
    sold_date: '2026-10-03'
  });
  assert.equal(sold.status, 'sold');
  assert.equal(sold.soldPrice, 40);
  assert.equal(sold.price, 50);
});

test('merge keeps the newer copy, local-only rows, and pending deletes', () => {
  resetSyncForTests();
  const local = bought({ id: 'p', name: 'Phone', updatedAt: '2026-10-02T04:00:00.000Z' });
  const base = syncData({ purchases: [local, bought({ id: 'stay', name: 'Stay' })] });
  const older = mergeSheet(base, {
    purchases: [sheetPurchase({ id: 'p', name: 'Old sheet', updated_at: '2026-10-02 11:00' })],
    wishlist: [],
    forSale: []
  }, []);
  assert.equal(older.changed, false);
  assert.equal(older.data.purchases.find((item) => item.id === 'p').name, 'Phone');

  const sameTime = mergeSheet(base, {
    purchases: [sheetPurchase({ id: 'p', name: 'Same sheet', updated_at: '2026-10-02 12:00' })],
    wishlist: [],
    forSale: []
  }, []);
  assert.equal(sameTime.changed, false);
  assert.equal(sameTime.data.purchases.find((item) => item.id === 'p').name, 'Phone');

  const checksOnly = mergeSheet(base, { ok: true, priceChecks: [] }, []);
  assert.equal(checksOnly.changed, false);
  assert.equal(checksOnly.data, base);

  const newer = mergeSheet(base, {
    purchases: [sheetPurchase({ id: 'p', name: 'New sheet', updated_at: '2026-10-02 13:00' })],
    wishlist: [],
    forSale: []
  }, []);
  assert.equal(newer.changed, true);
  assert.equal(newer.data.purchases.find((item) => item.id === 'p').name, 'New sheet');
  assert.equal(newer.data.purchases.find((item) => item.id === 'stay').name, 'Stay');

  const queue = [{ op: 'delete', sheet: 'Purchases', id: 'gone' }];
  const kept = mergeSheet(base, {
    purchases: [
      sheetPurchase({ id: 'gone', name: 'Ghost', updated_at: '2026-12-01 12:00' }),
      sheetPurchase({ id: 'added', name: 'Added', type: '2026-01-06', updated_at: '2026-10-03 12:00' })
    ],
    wishlist: [{
      id: 'wish-gone',
      name: 'Secret',
      original_amount: '10',
      currency: 'MYR',
      fx_rate: '1',
      amount_rm: '10',
      priority: 'Must have',
      added_at: '2026-10-03 12:00',
      updated_at: '2026-10-03 12:00'
    }],
    forSale: [{
      id: 's-blank',
      name: 'Mindwipe',
      condition: 'Loose',
      status: 'Listed',
      original_amount: '',
      amount_rm: '',
      updated_at: '2026-10-03 12:00'
    }]
  }, [...queue, { op: 'delete', sheet: 'Wishlist', id: 'wish-gone' }]);
  assert.deepEqual(queue, [{ op: 'delete', sheet: 'Purchases', id: 'gone' }]);
  assert.equal(kept.data.purchases.some((item) => item.id === 'gone'), false);
  assert.equal(kept.data.purchases.some((item) => item.id === 'added'), true);
  assert.equal(kept.data.purchases.find((item) => item.id === 'added').figureType, '1-6');
  assert.equal(purchaseRow(kept.data.purchases.find((item) => item.id === 'added')).type, '1/6');
  assert.equal(kept.data.purchases.some((item) => item.id === 'stay'), true);
  assert.equal(kept.data.wishlist.some((item) => item.id === 'wish-gone'), false);
  assert.equal(kept.data.forSale[0].price, null);
  assert.notEqual(kept.data.forSale[0].price, 0);
  assert.equal(kept.queue.some((op) => op.op === 'delete' && op.id === 'gone'), true);

  const editing = purchaseRow(bought({ id: 'p', name: 'Editing', updatedAt: '2026-10-02T06:00:00.000Z' }));
  const pending = [{ op: 'upsert', sheet: 'Purchases', id: 'p', row: editing }];
  const pendingWins = mergeSheet(syncData({ purchases: [local] }), {
    purchases: [sheetPurchase({ id: 'p', name: 'Sheet', updated_at: '2026-10-02 13:00' })],
    wishlist: [],
    forSale: []
  }, pending);
  assert.equal(pendingWins.changed, false);
  assert.equal(pendingWins.data.purchases[0].name, 'Phone');
  assert.equal(pendingWins.queue[0].row.name, 'Editing');

  const staleEdit = purchaseRow(bought({ id: 'p', name: 'Editing', updatedAt: '2026-10-02T04:30:00.000Z' }));
  const remoteWins = mergeSheet(syncData({ purchases: [local] }), {
    purchases: [sheetPurchase({ id: 'p', name: 'New sheet', updated_at: '2026-10-02 13:00' })],
    wishlist: [],
    forSale: []
  }, [{ op: 'upsert', sheet: 'Purchases', id: 'p', row: staleEdit }]);
  assert.equal(remoteWins.data.purchases[0].name, 'New sheet');
  assert.equal(remoteWins.queue.some((op) => op.op === 'upsert'), false);
});

test('a full sync pulls before it pushes and leaves the queue when the pull fails', async () => {
  resetSyncForTests();
  const calls = [];
  const sheet = sheetPurchase({
    id: 'from-sheet',
    name: 'Sheet Only',
    type: '2026-01-12',
    original_amount: '88.50',
    amount_rm: '88.50',
    fx_rate: '1',
    currency: 'MYR',
    updated_at: '2026-10-20 12:00'
  });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', init });
    if ((init.method || 'GET') === 'GET') {
      return {
        ok: true,
        text: async () => JSON.stringify({
          ok: true,
          purchases: [sheet],
          wishlist: [],
          forSale: [],
          priceChecks: []
        })
      };
    }
    return { ok: true, text: async () => JSON.stringify({ ok: true }) };
  };
  const data = syncData({ purchases: [bought({ id: 'local-1', name: 'Local Only' })] });
  let queuedAtRender = null;
  onSheetMerge(() => {
    queuedAtRender = readQueue().map((op) => op.op);
  });
  const result = await syncAllNow(data, { fetchImpl, online: true });
  assert.equal(result.ok, true);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, new RegExp(`token=${SYNC_TOKEN}`));
  assert.deepEqual(queuedAtRender, []);
  const posts = calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1);
  const posted = JSON.parse(posts[0].init.body);
  assert.equal(posted.action, 'syncAll');
  assert.equal(posted.purchases.find((row) => row.id === 'from-sheet').name, 'Sheet Only');
  assert.equal(posted.purchases.find((row) => row.id === 'from-sheet').type, '1/12');
  assert.equal(posted.purchases.find((row) => row.id === 'from-sheet').original_amount, 88.5);
  assert.equal(posted.purchases.some((row) => row.id === 'local-1'), true);
  assert.equal(readQueue().some((op) => op.op === 'upsert'), false);

  calls.length = 0;
  enqueueUpsert('Purchases', purchaseRow(bought({ id: 'queued', name: 'Queued' })));
  const failed = await syncAllNow(data, {
    fetchImpl: async (url, init = {}) => {
      calls.push(init.method || 'GET');
      if ((init.method || 'GET') === 'GET') throw new Error('down');
      return { ok: true, text: async () => JSON.stringify({ ok: true }) };
    },
    online: true
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(calls, ['GET']);
  assert.equal(readQueue().length, 1);
  assert.equal(readQueue()[0].op, 'upsert');
  assert.equal(readQueue()[0].id, 'queued');
  assert.match(syncStatusLabel(), /Not synced/);

  calls.length = 0;
  const denied = await syncAllNow(data, {
    fetchImpl: async (url, init = {}) => {
      calls.push(init.method || 'GET');
      return { ok: true, text: async () => JSON.stringify({ ok: false, error: 'unauthorized' }) };
    },
    online: true
  });
  assert.equal(denied.ok, false);
  assert.deepEqual(calls, ['GET']);
  assert.equal(readQueue().length, 1);

  calls.length = 0;
  const flushed = await flushQueue(() => data, {
    fetchImpl: async (url, init = {}) => {
      calls.push(init.method || 'GET');
      if ((init.method || 'GET') === 'GET') {
        return { ok: true, text: async () => JSON.stringify({ ok: true, priceChecks: [] }) };
      }
      return { ok: true, text: async () => JSON.stringify({ ok: true }) };
    },
    online: true
  });
  assert.equal(flushed.ok, true);
  assert.equal(calls[0], 'POST');
  assert.equal(readQueue().length, 0);

  enqueueUpsert('Purchases', purchaseRow(bought({ id: 'queued', name: 'Queued again' })));
  await syncAllNow(data, { fetchImpl: async () => { throw new Error('offline'); }, online: false });
  calls.length = 0;
  const pullFailed = await syncAllNow(data, {
    fetchImpl: async (url, init = {}) => {
      calls.push(init.method || 'GET');
      if ((init.method || 'GET') === 'GET') throw new Error('down');
      return { ok: true, text: async () => JSON.stringify({ ok: true }) };
    },
    online: true
  });
  assert.equal(pullFailed.ok, false);
  assert.deepEqual(calls, ['GET']);
  assert.equal(readQueue().length, 1);
  calls.length = 0;
  const retry = await flushQueue(() => data, {
    fetchImpl: async (url, init = {}) => {
      calls.push({ method: init.method || 'GET', body: init.body });
      if ((init.method || 'GET') === 'GET') {
        return { ok: true, text: async () => JSON.stringify({ ok: true, purchases: [], wishlist: [], forSale: [], priceChecks: [] }) };
      }
      return { ok: true, text: async () => JSON.stringify({ ok: true }) };
    },
    online: true
  });
  assert.equal(retry.ok, true);
  assert.equal(calls[0].method, 'GET');
  assert.equal(JSON.parse(calls.find((call) => call.method === 'POST').body).action, 'syncAll');
});
