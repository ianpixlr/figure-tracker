import assert from 'node:assert/strict';
import test from 'node:test';

import {
  balancesComing,
  chartMonths,
  effectiveCap,
  fitFor,
  fitLabel,
  historyGroups,
  historyModel,
  homeModel,
  monthSnapshot,
  monthSpent,
  yearBreakdown,
  planModel,
  sortWishlist,
  wishlistModel,
  yearSpent
} from '../js/budget.js';
import {
  carousellSearchUrl,
  categoryError,
  categoryTotals,
  cleanCategories,
  figureTypeLabel,
  filterPurchases,
  latestPriceCheck,
  normalizeFigureType,
  rrpSearchUrl
} from '../js/catalog.js';
import { formatRM, parseMoney, withAmounts } from '../js/money.js';
import {
  emptyData,
  exportPayload,
  forgetCategory,
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

test('spend totals count a deposit and a balance in the months they were paid', () => {
  const open = {
    id: 'asuka',
    name: 'Asuka',
    boughtAs: 'preorder',
    preorderStatus: 'deposit paid',
    figureType: '1-6',
    date: '2026-09-04',
    price: 1350,
    estFullPrice: 1350,
    depositDate: '2026-09-04',
    depositAmountRm: 475,
    balanceDueRm: 875
  };
  const paid = {
    id: 'rei',
    name: 'Rei',
    boughtAs: 'preorder',
    preorderStatus: 'fully paid',
    figureType: '1-12',
    date: '2026-09-12',
    price: 1000,
    estFullPrice: 1000,
    depositDate: '2026-09-12',
    depositAmountRm: 200,
    balancePaidDate: '2026-10-08',
    balancePaidRm: 800,
    finalTotalRm: 1000
  };
  const bought = {
    id: 'prize',
    name: 'Prize',
    boughtAs: 'purchased',
    figureType: 'other',
    date: '2026-10-02',
    price: 40
  };
  const purchases = [open, paid, bought];
  const base = settings({ monthlyCap: 2000, trackingStart: '2026-09' });
  const data = { settings: base, purchases, wishlist: [] };
  const when = new Date('2026-10-26T04:00:00Z');

  assert.equal(monthSpent(purchases, '2026-09'), 675);
  assert.equal(monthSpent(purchases, '2026-10'), 840);
  assert.equal(monthSpent(purchases, '2026-11'), 0);
  assert.equal(yearSpent(purchases, '2026'), 1515);

  const history = historyModel(data, when);
  for (const row of history.charts) {
    assert.equal(row.spent, monthSpent(purchases, row.ym));
  }
  assert.equal(history.groups.find((group) => group.ym === '2026-09').spent, 675);
  assert.equal(history.groups.find((group) => group.ym === '2026-10').spent, 840);

  const september = monthSnapshot(base, purchases, '2026-09');
  assert.equal(september.spent, 675);
  assert.equal(september.room, 1325);
  const home = homeModel(data, when);
  assert.equal(home.month.spent, 840);
  assert.equal(home.ytd, 1515);
  assert.deepEqual(home.balances, { count: 1, total: 875 });
  assert.deepEqual(home.breakdown.types, [
    { figureType: '1-12', total: 1000 },
    { figureType: '1-6', total: 475 }
  ]);
  assert.equal(home.breakdown.count, 3);

  const nextYear = {
    ...paid,
    balancePaidDate: '2027-01-04'
  };
  assert.equal(yearSpent([open, nextYear, bought], '2026'), 715);
  assert.equal(yearSpent([open, nextYear, bought], '2027'), 800);
  assert.deepEqual(yearBreakdown([open, nextYear], '2026').types, [
    { figureType: '1-6', total: 475 },
    { figureType: '1-12', total: 200 }
  ]);
  assert.equal(yearBreakdown([open, nextYear], '2027').types[0].total, 800);
  assert.equal(yearBreakdown([nextYear], '2027').count, 1);

  const allTypes = categoryTotals(purchases);
  assert.equal(allTypes.find((row) => row.figureType === '1-6').total, 475);
  assert.equal(allTypes.find((row) => row.figureType === '1-12').total, 1000);
  assert.equal(allTypes.find((row) => row.figureType === 'other').total, 40);

  const septemberTypes = categoryTotals(
    filterPurchases(purchases, { year: '2026', month: '09' }),
    { year: '2026', month: '09' }
  );
  assert.equal(septemberTypes.find((row) => row.figureType === '1-12').total, 200);
  assert.equal(septemberTypes.find((row) => row.figureType === '1-6').total, 475);
  assert.equal(septemberTypes.find((row) => row.figureType === 'other'), undefined);

  const octoberTypes = categoryTotals(
    filterPurchases(purchases, { year: '2026', month: '10' }),
    { year: '2026', month: '10' }
  );
  assert.equal(octoberTypes.length, 1);
  assert.equal(octoberTypes[0].total, 40);
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

test('history groups months and the chart lists every month', () => {
  const purchases = [buy('2026-09-02', 150), buy('2026-10-03', 80), buy('2026-10-01', 20)];
  const groups = historyGroups(settings(), purchases);
  assert.deepEqual(groups.map((group) => group.ym), ['2026-10', '2026-09']);
  assert.equal(groups[0].spent, 100);
  assert.deepEqual(groups[0].purchases.map((item) => item.price), [80, 20]);
  const chart = chartMonths(settings({ trackingStart: '2025-01' }), purchases, '2026-10');
  assert.equal(chart.months[0], '2025-01');
  assert.equal(chart.months.length, 22);
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
  assert.equal(clean.purchases[0].status, 'received');
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
  assert.equal(migrated.data.purchases[0].boughtAs, 'purchased');
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
  assert.deepEqual(emptyData('2026-11').settings.categories, []);
  assert.deepEqual(emptyData('2026-11').forSale, []);
});

test('order type migrates and status follows payment', () => {
  const clean = normalizeData({
    settings: { monthlyCap: 400, trackingStart: '2026-10' },
    purchases: [
      { id: 'n', name: 'New', price: 10, date: '2026-10-01', boughtAs: 'new', status: 'preordered' },
      { id: 's', name: 'Used', price: 12, date: '2026-10-02', boughtAs: 'second-hand', status: 'received' },
      { id: 'b', name: 'Bought', price: 15, date: '2026-10-03', boughtAs: 'purchased', status: 'preordered' },
      {
        id: 'o',
        name: 'Open',
        date: '2026-10-04',
        boughtAs: 'preorder',
        status: 'received',
        estFullPrice: 200,
        estFullCurrency: 'MYR',
        depositAmountRm: 50,
        depositCurrency: 'MYR',
        depositDate: '2026-10-04'
      }
    ],
    wishlist: []
  }, '2026-10');
  const byId = Object.fromEntries(clean.purchases.map((item) => [item.id, item]));
  assert.equal(byId.n.boughtAs, 'purchased');
  assert.equal(byId.n.status, 'received');
  assert.equal(byId.s.boughtAs, 'purchased');
  assert.equal(byId.s.status, 'received');
  assert.equal(byId.b.boughtAs, 'purchased');
  assert.equal(byId.b.status, 'received');
  assert.equal(byId.o.boughtAs, 'preorder');
  assert.equal(byId.o.status, 'preordered');
  assert.equal(byId.o.preorderStatus, 'deposit paid');
  assert.equal(byId.o.balanceDueRm, 150);
  assert.deepEqual(balancesComing([byId.o, byId.n, { preorderStatus: 'fully paid', balanceDueRm: 0 }]), {
    count: 1,
    total: 150
  });
  assert.deepEqual(balancesComing([{ preorderStatus: 'deposit paid', balanceDueRm: 0 }]), { count: 0, total: 0 });
});

test('money amounts stay together and break only at the dot separator', () => {
  assert.equal(
    withAmounts('Deposit RM 50.00 · Balance due RM 150.00'),
    '<span class="amt">Deposit RM 50.00</span> · <span class="amt">Balance due RM 150.00</span>'
  );
  assert.equal(
    withAmounts('cap RM 450 · RM 50 rolled over'),
    '<span class="amt">cap RM 450</span> · <span class="amt">RM 50</span> rolled over'
  );
  assert.equal(
    withAmounts('Market RM 40 / 55 / 80 · RRP RM 90'),
    '<span class="amt">Market RM 40 / 55 / 80</span> · <span class="amt">RRP RM 90</span>'
  );
  assert.equal(withAmounts('a < b · -RM 12.50 over'), 'a &lt; b · <span class="amt">-RM 12.50</span> over');
  assert.equal(withAmounts('left this month'), 'left this month');
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
  assert.equal(totals.find((row) => row.figureType === '').label, 'Not set');
  assert.equal(filterPurchases(purchases, { type: 'nendoroid' }).length, 1);
  assert.equal(filterPurchases(purchases, { type: 'scale' }).length, 1);

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

test('figure types migrate once and custom categories persist', () => {
  const input = {
    settings: {
      monthlyCap: 400,
      trackingStart: '2026-10',
      categories: [' Movie ', 'movie', 'Transformers', 'Way too long category name', 'Anniversary', 'nendoroid', '']
    },
    purchases: [
      { id: 'f', name: 'Figma', price: 10, date: '2026-10-01', figureType: 'figma' },
      { id: 'm', name: 'Kit', price: 10, date: '2026-10-01', figureType: 'model-kit' },
      { id: 's', name: 'Scale', price: 10, date: '2026-10-01', figureType: 'scale' },
      { id: 'n', name: 'Nendo', price: 10, date: '2026-10-01', type: 'nendoroid' },
      { id: 'p', name: 'Prize', price: 10, date: '2026-10-01', figureType: 'prize' },
      { id: 'o', name: 'Other', price: 10, date: '2026-10-01', figureType: 'other' },
      { id: 'u', name: 'Unknown', price: 10, date: '2026-10-01', figureType: 'unknown' },
      { id: 'q', name: 'Q', price: 10, date: '2026-10-01', figureType: '???' },
      { id: 'e', name: 'Empty', price: 10, date: '2026-10-01', figureType: '' },
      { id: 't', name: 'TF', price: 10, date: '2026-10-01', figureType: 'transformers' },
      { id: 'label', name: 'Label', price: 10, date: '2026-10-01', figureType: '1/12' },
      { id: 'word', name: 'Word', price: 10, date: '2026-10-01', figureType: 'Transformers' },
      { id: 'kit-label', name: 'Kit label', price: 10, date: '2026-10-01', figureType: 'Model kit' },
      { id: 'custom', name: 'Custom', price: 10, date: '2026-10-01', figureType: 'movie' },
      { id: 'kept', name: 'Kept', price: 10, date: '2026-10-01', figureType: 'Anniversary' },
      { id: 'stray', name: 'Stray', price: 10, date: '2026-10-01', figureType: 'Grail' },
      {
        id: 'order',
        name: 'Order',
        date: '2026-10-04',
        type: 'preorder',
        boughtAs: 'preorder',
        estFullPrice: 200,
        estFullCurrency: 'MYR',
        depositAmountRm: 50,
        depositCurrency: 'MYR',
        depositDate: '2026-10-04'
      },
      { id: 'bought', name: 'Bought', price: 10, date: '2026-10-01', type: 'bought' }
    ],
    wishlist: [
      { id: 'w1', name: 'Wish', price: 10, figureType: 'figma' },
      { id: 'w2', name: 'Plain', price: 12 }
    ],
    forSale: [
      { id: 'sale', name: 'Sale', price: 10, condition: 'MISB', figureType: 'nendoroid' }
    ]
  };
  const once = normalizeData(input, '2026-10');
  const twice = normalizeData(JSON.parse(JSON.stringify(once)), '2026-10');
  const typeShape = (data) => ({
    categories: data.settings.categories,
    purchases: data.purchases.map((item) => [item.id, item.figureType, item.boughtAs]),
    wishlist: data.wishlist.map((item) => [item.id, Object.hasOwn(item, 'figureType') ? item.figureType : null]),
    forSale: data.forSale.map((item) => [item.id, item.figureType])
  });
  assert.deepEqual(typeShape(twice), typeShape(once));
  assert.deepEqual(once.settings.categories, ['Movie', 'Anniversary']);
  const byId = Object.fromEntries(once.purchases.map((item) => [item.id, item]));
  assert.equal(byId.f.figureType, '1-12');
  assert.equal(byId.m.figureType, 'model-kit');
  assert.equal(byId.s.figureType, 'other');
  assert.equal(byId.n.figureType, 'other');
  assert.equal(byId.p.figureType, 'other');
  assert.equal(byId.o.figureType, 'other');
  assert.equal(byId.u.figureType, 'other');
  assert.equal(byId.q.figureType, 'other');
  assert.equal(byId.e.figureType, '');
  assert.equal(byId.t.figureType, 'transformers');
  assert.equal(byId.label.figureType, '1-12');
  assert.equal(byId.word.figureType, 'transformers');
  assert.equal(byId['kit-label'].figureType, 'model-kit');
  assert.equal(byId.custom.figureType, 'Movie');
  assert.equal(byId.kept.figureType, 'Anniversary');
  assert.equal(byId.stray.figureType, 'other');
  assert.equal(byId.order.figureType, '');
  assert.equal(byId.order.boughtAs, 'preorder');
  assert.equal(byId.bought.figureType, '');
  assert.equal(byId.bought.boughtAs, 'purchased');
  assert.equal(once.wishlist.find((item) => item.id === 'w1').figureType, '1-12');
  assert.equal(Object.hasOwn(once.wishlist.find((item) => item.id === 'w2'), 'figureType'), false);
  assert.equal(once.forSale[0].figureType, 'other');
  assert.equal(figureTypeLabel(''), 'Not set');
  assert.equal(figureTypeLabel('1-12'), '1/12');
  assert.equal(figureTypeLabel('1-6'), '1/6');
  assert.equal(figureTypeLabel('model-kit'), 'Model Kit');
  assert.equal(figureTypeLabel('Movie'), 'Movie');
  assert.equal(normalizeFigureType('transformers', []), 'transformers');
  assert.equal(categoryError('', []), 'Enter a category name.');
  assert.equal(categoryError('   ', []), 'Enter a category name.');
  assert.equal(categoryError('x'.repeat(21), []), 'Use 20 characters or fewer.');
  assert.equal(categoryError('x'.repeat(20), []), '');
  assert.equal(categoryError('Transformers', []), 'That category already exists.');
  assert.equal(categoryError('transformers', []), 'That category already exists.');
  assert.equal(categoryError('1/12', []), 'That category already exists.');
  assert.equal(categoryError('1-12', []), 'That category already exists.');
  assert.equal(categoryError('Not set', []), 'That category already exists.');
  assert.equal(categoryError('not-set', []), 'That category already exists.');
  assert.equal(categoryError('Model Kit', []), 'That category already exists.');
  assert.equal(categoryError('nendoroid', []), 'That category already exists.');
  assert.equal(categoryError(' movie ', ['Movie']), 'That category already exists.');
  assert.equal(categoryError('Movie', []), '');
  assert.deepEqual(cleanCategories([' Movie ', 'movie', 'Transformers', 'Too long for a chip name', '']), ['Movie']);

  const data = {
    settings: { categories: ['Movie', 'Anniversary'] },
    purchases: [
      { id: 'a', figureType: 'Movie' },
      { id: 'b', figureType: 'Anniversary' }
    ],
    wishlist: [{ id: 'w', figureType: 'movie' }],
    forSale: [{ id: 's', figureType: 'Movie' }]
  };
  const changed = forgetCategory(data, 'Movie');
  assert.deepEqual(data.settings.categories, ['Anniversary']);
  assert.equal(data.purchases[0].figureType, 'other');
  assert.equal(data.purchases[1].figureType, 'Anniversary');
  assert.equal(data.wishlist[0].figureType, 'other');
  assert.equal(data.forSale[0].figureType, 'other');
  assert.deepEqual(changed.map((item) => item.id), ['a']);

  const store = memory();
  save(once, store);
  const loaded = load('2026-10', store);
  assert.deepEqual(loaded.data.settings.categories, ['Movie', 'Anniversary']);
  assert.equal(loaded.data.purchases.find((item) => item.id === 'custom').figureType, 'Movie');
  const again = load('2026-10', store);
  assert.deepEqual(again.data, loaded.data);
  assert.deepEqual(typeShape(again.data), typeShape(once));
  const exported = exportPayload(loaded.data, '2026-10-26T00:00:00.000Z');
  assert.deepEqual(exported.settings.categories, ['Movie', 'Anniversary']);
  const imported = normalizeData(exported, '2026-10');
  assert.equal(imported.purchases.find((item) => item.id === 'custom').figureType, 'Movie');
  assert.equal(filterPurchases(imported.purchases, { type: 'Movie' }).map((item) => item.id).join(','), 'custom');
});
