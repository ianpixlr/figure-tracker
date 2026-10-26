// Phone-width walkthrough. Serves the repo on 127.0.0.1:8765.

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { DEFAULT_SYNC_URL } from '../js/sync.js';

const BASE = 'http://127.0.0.1:8765/';
const SHOTS = '/tmp/figure-cap-shots';

function klLong(date) {
  return new Intl.DateTimeFormat('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(date);
}

async function text(page, selector) {
  return page.$eval(selector, (el) => el.textContent.trim());
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function shot(page, name, focus) {
  await page.evaluate((selector) => {
    if (!selector) {
      window.scrollTo(0, 0);
      return;
    }
    const el = document.querySelector(selector);
    if (!el) {
      window.scrollTo(0, 0);
      return;
    }
    const top = el.getBoundingClientRect().top + window.scrollY - 72;
    window.scrollTo(0, Math.max(0, top));
  }, focus || '');
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function assertTextFits(page) {
  const problems = await page.evaluate(() => {
    const hidden = (el) => Boolean(el.closest('[hidden]'));
    const issues = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (hidden(el)) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'SVG' || tag === 'PATH') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (style.display !== 'inline' && el.scrollWidth > el.clientWidth + 1) {
        issues.push(`wide ${tag}.${String(el.className).slice(0, 40)} ${(el.textContent || '').trim().slice(0, 32)}`);
      }
    }
    const wordSplitsMidGlyph = (node, start, word) => {
      let lastTop = null;
      for (let i = 0; i < word.length; i += 1) {
        const glyph = document.createRange();
        glyph.setStart(node, start + i);
        glyph.setEnd(node, start + i + 1);
        const box = [...glyph.getClientRects()].find((item) => item.width > 0.5 && item.height > 0.5);
        if (!box) continue;
        if (lastTop != null && Math.abs(box.top - lastTop) > 1) {
          const prev = word[i - 1];
          if (prev !== '-' && prev !== '/' && prev !== '–' && prev !== '—') return true;
        }
        lastTop = box.top;
      }
      return false;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || hidden(parent)) continue;
      const text = node.textContent || '';
      const re = /\S+/g;
      let match;
      while ((match = re.exec(text))) {
        if (match[0].length < 2) continue;
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter((item) => item.width > 0.5 && item.height > 0.5);
        if (rects.length > 1 && wordSplitsMidGlyph(node, match.index, match[0])) {
          issues.push(`split ${match[0]}`);
        }
        if (issues.length > 10) return issues;
      }
    }
    return issues.slice(0, 10);
  });
  assert.deepEqual(problems, []);
}

async function assertTypeScale(page) {
  const stray = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const allowed = new Set([
      root.getPropertyValue('--font-large').trim(),
      root.getPropertyValue('--font-medium').trim(),
      root.getPropertyValue('--font-small').trim()
    ]);
    const seen = new Set();
    const bad = [];
    for (const el of document.body.querySelectorAll('*')) {
      const size = getComputedStyle(el).fontSize;
      seen.add(size);
      if (!allowed.has(size) && bad.length < 8) {
        bad.push(`${size} ${el.tagName}.${el.className}`.slice(0, 80));
      }
    }
    return { allowed: [...allowed], seen: [...seen], bad };
  });
  assert.deepEqual(stray.bad, [], JSON.stringify(stray));
  assert.equal(stray.allowed.length, 3);
  await assertTextFits(page);
}

async function assertAlignment(page) {
  const issues = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return ['missing main'];
    const box = main.getBoundingClientRect();
    const style = getComputedStyle(main);
    const left = box.left + parseFloat(style.paddingLeft);
    const right = box.right - parseFloat(style.paddingRight);
    const problems = [];
    const visible = (el) => {
      if (el.closest('[hidden]')) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    };
    for (const card of main.querySelectorAll('.block, .panel, .group')) {
      if (!visible(card)) continue;
      const rect = card.getBoundingClientRect();
      if (Math.abs(rect.left - left) > 1 || Math.abs(rect.right - right) > 1) {
        problems.push(`card ${card.className} ${Math.round(rect.left)}-${Math.round(rect.right)} vs ${Math.round(left)}-${Math.round(right)}`);
      }
      const edges = [...card.querySelectorAll(':scope [data-edge]')].filter((el) => {
        if (!visible(el)) return false;
        const nested = el.parentElement?.closest('.block, .panel, .group');
        return nested === card;
      });
      if (edges.length < 2) continue;
      const edgeLeft = edges[0].getBoundingClientRect().left;
      if (edges.some((el) => Math.abs(el.getBoundingClientRect().left - edgeLeft) > 1)) {
        problems.push(`edge ${card.className}`);
      }
    }
    for (const line of main.querySelectorAll('.checkline')) {
      if (!visible(line)) continue;
      const box = line.querySelector('input[type="checkbox"]');
      const title = line.querySelector('.check-title');
      if (!box || !title) continue;
      const boxRect = box.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(title).lineHeight) || titleRect.height;
      if (boxRect.top > titleRect.top + lineHeight || boxRect.bottom < titleRect.top) {
        problems.push('checkbox off the first line');
      }
      const host = line.closest('.money, .panel, .group');
      const field = host?.querySelector('.field input, .field select, .field textarea');
      if (field && Math.abs(boxRect.left - field.getBoundingClientRect().left) > 1) {
        problems.push('checkbox off the field edge');
      }
    }
    return problems;
  });
  assert.deepEqual(issues, []);
}

async function go(page, hash, ready) {
  await page.evaluate((next) => {
    if (location.hash !== next) location.hash = next;
  }, hash);
  await page.waitForFunction((next) => location.hash === next, {}, hash);
  await page.waitForSelector(ready);
}

async function typeInto(page, selector, value) {
  await page.waitForSelector(selector);
  await page.$eval(selector, (el) => el.scrollIntoView({ block: 'center' }));
  await page.click(selector, { clickCount: 3 });
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, selector);
  if (value) await page.type(selector, value, { delay: 8 });
}

async function setDate(page, selector, value) {
  await page.$eval(selector, (el, next) => {
    el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function press(page, selector) {
  await page.waitForSelector(selector);
  await page.$eval(selector, (el) => el.click());
}

async function clickLabel(page, label) {
  const ok = await page.evaluate((label) => {
    const shown = (el) => !el.closest('[hidden]') && getComputedStyle(el).display !== 'none';
    const match = [...document.querySelectorAll('label.chip, label.pick, label.checkline')]
      .filter(shown)
      .find((el) => el.textContent.trim().startsWith(label));
    if (!match) return false;
    match.click();
    return true;
  }, label);
  assert.equal(ok, true, `missing label ${label}`);
}

async function clickDialog(page, label) {
  await page.waitForSelector('dialog[open]');
  const ok = await page.evaluate((label) => {
    const button = [...document.querySelectorAll('dialog[open] button')]
      .find((el) => el.textContent.trim() === label);
    if (!button) return false;
    button.click();
    return true;
  }, label);
  assert.equal(ok, true, `missing dialog button ${label}`);
}

async function assertNoOverflow(page) {
  const extra = await page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ));
  assert.ok(extra <= 1, `horizontal overflow ${extra}px`);
}

async function assertTapTargets(page) {
  const small = await page.evaluate(() => {
    const nodes = [
      ...document.querySelectorAll('a.btn, button.btn, .nav a, .chip, .chips button, .icon-btn, .monogram, .arrow, label.pick, .field input, .field select, .field textarea, .search input')
    ];
    return nodes.flatMap((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || rect.height >= 47) return [];
      return [`${Math.round(rect.height)}px ${el.tagName}.${el.className} ${(el.textContent || el.id || '').trim().slice(0, 40)}`];
    });
  });
  assert.deepEqual(small, []);
}

async function reset(page) {
  await page.evaluate(() => {
    localStorage.clear();
    window.__figureCap.clearNow();
    if (location.hash !== '#home') location.hash = '#home';
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#month-title');
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const external = [];
  const errors = [];
  const browser = await puppeteer.launch({
    executablePath: '/usr/local/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.setRequestInterception(true);
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('chrome-extension:')) return;
      const host = new URL(url).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost') external.push(url);
      if (url.includes('script.google.com') || url.includes('script.googleusercontent.com')) {
        request.respond({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ ok: true, purchases: [], wishlist: [], forSale: [], priceChecks: [] })
        });
        return;
      }
      if (url.includes('api.frankfurter.app') || url.includes('open.er-api.com')) {
        const dated = url.match(/(\d{4}-\d{2}-\d{2})/);
        request.respond({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({
            amount: 1,
            base: 'JPY',
            date: dated ? dated[1] : '2026-10-26',
            rates: { MYR: 0.03055 }
          })
        });
        return;
      }
      request.continue().catch(() => {});
    });

    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#month-title');
    await page.waitForFunction(() => window.__figureCap);
    await reset(page);

    const realToday = await page.evaluate(() => window.__figureCap.today());
    assert.equal(await text(page, '#today-line'), klLong(new Date()));
    assert.equal(await text(page, '#left-value'), 'RM 400 / 400');
    const headingFocus = await page.evaluate(() => {
      const heading = document.getElementById('month-title');
      const style = getComputedStyle(heading);
      return {
        focused: document.activeElement === heading,
        tabIndex: heading.tabIndex,
        outline: style.outlineStyle,
        shadow: style.boxShadow
      };
    });
    assert.equal(headingFocus.focused, false);
    assert.equal(headingFocus.tabIndex, -1);
    assert.equal(headingFocus.outline, 'none');
    assert.equal(headingFocus.shadow, 'none');
    assert.equal(await text(page, '#cap-line'), 'left this month');
    assert.equal(await text(page, '#spent-value'), 'RM 0.00');
    assert.equal(await text(page, '#ytd-value'), 'RM 0.00');
    assert.equal(await page.$eval('#cap-status', (el) => el.dataset.state), 'ok');
    assert.equal(await page.$('#cap-message'), null);
    assert.equal(await page.$('#pace-card'), null);
    const homeText = await bodyText(page);
    assert.equal(homeText.includes('One in, one out'), false);
    assert.equal(homeText.includes('Rules'), false);
    assert.equal(homeText.includes('48-hour'), false);
    assert.equal(homeText.includes('Ready to buy'), false);
    const tabs = await page.$$eval('.nav a', (links) => links.map((link) => link.textContent.trim()));
    assert.deepEqual(tabs, ['Home', 'Log', 'Wishlist', 'Sell', 'Settings']);
    await assertNoOverflow(page);
    await assertTapTargets(page);
    await assertTypeScale(page);
    await assertAlignment(page);
    await assertTextFits(page);
    await shot(page, 'home');

    await go(page, '#settings', '#field-cap');
    assert.equal(await page.$('#field-wait'), null);
    assert.equal(await page.$eval('#field-payback', (el) => el.checked), true);
    assert.equal(await page.$eval('#field-cap', (el) => el.value), '400.00');
    assert.equal(await page.$eval('#field-rollover', (el) => el.checked), false);
    assert.equal(await page.$eval('#field-sync', (el) => el.value), DEFAULT_SYNC_URL);
    await page.waitForFunction(() => !/Sync off/.test(document.getElementById('sync-status').textContent));
    await press(page, '#sync-all');
    await page.waitForFunction(() => {
      const toast = document.getElementById('toast');
      return toast && !toast.hidden && toast.textContent.includes('Synced');
    });
    await typeInto(page, '#field-cap', 'abc');
    await page.$eval('#settings-form button[type="submit"]', (button) => button.click());
    await page.waitForSelector('.form-error:not([hidden])');
    assert.match(await text(page, '.form-error'), /Enter a cap/);

    await go(page, '#log', '#field-name');
    assert.equal(await page.$eval('#field-date', (el) => el.value), realToday);
    assert.equal(await page.$eval('#field-price-currency', (el) => el.value), 'MYR');
    await press(page, '#log-form button[type="submit"]');
    await page.waitForSelector('.form-error:not([hidden])');
    assert.match(await text(page, '.form-error'), /Enter a figure name/);
    await assertTapTargets(page);
    await assertNoOverflow(page);
    await assertTypeScale(page);
    await assertAlignment(page);
    await shot(page, 'log-add');

    await typeInto(page, '#field-name', 'Asuka Langley Soryu Plugsuit Ver. 1/7 Scale');
    await typeInto(page, '#field-price', '80');
    await page.$eval('details.more', (el) => { el.open = true; });
    await page.select('#field-type', 'nendoroid');
    await typeInto(page, '#field-series', 'Neon Genesis Evangelion');
    await typeInto(page, '#field-brand', 'Good Smile');
    await typeInto(page, '#field-notes', 'window');
    await press(page, '#log-form button[type="submit"]');
    await page.waitForSelector('#month-title');
    assert.equal(await text(page, '#spent-value'), 'RM 80.00');
    assert.equal(await text(page, '#left-value'), 'RM 320 / 400');
    assert.equal(await text(page, '#ytd-value'), 'RM 80.00');
    assert.equal(await page.$('#cap-message'), null);

    const earlier = `${realToday.slice(0, 4)}-01-15`;
    await go(page, '#log', '#field-name');
    await typeInto(page, '#field-name', 'Rei');
    await typeInto(page, '#field-price', '150');
    await setDate(page, '#field-date', earlier);
    await clickLabel(page, 'Pre-order');
    await press(page, '#log-form button[type="submit"]');
    await page.waitForSelector('#month-title');
    assert.equal(await text(page, '#spent-value'), 'RM 80.00');
    assert.equal(await text(page, '#ytd-value'), 'RM 230.00');

    await go(page, '#entries', '#chart');
    let entries = await bodyText(page);
    assert.match(entries, /Asuka/i);
    assert.match(entries, /Rei/i);
    assert.match(entries, /window/);
    assert.match(entries, /Pre-order/);
    assert.match(entries, /Nendoroid/i);
    assert.match(entries, /Good Smile/);
    await assertTypeScale(page);
    await assertAlignment(page);
    await shot(page, 'log-entries');
    await press(page, '[data-action="open-filters"]');
    await page.waitForSelector('dialog[open] [data-filter="brand"][data-value="Good Smile"]');
    await assertTypeScale(page);
    await page.evaluate(() => {
      document.querySelector('dialog[open] [data-filter="brand"][data-value="Good Smile"]').click();
    });
    await page.waitForFunction(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('asuka') && !text.includes('rei');
    });
    entries = await bodyText(page);
    assert.match(entries, /Nendoroid/);
    assert.match(entries, /RM 80\.00/);
    await assertNoOverflow(page);

    await page.evaluate(() => {
      const article = [...document.querySelectorAll('article')].find((el) => el.querySelector('h3')?.textContent.includes('Asuka'));
      article.querySelector('a.btn').click();
    });
    await page.waitForSelector('#edit-form');
    await assertTypeScale(page);
    await assertAlignment(page);
    await shot(page, 'log-edit');
    await typeInto(page, '#field-price', '90');
    await press(page, '#edit-form button[type="submit"]');
    await page.waitForSelector('#chart');
    assert.match(await bodyText(page), /RM 90\.00/);
    assert.match((await bodyText(page)).toLowerCase(), /asuka/);

    await go(page, '#wish', '#wish-name');
    await press(page, '#wish-form button[type="submit"]');
    await page.waitForSelector('.form-error:not([hidden])');
    assert.match(await text(page, '.form-error'), /Enter a figure name/);
    await typeInto(page, '#wish-name', 'Mari');
    await typeInto(page, '#wish-price', '100');
    await press(page, '#wish-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('wish-total')?.textContent === '100');
    assert.match(await bodyText(page), /Fits this month/);
    assert.equal((await bodyText(page)).includes('Ready to buy'), false);
    await assertTypeScale(page);
    await assertAlignment(page);
    await shot(page, 'wishlist');
    await page.evaluate(() => document.querySelector('[data-action="remove-wish"]').click());
    await page.waitForFunction(() => document.getElementById('wish-total')?.textContent === '0');
    await page.waitForSelector('[data-action="toast-action"]');
    await press(page, '[data-action="toast-action"]');
    await page.waitForFunction(() => document.getElementById('wish-total')?.textContent === '100');

    await go(page, '#plan', '#plan-summary');
    await assertTypeScale(page);
    await assertAlignment(page);
    await shot(page, 'plan');
    await page.click('label.pick');
    await page.waitForFunction(() => document.getElementById('plan-detail').textContent.includes('would still be left'));

    await go(page, '#sell', '#sale-name');
    await typeInto(page, '#sale-name', 'Mari');
    await typeInto(page, '#sale-price', '70');
    await press(page, '#sale-form button[type="submit"]');
    await page.waitForFunction(() => document.body.innerText.includes('No price check yet.'));
    assert.match(await bodyText(page), /MISB/);
    assert.match(await bodyText(page), /RM 70\.00/);
    await assertTypeScale(page);
    await assertAlignment(page);
    await shot(page, 'sell');
    await assertNoOverflow(page);
    await press(page, 'a[href^="#edit-sale/"]');
    await page.waitForSelector('#sale-form');
    await assertTypeScale(page);
    await assertAlignment(page);
    await shot(page, 'sell-edit');

    await go(page, '#settings', '#field-cap');
    await assertTypeScale(page);
    await assertAlignment(page);
    await shot(page, 'settings');

    await go(page, '#log', '#field-name');
    await typeInto(page, '#field-name', 'Over cap');
    await typeInto(page, '#field-price', '500');
    await press(page, '#log-form button[type="submit"]');
    await page.waitForSelector('#cap-message');
    assert.equal(await text(page, '#cap-message'), 'Month done, next purchase waits for the 1st');
    assert.equal(await page.$eval('#cap-status', (el) => el.dataset.state), 'over');

    await page.evaluate((today) => {
      localStorage.setItem('figure-cap.v1', JSON.stringify({
        settings: { monthlyCap: 400, waitHours: 0, rollover: false, trackingStart: '2026-01' },
        purchases: [{
          id: 'legacy',
          name: 'Legacy',
          price: 25,
          date: '2026-01-15',
          type: 'preorder',
          note: 'box',
          mood: 'excited',
          createdAt: '2026-01-15T00:00:00.000Z'
        }],
        wishlist: []
      }));
      location.hash = '#entries';
    }, realToday);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#chart');
    const migrated = await bodyText(page);
    assert.match(migrated, /Legacy/i);
    assert.match(migrated, /Pre-order/);
    assert.match(migrated, /Fully paid/);
    assert.match(migrated, /box/);
    assert.equal(migrated.includes('Excited'), false);
    assert.match(migrated, /RM 25\.00/);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('figure-cap.v1')).purchases[0]);
    assert.equal(stored.currency, 'MYR');
    assert.equal(stored.notes, 'box');
    assert.equal(stored.boughtAs, 'preorder');
    assert.equal(stored.preorderStatus, 'fully paid');
    assert.equal(stored.depositAmountRm, 25);
    assert.equal(stored.price, 25);

    await go(page, '#log', '#field-name');
    await typeInto(page, '#field-name', 'Yen figure');
    await page.select('#field-price-currency', 'JPY');
    await setDate(page, '#field-date', '2026-09-15');
    await typeInto(page, '#field-price', '12800');
    await page.waitForFunction(() => document.querySelector('[data-fx-hint]')?.textContent.includes('¥12,800 ≈ RM 391.04'));
    assert.equal((await text(page, '[data-fx-hint]')).includes('cached rate'), false);
    await shot(page, 'log-fx');
    await press(page, '#log-form button[type="submit"]');
    await page.waitForSelector('#ytd-value');
    const yen = await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('figure-cap.v1'));
      return data.purchases.find((item) => item.name === 'Yen figure');
    });
    assert.equal(yen.price, 391.04);
    assert.equal(yen.originalAmount, 12800);
    assert.equal(yen.currency, 'JPY');
    assert.equal(yen.fxDate, '2026-09-15');
    assert.equal(yen.fxOverridden, false);
    assert.equal(await text(page, '#ytd-value'), 'RM 416.04');

    await go(page, '#log', '#field-name');
    await typeInto(page, '#field-name', 'Statement');
    await page.select('#field-price-currency', 'JPY');
    await typeInto(page, '#field-price', '12800');
    await page.waitForFunction(() => document.querySelector('[data-fx-hint]')?.textContent.includes('RM 391.04'));
    const statementLines = await page.evaluate(() => [...document.querySelectorAll('[data-fx-toggle]')].filter((el) => !el.closest('[hidden]') && !el.hidden).length);
    assert.equal(statementLines, 1);
    await clickLabel(page, 'Use statement amount');
    await page.waitForSelector('#field-price-rm');
    await typeInto(page, '#field-price-rm', '10');
    await press(page, '#log-form button[type="submit"]');
    await page.waitForSelector('#spent-value');
    const spentAfter = await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('figure-cap.v1'));
      return data.purchases.find((item) => item.name === 'Statement');
    });
    assert.equal(spentAfter.price, 10);
    assert.equal(spentAfter.originalAmount, 12800);
    assert.equal(spentAfter.currency, 'JPY');
    assert.equal(spentAfter.fxOverridden, true);

    const fxHosts = external.filter((url) => url.includes('frankfurter') || url.includes('er-api'));
    assert.ok(fxHosts.length > 0, 'expected a rate request');
    const unexpected = external.filter((url) => (
      !url.includes('frankfurter') && !url.includes('er-api') && !url.includes('script.google')
    ));
    assert.deepEqual(unexpected, []);
    assert.ok(external.some((url) => url.includes('script.google.com')));

    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#month-title');
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(dark, 'rgb(18, 18, 18)');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.reload({ waitUntil: 'networkidle0' });
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(light, 'rgb(245, 245, 247)');

    await page.evaluate(() => {
      localStorage.setItem('figure-cap.v1', JSON.stringify({
        settings: { monthlyCap: 400, rollover: false, overspendPayback: true, trackingStart: '2026-10', syncUrl: '' },
        purchases: [{
          id: 'over',
          name: 'October figure',
          price: 460,
          originalAmount: 460,
          currency: 'MYR',
          fxRate: 1,
          date: '2026-10-20',
          boughtAs: 'new',
          status: 'received',
          createdAt: '2026-10-20T00:00:00.000Z',
          updatedAt: '2026-10-20T00:00:00.000Z'
        }],
        wishlist: [{
          id: 'wish-payback',
          name: 'November wish',
          price: 100,
          originalAmount: 100,
          currency: 'MYR',
          fxRate: 1,
          priority: 'really',
          addedAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z'
        }],
        forSale: []
      }));
      window.__figureCap.setNow('2026-10-20T04:00:00Z');
      location.hash = '#home';
    });
    await page.waitForFunction(() => document.getElementById('cap-line')?.textContent === 'RM 60 over');
    assert.equal(await text(page, '#left-value'), 'RM 0 / 400');
    assert.equal(await text(page, '#cap-line'), 'RM 60 over');
    await page.evaluate(() => window.__figureCap.setNow('2026-11-15T04:00:00Z'));
    await page.waitForFunction(() => document.getElementById('cap-line')?.textContent.includes('from October'));
    assert.equal(await text(page, '#cap-line'), 'cap RM 340 · RM 60 from October');
    assert.equal(await text(page, '#left-value'), 'RM 340 / 340');
    await assertTypeScale(page);
    await shot(page, 'home-payback');
    await go(page, '#entries', '#chart');
    assert.match(await bodyText(page), /RM 340\.00/);
    await shot(page, 'entries-payback');
    await go(page, '#plan', '#plan-summary');
    assert.match(await text(page, '#plan-summary'), /RM 340\.00/);
    await shot(page, 'plan-payback');
    await page.evaluate(() => window.__figureCap.clearNow());

    await go(page, '#log', '#field-name');
    await clickLabel(page, 'Pre-order');
    await typeInto(page, '#field-name', 'Rei');
    await typeInto(page, '#field-est', '200');
    await typeInto(page, '#field-deposit', '50');
    await page.waitForFunction(() => /Balance due/.test(document.querySelector('[data-balance-due]')?.textContent || ''));
    const order = await page.evaluate(() => {
      const name = document.querySelector('#field-name');
      const bought = [...document.querySelectorAll('.kicker')].find((el) => el.textContent.trim() === 'Bought as');
      const status = [...document.querySelectorAll('.kicker')].find((el) => el.textContent.trim() === 'Status');
      const price = document.querySelector('#field-est');
      const after = Node.DOCUMENT_POSITION_FOLLOWING;
      return Boolean(name && bought && status && price)
        && Boolean(name.compareDocumentPosition(bought) & after)
        && Boolean(bought.compareDocumentPosition(status) & after)
        && Boolean(status.compareDocumentPosition(price) & after);
    });
    assert.equal(order, true);
    await page.select('#field-est-currency', 'JPY');
    await page.waitForFunction(() => {
      const lines = [...document.querySelectorAll('[data-fx-toggle]')].filter((el) => !el.closest('[hidden]') && !el.hidden);
      return lines.length === 1 && lines[0].textContent.includes('Use the RM amount on your card statement');
    });
    await page.select('#field-est-currency', 'MYR');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-fx-toggle]')].every((el) => el.hidden || el.closest('[hidden]')));
    await assertTypeScale(page);
    await assertAlignment(page);
    await shot(page, 'log-add', '#log-form .group');

    await page.setViewport({ width: 320, height: 700, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    for (const [hash, ready] of [['#home', '#left-value'], ['#log', '#field-name'], ['#wish', '#wish-name'], ['#sell', '#sale-name'], ['#settings', '#field-cap']]) {
      await go(page, hash, ready);
      await assertNoOverflow(page);
      await assertTapTargets(page);
      await assertTextFits(page);
    }

    const sw = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return Boolean(reg.active);
    });
    assert.equal(sw, true);
    assert.deepEqual(errors, []);
    console.log('browser walkthrough ok');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
