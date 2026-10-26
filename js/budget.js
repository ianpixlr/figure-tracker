// Monthly cap, rollover, and wishlist fit.
// Dates are Malaysia calendar days from time.js. Money is cents from money.js.
// A pre-order counts its deposit in the deposit month and its balance in the month that balance was paid.

import { formatRM, fromCents, toCents } from './money.js';
import { addMonths, isMonth, isYMD, monthsFrom, todayYMD } from './time.js';

export const CAP_USED_MESSAGE = 'Month done, next purchase waits for the 1st';

export const PRIORITY_OPTIONS = [
  { value: 'must', label: 'Must have' },
  { value: 'really', label: 'Really want' },
  { value: 'nice', label: 'Nice to have' }
];

const PRIORITY_RANK = { must: 0, really: 1, nice: 2 };

export function priorityLabel(priority) {
  return PRIORITY_OPTIONS.find((item) => item.value === priority)?.label || 'Really want';
}

export function capPayments(purchase) {
  const preorder = purchase?.boughtAs === 'preorder' || purchase?.type === 'preorder';
  if (preorder && (purchase.depositAmountRm != null || purchase.preorderStatus)) {
    const payments = [];
    if (Number(purchase.depositAmountRm) > 0 && isYMD(purchase.depositDate)) {
      payments.push({ date: purchase.depositDate, amount: Number(purchase.depositAmountRm) });
    }
    if (Number(purchase.balancePaidRm) > 0 && isYMD(purchase.balancePaidDate)) {
      payments.push({ date: purchase.balancePaidDate, amount: Number(purchase.balancePaidRm) });
    }
    return payments;
  }
  if (!purchase || !isYMD(purchase.date) || !Number.isFinite(Number(purchase.price))) return [];
  return [{ date: purchase.date, amount: Number(purchase.price) }];
}

function spentCents(purchases, match) {
  let cents = 0;
  for (const purchase of purchases) {
    for (const payment of capPayments(purchase)) {
      if (match(payment.date)) cents += toCents(payment.amount) ?? 0;
    }
  }
  return cents;
}

export function monthSpent(purchases, ym) {
  return fromCents(spentCents(purchases, (date) => isYMD(date) && date.slice(0, 7) === ym));
}

export function yearSpent(purchases, year) {
  return fromCents(spentCents(purchases, (date) => isYMD(date) && date.slice(0, 4) === year));
}

export function balancesComing(purchases) {
  const open = purchases.filter((purchase) => purchase.preorderStatus === 'deposit paid');
  const cents = open.reduce((sum, purchase) => sum + (toCents(purchase.balanceDueRm) ?? 0), 0);
  return { count: open.length, total: fromCents(cents) };
}

export function yearBreakdown(purchases, year) {
  const types = new Map();
  const figures = new Set();
  for (const purchase of purchases) {
    let counted = false;
    for (const payment of capPayments(purchase)) {
      if (!isYMD(payment.date) || payment.date.slice(0, 4) !== year) continue;
      const key = purchase.figureType || '';
      const row = types.get(key) || { figureType: key, cents: 0 };
      row.cents += toCents(payment.amount) ?? 0;
      types.set(key, row);
      counted = true;
    }
    if (counted) figures.add(purchase.id || purchase.name);
  }
  return {
    types: [...types.values()]
      .sort((a, b) => b.cents - a.cents)
      .slice(0, 2)
      .map((row) => ({ figureType: row.figureType, total: fromCents(row.cents) })),
    count: figures.size
  };
}

// Earliest of the saved start month and any logged purchase. Used so a
// backdated purchase can roll into the next month, and deleting it removes
// that month from the chain again.
export function budgetStart(settings, purchases) {
  let start = isMonth(settings?.trackingStart) ? settings.trackingStart : null;
  for (const purchase of purchases) {
    for (const payment of capPayments(purchase)) {
      const ym = payment.date.slice(0, 7);
      if (!start || ym < start) start = ym;
    }
  }
  return start;
}

// Each month starts from the base cap. Only the previous month's net result
// carries: unused money if rollover is on, overspend if payback is on.
// The two cannot both apply to the same previous month. The cap never goes below 0.
export function capAdjustment(settings, purchases, ym) {
  const base = Math.max(0, toCents(settings?.monthlyCap) ?? 0);
  const rolloverOn = Boolean(settings?.rollover);
  const paybackOn = settings?.overspendPayback !== false;
  const plain = { cap: fromCents(base), rollover: 0, payback: 0, paybackMonth: '' };
  if ((!rolloverOn && !paybackOn) || !isMonth(ym)) return plain;
  const start = budgetStart(settings, purchases);
  if (!start || ym <= start) return plain;

  let cap = base;
  let cursor = start;
  let guard = 0;
  let rollover = 0;
  let payback = 0;
  let paybackMonth = '';
  while (cursor < ym && guard < 240) {
    const spent = toCents(monthSpent(purchases, cursor)) ?? 0;
    const delta = cap - spent;
    const source = cursor;
    cursor = addMonths(cursor, 1);
    rollover = 0;
    payback = 0;
    paybackMonth = '';
    if (delta > 0 && rolloverOn) {
      cap = base + delta;
      rollover = delta;
    } else if (delta < 0 && paybackOn) {
      const reduced = Math.max(0, base + delta);
      payback = base - reduced;
      paybackMonth = payback > 0 ? source : '';
      cap = reduced;
    } else {
      cap = base;
    }
    guard += 1;
  }
  return {
    cap: fromCents(cap),
    rollover: fromCents(rollover),
    payback: fromCents(payback),
    paybackMonth
  };
}

export function effectiveCap(settings, purchases, ym) {
  return capAdjustment(settings, purchases, ym).cap;
}

export function monthSnapshot(settings, purchases, ym) {
  const adjustment = capAdjustment(settings, purchases, ym);
  const cap = toCents(adjustment.cap) ?? 0;
  const spent = toCents(monthSpent(purchases, ym)) ?? 0;
  const left = cap - spent;
  let state = 'ok';
  if (spent > cap) state = 'over';
  else if (cap > 0 && spent * 4 > cap * 3) state = 'warn';

  return {
    ym,
    cap: fromCents(cap),
    spent: fromCents(spent),
    left: fromCents(left),
    room: fromCents(Math.max(0, left)),
    over: left < 0 ? fromCents(-left) : 0,
    state,
    usedUp: left <= 0 && (cap > 0 || spent > 0),
    rollover: adjustment.rollover,
    payback: adjustment.payback,
    paybackMonth: adjustment.paybackMonth
  };
}

export function stateLabel(state) {
  if (state === 'over') return 'Over the cap';
  if (state === 'warn') return 'Past 75% of the cap';
  return 'On track';
}

export function percentLabel(snapshot) {
  const cap = toCents(snapshot.cap) ?? 0;
  const spent = toCents(snapshot.spent) ?? 0;
  if (cap <= 0) return spent > 0 ? 'Over' : '0%';
  return `${Math.round((spent / cap) * 100)}%`;
}

export function statusLine(snapshot) {
  const label = stateLabel(snapshot.state);
  const percent = percentLabel(snapshot);
  if (percent === 'Over') return label;
  return `${percent} · ${label}`;
}

export function barWidth(snapshot) {
  const cap = toCents(snapshot.cap) ?? 0;
  const spent = toCents(snapshot.spent) ?? 0;
  if (cap <= 0) return spent > 0 ? 100 : 0;
  return Math.min(100, (spent / cap) * 100);
}

export function homeModel(data, date) {
  const today = todayYMD(date);
  const ym = today.slice(0, 7);
  const year = today.slice(0, 4);
  return {
    today,
    ym,
    year,
    month: monthSnapshot(data.settings, data.purchases, ym),
    ytd: yearSpent(data.purchases, year),
    balances: balancesComing(data.purchases),
    breakdown: yearBreakdown(data.purchases, year)
  };
}

export function sortWishlist(items) {
  return items.slice().sort((a, b) => {
    const rank = (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
    if (rank !== 0) return rank;
    return String(a.addedAt).localeCompare(String(b.addedAt));
  });
}

// `left` may be negative when the month is already over the cap.
// Fit uses the room still available (never below zero).
export function fitFor(price, left) {
  const priceCents = toCents(price) ?? 0;
  const roomCents = Math.max(0, toCents(left) ?? 0);
  const shortCents = priceCents - roomCents;
  return {
    fits: shortCents <= 0,
    percent: roomCents > 0 ? Math.round((priceCents / roomCents) * 100) : null,
    short: shortCents > 0 ? fromCents(shortCents) : 0
  };
}

export function fitLabel(price, left) {
  const fit = fitFor(price, left);
  if (fit.fits) return `Fits this month · ${fit.percent ?? 0}% of what's left`;
  const shortText = `Wait for next month (${formatRM(fit.short)} short)`;
  if (fit.percent == null) return shortText;
  return `${fit.percent}% of what's left · ${shortText}`;
}

export function wishlistModel(data, date) {
  const home = homeModel(data, date);
  const items = sortWishlist(data.wishlist).map((item) => ({
    ...item,
    priorityLabel: priorityLabel(item.priority),
    fitLabel: fitLabel(item.price, home.month.room),
    fit: fitFor(item.price, home.month.room)
  }));
  const totalCents = data.wishlist.reduce((sum, item) => sum + (toCents(item.price) ?? 0), 0);
  return {
    items,
    total: fromCents(totalCents),
    count: data.wishlist.length,
    room: home.month.room,
    over: home.month.over,
    month: home.month
  };
}

export function planModel(items, selectedIds, left) {
  const picked = items.filter((item) => selectedIds.has(item.id));
  const totalCents = picked.reduce((sum, item) => sum + (toCents(item.price) ?? 0), 0);
  const roomCents = Math.max(0, toCents(left) ?? 0);
  const delta = totalCents - roomCents;
  return {
    count: picked.length,
    total: fromCents(totalCents),
    fits: delta <= 0,
    over: delta > 0 ? fromCents(delta) : 0,
    remaining: delta <= 0 ? fromCents(roomCents - totalCents) : 0
  };
}

export function chartMonths(settings, purchases, todayYm) {
  let begin = budgetStart(settings, purchases) || todayYm;
  if (begin > todayYm) begin = todayYm;
  const months = monthsFrom(begin, todayYm);
  const truncated = months.length > 8;
  return {
    months: truncated ? months.slice(-8) : months,
    truncated
  };
}

export function historyGroups(settings, purchases) {
  const map = new Map();
  for (const purchase of purchases) {
    if (!isYMD(purchase.date)) continue;
    const ym = purchase.date.slice(0, 7);
    if (!map.has(ym)) map.set(ym, []);
    map.get(ym).push(purchase);
  }
  return [...map.keys()]
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((ym) => {
      const items = map.get(ym).slice().sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return String(b.createdAt).localeCompare(String(a.createdAt));
      });
      return { ...monthSnapshot(settings, purchases, ym), purchases: items };
    });
}

export function historyModel(data, date) {
  const todayYm = todayYMD(date).slice(0, 7);
  const chart = chartMonths(data.settings, data.purchases, todayYm);
  return {
    truncated: chart.truncated,
    charts: chart.months.map((ym) => monthSnapshot(data.settings, data.purchases, ym)),
    groups: historyGroups(data.settings, data.purchases)
  };
}
