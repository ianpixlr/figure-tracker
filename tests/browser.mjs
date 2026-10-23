// Phone-width walkthrough. Run with the static server on 127.0.0.1:8765
// and puppeteer-core installed (NODE_PATH=/tmp/pw/node_modules).

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

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

function monthTitle(ym) {
  const [year, month] = ym.split('-').map(Number);
  return new Intl.DateTimeFormat('en-MY', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric'
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function shiftYmd(ymd, days) {
  const [year, month, day] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${mm}-${dd}`;
}

function prevMonthYmd(ymd) {
  const [year, month] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 2, 15));
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${mm}-15`;
}

async function text(page, selector) {
  return page.$eval(selector, (el) => el.textContent.trim());
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
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
  await page.click(selector);
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, selector);
  if (value) await page.type(selector, value, { delay: 8 });
}

async function choose(page, label) {
  const ok = await page.evaluate((label) => {
    const match = [...document.querySelectorAll('label.choice')]
      .find((el) => el.textContent.trim() === label);
    if (!match) return false;
    match.click();
    return true;
  }, label);
  assert.equal(ok, true, `missing choice ${label}`);
}

async function clickNamed(page, name, action) {
  const ok = await page.evaluate((name, action) => {
    const article = [...document.querySelectorAll('article')]
      .find((el) => el.querySelector('h3')?.textContent === name);
    const button = article?.querySelector(`[data-action="${action}"]`);
    if (!button) return false;
    button.click();
    return true;
  }, name, action);
  assert.equal(ok, true, `missing ${action} on ${name}`);
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
      ...document.querySelectorAll('a.btn, button.btn, .nav a, label.choice, label.pick, .field input, .field select, .field textarea')
    ];
    return nodes.flatMap((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || rect.height >= 47) return [];
      return [`${Math.round(rect.height)}px ${el.tagName}.${el.className} ${(el.textContent || el.id).trim().slice(0, 40)}`];
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
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#month-title');
}

async function logPurchase(page, { name, price, date, type, note, mood }) {
  if (!await page.$('#log-link')) await go(page, '#home', '#log-link');
  await page.click('#log-link');
  await page.waitForSelector('#field-name');
  await typeInto(page, '#field-name', name);
  await typeInto(page, '#field-price', price);
  if (date) {
    await page.$eval('#field-date', (el, value) => {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, date);
  }
  if (type) await choose(page, type);
  if (note) await typeInto(page, '#field-note', note);
  if (mood) await choose(page, mood);
  await page.click('#log-form button[type="submit"]');
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
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('chrome-extension:')) return;
      const type = request.resourceType();
      if (!['document', 'script', 'stylesheet', 'image', 'fetch', 'xhr', 'manifest', 'font'].includes(type)) return;
      const host = new URL(url).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost') external.push(url);
    });

    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#month-title');
    await page.waitForFunction(() => window.__figureCap);
    await reset(page);

    const realToday = await page.evaluate(() => window.__figureCap.today());
    const realMonth = monthTitle(realToday.slice(0, 7));
    assert.equal(await text(page, '#today-line'), klLong(new Date()));
    assert.equal(await text(page, '#month-title'), realMonth);
    assert.equal(await text(page, '#spent-value'), 'RM 0.00');
    assert.equal(await text(page, '#left-value'), 'RM 400.00');
    assert.equal(await text(page, '#cap-line'), 'Cap RM 400.00');
    assert.equal(await text(page, '#ytd-value'), 'RM 0.00');
    assert.equal(await page.$eval('#cap-status', (el) => el.dataset.state), 'ok');
    assert.match(await text(page, '#cap-status'), /On track/);
    assert.equal(await page.$('#cap-message'), null);
    assert.equal(await page.$('#pace-card'), null);
    const rules = await text(page, '.rules');
    assert.match(rules, /One in, one out/);
    assert.match(rules, /Unspent money can roll over/);
    assert.match(rules, /Off\./);
    assert.equal((await bodyText(page)).includes('48-hour'), false);
    assert.equal((await bodyText(page)).includes('Ready to buy'), false);
    await assertNoOverflow(page);
    await assertTapTargets(page);
    await shot(page, '01-home-empty');

    await go(page, '#settings', '#field-wait');
    assert.equal(await page.$eval('#field-wait', (el) => el.value), '0');
    assert.equal(await page.$eval('#field-cap', (el) => el.value), '400.00');
    assert.equal(await page.$eval('#field-rollover', (el) => el.checked), false);
    assert.equal((await bodyText(page)).includes('48-hour'), false);
    await typeInto(page, '#field-cap', 'abc');
    await page.click('#settings-form button[type="submit"]');
    await page.waitForSelector('.form-error:not([hidden])');
    assert.match(await text(page, '.form-error'), /Enter a cap/);
    await shot(page, '02-settings');

    await go(page, '#home', '#log-link');
    await page.click('#log-link');
    await page.waitForSelector('#field-name');
    assert.equal(await page.$eval('#field-date', (el) => el.value), realToday);
    await page.click('#log-form button[type="submit"]');
    await page.waitForSelector('.form-error:not([hidden])');
    assert.match(await text(page, '.form-error'), /Enter a figure name/);
    await assertTapTargets(page);
    await shot(page, '03-log');

    await logPurchase(page, {
      name: 'Asuka',
      price: '80',
      note: 'window',
      mood: 'Excited'
    });
    assert.equal(await text(page, '#spent-value'), 'RM 80.00');
    assert.equal(await text(page, '#left-value'), 'RM 320.00');
    assert.equal(await text(page, '#ytd-value'), 'RM 80.00');
    assert.equal(await page.$('#cap-message'), null);

    const earlier = prevMonthYmd(realToday);
    const earlierMonth = monthTitle(earlier.slice(0, 7));
    await logPurchase(page, {
      name: 'Rei',
      price: '150',
      date: earlier,
      type: 'Pre-order paid in full'
    });
    assert.equal(await text(page, '#spent-value'), 'RM 80.00');
    assert.equal(await text(page, '#ytd-value'), 'RM 230.00');
    assert.equal(await text(page, '#month-title'), realMonth);

    await go(page, '#history', '#chart');
    const history = await bodyText(page);
    assert.match(history, new RegExp(earlierMonth));
    assert.match(history, /RM 150\.00/);
    assert.match(history, /Pre-order paid in full/);
    assert.match(history, /Asuka/);
    assert.match(history, /window/);
    assert.match(history, /Excited/);
    assert.match(history, /Bought/);
    await assertNoOverflow(page);
    await shot(page, '04-history');

    await go(page, '#wish', '#wish-form');
    await page.click('#wish-form button[type="submit"]');
    await page.waitForSelector('.form-error:not([hidden])');
    assert.match(await text(page, '.form-error'), /Enter a figure name/);

    async function addWish(name, price, priority) {
      await go(page, '#wish', '#wish-name');
      await typeInto(page, '#wish-name', name);
      await typeInto(page, '#wish-price', price);
      if (priority) await page.select('#wish-priority', priority);
      await page.click('#wish-form button[type="submit"]');
      await page.waitForFunction((name) => document.body.innerText.includes(name), {}, name);
    }

    await addWish('Nendoroid', '200');
    await addWish('Prize', '50', 'nice');
    await addWish('Grail', '300', 'must');
    await addWish('Mega', '500');

    assert.equal(await text(page, '#wish-total'), 'RM 1,050.00');
    assert.equal(await text(page, '#wish-count'), '4 figures');
    const names = await page.$$eval('#wish-list h3', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(names, ['Grail', 'Nendoroid', 'Mega', 'Prize']);
    const cards = await page.$$eval('#wish-list article', (nodes) => nodes.map((node) => node.innerText));
    assert.match(cards[0], /Must have · Fits this month · 94% of what's left/);
    assert.match(cards[1], /Really want · Fits this month · 63% of what's left/);
    assert.match(cards[2], /156% of what's left · Wait for next month \(RM 180\.00 short\)/);
    assert.match(cards[3], /Nice to have · Fits this month · 16% of what's left/);
    assert.equal(cards.join('\n').includes('Ready to buy'), false);
    assert.equal(cards.join('\n').includes('Ready in'), false);
    const enabled = await page.$$eval('[data-action="log-wish"]', (nodes) => nodes.every((node) => !node.disabled));
    assert.equal(enabled, true);
    await assertTapTargets(page);
    await assertNoOverflow(page);
    await shot(page, '05-wishlist');

    await clickNamed(page, 'Prize', 'remove-wish');
    await page.waitForSelector('#toast button');
    assert.equal(await text(page, '#wish-total'), 'RM 1,000.00');
    await page.click('#toast button');
    await page.waitForFunction(() => document.querySelector('#wish-total')?.textContent.includes('1,050.00'));
    assert.equal(await text(page, '#wish-count'), '4 figures');

    await page.click('a[href="#plan"]');
    await page.waitForSelector('#plan-summary');
    assert.match(await text(page, '#plan-detail'), /Pick figures/);
    await page.evaluate(() => {
      document.querySelectorAll('.pick input').forEach((input) => {
        const name = input.closest('.pick').innerText;
        if (name.includes('Grail') || name.includes('Nendoroid')) input.click();
      });
    });
    await page.waitForFunction(() => document.querySelector('#plan-detail')?.textContent.includes('over'));
    assert.match(await text(page, '.plan-headline'), /RM 500\.00 selected/);
    assert.match(await text(page, '#plan-detail'), /RM 180\.00 over what's left this month/);
    await page.evaluate(() => {
      const input = [...document.querySelectorAll('.pick input')]
        .find((el) => el.closest('.pick').innerText.includes('Nendoroid'));
      input.click();
    });
    await page.waitForFunction(() => document.querySelector('#plan-detail')?.textContent.includes('still be left'));
    assert.match(await text(page, '.plan-headline'), /RM 300\.00 selected/);
    assert.match(await text(page, '#plan-detail'), /RM 20\.00 would still be left/);
    await assertNoOverflow(page);
    await shot(page, '06-plan');

    await go(page, '#wish', '#wish-list');
    await clickNamed(page, 'Mega', 'log-wish');
    await page.waitForSelector('dialog[open]');
    const warning = await text(page, 'dialog');
    assert.match(warning, /This would go past what's left by RM 180\.00/);
    assert.match(warning, /Log it anyway/);
    await clickDialog(page, 'Cancel');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal((await page.$$eval('#wish-list h3', (nodes) => nodes.map((node) => node.textContent))).includes('Mega'), true);

    await clickNamed(page, 'Prize', 'log-wish');
    await page.waitForSelector('dialog[open]');
    const okLog = await text(page, 'dialog');
    assert.match(okLog, /Log this figure\?/);
    assert.equal(okLog.includes('go past'), false);
    await clickDialog(page, 'Log purchase');
    await page.waitForSelector('#spent-value');
    assert.equal(await text(page, '#spent-value'), 'RM 130.00');
    assert.equal(await text(page, '#left-value'), 'RM 270.00');
    assert.equal(await text(page, '#ytd-value'), 'RM 280.00');

    await go(page, '#history', '#chart');
    await page.evaluate(() => {
      const article = [...document.querySelectorAll('article')]
        .find((el) => el.querySelector('h3')?.textContent === 'Asuka');
      article.querySelector('a').click();
    });
    await page.waitForSelector('#edit-form');
    assert.equal(await page.$eval('#field-price', (el) => el.value), '80.00');
    assert.equal(await page.$eval('#field-note', (el) => el.value), 'window');
    await typeInto(page, '#field-price', '90');
    await page.click('#edit-form button[type="submit"]');
    await page.waitForSelector('#chart');
    assert.match(await bodyText(page), /RM 90\.00/);

    await go(page, '#home', '#spent-value');
    assert.equal(await text(page, '#spent-value'), 'RM 140.00');
    assert.equal(await text(page, '#ytd-value'), 'RM 290.00');

    await go(page, '#history', '#chart');
    await clickNamed(page, 'Rei', 'delete-purchase');
    await page.waitForSelector('dialog[open]');
    await clickDialog(page, 'Delete');
    await page.waitForSelector('#chart');
    assert.equal((await bodyText(page)).includes('Rei'), false);
    assert.equal((await bodyText(page)).includes(earlierMonth), false);
    await go(page, '#home', '#ytd-value');
    assert.equal(await text(page, '#spent-value'), 'RM 140.00');
    assert.equal(await text(page, '#left-value'), 'RM 260.00');
    assert.equal(await text(page, '#ytd-value'), 'RM 140.00');
    await shot(page, '07-home-after-edits');

    await page.evaluate(() => {
      window.__downloads = [];
      document.addEventListener('click', (event) => {
        const link = event.target.closest?.('a[download]');
        if (!link) return;
        window.__downloads.push({ name: link.download, href: link.href });
      }, true);
    });
    await go(page, '#settings', '#field-cap');
    await page.click('[data-action="export"]');
    const exported = await page.evaluate(async () => {
      const item = window.__downloads.at(-1);
      const json = await (await fetch(item.href)).json();
      return { name: item.name, json };
    });
    assert.equal(exported.name, `figure-cap-${realToday}.json`);
    assert.equal(exported.json.version, 1);
    assert.equal(exported.json.purchases.length, 2);
    await writeFile('/tmp/figure-cap-backup.json', JSON.stringify(exported.json));
    await writeFile('/tmp/figure-cap-bad.json', '{');
    await writeFile('/tmp/figure-cap-shape.json', '{"foo":1}');

    await reset(page);
    assert.equal(await text(page, '#spent-value'), 'RM 0.00');
    await go(page, '#settings', '#import-file');
    const input = await page.$('#import-file');
    await input.uploadFile('/tmp/figure-cap-backup.json');
    await page.waitForSelector('dialog[open]');
    await clickDialog(page, 'Cancel');
    await go(page, '#home', '#spent-value');
    assert.equal(await text(page, '#spent-value'), 'RM 0.00');

    await go(page, '#settings', '#import-file');
    await (await page.$('#import-file')).uploadFile('/tmp/figure-cap-shape.json');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('not a Figure Cap backup'));
    await (await page.$('#import-file')).uploadFile('/tmp/figure-cap-bad.json');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('not valid JSON'));

    await (await page.$('#import-file')).uploadFile('/tmp/figure-cap-backup.json');
    await page.waitForSelector('dialog[open]');
    await clickDialog(page, 'Replace');
    await page.waitForSelector('#spent-value');
    assert.equal(await text(page, '#spent-value'), 'RM 140.00');
    await go(page, '#wish', '#wish-total');
    assert.equal(await text(page, '#wish-total'), 'RM 1,000.00');

    await reset(page);
    await logPurchase(page, { name: 'Threshold', price: '300' });
    assert.equal(await page.$eval('.bar', (el) => el.dataset.state), 'ok');
    assert.match(await text(page, '#cap-status'), /75% · On track/);
    assert.equal(await page.$('#cap-message'), null);
    await logPurchase(page, { name: 'Cent', price: '0.01' });
    assert.equal(await page.$eval('.bar', (el) => el.dataset.state), 'warn');
    assert.match(await text(page, '#cap-status'), /Past 75% of the cap/);
    assert.equal(await page.$('#cap-message'), null);
    await logPurchase(page, { name: 'Rest', price: '99.99' });
    assert.equal(await text(page, '#cap-message'), 'Month done, next purchase waits for the 1st');
    assert.equal(await page.$eval('.bar', (el) => el.dataset.state), 'warn');
    assert.equal(await text(page, '#left-value'), 'RM 0.00');
    await logPurchase(page, { name: 'Extra', price: '10' });
    assert.equal(await page.$eval('.bar', (el) => el.dataset.state), 'over');
    assert.match(await text(page, '#cap-status'), /Over the cap/);
    assert.equal(await text(page, '#cap-message'), 'Month done, next purchase waits for the 1st');
    assert.match(await bodyText(page), /RM 10\.00 over/);
    await shot(page, '08-over-cap');

    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#cap-message');
    const dark = await page.$eval('body', (el) => getComputedStyle(el).backgroundColor);
    assert.equal(dark, 'rgb(18, 17, 15)');
    await shot(page, '09-dark');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#month-title');
    const light = await page.$eval('body', (el) => getComputedStyle(el).backgroundColor);
    assert.equal(light, 'rgb(243, 239, 230)');

    await page.setViewport({ width: 320, height: 720, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await go(page, '#log', '#field-name');
    await assertNoOverflow(page);
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

    await reset(page);
    const today = await page.evaluate(() => window.__figureCap.today());
    await logPurchase(page, { name: 'Recent', price: '300', date: shiftYmd(today, -29) });
    assert.equal(await page.$('#pace-card'), null);
    await reset(page);
    await logPurchase(page, { name: 'Older', price: '300', date: shiftYmd(today, -40) });
    await page.waitForSelector('#pace-card');
    const pace = await text(page, '#pace-card');
    assert.match(pace, /RM 225\.00/);
    assert.match(pace, /below the RM 400\.00 cap/);
    await shot(page, '10-pace');

    await reset(page);
    const clock = await page.evaluate(() => window.__figureCap.today());
    await logPurchase(page, { name: 'Last month', price: '100', date: prevMonthYmd(clock), type: 'Pre-order paid in full' });
    await go(page, '#settings', '#field-rollover');
    await page.click('.checkline');
    await page.waitForFunction(() => document.querySelector('#settings-preview').textContent.includes('700.00'));
    assert.match(await text(page, '#settings-preview'), /RM 700\.00, including RM 300\.00 rolled over/);
    await page.click('#settings-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Settings saved'));
    await go(page, '#home', '#cap-line');
    assert.match(await text(page, '#cap-line'), /Cap RM 700\.00/);
    assert.match(await text(page, '#cap-line'), /RM 300\.00 rolled over/);
    assert.equal(await text(page, '#spent-value'), 'RM 0.00');
    assert.equal(await text(page, '#left-value'), 'RM 700.00');
    assert.match(await text(page, '.rules'), /On\./);
    await shot(page, '11-rollover');

    await reset(page);
    await page.evaluate(() => window.__figureCap.setNow('2026-06-15T04:00:00.000Z'));
    await page.waitForFunction(() => document.querySelector('#today-line').textContent.includes('15 June 2026'));
    assert.equal(await text(page, '#month-title'), 'June 2026');
    await go(page, '#settings', '#field-wait');
    await typeInto(page, '#field-wait', '48');
    await page.click('#settings-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Settings saved'));
    await go(page, '#wish', '#wish-name');
    await typeInto(page, '#wish-name', 'Snail');
    await typeInto(page, '#wish-price', '25');
    await page.click('#wish-form button[type="submit"]');
    await page.waitForSelector('[data-countdown]');
    assert.match(await text(page, '[data-countdown]'), /Ready in/);
    assert.equal(await page.$eval('[data-action="log-wish"]', (el) => el.disabled), true);
    assert.equal((await bodyText(page)).includes('Ready to buy'), false);

    await logPurchase(page, { name: 'Impatient', price: '5' });
    assert.equal(await text(page, '#spent-value'), 'RM 5.00');
    await go(page, '#wish', '[data-countdown]');
    assert.equal(await page.$eval('[data-action="log-wish"]', (el) => el.disabled), true);

    const addedAt = await page.evaluate(() => window.__figureCap.dump().data.wishlist[0].addedAt);
    const plus47 = new Date(Date.parse(addedAt) + 47 * 3600000).toISOString();
    const plus49 = new Date(Date.parse(addedAt) + 49 * 3600000).toISOString();
    await page.evaluate((iso) => window.__figureCap.setNow(iso), plus47);
    await page.waitForSelector('[data-countdown]');
    assert.equal(await page.$eval('[data-action="log-wish"]', (el) => el.disabled), true);
    assert.match(await text(page, '[data-countdown]'), /Ready in/);
    await page.evaluate((iso) => window.__figureCap.setNow(iso), plus49);
    await page.waitForFunction(() => document.querySelector('[data-countdown]')?.textContent === 'Ready to buy');
    assert.equal(await page.$eval('[data-action="log-wish"]', (el) => el.disabled), false);
    await shot(page, '12-wait-ready');
    await clickNamed(page, 'Snail', 'log-wish');
    await clickDialog(page, 'Log purchase');
    await page.waitForSelector('#spent-value');
    assert.equal(await text(page, '#spent-value'), 'RM 30.00');

    await go(page, '#settings', '#field-wait');
    await typeInto(page, '#field-wait', '0');
    await page.click('#settings-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Settings saved'));
    await go(page, '#wish', '#wish-name');
    await typeInto(page, '#wish-name', 'Instant');
    await typeInto(page, '#wish-price', '30');
    await page.click('#wish-form button[type="submit"]');
    await page.waitForFunction(() => document.body.innerText.includes('Instant'));
    assert.equal(await page.$('[data-countdown]'), null);
    assert.equal((await bodyText(page)).includes('Ready to buy'), false);
    assert.equal((await bodyText(page)).includes('Ready in'), false);
    assert.equal(await page.$eval('article [data-action="log-wish"]', (el) => el.disabled), false);

    await reset(page);
    await page.evaluate(() => window.__figureCap.setNow('2026-10-31T16:30:00.000Z'));
    await page.waitForFunction(() => document.querySelector('#today-line').textContent === 'Sunday, 1 November 2026');
    assert.equal(await text(page, '#month-title'), 'November 2026');
    await logPurchase(page, { name: 'October figure', price: '40', date: '2026-10-31' });
    assert.equal(await text(page, '#month-title'), 'November 2026');
    assert.equal(await text(page, '#spent-value'), 'RM 0.00');
    await go(page, '#history', '#chart');
    const boundary = await page.$eval('main', (el) => el.innerText);
    assert.match(boundary, /October 2026/);
    assert.match(boundary, /October figure/);
    assert.match(boundary, /RM 40\.00/);
    assert.match(boundary, /Nov 2026/);
    assert.match(boundary, /RM 0\.00/);
    assert.equal(boundary.includes('November 2026'), false);

    const ready = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return Boolean(reg.active);
    });
    assert.equal(ready, true);

    assert.deepEqual(external, []);
    const noisy = errors.filter((line) => !/favicon/i.test(line));
    assert.deepEqual(noisy, []);
    console.log('browser walkthrough ok');
  } catch (error) {
    const pages = await browser.pages();
    if (pages[0]) {
      try {
        await pages.at(-1).screenshot({ path: `${SHOTS}/failure.png`, fullPage: true });
        console.error(await pages.at(-1).evaluate(() => document.body.innerText));
      } catch { /* page may already be gone */ }
    }
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
