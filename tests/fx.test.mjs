import assert from 'node:assert/strict';
import test from 'node:test';

import { conversionText, fetchMyrRate, moneyToMyr } from '../js/fx.js';

function jsonResponse(body, ok = true) {
  return {
    ok,
    status: ok ? 200 : 404,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

test('ringgit amounts do not call the network', async () => {
  let called = false;
  const quote = await fetchMyrRate({
    currency: 'MYR',
    date: '2026-10-02',
    today: '2026-10-26',
    cache: { entries: {} },
    fetchImpl() {
      called = true;
      throw new Error('should not fetch');
    }
  });
  assert.equal(called, false);
  assert.equal(quote.rate, 1);
  assert.equal(quote.cached, false);
  assert.equal(moneyToMyr(400, quote.rate), 400);
});

test('a past purchase uses that date and converts to ringgit', async () => {
  const urls = [];
  const cache = { entries: {} };
  const quote = await fetchMyrRate({
    currency: 'jpy',
    date: '2026-09-15',
    today: '2026-10-26',
    cache,
    fetchImpl(url) {
      urls.push(url);
      return jsonResponse({
        amount: 1,
        base: 'JPY',
        date: '2026-09-15',
        rates: { MYR: 0.03055 }
      });
    }
  });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /2026-09-15\?from=JPY&to=MYR/);
  assert.equal(quote.rate, 0.03055);
  assert.equal(quote.fxDate, '2026-09-15');
  assert.equal(quote.historical, true);
  assert.equal(quote.cached, false);
  assert.equal(quote.source, 'frankfurter');
  assert.equal(moneyToMyr(12800, quote.rate), 391.04);
  assert.equal(cache.entries['JPY|2026-09-15'].rate, 0.03055);
  assert.equal(
    conversionText({ amount: 12800, currency: 'JPY', rate: quote.rate, cached: false, historical: true }),
    '¥12,800 ≈ RM 391.04'
  );
});

test('a weekend request keeps the business day the rate was published', async () => {
  const quote = await fetchMyrRate({
    currency: 'USD',
    date: '2026-10-25',
    today: '2026-10-26',
    cache: { entries: {} },
    fetchImpl() {
      return jsonResponse({ date: '2026-10-23', rates: { MYR: 4.2 } });
    }
  });
  assert.equal(quote.fxDate, '2026-10-23');
  assert.equal(quote.historical, true);
  assert.equal(moneyToMyr(10, quote.rate), 42);
});

test('falls back to the latest provider when the historical rate is missing', async () => {
  const urls = [];
  const quote = await fetchMyrRate({
    currency: 'JPY',
    date: '2026-09-15',
    today: '2026-10-26',
    cache: { entries: {} },
    fetchImpl(url) {
      urls.push(url);
      if (url.includes('/2026-09-15')) return jsonResponse({}, false);
      if (url.includes('api.frankfurter.app/latest')) throw new Error('down');
      return jsonResponse({
        result: 'success',
        rates: { MYR: 0.03 },
        time_last_update_utc: 'Fri, 24 Oct 2026 00:02:31 +0000'
      });
    }
  });
  assert.equal(quote.source, 'er-api');
  assert.equal(quote.historical, false);
  assert.equal(quote.cached, false);
  assert.equal(quote.fxDate, '2026-10-24');
  assert.match(
    conversionText({ amount: 1000, currency: 'JPY', rate: quote.rate, cached: false, historical: false }),
    /today's rate/
  );
  assert.equal(urls.length, 3);
});

test('offline use is marked as a cached rate', async () => {
  const cache = {
    entries: {
      'JPY|2026-09-15': { rate: 0.03055, fxDate: '2026-09-15', source: 'frankfurter' }
    }
  };
  const quote = await fetchMyrRate({
    currency: 'JPY',
    date: '2026-09-15',
    today: '2026-10-26',
    cache,
    online: false,
    fetchImpl() {
      throw new Error('offline');
    }
  });
  assert.equal(quote.cached, true);
  assert.equal(quote.historical, true);
  assert.equal(moneyToMyr(12800, quote.rate), 391.04);
  assert.match(
    conversionText({ amount: 12800, currency: 'JPY', rate: quote.rate, cached: true, historical: true }),
    /cached rate/
  );
});

test('a saved rate for the purchase date beats today when history is down', async () => {
  const cache = {
    entries: {
      'EUR|2026-08-01': { rate: 4.8, fxDate: '2026-08-01', source: 'frankfurter' },
      'EUR|latest': { rate: 5, fxDate: '2026-10-26', source: 'frankfurter' }
    }
  };
  const quote = await fetchMyrRate({
    currency: 'EUR',
    date: '2026-08-01',
    today: '2026-10-26',
    cache,
    fetchImpl(url) {
      if (url.includes('/2026-08-01')) return jsonResponse({}, false);
      throw new Error(`unexpected ${url}`);
    }
  });
  assert.equal(quote.cached, true);
  assert.equal(quote.rate, 4.8);
  assert.equal(quote.historical, true);
});
