import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chartMonths,
  effectiveCap,
  fitFor,
  fitLabel,
  historyGroups,
  homeModel,
  monthSnapshot,
  paceInsight,
  planModel,
  sortWishlist,
  waitStatus,
  yearSpent
} from '../js/budget.js';
import { formatRM, parseMoney } from '../js/money.js';
import {
  emptyData,
  exportPayload,
  load,
  normalizeData,
  save,
  STORAGE_KEY
} from '../js/store.js';
import { addMonths, daysBetween, setNow, todayYMD } from '../js/time.js';

function memory() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

function settings(extra = {}) {
  return {
    monthlyCap: 400,
    waitHours: 0,
    rollover: false,
    trackingStart: '2026-10',
    ...extra
  };
}

function buy(date, price, extra = {}) {
  return {
    id: extra.id || date + price,
    name: extra.name || 'Figure',
    price,
    date,
    type: extra.type || 'bought',
    note: '',
    mood: '',
    createdAt: extra.createdAt || '2026-10-01T00:00:00.000Z'
  };
}

test('Malaysia calendar day flips at 16:00 UTC', () => {
  assert.equal(todayYMD(new Date('2026-10-23T15:59:00Z')), '2026-10-23');
  assert.equal(todayYMD(new Date('2026-10-23T16:30:00Z')), '2026-10-24');
  assert.equal(todayYMD(new Date('2026-10-31T16:30:00Z')), '2026-11-01');
  assert.equal(todayYMD(new Date('2026-10-31T15:30:00Z')), '2026-10-31');
});

test('setNow follows an absolute instant', () => {
  setNow('2026-12-31T16:30:00Z');
  assert.equal(todayYMD(), '2027-01-01');
  setNow(null);
});

test('month arithmetic crosses the year', () => {
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(daysBetween('2026-09-23', '2026-10-23'), 30);
  assert.equal(daysBetween('2026-09-24', '2026-10-23'), 29);
});

test('formats ringgit with 2 decimals', () => {
  assert.equal(formatRM(400), 'RM 400.00');
  assert.equal(formatRM(1234.5), 'RM 1,234.50');
  assert.equal(formatRM(0.1), 'RM 0.10');
  assert.equal(parseMoney('RM 1,234.50'), 1234.5);
  assert.equal(parseMoney('12,50'), 12.5);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney(400), 400);
});

test('cap states change after 75% and after the cap', () => {
  const base = settings();
  const at = (price) => monthSnapshot(base, [buy('2026-10-02', price)], '2026-10');
  assert.equal(at(300).state, 'ok');
  assert.equal(at(300).usedUp, false);
  assert.equal(at(300.01).state, 'warn');
  const exact = at(400);
  assert.equal(exact.state, 'warn');
  assert.equal(exact.usedUp, true);
  assert.equal(exact.room, 0);
  assert.equal(exact.over, 0);
  const over = at(410);
  assert.equal(over.state, 'over');
  assert.equal(over.usedUp, true);
  assert.equal(over.over, 10);
  assert.equal(over.room, 0);
});

test('pre-orders count in the month paid, at full price', () => {
  const purchases = [
    buy('2026-10-03', 80, { type: 'bought' }),
    buy('2026-09-02', 150, { type: 'preorder' }),
    buy('2026-11-01', 40, { type: 'preorder' })
  ];
  const october = monthSnapshot(settings(), purchases, '2026-10');
  assert.equal(october.spent, 80);
  assert.equal(monthSnapshot(settings(), purchases, '2026-09').spent, 150);
  assert.equal(yearSpent(purchases, '2026'), 270);
  assert.equal(yearSpent(purchases, '2025'), 0);
});

test('rollover adds last month leftover and ignores overspend', () => {
  const purchases = [
    buy('2026-08-01', 0.01),
    buy('2026-09-01', 100)
  ];
  const rolling = settings({ rollover: true, trackingStart: '2026-08' });
  assert.equal(effectiveCap(rolling, purchases, '2026-08'), 400);
  assert.equal(effectiveCap(rolling, purchases, '2026-09'), 799.99);
  assert.equal(effectiveCap(rolling, purchases, '2026-10'), 1099.99);

  const overspent = settings({ rollover: true, trackingStart: '2026-09' });
  assert.equal(effectiveCap(overspent, [buy('2026-09-01', 500)], '2026-10'), 400);
  assert.equal(effectiveCap(settings({ rollover: false }), [], '2026-10'), 400);
});

test('rollover chain crosses into January', () => {
  const rolling = settings({ rollover: true, trackingStart: '2026-12' });
  const purchases = [buy('2026-12-15', 100)];
  assert.equal(effectiveCap(rolling, purchases, '2027-01'), 700);
});

test('home model uses the Malaysia month of the clock', () => {
  const data = {
    settings: settings(),
    purchases: [buy('2026-10-31', 50), buy('2026-11-01', 20)],
    wishlist: []
  };
  const before = homeModel(data, new Date('2026-10-31T15:30:00Z'));
  assert.equal(before.ym, '2026-10');
  assert.equal(before.month.spent, 50);
  assert.equal(before.ytd, 70);
  const after = homeModel(data, new Date('2026-10-31T16:30:00Z'));
  assert.equal(after.ym, '2026-11');
  assert.equal(after.month.spent, 20);
  assert.equal(after.month.usedUp, false);
});

test('pace card waits for 30 days and suggests a cap change', () => {
  const under = [buy('2026-09-13', 300)];
  assert.equal(paceInsight(under, '2026-10-12', 400), null);
  const pace = paceInsight(under, '2026-10-23', 400);
  assert.equal(pace.days, 40);
  assert.equal(pace.average, 225);
  assert.match(pace.suggestion, /RM 225\.00, below the RM 400\.00 cap/);
  assert.match(pace.suggestion, /RM 230\.00/);

  const over = paceInsight([buy('2026-09-23', 800)], '2026-10-23', 400);
  assert.equal(over.average, 800);
  assert.match(over.suggestion, /above the RM 400\.00 cap/);

  const close = paceInsight([buy('2026-09-23', 350)], '2026-10-23', 400);
  assert.match(close.suggestion, /No change needed/);
});

test('wishlist sorts by priority and describes the cap', () => {
  const items = sortWishlist([
    { name: 'Prize', priority: 'nice', addedAt: '2026-10-03T00:00:00.000Z' },
    { name: 'Nendo', priority: 'really', addedAt: '2026-10-01T00:00:00.000Z' },
    { name: 'Grail', priority: 'must', addedAt: '2026-10-04T00:00:00.000Z' },
    { name: 'Mega', priority: 'really', addedAt: '2026-10-02T00:00:00.000Z' }
  ]);
  assert.deepEqual(items.map((item) => item.name), ['Grail', 'Nendo', 'Mega', 'Prize']);
  assert.equal(fitLabel(300, 320), "Fits this month · 94% of what's left");
  assert.equal(
    fitLabel(500, 320),
    "156% of what's left · Wait for next month (RM 180.00 short)"
  );
  assert.equal(fitLabel(80, 0), 'Wait for next month (RM 80.00 short)');
  assert.equal(fitFor(50, -20).short, 50);
  assert.equal(fitFor(320, 320).fits, true);
});

test('plan total is compared with room left', () => {
  const items = [
    { id: 'a', price: 300 },
    { id: 'b', price: 200 }
  ];
  const both = planModel(items, new Set(['a', 'b']), 320);
  assert.equal(both.total, 500);
  assert.equal(both.fits, false);
  assert.equal(both.over, 180);
  const one = planModel(items, new Set(['a']), 320);
  assert.equal(one.fits, true);
  assert.equal(one.remaining, 20);
  const alreadyOver = planModel([{ id: 'c', price: 10 }], new Set(['c']), -50);
  assert.equal(alreadyOver.over, 10);
});

test('optional wait is off at 0 hours and gates only when set', () => {
  const added = '2026-10-23T02:00:00.000Z';
  const at = new Date(added);
  assert.deepEqual(waitStatus(added, 0, at), { enabled: false, ready: true, text: '' });
  const early = waitStatus(added, 48, new Date(Date.parse(added) + 47 * 3600000));
  assert.equal(early.ready, false);
  assert.match(early.text, /^Ready in /);
  const ready = waitStatus(added, 48, new Date(Date.parse(added) + 48 * 3600000));
  assert.equal(ready.ready, true);
  assert.equal(ready.text, 'Ready to buy');
});

test('history groups months and the chart keeps a short recent window', () => {
  const purchases = [buy('2026-09-02', 150), buy('2026-10-03', 80), buy('2026-10-01', 20)];
  const groups = historyGroups(settings(), purchases);
  assert.deepEqual(groups.map((group) => group.ym), ['2026-10', '2026-09']);
  assert.equal(groups[0].spent, 100);
  assert.deepEqual(groups[0].purchases.map((item) => item.price), [80, 20]);
  const chart = chartMonths(settings({ trackingStart: '2025-01' }), purchases, '2026-10');
  assert.equal(chart.truncated, true);
  assert.equal(chart.months.length, 8);
  assert.equal(chart.months.at(-1), '2026-10');
});

test('storage defaults, import, and corrupt files', () => {
  const store = memory();
  const first = load('2026-10', store);
  assert.equal(first.corrupt, false);
  assert.equal(first.data.settings.monthlyCap, 400);
  assert.equal(first.data.settings.waitHours, 0);
  assert.equal(first.data.settings.rollover, false);
  assert.equal(first.data.settings.trackingStart, '2026-10');

  const messy = {
    settings: { monthlyCap: 'RM 250.50', waitHours: 900, rollover: 1, trackingStart: '2026-08' },
    purchases: [
      {
        id: 'p1',
        name: 'Figure',
        price: 40,
        date: '2026-08-02',
        type: 'preorder',
        note: '  shelf  ',
        mood: 'happy',
        createdAt: '2026-08-02T00:00:00.000Z'
      },
      { name: 'Nope', price: 0, date: '2026-08-02', type: 'bought' }
    ],
    wishlist: [{ name: '  Grail  ', price: '80', priority: 'later' }]
  };
  const clean = normalizeData(messy, '2026-10');
  assert.equal(clean.settings.monthlyCap, 250.5);
  assert.equal(clean.settings.waitHours, 720);
  assert.equal(clean.settings.rollover, true);
  assert.equal(clean.purchases.length, 1);
  assert.equal(clean.purchases[0].mood, '');
  assert.equal(clean.purchases[0].note, 'shelf');
  assert.equal(clean.purchases[0].type, 'preorder');
  assert.equal(clean.wishlist[0].name, 'Grail');
  assert.equal(clean.wishlist[0].priority, 'really');

  save(clean, store);
  assert.equal(load('2026-10', store).data.purchases[0].price, 40);
  assert.equal(exportPayload(clean, '2026-10-23T00:00:00.000Z').version, 1);

  store.setItem(STORAGE_KEY, '{');
  const broken = load('2026-10', store);
  assert.equal(broken.corrupt, true);
  assert.equal(store.getItem(STORAGE_KEY), '{');
  assert.deepEqual(emptyData('2026-11').settings.waitHours, 0);
});
