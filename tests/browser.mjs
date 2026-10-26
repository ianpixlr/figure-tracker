// Phone-width walkthrough. Serves the repo on 127.0.0.1:8765.

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { DEFAULT_SYNC_URL } from '../js/sync.js';

const BASE = 'http://127.0.0.1:8765/';
const SHOTS = '/tmp/figure-cap-shots';
const REPORTS = '/opt/cursor/artifacts/screenshots';

async function text(page, selector) {
  return page.$eval(selector, (el) => el.textContent.trim());
}

async function blockTones(page) {
  return page.$$eval('#main article.block', (els) => els.map((el) => (
    el.classList.contains('yellow') ? 'yellow' : 'white'
  )));
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function assertSearchToolbar(page) {
  const search = await page.evaluate(() => {
    const box = document.querySelector('.tools .search');
    const filter = document.querySelector('.tools .filter-btn');
    const input = box?.querySelector('input');
    const icon = box?.querySelector('.search-icon');
    if (!box || !filter || !input || !icon) return null;
    const br = box.getBoundingClientRect();
    const fr = filter.getBoundingClientRect();
    const ir = input.getBoundingClientRect();
    const bs = getComputedStyle(box);
    const fs = getComputedStyle(filter);
    const is = getComputedStyle(input);
    return {
      placeholder: input.placeholder,
      label: input.getAttribute('aria-label'),
      sameRow: Math.abs((br.top + br.height / 2) - (fr.top + fr.height / 2)) < 4,
      wider: br.width > fr.width + 8,
      heightDelta: Math.abs(br.height - fr.height),
      searchHeight: br.height,
      inputHeight: ir.height,
      inputWidth: ir.width,
      radius: bs.borderTopLeftRadius,
      filterRadius: fs.borderTopLeftRadius,
      border: bs.borderTopWidth,
      filterBorder: fs.borderTopWidth,
      borderColor: bs.borderTopColor,
      filterBorderColor: fs.borderTopColor,
      appearance: is.appearance
    };
  });
  assert.ok(search, 'search toolbar missing');
  assert.equal(search.placeholder, 'Search purchases');
  assert.equal(search.label, 'Search purchases');
  assert.equal(search.sameRow, true);
  assert.equal(search.wider, true);
  assert.ok(search.heightDelta < 2, `search ${search.searchHeight} vs filter`);
  assert.ok(search.searchHeight >= 47, String(search.searchHeight));
  assert.ok(search.inputHeight >= 47, String(search.inputHeight));
  assert.ok(search.inputWidth > 80, String(search.inputWidth));
  assert.equal(search.radius, search.filterRadius);
  assert.equal(search.border, '1px');
  assert.equal(search.filterBorder, '1px');
  assert.equal(search.borderColor, search.filterBorderColor);
  assert.equal(search.appearance, 'none');
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
      const clips = style.textOverflow === 'ellipsis' && (style.overflowX === 'hidden' || style.overflowX === 'clip');
      if (!clips && style.display !== 'inline' && el.scrollWidth > el.clientWidth + 1) {
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

async function assertChipRemove(page, mode) {
  const paint = await page.evaluate(() => {
    const chipOf = (name) => document.querySelector(`[data-name="${name}"]`)?.closest('.chip');
    const read = (name) => {
      const chip = chipOf(name);
      const button = chip?.querySelector('.chip-x');
      if (!chip || !button) return null;
      const cs = getComputedStyle(chip);
      const bs = getComputedStyle(button);
      const cr = chip.getBoundingClientRect();
      const br = button.getBoundingClientRect();
      const plain = document.querySelector('[data-type-chips] .chip:not(:has(.chip-x))');
      return {
        selected: chip.querySelector('input')?.checked === true,
        chipH: Math.round(cr.height),
        plainH: plain ? Math.round(plain.getBoundingClientRect().height) : 0,
        xW: Math.round(br.width),
        xH: Math.round(br.height),
        inside: br.left >= cr.left - 1 && br.right <= cr.right + 1 && br.top >= cr.top - 1 && br.bottom <= cr.bottom + 1,
        bg: bs.backgroundColor,
        border: bs.borderTopWidth,
        shadow: bs.boxShadow,
        radius: bs.borderTopLeftRadius,
        color: bs.color
      };
    };
    return { movie: read('Movie'), anime: read('Anime') };
  });
  for (const name of ['movie', 'anime']) assert.ok(paint[name], name);
  for (const row of [paint.movie, paint.anime]) {
    assert.equal(row.chipH, row.plainH);
    assert.ok(row.xW >= 32 && row.xH >= 32, `${row.xW}x${row.xH}`);
    assert.equal(row.inside, true);
    assert.equal(row.bg, 'rgba(0, 0, 0, 0)');
    assert.equal(row.border, '0px');
    assert.equal(row.shadow, 'none');
    assert.equal(row.radius, '0px');
  }
  assert.equal(paint.movie.selected, true);
  assert.equal(paint.anime.selected, false);
  assert.equal(paint.movie.color, 'rgb(22, 22, 22)');
  if (mode === 'light') assert.equal(paint.anime.color, 'rgb(92, 92, 102)');
  else assert.equal(paint.anime.color, 'rgb(183, 183, 192)');
}

async function press(page, selector) {
  await page.waitForSelector(selector);
  await page.$eval(selector, (el) => el.click());
}

function chipLabelList() {
  return `[...document.querySelectorAll('[data-type-chips] .chip')].map((el) => (el.querySelector(':scope > span')?.textContent || el.textContent).trim())`;
}

async function assertSettingsLayout(page) {
  const layout = await page.evaluate(() => {
    const gap = (a, b) => Math.round(b.getBoundingClientRect().top - a.getBoundingClientRect().bottom);
    const form = document.getElementById('settings-form');
    const sync = document.getElementById('sync-all');
    const backup = document.getElementById('backup');
    const groups = [...form.querySelectorAll(':scope > .setting')];
    const checks = [...form.querySelectorAll('.checks .checkline')];
    const capNote = form.querySelector('label[for="field-cap"] .meta');
    const syncNote = form.querySelector('label[for="field-sync"] .meta');
    const checkNote = checks[0]?.querySelector('.meta');
    const syncInput = document.getElementById('field-sync');
    const syncBox = syncInput.getBoundingClientRect();
    const fieldBox = syncInput.closest('.field').getBoundingClientRect();
    const capInput = document.getElementById('field-cap').getBoundingClientRect();
    const box = checks[0].querySelector('input').getBoundingClientRect();
    return {
      cardGap: gap(form, sync),
      backupGap: gap(sync, backup),
      groupGaps: groups.slice(1).map((el, index) => gap(groups[index], el)),
      checkGap: gap(checks[0], checks[1]),
      capCase: getComputedStyle(capNote).textTransform,
      syncCase: getComputedStyle(syncNote).textTransform,
      checkCase: getComputedStyle(checkNote).textTransform,
      capTrack: getComputedStyle(capNote).letterSpacing,
      syncClip: getComputedStyle(syncInput).textOverflow,
      syncOverflow: getComputedStyle(syncInput).overflowX,
      syncInside: syncBox.right <= fieldBox.right + 1 && syncBox.left >= fieldBox.left - 1,
      checksAlign: Math.abs(box.left - capInput.left) <= 1,
      categories: Boolean(document.getElementById('categories'))
    };
  });
  assert.equal(layout.cardGap, 24);
  assert.equal(layout.backupGap, 24);
  assert.deepEqual(layout.groupGaps, [20, 20, 20]);
  assert.equal(layout.checkGap, 14);
  assert.equal(layout.capCase, 'none');
  assert.equal(layout.syncCase, 'none');
  assert.equal(layout.checkCase, 'none');
  assert.ok(layout.capTrack === 'normal' || layout.capTrack === '0px', layout.capTrack);
  assert.equal(layout.syncClip, 'ellipsis');
  assert.ok(layout.syncOverflow === 'hidden' || layout.syncOverflow === 'clip', layout.syncOverflow);
  assert.equal(layout.syncInside, true);
  assert.equal(layout.checksAlign, true);
  assert.equal(layout.categories, false);
}

async function showTypeExtras(page) {
  const opened = await page.evaluate(() => {
    const button = document.querySelector('[data-action="new-category"]');
    if (!button) return false;
    button.click();
    return true;
  });
  if (opened) await page.waitForSelector('[data-new-category]:not([hidden]) input');
}

async function conditionValue(page) {
  return page.evaluate(() => document.querySelector('[data-condition] input:checked')?.value || '');
}

async function clickCondition(page, label) {
  const handle = await page.evaluateHandle((name) => [...document.querySelectorAll('[data-condition] label.chip')]
    .find((el) => (el.querySelector('span')?.textContent || '').trim() === name) || null, label);
  const el = handle.asElement();
  assert.ok(el, `missing condition ${label}`);
  await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await el.click();
  await handle.dispose();
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
      if (rect.width < 2 || rect.height < 2) return [];
      if (el.classList.contains('chip-x')) {
        if (rect.width >= 32 && rect.height >= 32) return [];
        return [`${Math.round(rect.width)}x${Math.round(rect.height)} chip-x`];
      }
      if (el.matches('.nav a')) {
        if (rect.height >= 40) return [];
        return [`${Math.round(rect.height)}px nav ${el.textContent.trim().slice(0, 20)}`];
      }
      if (rect.height >= 47) return [];
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
      standalone: document.documentElement.classList.contains('standalone'),
      touch: html.touchAction,
      viewport: document.querySelector('meta[name="viewport"]').content,
      preload: Boolean(document.querySelector('link[rel="preload"][as="font"]'))
    };
  });
  assert.equal(shell.viewport, 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover');
  assert.equal(shell.bodyPosition, 'fixed');
  assert.equal(shell.navPosition, 'relative');
  assert.equal(shell.standalone, false);
  assert.equal(shell.mainOverflow, 'auto');
  assert.ok(shell.overscroll.includes('none'), shell.overscroll);
  assert.ok(shell.bodyOverscroll.includes('none'), shell.bodyOverscroll);
  assert.ok(shell.mainOverscroll.includes('none'), shell.mainOverscroll);
  assert.equal(shell.bodyOverflow, 'hidden');
  assert.equal(shell.touch, 'manipulation');
  assert.equal(shell.preload, true);
}

async function clipShot(page, selector, path, pad = 8) {
  const box = await page.evaluate((sel) => {
    const rect = document.querySelector(sel).getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, inner: window.innerWidth, innerHeight: window.innerHeight };
  }, selector);
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const width = Math.min(box.inner - x, box.width + pad * 2);
  const height = Math.min(box.innerHeight - y, box.height + pad * 2);
  await page.screenshot({ path, clip: { x, y, width, height } });
}

async function showSyncing(page) {
  await page.evaluate(() => {
    document.getElementById('sync-status').textContent = 'Syncing…';
    document.getElementById('main').focus();
  });
}

async function assertHeaderDivider(page) {
  const result = await page.evaluate(() => {
    const top = document.querySelector('.top');
    const main = document.getElementById('main');
    main.focus();
    const topStyle = getComputedStyle(top);
    const topRect = top.getBoundingClientRect();
    const border = parseFloat(topStyle.borderBottomWidth);
    const lineTop = topRect.bottom - border;
    const gaps = [...document.querySelectorAll('.monogram, .top .icon-btn')].map((el) => lineTop - el.getBoundingClientRect().bottom);
    return {
      border,
      borderStyle: topStyle.borderBottomStyle,
      gaps,
      outline: getComputedStyle(main).outlineStyle,
      status: document.getElementById('sync-status').textContent
    };
  });
  assert.equal(result.border, 1);
  assert.equal(result.borderStyle, 'solid');
  assert.equal(result.outline, 'none');
  assert.equal(result.status, 'Syncing…');
  assert.ok(result.gaps.length >= 2, JSON.stringify(result));
  for (const gap of result.gaps) assert.ok(gap >= 8, `header gap ${gap}`);
}

async function safeAreaInsets(page) {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const insets = {
      top: parseFloat(style.paddingTop) || 0,
      right: parseFloat(style.paddingRight) || 0,
      bottom: parseFloat(style.paddingBottom) || 0,
      left: parseFloat(style.paddingLeft) || 0
    };
    probe.remove();
    return insets;
  });
}

async function assertNavOnScreen(page, expectedPad) {
  const result = await page.evaluate(() => {
    const nav = document.querySelector('.nav');
    const link = nav.querySelector('a[aria-current="page"]') || nav.querySelector('a');
    const style = getComputedStyle(nav);
    const linkStyle = getComputedStyle(link);
    const navRect = nav.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    const body = document.body.getBoundingClientRect();
    const mono = document.querySelector('.monogram').getBoundingClientRect();
    const text = [...link.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    const host = document.createElement('div');
    host.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;font:${linkStyle.font};line-height:${linkStyle.lineHeight};white-space:nowrap`;
    host.append(document.createTextNode(text.textContent));
    const marker = document.createElement('span');
    marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;padding:0;margin:0;border:0';
    host.append(marker);
    document.body.append(host);
    const probe = document.createRange();
    probe.setStart(host.firstChild, 0);
    probe.setEnd(host.firstChild, host.firstChild.textContent.length);
    const belowBaseline = probe.getBoundingClientRect().bottom - marker.getBoundingClientRect().bottom;
    host.remove();
    const live = document.createRange();
    live.setStart(text, 0);
    live.setEnd(text, text.textContent.length);
    const line = live.getBoundingClientRect();
    const mainPad = parseFloat(getComputedStyle(document.getElementById('main')).paddingBottom);
    return {
      navBottom: navRect.bottom,
      navHeight: navRect.height,
      innerHeight: window.innerHeight,
      linkGap: window.innerHeight - linkRect.bottom,
      linkHeight: linkRect.height,
      baselineGap: window.innerHeight - (line.bottom - belowBaseline),
      bodyHeight: body.height,
      bodyTop: body.top,
      monoTop: mono.top,
      pad: parseFloat(style.paddingBottom),
      padTop: parseFloat(style.paddingTop),
      minHeight: style.minHeight,
      parentPad: parseFloat(getComputedStyle(nav.parentElement).paddingBottom) || 0,
      mainPad
    };
  });
  assert.ok(Math.abs(result.navBottom - result.innerHeight) < 1, JSON.stringify(result));
  assert.ok(Math.abs(result.bodyTop) < 1, JSON.stringify(result));
  assert.ok(Math.abs(result.bodyHeight - result.innerHeight) < 1, JSON.stringify(result));
  assert.ok(Math.abs(result.pad - expectedPad) < 1, JSON.stringify(result));
  assert.ok(Math.abs(result.linkGap - expectedPad) < 2, JSON.stringify(result));
  assert.equal(result.minHeight, '0px');
  assert.equal(result.parentPad, 0);
  assert.ok(result.padTop >= 6 && result.padTop <= 8, JSON.stringify(result));
  assert.ok(result.linkHeight <= 50, JSON.stringify(result));
  assert.equal(result.mainPad, 0);
  if (expectedPad === 20) {
    assert.ok(result.navHeight >= 66 && result.navHeight <= 76, JSON.stringify(result));
    assert.ok(result.baselineGap >= 18 && result.baselineGap <= 32, JSON.stringify(result));
  }
  return result;
}

async function assertAlignedHeaders(page) {
  const problems = await page.evaluate(() => {
    const round = (value) => Math.round(value * 10) / 10;
    const box = (el) => el.getBoundingClientRect();
    const problems = [];
    const check = (label, row, targetLeft, targetRight) => {
      if (!row) {
        problems.push(`${label} missing`);
        return;
      }
      const rr = box(row);
      const style = getComputedStyle(row);
      if (Math.abs(rr.left - targetLeft) > 1) problems.push(`${label} left ${round(rr.left - targetLeft)}`);
      if (Math.abs(rr.right - targetRight) > 1) problems.push(`${label} right ${round(rr.right - targetRight)}`);
      if ((parseFloat(style.marginLeft) || 0) !== 0 || (parseFloat(style.marginRight) || 0) !== 0) {
        problems.push(`${label} margin ${style.marginLeft} ${style.marginRight}`);
      }
      if ((parseFloat(style.paddingLeft) || 0) !== 0 || (parseFloat(style.paddingRight) || 0) !== 0) {
        problems.push(`${label} padding ${style.paddingLeft} ${style.paddingRight}`);
      }
      if (row.scrollWidth > row.clientWidth + 1) problems.push(`${label} text ${row.scrollWidth}>${row.clientWidth}`);
      if (!row.matches('.item-top, .chart-top, .pick-top, .progress-meta, .month-head')) return;
      const amount = row.lastElementChild;
      if (!amount) return;
      const ar = box(amount);
      if (Math.abs(ar.right - targetRight) > 1) problems.push(`${label} amount ${round(ar.right - targetRight)}`);
    };
    for (const group of document.querySelectorAll('.month-group')) {
      const card = group.querySelector('article.block');
      const header = group.querySelector('.item-top');
      if (!card || !header) continue;
      const cr = box(card);
      check(`month ${header.textContent.replace(/\s+/g, ' ').trim().slice(0, 24)}`, header, cr.left, cr.right);
    }
    const chart = document.getElementById('chart');
    if (chart) {
      for (const top of chart.querySelectorAll('.chart-top')) {
        const bar = top.parentElement?.querySelector('.bar');
        if (!bar) continue;
        const br = box(bar);
        check(`chart ${top.textContent.replace(/\s+/g, ' ').trim().slice(0, 20)}`, top, br.left, br.right);
      }
    }
    const progress = document.querySelector('.progress-meta');
    const budget = document.getElementById('budget-bar');
    if (progress && budget) {
      const br = box(budget);
      check('progress', progress, br.left, br.right);
    }
    const pageTitle = document.querySelector('main h2');
    const card = document.querySelector('main article.block') || document.querySelector('main .panel');
    if (pageTitle && card) {
      const cr = box(card);
      check(`heading ${pageTitle.textContent.replace(/\s+/g, ' ').trim().slice(0, 24)}`, pageTitle, cr.left, cr.right);
    }
    for (const pick of document.querySelectorAll('label.pick')) {
      const top = pick.querySelector('.pick-top');
      if (!top) continue;
      const pr = box(pick);
      const padR = parseFloat(getComputedStyle(pick).paddingRight) || 0;
      const targetRight = pr.right - padR;
      const label = `pick ${top.textContent.replace(/\s+/g, ' ').trim().slice(0, 24)}`;
      const rr = box(top);
      if (Math.abs(rr.right - targetRight) > 1) problems.push(`${label} right ${round(rr.right - targetRight)}`);
      if (rr.left < pr.left - 1 || rr.right > pr.right + 1) problems.push(`${label} outside card`);
      const amount = top.querySelector('.pick-price');
      if (amount && Math.abs(box(amount).right - targetRight) > 1) {
        problems.push(`${label} amount ${round(box(amount).right - targetRight)}`);
      }
    }
    return problems;
  });
  assert.deepEqual(problems, []);
}

async function shootMonthAlign(page) {
  const box = await page.evaluate(() => {
    const group = document.querySelector('.month-group');
    const header = group.querySelector('.item-top');
    const card = group.querySelector('article.block');
    const scroller = document.getElementById('main');
    const origin = scroller.getBoundingClientRect().top;
    scroller.scrollTop += header.getBoundingClientRect().top - origin - 20;
    const h = header.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    document.querySelector('[data-align-guide]')?.remove();
    const line = document.createElement('div');
    line.setAttribute('data-align-guide', '');
    const top = Math.max(0, h.top - 6);
    const height = Math.max(24, c.top - h.top + 56);
    line.style.cssText = `position:fixed;top:${top}px;height:${height}px;width:2px;left:${c.right - 1}px;background:#e10600;z-index:20;pointer-events:none`;
    document.body.appendChild(line);
    const x = Math.max(0, Math.floor(h.left - 8));
    const y = Math.max(0, Math.floor(h.top - 10));
    const right = Math.min(window.innerWidth, Math.ceil(c.right + 10));
    const bottom = Math.min(window.innerHeight, Math.ceil(c.top + 52));
    return { x, y, width: right - x, height: bottom - y };
  });
  await page.screenshot({ path: `${REPORTS}/month-heading-align.png`, clip: box });
  await page.evaluate(() => document.querySelector('[data-align-guide]')?.remove());
}

async function assertNoFocusZoom(page) {
  await page.focus('#fc-item');
  const zoom = await page.evaluate(() => ({
    scale: window.visualViewport.scale,
    size: getComputedStyle(document.querySelector('#fc-item')).fontSize,
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
  await mkdir(REPORTS, { recursive: true });
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
    assert.equal(await page.$('#today-line'), null);
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
    const homeMain = await page.$eval('#main', (el) => el.innerText);
    assert.equal(homeMain.includes('Wishlist'), false);
    assert.match(homeMain, /Purchases/i);
    assert.equal(homeMain.includes('MONDAY'), false);
    assert.equal(await page.$('#main .block.sky'), null);
    assert.equal(await page.$('#main .block.coral'), null);
    assert.equal(await page.$('#main .block.lilac'), null);
    assert.deepEqual(await blockTones(page), ['white', 'yellow']);
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
    await assertSettingsLayout(page);
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

    await go(page, '#log', '#fc-item');
    assert.equal(await page.$('#today-line'), null);
    assert.equal(await page.$eval('input[name="boughtAs"]:checked', (el) => el.value), 'purchased');
    assert.equal(await page.$('input[name="status"]'), null);
    assert.equal(await page.$eval('#field-date', (el) => el.value), realToday);
    assert.equal(await page.$eval('#field-price-currency', (el) => el.value), 'MYR');
    await press(page, '#log-form button[type="submit"]');
    await page.waitForSelector('.form-error:not([hidden])');
    assert.match(await text(page, '.form-error'), /Enter a figure name/);
    await assertTapTargets(page);
    await assertNoOverflow(page);
    await assertTypeScale(page);
    await assertAlignment(page);
    await assertSingleDividers(page);
    await shot(page, 'log-add');

    const formShape = await page.evaluate(() => {
      const read = (id) => {
        const el = document.getElementById(id);
        return {
          autocorrect: el.getAttribute('autocorrect'),
          autocapitalize: el.getAttribute('autocapitalize'),
          spellcheck: el.getAttribute('spellcheck'),
          autocomplete: el.getAttribute('autocomplete'),
          inputmode: el.getAttribute('inputmode'),
          enterkeyhint: el.getAttribute('enterkeyhint'),
          list: el.getAttribute('list'),
          type: el.getAttribute('type')
        };
      };
      const after = Node.DOCUMENT_POSITION_FOLLOWING;
      const follows = (a, b) => Boolean(a && b && (a.compareDocumentPosition(b) & after));
      const chain = [
        document.querySelector('[data-type-chips]'),
        document.querySelector('#log-form [aria-label="Order type"]'),
        document.getElementById('field-brand'),
        document.getElementById('field-series'),
        document.getElementById('fc-item'),
        document.getElementById('field-price'),
        document.getElementById('field-date'),
        document.querySelector('[data-condition]')
      ];
      const more = document.querySelector('#log-form details.more');
      const itemLabel = [...document.querySelector('label[for="fc-item"]').childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const banned = [
        /\bname\b/i,
        /e-?mail/i,
        /\bphone\b/i,
        /\bmobile\b/i,
        /\bfax\b/i,
        /\btel\b/i,
        /\baddress\b/i,
        /\bstreet\b/i,
        /\bcity\b/i,
        /\btown\b/i,
        /\bzip\b/i,
        /\bpostal\b/i,
        /\bpostcode\b/i,
        /\bcountry\b/i,
        /\bprovince\b/i,
        /\bcounty\b/i,
        /\bstate\b/i,
        /organi[sz]ation/i,
        /\bcompany\b/i,
        /\bemployer\b/i,
        /\bbirthday\b/i,
        /\bbday\b/i,
        /\bsurname\b/i,
        /\bgiven[- ]?name\b/i,
        /\bfamily[- ]?name\b/i,
        /\bfirst[- ]?name\b/i,
        /\blast[- ]?name\b/i,
        /\bnickname\b/i
      ];
      const contactHits = [...document.querySelectorAll('#log-form input, #log-form textarea')].flatMap((el) => {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (el.tagName !== 'TEXTAREA' && type !== 'text' && type !== 'search') return [];
        const label = el.labels?.[0];
        const labelText = label
          ? [...label.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(' ')
          : '';
        const signature = [
          el.getAttribute('name') || '',
          el.id || '',
          el.getAttribute('placeholder') || '',
          el.getAttribute('aria-label') || '',
          labelText
        ].join(' ');
        return banned.filter((pattern) => pattern.test(signature)).map((pattern) => `${el.id || el.name}: ${pattern}`);
      });
      return {
        ordered: chain.every((node, index) => index === 0 || follows(chain[index - 1], node)),
        itemName: document.getElementById('fc-item').name,
        itemId: document.getElementById('fc-item').id,
        itemLabel,
        contactHits,
        name: read('fc-item'),
        brand: read('field-brand'),
        series: read('field-series'),
        shop: read('field-shop'),
        notes: read('field-notes'),
        fresh: read('field-new-category'),
        price: read('field-price'),
        est: read('field-est'),
        deposit: read('field-deposit'),
        balance: read('field-balance'),
        priceRm: read('field-price-rm'),
        date: read('field-date'),
        conditions: [...document.querySelectorAll('[data-condition] input')].map((el) => el.value),
        moreText: more.querySelector('.meta').textContent.trim(),
        moreOpen: more.open,
        brandInMore: Boolean(more.querySelector('#field-brand, #field-series, [data-type-chips], [data-condition]')),
        shopInMore: Boolean(more.querySelector('#field-shop')),
        notesInMore: Boolean(more.querySelector('#field-notes')),
        conditionSelect: Boolean(document.querySelector('select[name="condition"]'))
      };
    });
    assert.equal(formShape.ordered, true);
    assert.equal(formShape.itemName, 'fc_item');
    assert.equal(formShape.itemId, 'fc-item');
    assert.equal(formShape.itemLabel, 'Figure');
    assert.deepEqual(formShape.contactHits, []);
    for (const field of [formShape.name, formShape.brand, formShape.series, formShape.shop, formShape.fresh]) {
      assert.equal(field.autocorrect, 'off');
      assert.equal(field.autocapitalize, 'words');
      assert.equal(field.spellcheck, 'false');
      assert.equal(field.autocomplete, 'off');
    }
    assert.equal(formShape.notes.autocorrect, 'off');
    assert.equal(formShape.notes.autocapitalize, 'sentences');
    assert.equal(formShape.notes.spellcheck, 'false');
    assert.equal(formShape.notes.autocomplete, 'off');
    assert.equal(formShape.brand.list, 'brand-list');
    assert.equal(formShape.series.list, 'series-list');
    assert.equal(formShape.shop.list, 'shop-list');
    for (const money of [formShape.price, formShape.est, formShape.deposit, formShape.balance, formShape.priceRm]) {
      assert.equal(money.inputmode, 'decimal');
      assert.equal(money.enterkeyhint, 'done');
    }
    assert.equal(formShape.date.type, 'date');
    assert.equal(formShape.date.inputmode, null);
    assert.deepEqual(formShape.conditions, ['MISB', 'MIB', 'BIB', 'Loose']);
    assert.equal(formShape.moreText, 'Shop, notes');
    assert.equal(formShape.moreOpen, false);
    assert.equal(formShape.brandInMore, false);
    assert.equal(formShape.shopInMore, true);
    assert.equal(formShape.notesInMore, true);
    assert.equal(formShape.conditionSelect, false);
    await page.evaluate(() => { document.getElementById('main').scrollTop = 0; });
    await page.screenshot({ path: `${REPORTS}/log-add-top.png` });
    await page.evaluate(() => {
      const scroller = document.getElementById('main');
      const target = document.getElementById('field-date');
      const origin = scroller.getBoundingClientRect().top;
      const top = target.getBoundingClientRect().top - origin + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, top - 16);
    });
    await page.screenshot({ path: `${REPORTS}/log-add-scrolled.png` });
    await page.evaluate(() => { document.getElementById('main').scrollTop = 0; });

    await clickCondition(page, 'MISB');
    assert.equal(await conditionValue(page), 'MISB');
    const chipPaint = await page.evaluate(() => {
      const read = (el) => {
        const style = getComputedStyle(el);
        return { bg: style.backgroundColor, color: style.color };
      };
      return {
        type: read(document.querySelector('[data-type-chips] input:checked').closest('.chip')),
        misb: read(document.querySelector('[data-condition] input[value="MISB"]').closest('.chip')),
        loose: read(document.querySelector('[data-condition] input[value="Loose"]').closest('.chip')),
        order: read(document.querySelector('input[name="boughtAs"]:checked').closest('.chip'))
      };
    });
    assert.equal(chipPaint.type.bg, 'rgb(255, 228, 92)');
    assert.equal(chipPaint.type.color, 'rgb(22, 22, 22)');
    assert.equal(chipPaint.misb.bg, 'rgb(255, 228, 92)');
    assert.equal(chipPaint.misb.color, 'rgb(22, 22, 22)');
    assert.notEqual(chipPaint.loose.bg, 'rgb(255, 228, 92)');
    assert.notEqual(chipPaint.order.bg, 'rgb(255, 228, 92)');
    await clickCondition(page, 'MISB');
    assert.equal(await conditionValue(page), '');
    await page.$eval('[data-condition] input[value="MIB"]', (el) => el.closest('label').click());
    assert.equal(await conditionValue(page), 'MIB');
    await page.$eval('[data-condition] input[value="MIB"]', (el) => el.closest('label').click());
    assert.equal(await conditionValue(page), '');
    await clickCondition(page, 'Loose');
    assert.equal(await conditionValue(page), 'Loose');
    await clickCondition(page, 'BIB');
    assert.equal(await conditionValue(page), 'BIB');
    await clickCondition(page, 'BIB');
    assert.equal(await conditionValue(page), '');

    const formSnapshot = await page.evaluate(() => localStorage.getItem('figure-cap.v1'));
    await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('figure-cap.v1'));
      const row = (extra) => ({
        price: 20,
        originalAmount: 20,
        currency: 'MYR',
        fxRate: 1,
        boughtAs: 'purchased',
        status: 'received',
        figureType: '',
        condition: '',
        notes: '',
        ...extra
      });
      data.purchases = [
        row({
          id: 'smile-old',
          name: 'Older smile',
          brand: 'good smile',
          series: 'eva',
          shop: 'AmiAmi',
          date: '2026-01-02',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z'
        }),
        row({
          id: 'smile-new',
          name: 'Newer smile',
          brand: 'Good Smile',
          series: 'Eva',
          shop: 'Hobby Search',
          condition: 'MISB',
          date: '2026-03-02',
          createdAt: '2026-03-02T00:00:00.000Z',
          updatedAt: '2026-03-02T00:00:00.000Z'
        }),
        row({
          id: 'smile-mid',
          name: 'Mid smile',
          brand: 'Good Smile',
          series: 'EVA',
          shop: 'AmiAmi',
          date: '2026-02-02',
          createdAt: '2026-02-02T00:00:00.000Z',
          updatedAt: '2026-02-02T00:00:00.000Z'
        }),
        row({
          id: 'bandai',
          name: 'Gundam',
          brand: 'Bandai',
          series: 'Gundam',
          shop: 'AmiAmi',
          date: '2026-06-02',
          createdAt: '2026-06-02T00:00:00.000Z',
          updatedAt: '2026-06-02T00:00:00.000Z'
        }),
        row({
          id: 'koto',
          name: 'Frame',
          brand: 'Kotobukiya',
          series: 'Frame Arms',
          shop: 'HLJ',
          date: '2026-05-02',
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z'
        }),
        row({
          id: 'cond-other',
          name: 'Boxed extra',
          brand: 'Alter',
          series: 'Fate',
          shop: 'Nippon',
          notes: 'keep me',
          condition: 'Other',
          figureType: '1-6',
          price: 30,
          originalAmount: 30,
          date: '2026-04-04',
          createdAt: '2026-04-04T00:00:00.000Z',
          updatedAt: '2026-04-04T00:00:00.000Z'
        })
      ];
      localStorage.setItem('figure-cap.v1', JSON.stringify(data));
    });
    await go(page, '#home', '#month-title');
    await go(page, '#log', '#brand-list');
    const lists = await page.evaluate(() => ({
      brand: [...document.querySelectorAll('#brand-list option')].map((el) => el.value),
      series: [...document.querySelectorAll('#series-list option')].map((el) => el.value),
      shop: [...document.querySelectorAll('#shop-list option')].map((el) => el.value)
    }));
    assert.deepEqual(lists.brand, ['Good Smile', 'Bandai', 'Kotobukiya', 'Alter']);
    assert.deepEqual(lists.series, ['Eva', 'Gundam', 'Frame Arms', 'Fate']);
    assert.deepEqual(lists.shop, ['AmiAmi', 'HLJ', 'Nippon', 'Hobby Search']);
    await go(page, '#edit/smile-new', '#edit-form');
    assert.deepEqual(await page.$$eval('[data-condition] input', (els) => els.map((el) => el.value)), ['MISB', 'MIB', 'BIB', 'Loose']);
    assert.equal(await conditionValue(page), 'MISB');
    assert.equal(await page.$eval('#field-brand', (el) => el.value), 'Good Smile');
    assert.equal(await page.$eval('#field-series', (el) => el.value), 'Eva');
    assert.equal(await page.$eval('#fc-item', (el) => el.value), 'Newer smile');
    await go(page, '#edit/cond-other', '#edit-form');
    assert.deepEqual(await page.$$eval('[data-condition] input', (els) => els.map((el) => el.value)), ['MISB', 'MIB', 'BIB', 'Loose', 'Other']);
    assert.equal(await conditionValue(page), 'Other');
    assert.equal(await page.$eval('#field-brand', (el) => el.value), 'Alter');
    assert.equal(await page.$eval('#field-series', (el) => el.value), 'Fate');
    assert.equal(await page.$eval('#fc-item', (el) => el.value), 'Boxed extra');
    assert.equal(await page.$eval('#field-price', (el) => el.value), '30');
    assert.equal(await page.$eval('#field-date', (el) => el.value), '2026-04-04');
    assert.equal(await page.$eval('input[name="figureType"]:checked', (el) => el.value), '1-6');
    assert.equal(await page.$eval('details.more', (el) => el.open), true);
    assert.equal(await page.$eval('#field-shop', (el) => el.value), 'Nippon');
    assert.equal(await page.$eval('#field-notes', (el) => el.value), 'keep me');
    await press(page, '#edit-form button[type="submit"]');
    await page.waitForSelector('#chart');
    const kept = await page.evaluate(() => {
      const item = JSON.parse(localStorage.getItem('figure-cap.v1')).purchases.find((row) => row.id === 'cond-other');
      return {
        name: item.name,
        brand: item.brand,
        series: item.series,
        shop: item.shop,
        notes: item.notes,
        condition: item.condition,
        figureType: item.figureType,
        price: item.price,
        date: item.date,
        boughtAs: item.boughtAs
      };
    });
    assert.deepEqual(kept, {
      name: 'Boxed extra',
      brand: 'Alter',
      series: 'Fate',
      shop: 'Nippon',
      notes: 'keep me',
      condition: 'Other',
      figureType: '1-6',
      price: 30,
      date: '2026-04-04',
      boughtAs: 'purchased'
    });
    await page.evaluate((saved) => localStorage.setItem('figure-cap.v1', saved), formSnapshot);
    await go(page, '#home', '#left-value');
    await go(page, '#log', '#fc-item');

    await typeInto(page, '#fc-item', 'Asuka Langley Soryu Plugsuit Ver. 1/7 Scale');
    await typeInto(page, '#field-price', '80');
    await page.$eval('details.more', (el) => { el.open = true; });
    await clickLabel(page, '1/12');
    await typeInto(page, '#field-series', 'Neon Genesis Evangelion');
    await typeInto(page, '#field-brand', 'Good Smile');
    await typeInto(page, '#field-notes', 'window');
    await press(page, '#log-form button[type="submit"]');
    await page.waitForSelector('#month-title');
    const latestHome = await page.evaluate(() => {
      const article = document.querySelector('article.block:not(.yellow)');
      const ytd = document.getElementById('ytd-value').closest('article');
      return {
        order: [...article.children].map((el) => (
          el.classList.contains('card-head') ? 'tags'
            : el.tagName === 'H3' ? 'name'
              : el.classList.contains('block-value') ? 'price'
                : el.classList.contains('meta') ? 'meta'
                  : el.classList.contains('note') ? 'note'
                    : el.classList.contains('btn-row') ? 'actions'
                      : el.className
        )),
        meta: article.querySelector('p.meta')?.textContent.trim() || '',
        name: article.querySelector('h3')?.textContent.trim() || '',
        price: article.querySelector('.block-value')?.textContent.trim() || '',
        ytd: ytd.innerText.replace(/\s+/g, ' ').trim(),
        ytdLabels: [...ytd.querySelectorAll('.spec-label')].map((el) => el.textContent.trim())
      };
    });
    assert.deepEqual(latestHome.order, ['tags', 'meta', 'name', 'price', 'note', 'actions']);
    assert.match(latestHome.meta, /Good Smile · Neon Genesis Evangelion$/);
    assert.match(latestHome.name, /Asuka/);
    assert.equal(latestHome.price, 'RM 80.00');
    assert.equal(latestHome.meta.includes('Received'), false);
    assert.equal(latestHome.meta.includes('Purchased'), false);
    assert.deepEqual(latestHome.ytdLabels, ['Purchases']);
    assert.equal(latestHome.ytd.includes('1/12'), false);
    assert.equal(await text(page, '#spent-value'), 'RM 80.00');
    assert.equal(await text(page, '#left-value'), 'RM 320 / 400');
    assert.equal(await text(page, '#ytd-value'), 'RM 80.00');
    assert.equal(await page.$('#cap-message'), null);

    const earlier = `${realToday.slice(0, 4)}-01-15`;
    await go(page, '#log', '#fc-item');
    await typeInto(page, '#fc-item', 'Rei');
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
    assert.match(entries, /Fully paid/);
    assert.match(entries, /1\/12/);
    const asukaMeta = await page.evaluate(() => {
      const article = [...document.querySelectorAll('article.block')].find((el) => el.querySelector('h3')?.textContent.includes('Asuka'));
      return article?.querySelector('p.meta')?.textContent.trim() || '';
    });
    assert.match(asukaMeta, /Good Smile · Neon Genesis Evangelion$/);
    assert.equal(asukaMeta.includes('Received'), false);
    assert.equal(asukaMeta.includes('Purchased'), false);
    const reiMeta = await page.evaluate(() => {
      const article = [...document.querySelectorAll('article.block')].find((el) => el.querySelector('h3')?.textContent.trim() === 'Rei');
      return article?.querySelector('p.meta')?.textContent.trim() || '';
    });
    assert.match(reiMeta, /^15 Jan$/);
    assert.equal(reiMeta.includes('Received'), false);
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
    assert.match(entries, /1\/12/);
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

    await go(page, '#log', '#fc-item');
    await typeInto(page, '#fc-item', 'Over cap');
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
    assert.match(migrated, /Fully paid/);
    assert.match(migrated, /box/);
    assert.equal(migrated.includes('Excited'), false);
    assert.match(migrated, /RM 25\.00/);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('figure-cap.v1')).purchases[0]);
    assert.equal(stored.currency, 'MYR');
    assert.equal(stored.notes, 'box');
    assert.equal(stored.boughtAs, 'preorder');
    assert.equal(stored.status, 'received');
    assert.equal(stored.preorderStatus, 'fully paid');
    assert.equal(stored.depositAmountRm, 25);
    assert.equal(stored.price, 25);

    await go(page, '#log', '#fc-item');
    await typeInto(page, '#fc-item', 'Yen figure');
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

    await go(page, '#log', '#fc-item');
    await typeInto(page, '#fc-item', 'Statement');
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
    await go(page, '#log', '#fc-item');
    await typeInto(page, '#fc-item', 'Offline yen');
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
    await page.evaluate(() => {
      const saved = localStorage.getItem('figure-cap.v1');
      localStorage.setItem('figure-cap.v1', JSON.stringify({
        settings: { monthlyCap: 400, rollover: true, overspendPayback: true, trackingStart: '2026-09', syncUrl: '' },
        purchases: [{
          id: 'sep',
          name: 'September prize',
          price: 350,
          originalAmount: 350,
          currency: 'MYR',
          fxRate: 1,
          date: '2026-09-02',
          boughtAs: 'purchased',
          status: 'received',
          createdAt: '2026-09-02T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z'
        }],
        wishlist: [],
        forSale: []
      }));
      if (location.hash !== '#home') location.hash = '#home';
      window.__figureCap.setNow('2026-10-20T04:00:00Z');
      window.__savedCap = saved;
    });
    await page.waitForFunction(() => document.getElementById('cap-line')?.textContent === 'cap RM 450 · RM 50 rolled over');
    assert.equal(await page.$('#main .block.coral'), null);
    assert.equal(await page.$('#main .block.lilac'), null);
    assert.equal(await page.$('#balances-card'), null);
    assert.deepEqual(await blockTones(page), ['white', 'yellow']);
    assert.equal(await page.$('#today-line'), null);
    assert.match(await page.$eval('#cap-line', (el) => el.innerHTML), /<span class="amt">cap RM 450<\/span> · <span class="amt">RM 50<\/span> rolled over/);
    await page.evaluate(() => {
      localStorage.setItem('figure-cap.v1', window.__savedCap);
      window.__figureCap.clearNow();
    });

    await go(page, '#log', '#fc-item');
    await clickLabel(page, 'Pre-order');
    await page.waitForSelector('[data-preorder]:not([hidden]) #field-est');
    await page.evaluate(() => {
      const scroller = document.getElementById('main');
      const target = document.getElementById('field-est');
      const origin = scroller.getBoundingClientRect().top;
      const top = target.getBoundingClientRect().top - origin + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, top - 72);
    });
    await page.screenshot({ path: `${REPORTS}/log-add-preorder.png` });
    await page.evaluate(() => { document.getElementById('main').scrollTop = 0; });
    await typeInto(page, '#fc-item', 'Rei');
    await typeInto(page, '#field-est', '200');
    await typeInto(page, '#field-deposit', '50');
    await page.waitForFunction(() => /Balance due/.test(document.querySelector('[data-balance-due]')?.textContent || ''));
    const due = await page.$eval('[data-balance-due]', (el) => ({
      text: el.textContent.trim(),
      html: el.innerHTML,
      nowrap: el.querySelector('.amt') ? getComputedStyle(el.querySelector('.amt')).whiteSpace : '',
      lines: el.querySelector('.amt') ? el.querySelector('.amt').getClientRects().length : 0
    }));
    assert.equal(due.text, 'Balance due RM 150.00');
    assert.equal(due.html, '<span class="amt">Balance due RM 150.00</span>');
    assert.equal(due.nowrap, 'nowrap');
    assert.equal(due.lines, 1);
    const order = await page.evaluate(() => {
      const after = Node.DOCUMENT_POSITION_FOLLOWING;
      const follows = (a, b) => Boolean(a && b && (a.compareDocumentPosition(b) & after));
      const chain = [
        document.querySelector('[data-type-chips]'),
        document.querySelector('#log-form [aria-label="Order type"]'),
        document.getElementById('field-brand'),
        document.getElementById('field-series'),
        document.getElementById('fc-item'),
        document.getElementById('field-est'),
        document.getElementById('field-deposit'),
        document.getElementById('field-date'),
        document.querySelector('[data-condition]')
      ];
      const status = [...document.querySelectorAll('#log-form .kicker')].find((el) => el.textContent.trim() === 'Status');
      const more = document.querySelector('#log-form details.more');
      const label = document.querySelector('[data-date-label]')?.textContent.trim();
      return chain.every((node, index) => index === 0 || follows(chain[index - 1], node))
        && !status
        && label === 'Deposit date'
        && !more.querySelector('#field-brand, #field-series, [data-type-chips]')
        && more.querySelector('.meta').textContent.trim() === 'Shop, notes';
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

    await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('figure-cap.v1'));
      data.settings.categories = ['Anniversary Figure Y'];
      const over = data.purchases.find((item) => item.id === 'over');
      if (over) over.figureType = 'Anniversary Figure Y';
      localStorage.setItem('figure-cap.v1', JSON.stringify(data));
    });

    const screens = [
      ['#home', '#left-value'],
      ['#entries', '#chart'],
      ['#log', '#fc-item'],
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
          await showTypeExtras(page);
          await assertFocusRing(page, '#fc-item');
        }
        if (hash === '#settings') await assertFocusRing(page, '#field-cap');
        await assertContrast(page);
        await assertTypeScale(page);
        await assertNoOverflow(page);
        await assertSingleDividers(page);
        if (mode === 'dark' && (hash === '#entries' || hash === '#sell' || hash === '#home')) {
          const paint = await page.evaluate(() => {
            const root = getComputedStyle(document.documentElement);
            const yellow = document.querySelector('article.block.yellow');
            const list = document.querySelector('article.block:not(.yellow)');
            const panel = document.querySelector('.panel');
            const textOf = (el) => el?.querySelector('h3, .block-value, .kicker, .spec-label');
            const yellowText = textOf(yellow);
            const listText = textOf(list);
            const typeTag = list?.querySelector('.tag');
            return {
              yellowVar: root.getPropertyValue('--yellow').trim(),
              mintVar: root.getPropertyValue('--mint').trim(),
              lilacVar: root.getPropertyValue('--lilac').trim(),
              yellow: yellow ? getComputedStyle(yellow).backgroundColor : '',
              yellowInk: yellowText ? getComputedStyle(yellowText).color : '',
              list: list ? getComputedStyle(list).backgroundColor : '',
              listInk: listText ? getComputedStyle(listText).color : '',
              panel: panel ? getComputedStyle(panel).backgroundColor : '',
              typeTag: typeTag ? getComputedStyle(typeTag).backgroundColor : '',
              typeInk: typeTag ? getComputedStyle(typeTag).color : '',
              mintCard: Boolean(document.querySelector('.mint'))
            };
          });
          assert.equal(paint.yellowVar, '#ffe45c');
          assert.equal(paint.mintVar, '');
          assert.equal(paint.lilacVar, '');
          assert.equal(paint.mintCard, false);
          if (hash !== '#sell') {
            assert.equal(paint.yellow, 'rgb(255, 228, 92)');
            assert.equal(paint.yellowInk, 'rgb(22, 22, 22)');
          }
          if (paint.list) {
            assert.equal(paint.list, paint.panel || 'rgb(28, 28, 28)');
            assert.equal(paint.listInk, 'rgb(244, 244, 245)');
          }
          if (paint.typeTag) {
            assert.equal(paint.typeTag, 'rgb(255, 228, 92)');
            assert.equal(paint.typeInk, 'rgb(22, 22, 22)');
          }
        }
      }
    }

    await page.evaluate(() => localStorage.setItem('figure-cap.theme', 'light'));
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    for (const width of [320, 360, 390]) {
      await page.setViewport({ width, height: 700, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      for (const [hash, ready] of [
        ['#home', '#left-value'],
        ['#log', '#fc-item'],
        ['#entries', '#chart'],
        ['#edit/over', '#fc-item'],
        ['#wish', '#wish-name'],
        ['#plan', '#plan-summary'],
        ['#sell', '#sale-name'],
        ['#edit-sale/sale-1', '#sale-name'],
        ['#settings', '#field-cap']
      ]) {
        await go(page, hash, ready);
        assert.equal(await page.$('#today-line'), null);
        if (hash === '#log' || hash === '#edit/over') await showTypeExtras(page);
        if (hash === '#log') await clickLabel(page, 'Pre-order');
        if (hash === '#entries') {
          await assertSearchToolbar(page);
          await page.evaluate(() => { document.documentElement.dataset.mode = 'dark'; });
          await assertSearchToolbar(page);
          await assertNoOverflow(page);
          await assertTextFits(page);
          await page.evaluate(() => { document.documentElement.dataset.mode = 'light'; });
        }
        await assertNoOverflow(page);
        await assertTapTargets(page);
        await assertTextFits(page);
      }
    }

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('figure-cap.v1'));
      data.settings.categories = [];
      for (const purchase of data.purchases) {
        if (purchase.figureType === 'Anniversary Figure Y') purchase.figureType = '';
      }
      localStorage.setItem('figure-cap.v1', JSON.stringify(data));
      localStorage.setItem('figure-cap.theme', 'light');
      document.documentElement.dataset.mode = 'light';
      document.documentElement.dataset.theme = 'light';
    });
    await go(page, '#log', '#fc-item');
    await page.$eval('details.more', (el) => { el.open = true; });
    const builtInChips = await page.evaluate(new Function(`return ${chipLabelList()};`));
    assert.deepEqual(builtInChips, ['Not set', 'Transformers', '1/12', '1/6', 'Other', 'Model Kit', '+ New']);
    await press(page, '[data-action="new-category"]');
    await page.waitForSelector('[data-new-category]:not([hidden]) input');
    await press(page, '[data-action="add-category"]');
    await page.waitForSelector('[data-category-error]:not([hidden])');
    assert.match(await text(page, '[data-category-error]'), /Enter a category name/);
    await typeInto(page, '#field-new-category', 'Transformers');
    await press(page, '[data-action="add-category"]');
    assert.match(await text(page, '[data-category-error]'), /already exists/);
    await typeInto(page, '#field-new-category', '  Movie  ');
    await page.focus('#field-new-category');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const data = JSON.parse(localStorage.getItem('figure-cap.v1') || '{}');
      return data.settings?.categories?.includes('Movie');
    });
    const customChips = await page.evaluate(new Function(`return ${chipLabelList()};`));
    assert.deepEqual(customChips, ['Not set', 'Transformers', '1/12', '1/6', 'Other', 'Model Kit', 'Movie', '+ New']);
    assert.equal(await page.$eval('input[name="figureType"]:checked', (el) => el.value), 'Movie');
    assert.equal(await page.$eval('[data-new-category]', (el) => el.hidden), true);
    await page.reload({ waitUntil: 'networkidle0' });
    await go(page, '#log', '#fc-item');
    await page.$eval('details.more', (el) => { el.open = true; });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-type-chips] .chip')].some((el) => el.querySelector(':scope > span')?.textContent.trim() === 'Movie'));
    await clickLabel(page, 'Movie');
    await page.evaluate(() => {
      const scroller = document.getElementById('main');
      const target = document.querySelector('.type-field');
      const origin = scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, target.getBoundingClientRect().top - origin + scroller.scrollTop - 8);
    });
    await page.screenshot({ path: `${REPORTS}/types-log-add.png` });
    await typeInto(page, '#fc-item', 'Optimus');
    await typeInto(page, '#field-price', '40');
    await setDate(page, '#field-date', '2026-10-12');
    await typeInto(page, '#field-brand', 'Good Smile');
    await typeInto(page, '#field-series', 'Evangelion');
    await press(page, '#log-form button[type="submit"]');
    await page.waitForFunction(() => {
      const data = JSON.parse(localStorage.getItem('figure-cap.v1') || '{}');
      return data.purchases?.some((item) => item.name === 'Optimus' && item.figureType === 'Movie' && item.status === 'received');
    });
    await go(page, '#entries', '#chart');
    const optimus = await page.evaluate(() => {
      const article = [...document.querySelectorAll('article.block')].find((el) => el.querySelector('h3')?.textContent.trim() === 'Optimus');
      return article?.querySelector('p.meta')?.textContent.trim() || '';
    });
    assert.equal(optimus, '12 Oct · Good Smile · Evangelion');
    await press(page, '[data-action="open-filters"]');
    await page.waitForSelector('dialog[open] [data-filter="type"][data-value="Movie"]');
    await press(page, 'dialog[open] [data-action="close-dialog"]');
    await go(page, '#log', '#fc-item');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.$eval('details.more', (el) => { el.open = true; });
    await press(page, '[data-action="new-category"]');
    await typeInto(page, '#field-new-category', 'Anime');
    await press(page, '[data-action="add-category"]');
    await page.waitForSelector('[data-name="Anime"]');
    await clickLabel(page, 'Movie');
    const removable = await page.evaluate(() => [...document.querySelectorAll('[data-type-chips] .chip')].map((el) => ({
      label: (el.querySelector(':scope > span')?.textContent || el.textContent).trim(),
      remove: Boolean(el.querySelector('.chip-x'))
    })));
    assert.deepEqual(removable, [
      { label: 'Not set', remove: false },
      { label: 'Transformers', remove: false },
      { label: '1/12', remove: false },
      { label: '1/6', remove: false },
      { label: 'Other', remove: false },
      { label: 'Model Kit', remove: false },
      { label: 'Movie', remove: true },
      { label: 'Anime', remove: true },
      { label: '+ New', remove: false }
    ]);
    await page.evaluate(() => {
      const scroller = document.getElementById('main');
      const target = document.querySelector('[data-name="Movie"]')?.closest('.chip');
      const origin = scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, target.getBoundingClientRect().top - origin + scroller.scrollTop - 72);
    });
    await assertChipRemove(page, 'light');
    await page.screenshot({ path: `${REPORTS}/chip-remove-light.png` });
    await page.evaluate(() => {
      localStorage.setItem('figure-cap.theme', 'dark');
      document.documentElement.dataset.mode = 'dark';
      document.documentElement.dataset.theme = 'dark';
    });
    await assertChipRemove(page, 'dark');
    await assertContrast(page);
    await page.screenshot({ path: `${REPORTS}/chip-remove-dark.png` });
    await page.evaluate(() => {
      localStorage.setItem('figure-cap.theme', 'light');
      document.documentElement.dataset.mode = 'light';
      document.documentElement.dataset.theme = 'light';
    });
    await press(page, '[data-action="remove-category"][data-name="Anime"]');
    await page.waitForSelector('dialog[open]');
    await clickDialog(page, 'Remove');
    await page.waitForFunction(() => {
      const data = JSON.parse(localStorage.getItem('figure-cap.v1') || '{}');
      return data.settings?.categories?.length === 1 && data.settings.categories[0] === 'Movie';
    });
    await go(page, '#log', '#fc-item');
    await page.$eval('details.more', (el) => { el.open = true; });
    await press(page, '[data-action="remove-category"][data-name="Movie"]');
    await page.waitForSelector('dialog[open]');
    assert.match(await text(page, '#dialog-title'), /Remove Movie/);
    await clickDialog(page, 'Remove');
    await page.waitForFunction(() => {
      const data = JSON.parse(localStorage.getItem('figure-cap.v1') || '{}');
      const optimus = data.purchases?.find((item) => item.name === 'Optimus');
      return data.settings?.categories?.length === 0 && optimus?.figureType === 'other';
    });
    assert.equal(await page.$('[data-name="Movie"]'), null);
    await go(page, '#settings', '#backup');
    assert.equal(await page.$('#categories'), null);
    await assertSettingsLayout(page);
    const settingsHeight = await page.evaluate(() => {
      const main = document.getElementById('main');
      return window.innerHeight + Math.max(0, main.scrollHeight - main.clientHeight) + 4;
    });
    await page.setViewport({ width: 390, height: settingsHeight, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.evaluate(() => { document.getElementById('main').scrollTop = 0; });
    await page.screenshot({ path: `${REPORTS}/settings-light.png` });
    await page.evaluate(() => {
      localStorage.setItem('figure-cap.theme', 'dark');
      document.documentElement.dataset.mode = 'dark';
      document.documentElement.dataset.theme = 'dark';
    });
    await page.screenshot({ path: `${REPORTS}/settings-dark.png` });
    await page.evaluate(() => {
      localStorage.setItem('figure-cap.theme', 'light');
      document.documentElement.dataset.mode = 'light';
      document.documentElement.dataset.theme = 'light';
    });

    await page.setViewport({ width: 320, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.evaluate(() => {
      localStorage.setItem('figure-cap.theme', 'light');
      document.documentElement.dataset.mode = 'light';
      document.documentElement.dataset.theme = 'light';
      localStorage.setItem('figure-cap.v1', JSON.stringify({
        settings: { monthlyCap: 400, rollover: true, overspendPayback: true, trackingStart: '2026-09', syncUrl: '' },
        purchases: [
          {
            id: 'sep',
            name: 'September prize',
            price: 350,
            originalAmount: 350,
            currency: 'MYR',
            fxRate: 1,
            date: '2026-09-02',
            boughtAs: 'purchased',
            status: 'received',
            figureType: 'prize',
            createdAt: '2026-09-02T00:00:00.000Z',
            updatedAt: '2026-09-02T00:00:00.000Z'
          },
          {
            id: 'open-po',
            name: 'Rei Ayanami',
            date: '2026-10-04',
            boughtAs: 'preorder',
            status: 'preordered',
            price: 200,
            originalAmount: 200,
            currency: 'MYR',
            fxRate: 1,
            figureType: 'scale',
            series: 'Evangelion',
            estFullPrice: 200,
            estFullOriginalAmount: 200,
            estFullCurrency: 'MYR',
            estFullFxRate: 1,
            estFullFxDate: '2026-10-04',
            depositAmountRm: 50,
            depositOriginalAmount: 50,
            depositCurrency: 'MYR',
            depositFxRate: 1,
            depositFxDate: '2026-10-04',
            depositDate: '2026-10-04',
            balanceDueRm: 150,
            preorderStatus: 'deposit paid',
            createdAt: '2026-10-04T00:00:00.000Z',
            updatedAt: '2026-10-04T00:00:00.000Z'
          }
        ],
        wishlist: [],
        forSale: []
      }));
      window.__figureCap.setNow('2026-10-26T04:00:00Z');
      location.hash = '#entries';
    });
    await page.waitForSelector('.money-note');
    const moneyLine = await page.evaluate(() => {
      const el = document.querySelector('.money-note');
      const amts = [...el.querySelectorAll('.amt')];
      return {
        text: el.textContent.trim(),
        lines: amts.map((amt) => amt.getClientRects().length),
        nowrap: amts.map((amt) => getComputedStyle(amt).whiteSpace)
      };
    });
    assert.equal(moneyLine.text, 'Deposit RM 50.00 · Balance due RM 150.00');
    assert.deepEqual(moneyLine.lines, [1, 1]);
    assert.deepEqual(moneyLine.nowrap, ['nowrap', 'nowrap']);
    await assertNoOverflow(page);
    await assertTextFits(page);
    await assertSearchToolbar(page);

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await go(page, '#home', '#left-value');
    assert.equal(await text(page, '#cap-line'), 'cap RM 450 · RM 50 rolled over');
    assert.equal(await page.$('#today-line'), null);
    assert.notEqual(await page.$('#balances-card'), null);
    assert.equal(await page.$eval('#balances-card', (el) => el.classList.contains('yellow')), true);
    assert.equal(await page.$eval('#balances-card + article.block', (el) => el.classList.contains('yellow')), true);
    assert.deepEqual(await blockTones(page), ['white', 'yellow', 'yellow']);
    assert.equal(await page.$('#main .block.sky'), null);
    assert.equal(await page.$('#main .block.lilac'), null);
    await page.evaluate(() => { document.getElementById('main').scrollTop = 0; });
    await page.screenshot({ path: `${REPORTS}/streamline-home-light.png` });

    await go(page, '#log', '#fc-item');
    await page.evaluate(() => { document.getElementById('main').scrollTop = 0; });
    await page.screenshot({ path: `${REPORTS}/streamline-log-add-light.png` });

    await page.evaluate(() => {
      document.documentElement.dataset.mode = 'dark';
      document.documentElement.dataset.theme = 'dark';
      localStorage.setItem('figure-cap.theme', 'dark');
    });
    await clickLabel(page, 'Pre-ordered');
    await page.waitForSelector('#field-deposit');
    await page.evaluate(() => {
      const scroller = document.getElementById('main');
      const target = [...document.querySelectorAll('.kicker')].find((el) => el.textContent.trim() === 'Order type');
      const origin = scroller.getBoundingClientRect().top;
      const top = target.getBoundingClientRect().top - origin + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, top - 8);
    });
    await page.screenshot({ path: `${REPORTS}/streamline-log-add-dark.png` });

    await page.evaluate(() => {
      document.documentElement.dataset.mode = 'light';
      document.documentElement.dataset.theme = 'light';
      localStorage.setItem('figure-cap.theme', 'light');
    });
    await go(page, '#entries', '.tools .search');
    await page.evaluate(() => { document.getElementById('main').scrollTop = 0; });
    await assertSearchToolbar(page);
    await page.screenshot({ path: `${REPORTS}/streamline-log-entries-toolbar.png` });
    await page.evaluate(() => { document.documentElement.dataset.mode = 'dark'; });
    await assertSearchToolbar(page);
    await page.screenshot({ path: `${REPORTS}/streamline-log-entries-toolbar-dark.png` });
    await page.evaluate(() => { document.documentElement.dataset.mode = 'light'; });

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.evaluate(() => {
      localStorage.setItem('figure-cap.theme', 'light');
      document.documentElement.dataset.mode = 'light';
      document.documentElement.dataset.theme = 'light';
      localStorage.setItem('figure-cap.v1', JSON.stringify({
        settings: { monthlyCap: 400, rollover: false, overspendPayback: true, trackingStart: '2026-09', syncUrl: '' },
        purchases: [
          {
            id: 'asuka',
            name: 'Asuka',
            price: 80,
            originalAmount: 80,
            currency: 'MYR',
            fxRate: 1,
            date: '2026-10-20',
            boughtAs: 'purchased',
            status: 'received',
            figureType: '1-12',
            condition: 'MISB',
            brand: 'Good Smile',
            series: 'Evangelion',
            createdAt: '2026-10-20T00:00:00.000Z',
            updatedAt: '2026-10-20T00:00:00.000Z'
          },
          {
            id: 'rei',
            name: 'Rei Ayanami',
            date: '2026-10-12',
            boughtAs: 'preorder',
            status: 'preordered',
            price: 200,
            originalAmount: 200,
            currency: 'MYR',
            fxRate: 1,
            figureType: '1-6',
            series: 'Evangelion',
            estFullPrice: 200,
            estFullOriginalAmount: 200,
            estFullCurrency: 'MYR',
            estFullFxRate: 1,
            estFullFxDate: '2026-10-12',
            depositAmountRm: 50,
            depositOriginalAmount: 50,
            depositCurrency: 'MYR',
            depositFxRate: 1,
            depositFxDate: '2026-10-12',
            depositDate: '2026-10-12',
            balanceDueRm: 150,
            preorderStatus: 'deposit paid',
            createdAt: '2026-10-12T00:00:00.000Z',
            updatedAt: '2026-10-12T00:00:00.000Z'
          },
          {
            id: 'optimus',
            name: 'Optimus',
            price: 40,
            originalAmount: 40,
            currency: 'MYR',
            fxRate: 1,
            date: '2026-09-02',
            boughtAs: 'purchased',
            status: 'received',
            figureType: 'transformers',
            createdAt: '2026-09-02T00:00:00.000Z',
            updatedAt: '2026-09-02T00:00:00.000Z'
          }
        ],
        wishlist: [],
        forSale: [
          {
            id: 'sale-miku',
            name: 'Miku',
            condition: 'MISB',
            price: 80,
            originalAmount: 80,
            currency: 'MYR',
            fxRate: 1,
            status: 'listed',
            createdAt: '2026-10-02T00:00:00.000Z',
            updatedAt: '2026-10-02T00:00:00.000Z'
          },
          {
            id: 'sale-mindwipe',
            name: 'Mindwipe',
            condition: 'Loose',
            price: 60,
            originalAmount: 60,
            currency: 'MYR',
            fxRate: 1,
            status: 'listed',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z'
          }
        ]
      }));
      window.__figureCap.setNow('2026-10-26T04:00:00Z');
      location.hash = '#settings';
    });
    await go(page, '#home', '#balances-card');
    assert.deepEqual(await blockTones(page), ['white', 'yellow', 'yellow']);
    await go(page, '#entries', '#category-totals');
    assert.equal(await page.$eval('#category-totals', (el) => el.classList.contains('yellow')), true);
    const entryCards = await page.evaluate(() => [...document.querySelectorAll('article.block')].map((el) => {
      if (el.id === 'category-totals') return 'totals';
      return el.querySelector('h3')?.textContent.trim();
    }));
    assert.deepEqual(entryCards, ['totals', 'Asuka', 'Rei Ayanami', 'Optimus']);
    assert.deepEqual(await blockTones(page), ['yellow', 'white', 'white', 'white']);
    const paid = await page.evaluate(() => {
      const card = [...document.querySelectorAll('article.block')].find((el) => el.textContent.includes('Deposit paid'));
      const tags = [...card.querySelectorAll('.tag')].map((el) => ({
        text: el.textContent.trim(),
        bg: getComputedStyle(el).backgroundColor,
        color: getComputedStyle(el).color
      }));
      const edit = card.querySelector('.btn-ghost');
      const chart = document.getElementById('chart');
      return {
        yellow: card.classList.contains('yellow'),
        background: getComputedStyle(card).backgroundColor,
        chart: getComputedStyle(chart).backgroundColor,
        radius: getComputedStyle(card).borderRadius,
        chartRadius: getComputedStyle(chart).borderRadius,
        shadow: getComputedStyle(card).boxShadow,
        chartShadow: getComputedStyle(chart).boxShadow,
        tags,
        editBg: getComputedStyle(edit).backgroundColor,
        editColor: getComputedStyle(edit).color
      };
    });
    assert.equal(paid.yellow, false);
    assert.equal(paid.background, paid.chart);
    assert.equal(paid.background, 'rgb(255, 255, 255)');
    assert.equal(paid.radius, paid.chartRadius);
    assert.equal(paid.shadow, paid.chartShadow);
    assert.equal(paid.tags[0].text, '1/6');
    assert.equal(paid.tags[0].bg, 'rgb(255, 228, 92)');
    assert.equal(paid.tags[0].color, 'rgb(22, 22, 22)');
    assert.equal(paid.tags.find((tag) => tag.text === 'Deposit paid').bg, 'rgb(255, 228, 92)');
    assert.equal(paid.tags.find((tag) => tag.text === 'Deposit paid').color, 'rgb(22, 22, 22)');
    assert.equal(paid.editBg, 'rgb(231, 231, 235)');
    assert.equal(paid.editColor, 'rgb(22, 22, 22)');
    await go(page, '#sell', 'article.block');
    assert.deepEqual(await blockTones(page), ['white', 'white']);

    for (const mode of ['light', 'dark']) {
      await page.evaluate((next) => {
        localStorage.setItem('figure-cap.theme', next);
        document.documentElement.dataset.mode = next;
        document.documentElement.dataset.theme = next;
      }, mode);
      await go(page, '#home', '#balances-card');
      const summaryTags = await page.evaluate(() => [...document.querySelectorAll('article.block.yellow .tag')].map((el) => {
        const style = getComputedStyle(el);
        return {
          text: el.textContent.trim(),
          bg: style.backgroundColor,
          color: style.color,
          borderColor: style.borderTopColor
        };
      }));
      assert.ok(summaryTags.length >= 2, JSON.stringify(summaryTags));
      for (const tag of summaryTags) {
        assert.equal(tag.bg, 'rgb(255, 255, 255)', `${mode} ${tag.text}`);
        assert.equal(tag.color, 'rgb(22, 22, 22)', `${mode} ${tag.text}`);
        assert.equal(tag.borderColor, 'rgba(0, 0, 0, 0)', `${mode} ${tag.text}`);
      }
      await page.evaluate(() => {
        const scroller = document.getElementById('main');
        const target = document.querySelector('article.block:not(.yellow)');
        const origin = scroller.getBoundingClientRect().top;
        scroller.scrollTop = Math.max(0, target.getBoundingClientRect().top - origin + scroller.scrollTop - 16);
      });
      await assertContrast(page);
      await assertNoOverflow(page);
      await page.screenshot({ path: `${REPORTS}/cards-home-${mode}.png` });
      await go(page, '#entries', '#category-totals');
      await page.evaluate(() => {
        const scroller = document.getElementById('main');
        const target = document.querySelector('article.block:not(.yellow)');
        const origin = scroller.getBoundingClientRect().top;
        scroller.scrollTop = Math.max(0, target.getBoundingClientRect().top - origin + scroller.scrollTop - 96);
      });
      await assertContrast(page);
      await assertNoOverflow(page);
      await page.screenshot({ path: `${REPORTS}/cards-entries-${mode}.png` });
      await go(page, '#sell', 'article.block');
      await page.evaluate(() => {
        const scroller = document.getElementById('main');
        const target = document.querySelector('article.block');
        const origin = scroller.getBoundingClientRect().top;
        scroller.scrollTop = Math.max(0, target.getBoundingClientRect().top - origin + scroller.scrollTop - 8);
      });
      await assertContrast(page);
      await assertNoOverflow(page);
      await page.screenshot({ path: `${REPORTS}/two-tone-sell-${mode}.png` });
    }

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.evaluate(() => {
      localStorage.setItem('figure-cap.theme', 'light');
      document.documentElement.dataset.mode = 'light';
      document.documentElement.dataset.theme = 'light';
      localStorage.setItem('figure-cap.v1', JSON.stringify({
        settings: { monthlyCap: 2000, rollover: false, overspendPayback: true, trackingStart: '2026-09', syncUrl: '' },
        purchases: [
          {
            id: 'asuka',
            name: 'Asuka',
            boughtAs: 'preorder',
            preorderStatus: 'deposit paid',
            status: 'preordered',
            figureType: '1-6',
            series: 'Evangelion',
            date: '2026-09-04',
            price: 1350,
            originalAmount: 1350,
            currency: 'MYR',
            fxRate: 1,
            estFullPrice: 1350,
            estFullOriginalAmount: 1350,
            estFullCurrency: 'MYR',
            estFullFxRate: 1,
            estFullFxDate: '2026-09-04',
            depositAmountRm: 475,
            depositOriginalAmount: 475,
            depositCurrency: 'MYR',
            depositFxRate: 1,
            depositFxDate: '2026-09-04',
            depositDate: '2026-09-04',
            balanceDueRm: 875,
            createdAt: '2026-09-04T00:00:00.000Z',
            updatedAt: '2026-09-04T00:00:00.000Z'
          },
          {
            id: 'rei',
            name: 'Rei',
            boughtAs: 'preorder',
            preorderStatus: 'fully paid',
            status: 'received',
            figureType: '1-12',
            series: 'Evangelion',
            date: '2026-09-12',
            price: 1000,
            originalAmount: 1000,
            currency: 'MYR',
            fxRate: 1,
            estFullPrice: 1000,
            estFullOriginalAmount: 1000,
            estFullCurrency: 'MYR',
            estFullFxRate: 1,
            estFullFxDate: '2026-09-12',
            depositAmountRm: 200,
            depositOriginalAmount: 200,
            depositCurrency: 'MYR',
            depositFxRate: 1,
            depositFxDate: '2026-09-12',
            depositDate: '2026-09-12',
            balancePaidRm: 800,
            balancePaidOriginalAmount: 800,
            balancePaidCurrency: 'MYR',
            balancePaidFxRate: 1,
            balancePaidFxDate: '2026-10-08',
            balancePaidDate: '2026-10-08',
            balanceDueRm: 0,
            finalTotalRm: 1000,
            createdAt: '2026-09-12T00:00:00.000Z',
            updatedAt: '2026-10-08T00:00:00.000Z'
          },
          {
            id: 'prize',
            name: 'Prize',
            boughtAs: 'purchased',
            status: 'received',
            figureType: 'other',
            date: '2026-10-02',
            price: 40,
            originalAmount: 40,
            currency: 'MYR',
            fxRate: 1,
            createdAt: '2026-10-02T00:00:00.000Z',
            updatedAt: '2026-10-02T00:00:00.000Z'
          }
        ],
        wishlist: [],
        forSale: []
      }));
      window.__figureCap.setNow('2026-10-26T04:00:00Z');
      location.hash = '#entries';
    });
    await go(page, '#entries', '.month-group');
    const paidTotals = await page.evaluate(() => {
      const header = (label) => {
        const heading = [...document.querySelectorAll('.month-group h3')].find((el) => el.textContent.includes(label));
        return heading?.parentElement.querySelector('p')?.textContent.trim() || '';
      };
      const chart = (label) => {
        const row = [...document.querySelectorAll('.chart-row')].find((el) => (
          el.querySelector('.chart-top span')?.textContent.startsWith(label)
        ));
        return row?.querySelector('.chart-top span:last-child')?.textContent.trim() || '';
      };
      const byType = [...document.querySelectorAll('#category-totals [data-stat]')].map((el) => el.textContent.replace(/\s+/g, ' ').trim());
      return {
        septemberHeader: header('September'),
        septemberChart: chart('Sep'),
        octoberHeader: header('October'),
        octoberChart: chart('Oct'),
        byType,
        openNote: [...document.querySelectorAll('.money-note')].some((el) => el.textContent.includes('Balance due')),
        paidNote: [...document.querySelectorAll('.tag')].some((el) => el.textContent.trim() === 'Fully paid')
      };
    });
    assert.equal(paidTotals.septemberHeader, 'RM 675.00');
    assert.equal(paidTotals.septemberChart, 'RM 675.00');
    assert.equal(paidTotals.octoberHeader, 'RM 840.00');
    assert.equal(paidTotals.octoberChart, 'RM 840.00');
    assert.equal(paidTotals.openNote, true);
    assert.equal(paidTotals.paidNote, true);
    assert.ok(paidTotals.byType.some((row) => row.includes('1/6') && row.includes('RM 475.00')));
    assert.ok(paidTotals.byType.some((row) => row.includes('1/12') && row.includes('RM 1,000.00')));
    await page.evaluate(() => {
      const scroller = document.getElementById('main');
      const header = [...document.querySelectorAll('.month-group h3')].find((el) => el.textContent.includes('September'));
      const origin = scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, header.getBoundingClientRect().top - origin + scroller.scrollTop - 8);
    });
    await page.screenshot({ path: `${REPORTS}/paid-totals-log.png` });
    await go(page, '#home', '#ytd-value');
    assert.equal(await text(page, '#spent-value'), 'RM 840.00');
    assert.equal(await text(page, '#ytd-value'), 'RM 1,515.00');
    assert.equal(await text(page, '#balances-card .block-value'), 'RM 875.00');
    const ytdHome = await page.evaluate(() => {
      const card = document.getElementById('ytd-value').closest('article');
      return {
        labels: [...card.querySelectorAll('.spec-label')].map((el) => el.textContent.trim()),
        text: card.innerText
      };
    });
    assert.deepEqual(ytdHome.labels, ['Purchases']);
    assert.equal(/1\/6|1\/12|Transformers|Model Kit/.test(ytdHome.text), false);
    assert.equal(await page.$eval('#balances-card .arrow', (el) => el.getAttribute('href')), '#entries/preorders');
    assert.equal(await page.$eval('#ytd-value', (el) => el.closest('article').querySelector('.arrow').getAttribute('href')), '#entries/types');
    await page.click('a[aria-label="Open spending by type"]');
    await page.waitForFunction(() => location.hash === '#entries/types');
    await page.waitForSelector('#category-totals');
    const typeGap = await page.evaluate(() => {
      const main = document.getElementById('main').getBoundingClientRect();
      const card = document.getElementById('category-totals');
      const rect = card.getBoundingClientRect();
      const labels = [...card.querySelectorAll('.spec-label')].map((el) => el.textContent.trim());
      return { gap: rect.top - main.top, labels, current: document.querySelector('.nav a[aria-current="page"]')?.textContent.trim() || '' };
    });
    assert.ok(typeGap.gap >= 0 && typeGap.gap <= 16, JSON.stringify(typeGap));
    assert.ok(typeGap.labels.includes('1/6') && typeGap.labels.includes('1/12'), JSON.stringify(typeGap));
    assert.equal(typeGap.current, 'Log');
    await go(page, '#home', '#balances-card');
    await page.click('#balances-card .arrow');
    await page.waitForSelector('#preorder-filter');
    const openOnly = await page.evaluate(() => ({
      names: [...document.querySelectorAll('.month-group article h3')].map((el) => el.textContent.trim()),
      showAll: document.querySelector('#preorder-filter a')?.textContent.trim() || '',
      href: document.querySelector('#preorder-filter a')?.getAttribute('href') || '',
      arrows: document.querySelectorAll('.month-group .arrow').length,
      label: document.querySelector('#preorder-filter .meta')?.textContent.trim() || ''
    }));
    assert.deepEqual(openOnly.names, ['Asuka']);
    assert.equal(openOnly.showAll, 'Show all');
    assert.equal(openOnly.href, '#entries');
    assert.equal(openOnly.arrows, 0);
    assert.equal(openOnly.label, 'Open pre-orders');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.evaluate(() => {
      const scroller = document.getElementById('main');
      const bar = document.getElementById('preorder-filter');
      const origin = scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, bar.getBoundingClientRect().top - origin + scroller.scrollTop - 8);
    });
    await page.screenshot({ path: `${REPORTS}/preorders.png` });
    await page.click('#preorder-filter a');
    await page.waitForFunction(() => location.hash === '#entries' && document.querySelector('[data-id="rei"]') && !document.getElementById('preorder-filter'));
    await go(page, '#home', '#balances-card');
    await page.evaluate(() => {
      const scroller = document.getElementById('main');
      const card = document.getElementById('balances-card');
      const origin = scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, card.getBoundingClientRect().top - origin + scroller.scrollTop - 8);
    });
    await page.screenshot({ path: `${REPORTS}/paid-totals-home.png` });

    await page.evaluate(() => {
      localStorage.setItem('figure-cap.v1', JSON.stringify({
        settings: { monthlyCap: 2000, rollover: false, overspendPayback: true, trackingStart: '2026-10', syncUrl: '' },
        purchases: [
          {
            id: 'soundwave',
            name: 'Soundwave (Laserbeak)',
            boughtAs: 'purchased',
            status: 'received',
            figureType: 'model-kit',
            brand: 'Blokees',
            series: 'Wheels C04',
            shop: 'PinDuoDuo',
            date: '2026-10-04',
            price: 42.31,
            originalAmount: 69.48,
            currency: 'CNY',
            fxRate: 0.61,
            fxDate: '2026-10-04',
            createdAt: '2026-10-04T00:00:00.000Z',
            updatedAt: '2026-10-04T00:00:00.000Z'
          },
          {
            id: 'shop-only',
            name: 'Shop only',
            boughtAs: 'purchased',
            status: 'received',
            date: '2026-10-03',
            shop: 'Shopee',
            price: 10,
            originalAmount: 10,
            currency: 'MYR',
            fxRate: 1,
            createdAt: '2026-10-03T00:00:00.000Z',
            updatedAt: '2026-10-03T00:00:00.000Z'
          },
          {
            id: 'foreign-only',
            name: 'Foreign only',
            boughtAs: 'purchased',
            status: 'received',
            date: '2026-10-02',
            price: 20,
            originalAmount: 30,
            currency: 'CNY',
            fxRate: 0.67,
            fxDate: '2026-10-02',
            createdAt: '2026-10-02T00:00:00.000Z',
            updatedAt: '2026-10-02T00:00:00.000Z'
          },
          {
            id: 'plain',
            name: 'Plain',
            boughtAs: 'purchased',
            status: 'received',
            date: '2026-10-01',
            price: 15,
            originalAmount: 15,
            currency: 'MYR',
            fxRate: 1,
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z'
          }
        ],
        wishlist: [
          {
            id: 'wish-sw',
            name: 'Shockwave',
            priority: 'really',
            price: 50,
            originalAmount: 80,
            currency: 'CNY',
            fxRate: 0.62,
            fxDate: '2026-10-01',
            addedAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z'
          }
        ],
        forSale: [
          {
            id: 'sale-sw',
            name: 'Ravage',
            brand: 'Blokees',
            series: 'Wheels C04',
            condition: 'MISB',
            status: 'listed',
            price: 30,
            originalAmount: 48,
            currency: 'CNY',
            fxRate: 0.62,
            fxDate: '2026-10-01',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z'
          }
        ]
      }));
      location.hash = '#entries';
      window.__figureCap.setNow('2026-10-26T04:00:00Z');
    });
    await page.waitForSelector('[data-id="soundwave"] h3');
    const cardOrder = await page.evaluate(() => {
      const read = (id) => {
        const article = document.querySelector(`[data-id="${id}"]`);
        return [...article.children].map((el) => {
          let kind = 'other';
          if (el.classList.contains('card-head')) kind = 'tags';
          else if (el.tagName === 'H3') kind = 'name';
          else if (el.classList.contains('block-value')) kind = 'price';
          else if (el.classList.contains('meta')) kind = 'meta';
          else if (el.classList.contains('btn-row')) kind = 'actions';
          return { kind, text: el.textContent.replace(/\s+/g, ' ').trim() };
        });
      };
      const sound = read('soundwave');
      const meta = document.querySelector('[data-id="soundwave"] .meta');
      const price = document.querySelector('[data-id="soundwave"] .block-value');
      const name = document.querySelector('[data-id="soundwave"] h3');
      return {
        sound,
        shop: read('shop-only'),
        foreign: read('foreign-only'),
        plain: read('plain'),
        fonts: {
          tag: getComputedStyle(document.querySelector('[data-id="soundwave"] .tag')).fontSize,
          meta: getComputedStyle(meta).fontSize,
          metaWeight: getComputedStyle(meta).fontWeight,
          name: getComputedStyle(name).fontSize,
          price: getComputedStyle(price).fontSize
        }
      };
    });
    assert.deepEqual(cardOrder.sound.map((row) => row.kind), ['tags', 'meta', 'name', 'price', 'meta', 'actions']);
    assert.match(cardOrder.sound[0].text, /Model Kit/);
    assert.equal(cardOrder.sound[1].text, '4 Oct · Blokees · Wheels C04');
    assert.equal(cardOrder.sound[2].text, 'Soundwave (Laserbeak)');
    assert.equal(cardOrder.sound[3].text, 'RM 42.31');
    assert.equal(cardOrder.sound[4].text, 'CN¥69.48 · PinDuoDuo');
    assert.match(cardOrder.sound[5].text, /Edit/);
    assert.match(cardOrder.sound[5].text, /Delete/);
    assert.equal(cardOrder.shop.filter((row) => row.kind === 'meta').map((row) => row.text).join('|'), '3 Oct|Shopee');
    assert.equal(cardOrder.foreign.filter((row) => row.kind === 'meta').map((row) => row.text).join('|'), '2 Oct|CN¥30.00');
    assert.deepEqual(cardOrder.plain.filter((row) => row.kind === 'meta').map((row) => row.text), ['1 Oct']);
    assert.equal(cardOrder.fonts.tag, '15px');
    assert.equal(cardOrder.fonts.meta, '15px');
    assert.equal(cardOrder.fonts.metaWeight, '400');
    assert.equal(cardOrder.fonts.name, '22px');
    assert.equal(cardOrder.fonts.price, '22px');
    const entryEdge = await page.evaluate(() => {
      const card = document.querySelector('[data-id="soundwave"]');
      const left = card.getBoundingClientRect().left + parseFloat(getComputedStyle(card).paddingLeft);
      return {
        arrow: Boolean(card.querySelector('.arrow')),
        head: Math.abs(card.querySelector('.card-head').getBoundingClientRect().left - left),
        name: Math.abs(card.querySelector('h3').getBoundingClientRect().left - left),
        edit: card.querySelector('.btn-row a')?.textContent.trim() || ''
      };
    });
    assert.equal(entryEdge.arrow, false);
    assert.ok(entryEdge.head <= 1, JSON.stringify(entryEdge));
    assert.ok(entryEdge.name <= 1, JSON.stringify(entryEdge));
    assert.equal(entryEdge.edit, 'Edit');
    await page.evaluate(() => {
      const scroller = document.getElementById('main');
      const card = document.querySelector('[data-id="soundwave"]');
      const origin = scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, card.getBoundingClientRect().top - origin + scroller.scrollTop - 12);
    });
    await assertTypeScale(page);
    await assertNoOverflow(page);
    await page.screenshot({ path: `${REPORTS}/log-card-after.png` });
    await clipShot(page, '[data-id="soundwave"]', `${REPORTS}/entries-no-arrow.png`, 12);

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await go(page, '#home', '[data-id="soundwave"]');
    const homeLatest = await page.evaluate(() => {
      const read = (article) => [...article.children].map((el) => {
        let kind = 'other';
        if (el.classList.contains('card-head')) kind = 'tags';
        else if (el.tagName === 'H3') kind = 'name';
        else if (el.classList.contains('block-value')) kind = 'price';
        else if (el.classList.contains('meta')) kind = 'meta';
        else if (el.classList.contains('btn-row')) kind = 'actions';
        else if (el.classList.contains('ytd-count')) kind = 'count';
        return { kind, text: el.textContent.replace(/\s+/g, ' ').trim() };
      });
      const latest = document.querySelector('[data-id="soundwave"]');
      const ytd = document.getElementById('ytd-value').closest('article');
      const count = ytd.querySelector('.ytd-count');
      const countStyle = getComputedStyle(count);
      const name = latest.querySelector('h3');
      return {
        latest: read(latest),
        ytd: read(ytd),
        countLeft: count.getBoundingClientRect().left,
        kickerLeft: ytd.querySelector('.kicker').getBoundingClientRect().left,
        totalLeft: document.getElementById('ytd-value').getBoundingClientRect().left,
        countAlign: countStyle.textAlign,
        countSize: getComputedStyle(count.querySelector('.stat-v')).fontSize,
        nameSize: getComputedStyle(name).fontSize,
        priceSize: getComputedStyle(latest.querySelector('.block-value')).fontSize,
        metaSize: getComputedStyle(latest.querySelector('.meta')).fontSize,
        arrow: Boolean(latest.querySelector('.arrow')),
        buttons: [...latest.querySelectorAll('.btn-row a, .btn-row button')].map((el) => el.textContent.trim()),
        fullWidth: (() => {
          const button = latest.querySelector('.btn-row a, .btn-row button');
          const style = getComputedStyle(latest);
          const inner = latest.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          return Math.abs(button.getBoundingClientRect().width - inner) <= 2;
        })(),
        logArrow: Boolean(document.querySelector('a.arrow[aria-label="Log a purchase"]'))
      };
    });
    assert.deepEqual(homeLatest.latest.map((row) => row.kind), ['tags', 'meta', 'name', 'price', 'meta', 'actions']);
    assert.match(homeLatest.latest[0].text, /Model Kit/);
    assert.equal(homeLatest.latest[1].text, '4 Oct · Blokees · Wheels C04');
    assert.equal(homeLatest.latest[2].text, 'Soundwave (Laserbeak)');
    assert.equal(homeLatest.latest[3].text, 'RM 42.31');
    assert.equal(homeLatest.latest[4].text, 'CN¥69.48 · PinDuoDuo');
    assert.equal(homeLatest.arrow, false);
    assert.deepEqual(homeLatest.buttons, ['Edit']);
    assert.equal(homeLatest.fullWidth, true);
    assert.equal(homeLatest.logArrow, false);
    assert.deepEqual(homeLatest.ytd.map((row) => row.kind), ['tags', 'other', 'price', 'count']);
    assert.match(homeLatest.ytd[1].text, /Year to date/);
    assert.match(homeLatest.ytd[3].text, /^Purchases 4$/);
    assert.equal(homeLatest.ytd.some((row) => /Model Kit|1\/6|1\/12|Transformers/.test(row.text)), false);
    assert.ok(Math.abs(homeLatest.countLeft - homeLatest.kickerLeft) <= 1);
    assert.ok(Math.abs(homeLatest.countLeft - homeLatest.totalLeft) <= 1);
    assert.equal(homeLatest.countAlign, 'left');
    assert.equal(homeLatest.countSize, '15px');
    assert.equal(homeLatest.nameSize, '22px');
    assert.equal(homeLatest.priceSize, '22px');
    assert.equal(homeLatest.metaSize, '15px');
    await page.evaluate(() => {
      const scroller = document.getElementById('main');
      const card = document.querySelector('[data-id="soundwave"]');
      const origin = scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, card.getBoundingClientRect().top - origin + scroller.scrollTop - 16);
    });
    await assertNoOverflow(page);
    await assertTypeScale(page);
    await page.screenshot({ path: `${REPORTS}/home-latest.png` });

    const homeBeforePay = await page.evaluate(() => localStorage.getItem('figure-cap.v1'));
    await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('figure-cap.v1'));
      const item = data.purchases.find((row) => row.id === 'soundwave');
      Object.assign(item, {
        boughtAs: 'preorder',
        estFullPrice: 80,
        estFullOriginalAmount: 80,
        estFullCurrency: 'MYR',
        estFullFxRate: 1,
        estFullFxDate: '2026-10-04',
        depositAmountRm: 20,
        depositOriginalAmount: 20,
        depositCurrency: 'MYR',
        depositFxRate: 1,
        depositFxDate: '2026-10-04',
        depositDate: '2026-10-04'
      });
      localStorage.setItem('figure-cap.v1', JSON.stringify(data));
    });
    await go(page, '#entries', '[data-id="soundwave"]');
    const payEntry = await page.evaluate(() => {
      const card = document.querySelector('.month-group [data-id="soundwave"]');
      return [...card.querySelectorAll('.btn-row a, .btn-row button')].map((el) => el.textContent.trim());
    });
    assert.deepEqual(payEntry, ['Pay balance', 'Delete']);
    await go(page, '#home', '[data-id="soundwave"]');
    const payHome = await page.evaluate(() => {
      const latest = document.querySelector('[data-id="soundwave"]');
      return {
        buttons: [...latest.querySelectorAll('.btn-row a, .btn-row button')].map((el) => el.textContent.trim()),
        arrow: Boolean(latest.querySelector('.arrow'))
      };
    });
    assert.deepEqual(payHome.buttons, ['Pay balance']);
    assert.equal(payHome.arrow, false);
    await page.evaluate((saved) => localStorage.setItem('figure-cap.v1', saved), homeBeforePay);
    await go(page, '#entries', '#chart');

    await go(page, '#wish', '[data-id="wish-sw"]');
    const wishOrder = await page.evaluate(() => {
      const article = document.querySelector('[data-id="wish-sw"]');
      return [...article.children].map((el) => ({
        kind: el.classList.contains('card-head') ? 'tags'
          : el.tagName === 'H3' ? 'name'
            : el.classList.contains('block-value') ? 'price'
              : el.classList.contains('meta') ? 'meta'
                : el.classList.contains('btn-row') ? 'actions' : 'other',
        text: el.textContent.replace(/\s+/g, ' ').trim()
      }));
    });
    assert.deepEqual(wishOrder.map((row) => row.kind), ['tags', 'name', 'price', 'meta', 'meta', 'actions']);
    assert.match(wishOrder[0].text, /Really want/);
    assert.equal(wishOrder[1].text, 'Shockwave');
    assert.equal(wishOrder[2].text, 'RM 50.00');
    assert.equal(wishOrder[3].text, 'CN¥80.00');
    assert.match(wishOrder[4].text, /Fits this month|what's left/);
    assert.match(wishOrder[5].text, /Log purchase/);
    assert.match(wishOrder[5].text, /Remove/);

    await go(page, '#sell', '[data-id="sale-sw"]');
    const saleOrder = await page.evaluate(() => {
      const article = document.querySelector('[data-id="sale-sw"]');
      return [...article.children].map((el) => ({
        kind: el.classList.contains('card-head') ? 'tags'
          : el.tagName === 'H3' ? 'name'
            : el.classList.contains('block-value') ? 'price'
              : el.classList.contains('meta') ? 'meta'
                : el.classList.contains('search-pills') ? 'search'
                  : el.classList.contains('check') ? 'check'
                    : el.classList.contains('btn-row') ? 'actions' : 'other',
        text: el.textContent.replace(/\s+/g, ' ').trim()
      }));
    });
    assert.deepEqual(saleOrder.map((row) => row.kind), ['tags', 'meta', 'name', 'price', 'meta', 'search', 'check', 'actions']);
    assert.match(saleOrder[0].text, /MISB/);
    assert.match(saleOrder[0].text, /Listed/);
    assert.equal(saleOrder[1].text, 'Blokees · Wheels C04');
    assert.equal(saleOrder[2].text, 'Ravage');
    assert.equal(saleOrder[3].text, 'RM 30.00');
    assert.equal(saleOrder[4].text, 'CN¥48.00');
    assert.match(saleOrder[7].text, /Edit/);
    assert.match(saleOrder[7].text, /Delete/);
    assert.equal(await page.$('[data-id="sale-sw"] .arrow'), null);
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.evaluate(() => {
      const scroller = document.getElementById('main');
      const card = document.querySelector('[data-id="sale-sw"]');
      const origin = scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, card.getBoundingClientRect().top - origin + scroller.scrollTop - 12);
    });
    await clipShot(page, '[data-id="sale-sw"]', `${REPORTS}/sell-no-arrow.png`, 12);

    await go(page, '#home', '#month-title');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await showSyncing(page);
    await assertHeaderDivider(page);
    await clipShot(page, '.top', `${REPORTS}/header-after.png`, 0);
    await page.evaluate(() => {
      localStorage.setItem('figure-cap.theme', 'dark');
      document.documentElement.dataset.mode = 'dark';
      document.documentElement.dataset.theme = 'dark';
    });
    await showSyncing(page);
    await assertHeaderDivider(page);
    await clipShot(page, '.top', `${REPORTS}/header-after-dark.png`, 0);
    await page.setViewport({ width: 320, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await showSyncing(page);
    await assertHeaderDivider(page);
    await assertNoOverflow(page);
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.evaluate(() => {
      localStorage.setItem('figure-cap.theme', 'light');
      document.documentElement.dataset.mode = 'light';
      document.documentElement.dataset.theme = 'light';
    });
    await showSyncing(page);
    const session = await page.createCDPSession();
    await session.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: 59, bottom: 34, left: 0, right: 0, topMax: 59, bottomMax: 34, leftMax: 0, rightMax: 0 }
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const insets = await safeAreaInsets(page);
    assert.equal(insets.top, 59);
    assert.equal(insets.bottom, 34);
    const navBox = await assertNavOnScreen(page, 20);
    assert.ok(navBox.monoTop >= 59 + 20 && navBox.monoTop <= 59 + 28, JSON.stringify(navBox));
    await page.screenshot({ path: `${REPORTS}/nav-tab-height.png` });
    await clipShot(page, '.nav', `${REPORTS}/nav-after.png`, 0);
    await session.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: 0, bottom: 0, left: 0, right: 0, topMax: 0, bottomMax: 0, leftMax: 0, rightMax: 0 }
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await assertNavOnScreen(page, 8);

    await page.evaluate(() => {
      const buy = (id, name, date, price, figureType) => ({
        id,
        name,
        date,
        price,
        boughtAs: 'purchased',
        status: 'received',
        figureType,
        originalAmount: price,
        currency: 'MYR',
        fxRate: 1,
        createdAt: `${date}T00:00:00.000Z`,
        updatedAt: `${date}T00:00:00.000Z`
      });
      localStorage.setItem('figure-cap.theme', 'light');
      document.documentElement.dataset.mode = 'light';
      document.documentElement.dataset.theme = 'light';
      localStorage.setItem('figure-cap.v1', JSON.stringify({
        settings: { monthlyCap: 400, rollover: false, overspendPayback: true, trackingStart: '2026-06', syncUrl: '' },
        purchases: [
          buy('jun', 'June figure', '2026-06-04', 40, '1-6'),
          buy('jul', 'July figure', '2026-07-04', 50, '1-12'),
          buy('aug', 'August figure', '2026-08-04', 60, 'model-kit'),
          buy('sep', 'September figure', '2026-09-04', 70, 'transformers'),
          buy('oct', 'October figure', '2026-10-04', 80, 'other')
        ],
        wishlist: [],
        forSale: []
      }));
      location.hash = '#entries';
      window.__figureCap.setNow('2026-10-26T04:00:00Z');
    });
    await page.waitForSelector('#chart .chart-row');
    const collapsed = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('#chart .chart-top span:first-child')].map((el) => el.textContent.trim());
      const toggle = document.querySelector('[data-action="toggle-chart"]');
      const chart = document.getElementById('chart');
      const types = document.getElementById('category-totals');
      const group = document.querySelector('.month-group');
      const header = group.querySelector('.item-top');
      const card = group.querySelector('article');
      const label = types.querySelector('.spec-label');
      const amount = types.querySelector('.stat-v');
      return {
        labels,
        toggle: toggle ? toggle.textContent.trim() : '',
        expanded: toggle?.getAttribute('aria-expanded') || '',
        gap: types.getBoundingClientRect().top - chart.getBoundingClientRect().bottom,
        above: group.getBoundingClientRect().top - types.getBoundingClientRect().bottom,
        below: card.getBoundingClientRect().top - header.getBoundingClientRect().bottom,
        nameWeight: getComputedStyle(label).fontWeight,
        amountWeight: getComputedStyle(amount).fontWeight,
        nameSize: getComputedStyle(label).fontSize,
        amountSize: getComputedStyle(amount).fontSize,
        toggleSize: getComputedStyle(toggle).fontSize
      };
    });
    assert.deepEqual(collapsed.labels, ['Aug 2026', 'Sept 2026', 'Oct 2026']);
    assert.equal(collapsed.toggle, 'Show all');
    assert.equal(collapsed.expanded, 'false');
    assert.ok(collapsed.gap >= 8 && collapsed.gap <= 14, JSON.stringify(collapsed));
    assert.ok(collapsed.above >= 30 && collapsed.above <= 36, JSON.stringify(collapsed));
    assert.ok(collapsed.below >= 8 && collapsed.below <= 14, JSON.stringify(collapsed));
    assert.ok(collapsed.nameWeight === '700' || collapsed.nameWeight === 'bold', JSON.stringify(collapsed));
    assert.ok(collapsed.amountWeight === '400' || collapsed.amountWeight === 'normal', JSON.stringify(collapsed));
    assert.equal(collapsed.nameSize, '15px');
    assert.equal(collapsed.amountSize, '15px');
    assert.equal(collapsed.toggleSize, '15px');
    await page.evaluate(() => {
      const scroller = document.getElementById('main');
      const chart = document.getElementById('chart');
      const origin = scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, chart.getBoundingClientRect().top - origin + scroller.scrollTop - 8);
    });
    await assertTypeScale(page);
    await assertNoOverflow(page);
    await page.screenshot({ path: `${REPORTS}/log-months-collapsed.png` });
    await press(page, '[data-action="toggle-chart"]');
    await page.waitForFunction(() => document.querySelector('[data-action="toggle-chart"]')?.textContent.trim() === 'Show less');
    const expanded = await page.evaluate(() => ({
      labels: [...document.querySelectorAll('#chart .chart-top span:first-child')].map((el) => el.textContent.trim()),
      toggle: document.querySelector('[data-action="toggle-chart"]').textContent.trim(),
      expanded: document.querySelector('[data-action="toggle-chart"]').getAttribute('aria-expanded')
    }));
    assert.deepEqual(expanded.labels, ['Jun 2026', 'Jul 2026', 'Aug 2026', 'Sept 2026', 'Oct 2026']);
    assert.equal(expanded.toggle, 'Show less');
    assert.equal(expanded.expanded, 'true');
    await page.evaluate(() => {
      const scroller = document.getElementById('main');
      const chart = document.getElementById('chart');
      const origin = scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, chart.getBoundingClientRect().top - origin + scroller.scrollTop - 8);
    });
    await assertNoOverflow(page);
    await page.screenshot({ path: `${REPORTS}/log-months-expanded.png` });
    await page.evaluate(() => {
      localStorage.setItem('figure-cap.theme', 'dark');
      document.documentElement.dataset.mode = 'dark';
      document.documentElement.dataset.theme = 'dark';
    });
    await assertNoOverflow(page);
    await page.screenshot({ path: `${REPORTS}/log-months-expanded-dark.png` });
    await press(page, '[data-action="toggle-chart"]');
    await page.waitForFunction(() => document.querySelector('[data-action="toggle-chart"]')?.textContent.trim() === 'Show all');
    await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('figure-cap.v1'));
      const oct = saved.purchases.find((item) => item.id === 'oct');
      oct.price = 721.82;
      oct.originalAmount = 721.82;
      saved.wishlist = [{
        id: 'wish-align',
        name: 'Shockwave',
        price: 180,
        priority: 'really',
        originalAmount: 180,
        currency: 'MYR',
        addedAt: '2026-10-01T00:00:00.000Z'
      }];
      saved.forSale = [{
        id: 'sale-align',
        name: 'Ravage',
        brand: 'Blokees',
        series: 'Wheels',
        condition: 'MISB',
        status: 'listed',
        price: 90,
        originalAmount: 90,
        currency: 'MYR',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z'
      }];
      localStorage.setItem('figure-cap.v1', JSON.stringify(saved));
      window.__figureCap.setNow('2026-10-26T04:00:00Z');
    });
    await page.waitForFunction(() => document.querySelector('.month-group .item-top p')?.textContent.includes('721.82'));
    for (const mode of ['light', 'dark']) {
      await page.evaluate((next) => {
        localStorage.setItem('figure-cap.theme', next);
        document.documentElement.dataset.mode = next;
        document.documentElement.dataset.theme = next;
      }, mode);
      for (const width of [320, 390, 430]) {
        await page.setViewport({ width, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        await go(page, '#entries', '.month-group');
        await assertAlignedHeaders(page);
        await go(page, '#home', '#budget-bar');
        await assertAlignedHeaders(page);
        await go(page, '#wish', '#wish-list article');
        await assertAlignedHeaders(page);
        await go(page, '#plan', 'label.pick');
        await assertAlignedHeaders(page);
        await go(page, '#sell', '[data-id="sale-align"]');
        await assertAlignedHeaders(page);
        if (mode === 'light' && width === 390) {
          await go(page, '#entries', '.month-group');
          await assertNoOverflow(page);
          await shootMonthAlign(page);
        }
      }
    }
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await go(page, '#entries', '.month-group');
    await page.evaluate(() => {
      localStorage.setItem('figure-cap.v1', JSON.stringify({
        settings: { monthlyCap: 400, rollover: false, overspendPayback: true, trackingStart: '2026-10', syncUrl: '' },
        purchases: [{
          id: 'only',
          name: 'Only',
          date: '2026-10-02',
          price: 20,
          boughtAs: 'purchased',
          status: 'received',
          figureType: '1-6',
          originalAmount: 20,
          currency: 'MYR',
          fxRate: 1,
          createdAt: '2026-10-02T00:00:00.000Z',
          updatedAt: '2026-10-02T00:00:00.000Z'
        }],
        wishlist: [],
        forSale: []
      }));
      window.__figureCap.setNow('2026-10-26T04:00:00Z');
    });
    await page.waitForFunction(() => document.querySelectorAll('#chart .chart-row').length === 1);
    assert.equal(await page.$('[data-action="toggle-chart"]'), null);
    await page.evaluate(() => {
      localStorage.setItem('figure-cap.theme', 'light');
      document.documentElement.dataset.mode = 'light';
      document.documentElement.dataset.theme = 'light';
    });

    const shellSession = await page.createCDPSession();
    await shellSession.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 785,
      deviceScaleFactor: 2,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
      window.__figureCapFitShell();
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const shortShell = await page.evaluate(() => {
      const nav = document.querySelector('.nav').getBoundingClientRect();
      const app = document.querySelector('.app').getBoundingClientRect();
      const root = document.documentElement;
      return {
        standalone: root.classList.contains('standalone'),
        appH: getComputedStyle(root).getPropertyValue('--app-h').trim(),
        navBottom: nav.bottom,
        appBottom: app.bottom,
        innerHeight: window.innerHeight,
        screenHeight: window.screen.height,
        navPosition: getComputedStyle(document.querySelector('.nav')).position
      };
    });
    assert.equal(shortShell.standalone, true, JSON.stringify(shortShell));
    assert.equal(shortShell.navPosition, 'relative', JSON.stringify(shortShell));
    assert.equal(shortShell.screenHeight, 844, JSON.stringify(shortShell));
    assert.ok(shortShell.innerHeight <= 844 - 50, JSON.stringify(shortShell));
    assert.equal(shortShell.appH, '844px', JSON.stringify(shortShell));
    assert.ok(Math.abs(shortShell.navBottom - 844) < 2, JSON.stringify(shortShell));
    assert.ok(Math.abs(shortShell.appBottom - 844) < 2, JSON.stringify(shortShell));
    await go(page, '#log', '#fc-item');
    await page.focus('#fc-item');
    await shellSession.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 500,
      deviceScaleFactor: 2,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844
    });
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const whileTyping = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim());
    assert.equal(whileTyping, '844px');
    await page.evaluate(() => document.activeElement?.blur());
    await shellSession.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 785,
      deviceScaleFactor: 2,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844
    });
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const afterKeys = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim());
    assert.equal(afterKeys, '844px');
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => false });
      window.__figureCapFitShell();
    });
    await shellSession.send('Emulation.clearDeviceMetricsOverride');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.evaluate(() => window.__figureCapFitShell());

    await page.goto(`${BASE}?diag=1#settings`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#shell-diag');
    const diag = await page.evaluate(() => {
      const el = document.getElementById('shell-diag');
      const style = getComputedStyle(el);
      return { text: el.textContent, size: style.fontSize, weight: style.fontWeight };
    });
    assert.match(diag.text, /inner \d+/);
    assert.match(diag.text, /client \d+/);
    assert.match(diag.text, /screen \d+/);
    assert.match(diag.text, /vv \d+/);
    assert.match(diag.text, /safe \d+\/\d+\/\d+\/\d+/);
    assert.match(diag.text, /nav \d+/);
    assert.equal(diag.size, '15px');
    assert.ok(diag.weight === '400' || diag.weight === 'normal');
    await page.goto(`${BASE}#settings`, { waitUntil: 'networkidle0' });
    assert.equal(await page.$('#shell-diag'), null);

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
