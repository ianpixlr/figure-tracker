// Local run of the Entries filter check. Loads a sheet GET payload into
// figure-cap.v1, then taps every Year/Month/Brand/Series/Type chip and the
// search box. Uses the same Chrome the rest of the browser checks use.
//
//   node tests/entries-filters.mjs path/to/sheet.json
//
// Sync is pointed at a non-URL so a saved test purchase is not pushed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

import { openPreorders } from '../js/budget.js';
import { filterPurchases, purchaseFilterOptions } from '../js/catalog.js';
import { normalizeData } from '../js/store.js';

const BASE = process.env.BASE || 'http://127.0.0.1:8765/';
const sheetPath = process.argv[2];
if (!sheetPath) {
  console.error('Usage: node tests/entries-filters.mjs <sheet.json>');
  process.exit(1);
}

const SIXTH = [
  'Black Platform Martin Boots',
  'Figure Body (Pale)',
  'Body Accessory (Pale)',
  'Gilly Headsculpt (Android 18)'
];

function sheetData(path) {
  const sheet = JSON.parse(readFileSync(path, 'utf8'));
  const stored = {
    version: 3,
    settings: {
      monthlyCap: 400,
      rollover: false,
      overspendPayback: true,
      trackingStart: '2026-01',
      syncUrl: 'local-only',
      categories: []
    },
    purchases: sheet.purchases,
    wishlist: [],
    forSale: []
  };
  const data = normalizeData(stored, '2026-10');
  assert.equal(data.purchases.length, sheet.purchases.length, 'every sheet row should load');
  return { stored, data };
}

function names(page) {
  return page.evaluate(() => (
    [...document.querySelectorAll('#main article.block:not(.yellow):not(.empty-card) h3')]
      .map((el) => el.textContent.trim())
  ));
}

async function listed(page) {
  const found = await names(page);
  const nothing = await page.evaluate(() => document.getElementById('main').innerText.includes('Nothing matches'));
  return { count: found.length, names: found, nothing };
}

async function choose(page, key, value) {
  await page.click('[data-action="open-filters"]');
  await page.waitForSelector('dialog[open]');
  const clicked = await page.evaluate((filterKey, filterValue) => {
    const button = [...document.querySelectorAll('dialog[open] [data-filter]')].find((el) => (
      el.dataset.filter === filterKey && el.dataset.value === filterValue
    ));
    if (!button) return false;
    button.click();
    return true;
  }, key, value);
  assert.equal(clicked, true, `missing chip ${key}=${value}`);
  await page.waitForFunction(() => !document.getElementById('dialog')?.open);
}

async function clearChip(page, key) {
  const cleared = await page.evaluate((filterKey) => {
    const chip = [...document.querySelectorAll('#main .chips [data-filter]')].find((el) => el.dataset.filter === filterKey);
    if (!chip) return false;
    chip.click();
    return true;
  }, key);
  assert.equal(cleared, true, `missing active chip ${key}`);
}

async function activeKeys(page) {
  return page.evaluate(() => (
    [...document.querySelectorAll('#main .chips [data-filter]')].map((el) => el.dataset.filter)
  ));
}

async function search(page, query) {
  await page.evaluate((value) => {
    const input = document.getElementById('field-search');
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, query);
  await page.waitForFunction((value) => document.getElementById('field-search')?.value === value, {}, query);
  return listed(page);
}

async function clearSearch(page) {
  if (await page.$('#field-search') == null) return;
  await search(page, '');
}

async function main() {
  const { stored, data } = sheetData(sheetPath);
  const expected = purchaseFilterOptions(data.purchases, {});
  const browser = await puppeteer.launch({
    executablePath: '/usr/local/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking']
  });
  const leaked = [];
  const pageErrors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.setRequestInterception(true);
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('script.google.com') || url.includes('googleusercontent.com')) {
        leaked.push(url);
        request.abort().catch(() => {});
        return;
      }
      request.continue().catch(() => {});
    });

    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#month-title');
    await page.evaluate((payload) => {
      localStorage.setItem('figure-cap.v1', payload);
      localStorage.removeItem('figure-cap.sync-full.v1');
      localStorage.removeItem('figure-cap.sync-queue.v1');
    }, JSON.stringify(stored));
    await page.goto(`${BASE}#entries`, { waitUntil: 'networkidle0' });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#field-search');
    const loaded = await page.evaluate(() => JSON.parse(localStorage.getItem('figure-cap.v1')).purchases.length);
    assert.equal(loaded, data.purchases.length);
    console.log('loaded', loaded);

    await page.click('[data-action="open-filters"]');
    await page.waitForSelector('dialog[open]');
    const options = await page.evaluate(() => (
      [...document.querySelectorAll('dialog[open] [data-filter]')].map((el) => ({
        key: el.dataset.filter,
        value: el.dataset.value,
        text: el.textContent.trim()
      }))
    ));
    await page.click('dialog[open] [data-action="close-dialog"]');
    await page.waitForFunction(() => !document.getElementById('dialog')?.open);

    const months = options.filter((item) => item.key === 'month' && item.value).map((item) => item.text);
    assert.deepEqual(months, ['Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    for (const absent of ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Nov', 'Dec']) {
      assert.equal(months.includes(absent), false, absent);
    }
    assert.deepEqual(options.filter((item) => item.key === 'year' && item.value).map((item) => item.value), expected.years);
    assert.deepEqual(options.filter((item) => item.key === 'brand' && item.value).map((item) => item.value), expected.brands);
    assert.deepEqual(options.filter((item) => item.key === 'series' && item.value).map((item) => item.value), expected.series);
    assert.deepEqual(options.filter((item) => item.key === 'type' && item.value).map((item) => item.text), expected.types.map((item) => item.label));

    for (const option of options) {
      if (!option.value) continue;
      await choose(page, option.key, option.value);
      const result = await listed(page);
      const want = filterPurchases(data.purchases, { [option.key]: option.value }).length;
      console.log(option.key, JSON.stringify(option.text), '->', result.nothing ? 'NOTHING' : result.count);
      assert.equal(result.nothing, false, option.text);
      assert.ok(result.count >= 1, option.text);
      assert.equal(result.count, want, `${option.key} ${option.text}`);
      if (option.key === 'type' && option.text === '1/6') {
        for (const name of SIXTH) assert.ok(result.names.some((item) => item.includes(name)), name);
        assert.equal(result.count, 4);
      }
      if (option.key === 'type' && option.text === '1/12') {
        assert.equal(result.count, filterPurchases(data.purchases, { type: '1-12' }).length);
        assert.equal(result.count, 13);
      }
      await clearChip(page, option.key);
      assert.equal((await activeKeys(page)).includes(option.key), false);
    }

    for (const query of ['sheik', 'Sheik Mainland', 'hasbro', 'worldbox', 'wheels', 'misb']) {
      const result = await search(page, query);
      const want = filterPurchases(data.purchases, { q: query }).length;
      console.log('search', JSON.stringify(query), '->', result.count);
      assert.equal(result.nothing, false, query);
      assert.ok(result.count >= 1, query);
      assert.equal(result.count, want, query);
    }
    assert.ok((await search(page, 'Sheik Mainland')).names.some((item) => item.includes('Xeno Dash')));
    await clearSearch(page);

    await choose(page, 'year', '2026');
    await choose(page, 'month', '10');
    await choose(page, 'brand', 'Hasbro');
    await search(page, 'classified');
    const combined = await listed(page);
    const combinedWant = filterPurchases(data.purchases, { year: '2026', month: '10', brand: 'Hasbro', q: 'classified' });
    console.log('combined year+month+brand+search ->', combined.count);
    assert.ok(combined.count >= 1);
    assert.equal(combined.count, combinedWant.length);
    assert.deepEqual((await activeKeys(page)).slice().sort(), ['brand', 'month', 'year']);
    await clearChip(page, 'brand');
    assert.deepEqual((await activeKeys(page)).slice().sort(), ['month', 'year']);
    assert.equal((await page.$eval('#field-search', (el) => el.value)), 'classified');
    const afterBrand = await listed(page);
    assert.equal(afterBrand.count, filterPurchases(data.purchases, { year: '2026', month: '10', q: 'classified' }).length);
    assert.ok(afterBrand.count >= combined.count);
    await clearChip(page, 'month');
    await clearChip(page, 'year');
    assert.deepEqual(await activeKeys(page), []);
    await clearSearch(page);

    const purchased = data.purchases.find((item) => (
      item.boughtAs === 'purchased'
      && openPreorders(filterPurchases(data.purchases, { q: item.name })).length === 0
      && filterPurchases(data.purchases, { q: item.name }).some((row) => row.id === item.id)
    ));
    assert.ok(purchased, 'need a purchased figure the pre-order search does not match');
    await page.evaluate(() => { location.hash = '#entries/preorders'; });
    await page.waitForFunction(() => document.querySelector('#entries-scope [aria-selected="true"]')?.textContent.includes('Pre-orders'));
    const batman = await search(page, 'batman');
    console.log('preorders search batman ->', batman.count, batman.names.join(', '));
    assert.deepEqual(batman.names, ['The Batman']);
    assert.equal(batman.count, openPreorders(filterPurchases(data.purchases, { q: 'batman' })).length);
    const hidden = await search(page, purchased.name);
    console.log('preorders search purchased ->', hidden.count);
    assert.equal(hidden.count, 0);
    await clearSearch(page);
    await page.evaluate(() => { location.hash = '#entries'; });
    await page.waitForFunction(() => document.querySelector('#entries-scope [aria-selected="true"]')?.textContent.trim() === 'All');
    const back = await search(page, purchased.name);
    assert.ok(back.count >= 1, purchased.name);
    await clearSearch(page);

    await page.evaluate(() => { window.__noReload = true; });
    await page.evaluate(() => { location.hash = '#log'; });
    await page.waitForSelector('#log-form');
    await page.evaluate(() => {
      document.querySelector('#log-form input[name="figureType"][value="1-6"]').closest('label').click();
    });
    await page.type('#field-brand', 'Zeta Test Brand');
    await page.type('#field-series', 'Zeta Test Series');
    await page.type('#fc-item', 'Zeta Probe');
    await page.type('#field-price', '25');
    await page.click('#log-form button[type="submit"]');
    try {
      await page.waitForFunction(() => {
        const saved = JSON.parse(localStorage.getItem('figure-cap.v1') || '{}');
        return saved.purchases?.some((item) => item.brand === 'Zeta Test Brand' && item.figureType === '1-6' && item.series === 'Zeta Test Series');
      }, { timeout: 8000 });
    } catch (error) {
      const message = await page.$eval('#log-form .form-error', (el) => (el.hidden ? '' : el.textContent.trim())).catch(() => '');
      throw new Error(message || error.message);
    }
    assert.equal(await page.evaluate(() => window.__noReload), true);
    await page.evaluate(() => { location.hash = '#entries'; });
    await page.waitForSelector('#field-search');
    assert.equal(await page.evaluate(() => window.__noReload), true);

    await page.click('[data-action="open-filters"]');
    await page.waitForSelector('dialog[open]');
    const fresh = await page.evaluate(() => (
      [...document.querySelectorAll('dialog[open] [data-filter]')].map((el) => ({
        key: el.dataset.filter,
        value: el.dataset.value,
        text: el.textContent.trim()
      }))
    ));
    await page.click('dialog[open] [data-action="close-dialog"]');
    assert.ok(fresh.some((item) => item.key === 'brand' && item.value === 'Zeta Test Brand'));
    assert.ok(fresh.some((item) => item.key === 'series' && item.value === 'Zeta Test Series'));
    assert.ok(fresh.some((item) => item.key === 'type' && item.text === '1/6'));
    console.log('new brand/series/type chips -> present without reload');

    await choose(page, 'brand', 'Zeta Test Brand');
    const zetaBrand = await listed(page);
    console.log('brand Zeta Test Brand ->', zetaBrand.count, zetaBrand.names.join(', '));
    assert.deepEqual(zetaBrand.names, ['Zeta Probe']);
    await clearChip(page, 'brand');
    await choose(page, 'type', '1-6');
    const zetaType = await listed(page);
    console.log('type 1/6 after new row ->', zetaType.count);
    assert.equal(zetaType.count, 5);
    for (const name of SIXTH) assert.ok(zetaType.names.some((item) => item.includes(name)), name);
    assert.ok(zetaType.names.includes('Zeta Probe'));
    await clearChip(page, 'type');
    for (const query of ['zeta', 'Zeta Test Brand']) {
      const result = await search(page, query);
      console.log('search', JSON.stringify(query), '->', result.count);
      assert.ok(result.names.includes('Zeta Probe'), query);
    }

    assert.deepEqual(leaked, []);
    assert.deepEqual(pageErrors, []);
    console.log('entries filters ok');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
