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
    const scroller = document.getElementById('main') || document.scrollingElement;
    const pinBottom = selector.startsWith('bottom:');
    const query = pinBottom ? selector.slice('bottom:'.length) : selector;
    if (!query) {
      scroller.scrollTop = 0;
      window.scrollTo(0, 0);
      return;
    }
    const el = document.querySelector(query);
    if (!el) {
      scroller.scrollTop = 0;
      return;
    }
    const origin = scroller.getBoundingClientRect().top;
    const elTop = el.getBoundingClientRect().top - origin + scroller.scrollTop;
    const elBottom = el.getBoundingClientRect().bottom - origin + scroller.scrollTop;
    const top = pinBottom
      ? elBottom - scroller.clientHeight + 96
      : elTop - 8;
    scroller.scrollTop = Math.max(0, top);
    window.scrollTo(0, 0);
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
  const extra = await page.evaluate(() => {
    const wide = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('[hidden]')) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (rect.right > window.innerWidth + 1 || rect.left < -1) {
        wide.push(`${el.tagName}.${String(el.className).slice(0, 40)} ${Math.round(rect.left)}-${Math.round(rect.right)}`);
      }
      if (wide.length > 6) break;
    }
    return {
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
      wide
    };
  });
  assert.equal(extra.scroll, extra.inner, JSON.stringify(extra));
  assert.deepEqual(extra.wide, []);
}

async function assertClearsNav(page) {
  const covered = await page.evaluate(() => {
    const scroller = document.getElementById('main');
    scroller.scrollTop = scroller.scrollHeight;
    const nav = document.querySelector('.nav');
    if (!nav) return ['missing nav'];
    const limit = nav.getBoundingClientRect().top;
    const problems = [];
    for (const el of document.querySelectorAll('main a, main button, main input, main select, main textarea, main p, main h2, main h3, main label')) {
      if (el.closest('[hidden]')) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || rect.top >= window.innerHeight) continue;
      if (rect.bottom > limit + 1) {
        problems.push(`${el.tagName}.${String(el.className).slice(0, 30)} ${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 28)}`);
      }
      if (problems.length > 6) break;
    }
    return problems;
  });
  assert.deepEqual(covered, []);
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

async function assertShell(page) {
  const shell = await page.evaluate(() => {
    const html = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const main = getComputedStyle(document.getElementById('main'));
    const nav = getComputedStyle(document.querySelector('.nav'));
    return {
      overscroll: html.overscrollBehavior,
      bodyOverscroll: body.overscrollBehavior,
      bodyPosition: body.position,
      bodyOverflow: body.overflowX,
      mainOverflow: main.overflowY,
      mainOverscroll: main.overscrollBehavior,
      navPosition: nav.position,
      touch: html.touchAction,
      viewport: document.querySelector('meta[name="viewport"]').content,
      preload: Boolean(document.querySelector('link[rel="preload"][as="font"]'))
    };
  });
  assert.equal(shell.viewport, 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover');
  assert.equal(shell.bodyPosition, 'fixed');
  assert.equal(shell.navPosition, 'fixed');
  assert.equal(shell.mainOverflow, 'auto');
  assert.ok(shell.overscroll.includes('none'), shell.overscroll);
  assert.ok(shell.bodyOverscroll.includes('none'), shell.bodyOverscroll);
  assert.ok(shell.mainOverscroll.includes('none'), shell.mainOverscroll);
  assert.equal(shell.bodyOverflow, 'hidden');
  assert.equal(shell.touch, 'manipulation');
  assert.equal(shell.preload, true);
}

async function assertNoFocusZoom(page) {
  await page.focus('#field-name');
  const zoom = await page.evaluate(() => ({
    scale: window.visualViewport.scale,
    size: getComputedStyle(document.querySelector('#field-name')).fontSize,
    scrollWidth: document.documentElement.scrollWidth,
    inner: window.innerWidth
  }));
  assert.equal(zoom.scale, 1);
  assert.equal(zoom.size, '15px');
  assert.equal(zoom.scrollWidth, zoom.inner);
}

function contrastScript() {
  return `(() => {
    const parse = (text) => {
      const match = String(text || '').match(/rgba?\\(([^)]+)\\)/);
      if (!match) return null;
      const parts = match[1].split(',').map((part) => Number(part.trim()));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const lin = (channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const lum = (rgb) => 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1
    });
    const ratio = (a, b) => {
      const left = lum(a);
      const right = lum(b);
      return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
    };
    const painted = (el) => {
      const layers = [];
      let node = el;
      while (node) {
        const bg = parse(getComputedStyle(node).backgroundColor);
        if (bg && bg.a > 0.01) layers.push(bg);
        if (bg && bg.a >= 0.99) break;
        node = node.parentElement;
      }
      if (!layers.length) layers.push(parse(getComputedStyle(document.body).backgroundColor));
      let acc = layers[layers.length - 1];
      for (let i = layers.length - 2; i >= 0; i -= 1) acc = over(layers[i], acc);
      return acc;
    };
    const hidden = (el) => {
      if (!el || el.closest('[hidden]')) return true;
      const style = getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
    };
    const problems = [];
    const note = (label, value, need) => {
      if (value + 0.02 < need) problems.push(label + ' ' + value.toFixed(2) + '<' + need);
    };
    for (const el of document.body.querySelectorAll('*')) {
      if (hidden(el) || el.disabled) continue;
      const direct = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
      if (!direct) continue;
      const style = getComputedStyle(el);
      const fg = parse(style.color);
      if (!fg || fg.a < 0.2) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const size = parseFloat(style.fontSize);
      const need = size >= 22 ? 3 : 4.5;
      note(size + 'px ' + (el.innerText || '').trim().slice(0, 42), ratio(fg, painted(el)), need);
      if (problems.length > 8) break;
    }
    for (const el of document.querySelectorAll('input, textarea')) {
      if (hidden(el) || el.disabled || el.type === 'checkbox' || el.type === 'radio' || el.type === 'file') continue;
      const hint = parse(getComputedStyle(el, '::placeholder').color);
      if (!hint) continue;
      note('placeholder ' + (el.getAttribute('placeholder') || el.id || ''), ratio(hint, painted(el)), 4.5);
      if (problems.length > 10) break;
    }
    return problems.slice(0, 10);
  })()`;
}

async function assertContrast(page) {
  const problems = await page.evaluate(new Function(`return ${contrastScript()};`));
  assert.deepEqual(problems, []);
}

async function assertFocusRing(page, selector) {
  await page.$eval(selector, (el) => el.focus({ focusVisible: true }));
  const ring = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const style = getComputedStyle(el);
    const parse = (text) => {
      const match = String(text || '').match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(',').map((part) => Number(part.trim()));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const lin = (channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const lum = (rgb) => 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
    const ratio = (a, b) => {
      const left = lum(a);
      const right = lum(b);
      return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
    };
    let node = el.parentElement;
    let bg = null;
    while (node) {
      const paint = parse(getComputedStyle(node).backgroundColor);
      if (paint && paint.a >= 0.99) {
        bg = paint;
        break;
      }
      node = node.parentElement;
    }
    const fg = parse(style.outlineColor);
    return {
      width: style.outlineWidth,
      style: style.outlineStyle,
      ratio: fg && bg ? ratio(fg, bg) : 0
    };
  }, selector);
  assert.equal(ring.style, 'solid');
  assert.ok(parseFloat(ring.width) >= 3, ring.width);
  assert.ok(ring.ratio >= 3, String(ring.ratio));
}

async function assertSingleDividers(page) {
  const problems = await page.evaluate(() => {
    const visible = (el) => el && !el.hidden && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none';
    const problems = [];
    for (const row of document.querySelectorAll('.row')) {
      if (!visible(row)) continue;
      const top = parseFloat(getComputedStyle(row).borderTopWidth) || 0;
      if (row.querySelector('.field') && top > 0) problems.push('field row border');
    }
    for (const group of document.querySelectorAll('.group')) {
      const rows = [...group.querySelectorAll(':scope > .row')].filter(visible);
      for (let i = 1; i < rows.length; i += 1) {
        const prevField = Boolean(rows[i - 1].querySelector('.field'));
        const field = Boolean(rows[i].querySelector('.field'));
        const top = parseFloat(getComputedStyle(rows[i]).borderTopWidth) || 0;
        if ((prevField || field) && top > 0) problems.push('double divider');
        if (!prevField && !field && top < 1) problems.push('missing chip line');
      }
    }
    for (const entry of document.querySelectorAll('.month-group article')) {
      const top = parseFloat(getComputedStyle(entry).borderTopWidth) || 0;
      if (top > 0) problems.push('entry border');
    }
    return problems;
  });
  assert.deepEqual(problems, []);
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
  let fxDown = false;
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
        if (fxDown) {
          request.respond({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ rates: {} })
          });
          return;
        }
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
    assert.equal(await page.$('article [data-check-form]'), null);
    const caro = await page.$eval('article a[href*="carousell.com.my"]', (el) => el.getAttribute('href'));
    const rrp = await page.$eval('article a[href*="google.com/search"]', (el) => el.getAttribute('href'));
    assert.equal(caro, `https://www.carousell.com.my/search/${encodeURIComponent('Mari MISB')}`);
    assert.equal(rrp, `https://www.google.com/search?q=${encodeURIComponent('Mari RRP')}`);
    await press(page, 'a[href^="#edit-sale/"]');
    await page.waitForSelector('[data-check-form] input[name="source"]');
    assert.equal(await page.$eval('[data-check-form] input[name="source"]', (el) => el.value), 'Carousell');
    await typeInto(page, '[data-check-form] input[name="low"]', '40');
    await typeInto(page, '[data-check-form] input[name="typical"]', '55');
    await typeInto(page, '[data-check-form] input[name="high"]', '80');
    await typeInto(page, '[data-check-form] input[name="rrp"]', 'RM 90');
    await press(page, '[data-check-form] button[type="submit"]');
    await page.waitForFunction(() => document.body.innerText.includes('Market RM 40 / 55 / 80 · RRP RM 90'));
    await go(page, '#sell', 'article.block');
    const cardText = await page.$eval('article.block', (el) => el.innerText);
    assert.match(cardText, /Market RM 40 \/ 55 \/ 80 · RRP RM 90/);
    assert.match(cardText, /Carousell · \d{1,2} \w{3}/);
    assert.equal(/\d{2}:\d{2}/.test(cardText), false);
    assert.equal(await page.$('article [data-check-form]'), null);
    await assertTypeScale(page);
    await assertAlignment(page);
    await assertClearsNav(page);
    await shot(page, 'sell');
    await shot(page, 'sell-check', 'article.block');
    await assertNoOverflow(page);
    await press(page, 'a[href^="#edit-sale/"]');
    await page.waitForSelector('#sale-form');
    await page.waitForFunction(() => document.body.innerText.includes('Market RM 40 / 55 / 80 · RRP RM 90'));
    await assertTypeScale(page);
    await assertAlignment(page);
    await page.setViewport({ width: 360, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await assertTextFits(page);
    await assertNoOverflow(page);
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await assertClearsNav(page);
    await shot(page, 'sell-edit');
    await shot(page, 'sell-check-edit', '.check');

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

    fxDown = true;
    await page.evaluate(() => localStorage.removeItem('figure-cap.fx.v1'));
    await go(page, '#log', '#field-name');
    await typeInto(page, '#field-name', 'Offline yen');
    await page.select('#field-price-currency', 'USD');
    await typeInto(page, '#field-price', '10');
    await page.waitForFunction(() => /Rate unavailable/.test(document.querySelector('[data-fx-hint]')?.textContent || ''));
    await clickLabel(page, 'Use statement amount');
    await page.waitForSelector('#field-price-rm');
    await typeInto(page, '#field-price-rm', '25');
    await press(page, '#log-form button[type="submit"]');
    await page.waitForFunction(() => {
      const data = JSON.parse(localStorage.getItem('figure-cap.v1') || '{}');
      const item = data.purchases?.find((purchase) => purchase.name === 'Offline yen');
      return item?.price === 25 && item.fxOverridden === true;
    });
    fxDown = false;

    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#month-title');
    const dark = await page.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      mode: document.documentElement.dataset.mode,
      theme: document.documentElement.dataset.theme,
      color: document.querySelector('meta[name="theme-color"]').content
    }));
    assert.equal(dark.bg, 'rgb(18, 18, 18)');
    assert.equal(dark.mode, 'dark');
    assert.equal(dark.theme, 'system');
    assert.equal(dark.color, '#121212');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.reload({ waitUntil: 'networkidle0' });
    const light = await page.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      mode: document.documentElement.dataset.mode,
      color: document.querySelector('meta[name="theme-color"]').content
    }));
    assert.equal(light.bg, 'rgb(245, 245, 247)');
    assert.equal(light.mode, 'light');
    assert.equal(light.color, '#f5f5f7');

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
    await assertSingleDividers(page);
    await assertNoFocusZoom(page);
    await assertShell(page);
    await shot(page, 'log-add', '#log-form .group');
    await page.evaluate(() => { document.getElementById('main').scrollTop = 240; });
    await go(page, '#home', '#left-value');
    assert.equal(await page.evaluate(() => document.getElementById('main').scrollTop), 0);

    await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('figure-cap.v1'));
      data.forSale = [{
        id: 'sale-1',
        name: 'Miku',
        condition: 'MISB',
        price: 80,
        originalAmount: 80,
        currency: 'MYR',
        fxRate: 1,
        status: 'listed',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z'
      }];
      localStorage.setItem('figure-cap.v1', JSON.stringify(data));
      localStorage.setItem('figure-cap.price-checks.local.v1', JSON.stringify([{
        for_sale_id: 'sale-1',
        figure: 'Miku',
        condition: 'MISB',
        low_rm: 40,
        typical_rm: 55,
        high_rm: 80,
        rrp: 'RM 90',
        sources: 'Carousell',
        checked_at: '2026-10-26T00:00:00.000Z'
      }]));
    });

    await go(page, '#settings', '#theme-label');
    await clickLabel(page, 'Dark');
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'dark');
    assert.equal(await page.evaluate(() => localStorage.getItem('figure-cap.theme')), 'dark');
    assert.equal(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content), '#121212');
    const darkChip = await page.evaluate(() => {
      const input = document.querySelector('input[name="theme"][value="dark"]');
      const style = getComputedStyle(input.closest('.chip'));
      return { bg: style.backgroundColor, color: style.color, checked: input.checked };
    });
    assert.equal(darkChip.checked, true);
    assert.equal(darkChip.bg, 'rgb(244, 244, 245)');
    assert.equal(darkChip.color, 'rgb(20, 20, 20)');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#theme-label');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.mode), 'dark');
    await clickLabel(page, 'Light');
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'light');
    const lightChip = await page.evaluate(() => {
      const input = document.querySelector('input[name="theme"][value="light"]');
      const style = getComputedStyle(input.closest('.chip'));
      return { bg: style.backgroundColor, color: style.color };
    });
    assert.equal(lightChip.bg, 'rgb(20, 20, 20)');
    assert.equal(lightChip.color, 'rgb(255, 255, 255)');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#theme-label');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.mode), 'light');
    await clickLabel(page, 'Match phone');
    assert.equal(await page.evaluate(() => localStorage.getItem('figure-cap.theme')), 'system');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.evaluate(() => {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      media.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'light');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.evaluate(() => {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      media.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'dark');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('figure-cap.v1')).settings);
    assert.equal(saved.theme, undefined);
    assert.equal(Object.hasOwn(saved, 'theme'), false);

    const screens = [
      ['#home', '#left-value'],
      ['#entries', '#chart'],
      ['#log', '#field-name'],
      ['#wish', '#wish-name'],
      ['#sell', 'article.block'],
      ['#edit-sale/sale-1', '#sale-name'],
      ['#settings', '#theme-label']
    ];
    for (const mode of ['dark', 'light']) {
      await page.evaluate((next) => {
        localStorage.setItem('figure-cap.theme', next);
      }, mode);
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode === 'dark' ? 'light' : 'dark' }]);
      await page.reload({ waitUntil: 'networkidle0' });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.mode), mode);
      for (const [hash, ready] of screens) {
        await go(page, hash, ready);
        if (hash === '#log') {
          await clickLabel(page, 'Pre-order');
          await assertFocusRing(page, '#field-name');
        }
        if (hash === '#settings') await assertFocusRing(page, '#field-cap');
        await assertContrast(page);
        await assertTypeScale(page);
        await assertNoOverflow(page);
        await assertSingleDividers(page);
      }
    }

    await page.evaluate(() => localStorage.setItem('figure-cap.theme', 'light'));
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    for (const width of [320, 360, 390]) {
      await page.setViewport({ width, height: 700, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      for (const [hash, ready] of [
        ['#home', '#left-value'],
        ['#log', '#field-name'],
        ['#entries', '#chart'],
        ['#edit/over', '#field-name'],
        ['#wish', '#wish-name'],
        ['#plan', '#plan-summary'],
        ['#sell', '#sale-name'],
        ['#edit-sale/sale-1', '#sale-name'],
        ['#settings', '#field-cap']
      ]) {
        await go(page, hash, ready);
        if (hash === '#log') await clickLabel(page, 'Pre-order');
        await assertNoOverflow(page);
        await assertTapTargets(page);
        await assertTextFits(page);
      }
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
