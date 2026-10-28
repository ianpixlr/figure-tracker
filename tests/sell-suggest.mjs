// Sell-card price suggestions at phone width. Seeds two listings and checks
// the grid, the few-listings note, and the heads-up in light and dark mode.
//
//   node tests/sell-suggest.mjs

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://127.0.0.1:8765/';
const SHOTS = '/opt/cursor/artifacts/screenshots';

const store = {
  version: 3,
  settings: {
    monthlyCap: 400,
    rollover: false,
    overspendPayback: true,
    trackingStart: '2026-01',
    syncUrl: 'local-only',
    categories: []
  },
  purchases: [{
    id: 'p1',
    date: '2026-08-01',
    name: 'Mindwipe',
    brand: 'Hasbro',
    series: 'Titans Return',
    condition: 'MISB',
    price: 40,
    originalAmount: 40,
    currency: 'MYR',
    boughtAs: 'purchased'
  }],
  wishlist: [],
  forSale: [
    {
      id: 's1',
      name: 'Mindwipe',
      brand: 'Hasbro',
      series: 'Titans Return',
      condition: 'Loose',
      price: null,
      originalAmount: null,
      currency: '',
      status: 'listed'
    },
    {
      id: 's2',
      name: 'Bumblebee',
      brand: 'Hasbro',
      series: 'Studio Series',
      condition: 'MISB',
      price: 100,
      originalAmount: 100,
      currency: 'MYR',
      status: 'listed'
    }
  ]
};

const checks = [
  {
    for_sale_id: 's1',
    figure: 'Mindwipe',
    condition: 'MISB',
    low_rm: 60,
    typical_rm: 95,
    high_rm: 130,
    listing_count: 2,
    sources: 'Carousell',
    checked_at: '2026-10-01 09:00'
  },
  {
    for_sale_id: 's1',
    figure: 'Mindwipe',
    condition: 'Loose',
    low_rm: 50,
    typical_rm: 83,
    high_rm: 110,
    listing_count: 6,
    rrp: 'USD 16.99',
    rrp_source: 'https://example.com/rrp',
    sources: "Carousell MY search 'titans return mindwipe'. Both listed as brand new.",
    sample_links: 'https://www.carousell.com.my/p/transformers-mindwipe-1/',
    checked_at: '2026-10-20 09:00'
  },
  {
    for_sale_id: 's2',
    figure: 'Bumblebee',
    condition: 'MISB',
    low_rm: 90,
    typical_rm: 100,
    high_rm: 140,
    listing_count: 2,
    sources: 'Carousell',
    checked_at: '2026-10-20 09:00'
  }
];

async function prepare(page, theme) {
  await page.evaluate((payload, themeName) => {
    localStorage.setItem('figure-cap.v1', payload.store);
    localStorage.setItem('figure-cap.price-checks.v1', payload.checks);
    localStorage.setItem('figure-cap.theme', themeName);
    localStorage.removeItem('figure-cap.sync-queue.v1');
    localStorage.removeItem('figure-cap.sync-full.v1');
  }, { store: JSON.stringify(store), checks: JSON.stringify(checks) }, theme);
  await page.goto(`${BASE}#sell`, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-suggest]');
}

async function assertCards(page) {
  const report = await page.evaluate(() => {
    const allowed = new Set(['52px', '22px', '15px']);
    const cards = [...document.querySelectorAll('article.block')].filter((card) => card.querySelector('[data-suggest]'));
    return cards.map((card) => {
      const fonts = [...card.querySelectorAll('*')].map((el) => getComputedStyle(el).fontSize);
      const values = [...card.querySelectorAll('.suggest .stat-v')].map((el) => ({
        text: el.textContent.trim(),
        nowrap: getComputedStyle(el).whiteSpace,
        weight: getComputedStyle(el).fontWeight
      }));
      const labels = [...card.querySelectorAll('[data-suggest] .spec-label')].map((el) => ({
        text: el.textContent.trim(),
        weight: getComputedStyle(el).fontWeight
      }));
      return {
        text: card.innerText,
        overflow: card.scrollWidth > card.clientWidth + 1,
        fonts: [...new Set(fonts.filter((size) => !allowed.has(size)))],
        values,
        labels
      };
    });
  });
  assert.equal(report.length, 2);
  const [mindwipe, bee] = report;
  assert.match(mindwipe.text, /LIST AT/);
  assert.match(mindwipe.text, /DROP TO/);
  assert.match(mindwipe.text, /FLOOR/);
  assert.match(mindwipe.text, /RM 85\.00/);
  assert.match(mindwipe.text, /RM 65\.00/);
  assert.match(mindwipe.text, /RM 50\.00/);
  assert.match(mindwipe.text, /Based on 6 Carousell listings, Loose/);
  assert.match(mindwipe.text, /No price yet/);
  assert.match(mindwipe.text, /RRP USD 16\.99 · 6 listings · 20 Oct/);
  assert.match(mindwipe.text, /Market is above what you paid\. You could list higher\./);
  assert.equal(mindwipe.text.includes('Few listings'), false);
  assert.equal(mindwipe.text.includes('Carousell MY search'), false);
  assert.equal(mindwipe.text.includes('carousell.com.my/p'), false);
  assert.match(bee.text, /Based on 2 Carousell listings, MISB · Few listings/);
  assert.match(bee.text, /RM 100\.00/);
  assert.match(bee.text, /RM 95\.00/);
  assert.match(bee.text, /RM 85\.00/);
  assert.equal(bee.text.includes('You could list higher'), false);
  for (const card of report) {
    assert.equal(card.overflow, false, card.text.slice(0, 80));
    assert.deepEqual(card.fonts, []);
    assert.deepEqual(card.labels.map((label) => label.text), ['List at', 'Drop to', 'Floor']);
    assert.deepEqual(card.labels.map((label) => label.weight), ['400', '400', '400']);
    assert.ok(card.values.every((value) => value.nowrap === 'nowrap'));
  }
  console.log('suggest cards ok');
}

async function shot(page, name) {
  const card = await page.$('[data-id="s1"]');
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await card.screenshot({ path: `${SHOTS}/${name}.png` });
  console.log('shot', name);
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: '/usr/local/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('script.google.com') || url.includes('googleusercontent.com')) {
        request.abort().catch(() => {});
        return;
      }
      request.continue().catch(() => {});
    });
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await prepare(page, 'light');
    await assertCards(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.mode), 'light');
    await shot(page, 'sell_suggest_light');
    await page.evaluate(() => document.querySelector('[data-id="s1"] [data-action="toggle-sources"]').click());
    const opened = await page.$eval('[data-id="s1"]', (card) => card.innerText);
    assert.match(opened, /Carousell MY search/);
    assert.match(opened, /carousell\.com\.my\/p\/transformers-mindwipe-1/);
    assert.equal(await page.$eval('[data-id="s1"] [data-action="toggle-sources"]', (el) => el.getAttribute('aria-expanded')), 'true');
    await page.evaluate(() => { location.hash = '#log'; });
    await page.evaluate(() => { location.hash = '#sell'; });
    await page.waitForSelector('#fc-sale');
    await page.type('#fc-sale', 'Unpriced Probe');
    await page.click('#sale-form button[type="submit"]');
    await page.waitForFunction(() => {
      const data = JSON.parse(localStorage.getItem('figure-cap.v1') || '{}');
      return data.forSale?.some((item) => item.name === 'Unpriced Probe' && item.price == null);
    });
    const queued = await page.evaluate(() => {
      const queue = JSON.parse(localStorage.getItem('figure-cap.sync-queue.v1') || '[]');
      return queue.find((op) => op.row?.name === 'Unpriced Probe')?.row;
    });
    assert.equal(queued.amount_rm, '');
    assert.notEqual(queued.amount_rm, 0);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('unpriced probe') && text.includes('no price yet');
    });
    await prepare(page, 'dark');
    await assertCards(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.mode), 'dark');
    await shot(page, 'sell_suggest_dark');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
