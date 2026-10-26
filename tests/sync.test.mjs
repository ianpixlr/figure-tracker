import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
  priceCheckRow,
  purchaseRow,
  rememberLocalCheck,
  resolveSyncUrl,
  readQueue,
  resetSyncForTests,
  saleRow,
  syncAllBody,
  syncAllNow,
  syncStatusLabel,
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
  assert.equal(purchaseRow({ ...samplePurchase(), figureType: '1-12' }).type, '1/12');
  assert.equal(purchaseRow({ ...samplePurchase(), figureType: 'model-kit' }).type, 'Model Kit');
  assert.equal(purchaseRow({ ...samplePurchase(), figureType: 'Movie' }).type, 'Movie');
  assert.equal(purchaseRow({ ...samplePurchase(), figureType: '' }).type, '');
  assert.equal(row.bought_as, 'Pre-ordered');
  assert.equal(row.status, 'Pre-ordered');
  const purchased = purchaseRow({ ...samplePurchase(), boughtAs: 'purchased', status: 'received' });
  assert.equal(purchased.bought_as, 'Purchased');
  assert.equal(purchased.status, 'Received');
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
