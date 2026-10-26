import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeData, exportPayload } from '../js/store.js';
import { syncAllBody } from '../js/sync.js';
import {
  applyTheme,
  normalizeTheme,
  readTheme,
  resolveMode,
  themeColorFor,
  writeTheme,
  THEME_KEY
} from '../js/theme.js';

function memory() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

function fakeDocument() {
  const metas = {
    'theme-color': '',
    'color-scheme': ''
  };
  return {
    documentElement: { dataset: {} },
    querySelector(selector) {
      const name = selector.match(/name="([^"]+)"/)?.[1];
      if (!name || !(name in metas)) return null;
      return {
        setAttribute(attr, value) {
          if (attr === 'content') metas[name] = value;
        }
      };
    },
    metas
  };
}

test('theme defaults to match phone and resolves from the system', () => {
  const store = memory();
  assert.equal(readTheme(store), 'system');
  assert.equal(normalizeTheme('nope'), 'system');
  assert.equal(resolveMode('system', true), 'dark');
  assert.equal(resolveMode('system', false), 'light');
  assert.equal(resolveMode('dark', false), 'dark');
  assert.equal(resolveMode('light', true), 'light');
  assert.equal(themeColorFor('dark'), '#121212');
  assert.equal(themeColorFor('light'), '#f5f5f7');
});

test('theme is stored apart from the collection and the sheet', () => {
  const store = memory();
  assert.equal(writeTheme(store, 'dark'), 'dark');
  assert.equal(store.getItem(THEME_KEY), 'dark');
  const doc = fakeDocument();
  const applied = applyTheme('dark', false, doc);
  assert.deepEqual(applied, { theme: 'dark', mode: 'dark' });
  assert.equal(doc.documentElement.dataset.theme, 'dark');
  assert.equal(doc.documentElement.dataset.mode, 'dark');
  assert.equal(doc.metas['theme-color'], '#121212');
  assert.equal(doc.metas['color-scheme'], 'dark');

  const data = normalizeData({
    settings: { monthlyCap: 400, theme: 'dark' },
    purchases: [],
    wishlist: [],
    forSale: []
  }, '2026-10');
  assert.equal(data.settings.theme, undefined);
  const exported = exportPayload(data, '2026-10-26T00:00:00.000Z');
  assert.equal(JSON.stringify(exported).includes('theme'), false);
  const body = syncAllBody({ ...data, theme: 'dark' });
  assert.equal(Object.hasOwn(body, 'theme'), false);
  assert.equal(Object.hasOwn(body, 'settings'), false);
  assert.deepEqual(Object.keys(body), ['action', 'purchases', 'wishlist', 'forSale']);
});
