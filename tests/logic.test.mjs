import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chartMonths,
  effectiveCap,
  fitFor,
  fitLabel,
  historyGroups,
  historyModel,
  homeModel,
  monthSnapshot,
  monthSpent,
  planModel,
  sortWishlist,
  wishlistModel,
  yearSpent
} from '../js/budget.js';
import { carousellSearchUrl, categoryTotals, filterPurchases, latestPriceCheck, rrpSearchUrl } from '../js/catalog.js';
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
    rollover: false,
    overspendPayback: true,
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

test('a pre-order deposit and balance count in the months they were paid', () => {
  const legacy = [
    buy('2026-10-03', 80, { type: 'bought' }),
    buy('2026-09-02', 150, { type: 'preorder' }),
    buy('2026-11-01', 40, { type: 'preorder' })
  ];
  const october = monthSnapshot(settings(), legacy, '2026-10');
  assert.equal(october.spent, 80);
  assert.equal(monthSnapshot(settings(), legacy, '2026-09').spent, 150);
  assert.equal(yearSpent(legacy, '2026'), 270);
  assert.equal(yearSpent(legacy, '2025'), 0);

  const split = {
    id: 'po',
    name: 'Rei',
    boughtAs: 'preorder',
    preorderStatus: 'fully paid',
    date: '2026-10-02',
    price: 170,
    depositDate: '2026-10-02',
    depositAmountRm: 50,
    balancePaidDate: '2026-11-04',
    balancePaidRm: 120
  };
  assert.equal(monthSpent([split], '2026-10'), 50);
  assert.equal(monthSpent([split], '2026-11'), 120);
  assert.equal(monthSpent([split], '2026-09'), 0);
  assert.equal(yearSpent([split], '2026'), 170);
});

test('rollover adds last month leftover', () => {
  const purchases = [
    buy('2026-08-01', 0.01),
    buy('2026-09-01', 100)
  ];
  const rolling = settings({ rollover: true, trackingStart: '2026-08' });
  assert.equal(effectiveCap(rolling, purchases, '2026-08'), 400);
  assert.equal(effectiveCap(rolling, purchases, '2026-09'), 799.99);
  assert.equal(effectiveCap(rolling, purchases, '2026-10'), 1099.99);

  const overspent = settings({ rollover: true, overspendPayback: false, trackingStart: '2026-09' });
  assert.equal(effectiveCap(overspent, [buy('2026-09-01', 500)], '2026-10'), 400);
  assert.equal(effectiveCap(settings({ rollover: false }), [], '2026-10'), 400);
});

test('overspend lowers only the next month', () => {
  const base = settings({ trackingStart: '2026-10' });
  const purchases = [buy('2026-10-01', 460)];
  const november = monthSnapshot(base, purchases, '2026-11');
  assert.equal(november.cap, 340);
  assert.equal(november.payback, 60);
  assert.equal(november.paybackMonth, '2026-10');
  assert.equal(effectiveCap(base, purchases, '2026-12'), 400);
  assert.equal(monthSnapshot(base, purchases, '2026-12').payback, 0);

  const history = historyModel(
    { settings: base, purchases, wishlist: [] },
    new Date('2026-11-15T04:00:00Z')
  );
  assert.equal(history.charts.find((row) => row.ym === '2026-11').cap, 340);
  const planned = wishlistModel({
    settings: base,
    purchases,
    wishlist: [{ id: 'w', name: 'Grail', price: 300, priority: 'must', addedAt: '2026-11-01T00:00:00.000Z' }]
  }, new Date('2026-11-15T04:00:00Z'));
  assert.equal(planned.month.cap, 340);
  assert.equal(planned.room, 340);
  assert.equal(planModel(planned.items, new Set(['w']), planned.room).remaining, 40);
});

test('payback off leaves the next cap unchanged', () => {
  const base = settings({ trackingStart: '2026-10', overspendPayback: false });
  const purchases = [buy('2026-10-01', 460)];
  const november = monthSnapshot(base, purchases, '2026-11');
  assert.equal(november.cap, 400);
  assert.equal(november.payback, 0);
  assert.equal(november.paybackMonth, '');
});

test('rollover and payback each use only the previous month', () => {
  const both = settings({ rollover: true, overspendPayback: true, trackingStart: '2026-09' });
  const purchases = [buy('2026-09-01', 100), buy('2026-10-01', 760)];
  assert.equal(effectiveCap(both, purchases, '2026-10'), 700);
  const november = monthSnapshot(both, purchases, '2026-11');
  assert.equal(november.cap, 340);
  assert.equal(november.payback, 60);
  assert.equal(november.rollover, 0);
  assert.equal(effectiveCap(both, purchases, '2026-12'), 740);
});

test('payback never drops the cap below zero', () => {
  const base = settings({ trackingStart: '2026-10' });
  const november = monthSnapshot(base, [buy('2026-10-01', 900)], '2026-11');
  assert.equal(november.cap, 0);
  assert.equal(november.payback, 400);
  assert.equal(november.paybackMonth, '2026-10');
  assert.equal(effectiveCap(base, [buy('2026-10-01', 900)], '2026-12'), 400);
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
  assert.equal(first.data.settings.overspendPayback, true);
  assert.equal(first.data.settings.waitHours, undefined);
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
  assert.equal(clean.settings.overspendPayback, true);
  assert.equal(clean.settings.waitHours, undefined);
  assert.equal(clean.settings.rollover, true);
  assert.equal(clean.purchases.length, 1);
  assert.equal(clean.purchases[0].mood, undefined);
  assert.equal(clean.purchases[0].notes, 'shelf');
  assert.equal(clean.purchases[0].boughtAs, 'preorder');
  assert.equal(clean.purchases[0].status, 'preordered');
  assert.equal(clean.purchases[0].currency, 'MYR');
  assert.equal(clean.purchases[0].originalAmount, 40);
  assert.equal(clean.purchases[0].price, 40);
  assert.equal(clean.purchases[0].preorderStatus, 'fully paid');
  assert.equal(clean.purchases[0].estFullPrice, 40);
  assert.equal(clean.purchases[0].depositAmountRm, 40);
  assert.equal(clean.purchases[0].balanceDueRm, 0);
  assert.equal(clean.purchases[0].finalTotalRm, 40);
  assert.equal(clean.purchases[0].fxRate, 1);
  assert.equal(clean.purchases[0].fxOverridden, false);
  assert.equal(clean.purchases[0].fxDate, '2026-08-02');
  assert.equal(clean.wishlist[0].name, 'Grail');
  assert.equal(clean.wishlist[0].priority, 'really');
  assert.equal(clean.wishlist[0].currency, 'MYR');
  assert.equal(clean.wishlist[0].price, 80);
  assert.deepEqual(clean.forSale, []);

  save(clean, store);
  assert.equal(load('2026-10', store).data.purchases[0].price, 40);
  assert.equal(exportPayload(clean, '2026-10-23T00:00:00.000Z').version, 3);
  const paybackOff = normalizeData({
    settings: { monthlyCap: 400, overspendPayback: false, trackingStart: '2026-10' },
    purchases: [],
    wishlist: []
  }, '2026-10');
  assert.equal(paybackOff.settings.overspendPayback, false);

  const legacyStore = memory();
  legacyStore.setItem(STORAGE_KEY, JSON.stringify({
    settings: { monthlyCap: 400, waitHours: 0, rollover: false, trackingStart: '2026-10' },
    purchases: [{
      id: 'old',
      name: 'Asuka',
      price: 80,
      date: '2026-10-02',
      type: 'bought',
      note: 'window',
      mood: 'excited',
      createdAt: '2026-10-02T00:00:00.000Z'
    }],
    wishlist: []
  }));
  const migrated = load('2026-10', legacyStore);
  assert.equal(migrated.data.purchases[0].notes, 'window');
  assert.equal(migrated.data.purchases[0].boughtAs, 'new');
  assert.equal(migrated.data.purchases[0].status, 'received');
  assert.equal(migrated.data.purchases[0].mood, undefined);
  assert.equal(migrated.data.purchases[0].price, 80);
  assert.equal(migrated.data.settings.overspendPayback, true);
  const rewritten = JSON.parse(legacyStore.getItem(STORAGE_KEY));
  assert.equal(rewritten.purchases[0].notes, 'window');
  assert.equal(rewritten.purchases[0].note, undefined);
  assert.ok(Array.isArray(rewritten.forSale));

  store.setItem(STORAGE_KEY, '{');
  const broken = load('2026-10', store);
  assert.equal(broken.corrupt, true);
  assert.equal(store.getItem(STORAGE_KEY), '{');
  assert.equal(emptyData('2026-11').settings.overspendPayback, true);
  assert.equal(emptyData('2026-11').settings.waitHours, undefined);
  assert.equal(emptyData('2026-11').settings.syncUrl, '');
  assert.deepEqual(emptyData('2026-11').forSale, []);
});

test('filters, category totals, and the latest price check', () => {
  const purchases = [
    { date: '2026-10-02', brand: 'Good Smile', series: 'Eva', figureType: 'nendoroid', price: 80 },
    { date: '2025-10-02', brand: 'Good Smile', series: 'Eva', figureType: 'scale', price: 400 },
    { date: '2026-11-02', brand: 'Bandai', series: 'Gundam', figureType: '', price: 30 }
  ];
  assert.equal(filterPurchases(purchases, { year: '2026', month: '10' }).length, 1);
  assert.equal(filterPurchases(purchases, { month: '10' }).length, 2);
  assert.equal(filterPurchases(purchases, { brand: 'Bandai', series: 'Gundam' }).length, 1);
  const totals = categoryTotals(filterPurchases(purchases, { year: '2026' }));
  assert.equal(totals.find((row) => row.figureType === 'nendoroid').total, 80);
  assert.equal(totals.find((row) => row.figureType === '').label, 'Other');

  const listing = { id: 's1', name: 'Asuka', condition: 'MISB' };
  const checks = [
    { for_sale_id: 's1', figure: 'Other', condition: 'Loose', low_rm: 10, checked_at: '2026-10-01' },
    { for_sale_id: 's1', figure: 'Other', condition: 'Loose', low_rm: 12, checked_at: '2026-10-20 09:00' },
    { for_sale_id: '', figure: 'Asuka', condition: 'MISB', low_rm: 99, checked_at: '2026-10-25' }
  ];
  assert.equal(latestPriceCheck(listing, checks).low_rm, 12);
  const byName = latestPriceCheck({ id: 's2', name: 'Rei', condition: 'Loose' }, [
    { for_sale_id: 'nope', figure: 'rei', condition: 'loose', typical_rm: 40, checked_at: '2026-10-01' },
    { figure: 'Rei', condition: 'Loose', typical_rm: 55, checked_at: '2026-10-02' }
  ]);
  assert.equal(byName.typical_rm, 55);
  assert.equal(latestPriceCheck({ id: 'x', name: 'Nope', condition: 'MIB' }, checks), null);
  assert.equal(latestPriceCheck(listing, []), null);
  assert.equal(
    carousellSearchUrl('Asuka Langley', 'MISB'),
    `https://www.carousell.com.my/search/${encodeURIComponent('Asuka Langley MISB')}`
  );
  assert.equal(rrpSearchUrl('Asuka Langley'), `https://www.google.com/search?q=${encodeURIComponent('Asuka Langley RRP')}`);
});
