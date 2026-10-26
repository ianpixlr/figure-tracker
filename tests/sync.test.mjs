import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_SYNC_URL,
  PURCHASE_COLUMNS,
  SALE_COLUMNS,
  SYNC_TOKEN,
  WISHLIST_COLUMNS,
  cachedPriceChecks,
  enqueueDelete,
  enqueueUpsert,
  flushQueue,
  isConfiguredUrl,
  purchaseRow,
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
    figureType: 'nendoroid',
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
    mood: 'excited',
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
  assert.equal(row.type, 'Nendoroid');
  assert.equal(row.bought_as, 'Pre-order');
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
