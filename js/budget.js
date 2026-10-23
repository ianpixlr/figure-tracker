// Monthly cap, rollover, wishlist fit, and the 30-day pace card.
// Dates are Malaysia calendar days from time.js. Money is cents from money.js.

import { formatRM, fromCents, toCents } from './money.js';
import { addMonths, daysBetween, isMonth, isYMD, monthsFrom, todayYMD } from './time.js';

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

export function monthSpent(purchases, ym) {
  const cents = purchases.reduce((sum, purchase) => {
    if (!isYMD(purchase.date) || purchase.date.slice(0, 7) !== ym) return sum;
    return sum + (toCents(purchase.price) ?? 0);
  }, 0);
  return fromCents(cents);
}

export function yearSpent(purchases, year) {
  const cents = purchases.reduce((sum, purchase) => {
    if (!isYMD(purchase.date) || purchase.date.slice(0, 4) !== year) return sum;
    return sum + (toCents(purchase.price) ?? 0);
  }, 0);
  return fromCents(cents);
}

// Earliest of the saved start month and any logged purchase. Used so a
// backdated purchase can roll into the next month, and deleting it removes
// that month from the chain again.
export function budgetStart(settings, purchases) {
  let start = isMonth(settings?.trackingStart) ? settings.trackingStart : null;
  for (const purchase of purchases) {
    if (!isYMD(purchase.date)) continue;
    const ym = purchase.date.slice(0, 7);
    if (!start || ym < start) start = ym;
  }
  return start;
}

export function effectiveCap(settings, purchases, ym) {
  const base = toCents(settings.monthlyCap) ?? 0;
  if (!settings.rollover) return fromCents(base);
  const start = budgetStart(settings, purchases);
  if (!start || ym <= start) return fromCents(base);

  let cap = base;
  let cursor = start;
  let guard = 0;
  while (cursor < ym && guard < 240) {
    const spent = toCents(monthSpent(purchases, cursor)) ?? 0;
    const leftover = Math.max(0, cap - spent);
    cursor = addMonths(cursor, 1);
    cap = base + leftover;
    guard += 1;
  }
  return fromCents(cap);
}

export function monthSnapshot(settings, purchases, ym) {
  const cap = toCents(effectiveCap(settings, purchases, ym)) ?? 0;
  const spent = toCents(monthSpent(purchases, ym)) ?? 0;
  const left = cap - spent;
  const base = toCents(settings.monthlyCap) ?? 0;
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
    rollover: cap > base ? fromCents(cap - base) : 0
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
    pace: paceInsight(data.purchases, today, data.settings.monthlyCap)
  };
}

function roundSuggestedCap(average) {
  const cents = toCents(average) ?? 0;
  const step = 1000;
  const rounded = Math.max(step, Math.round(cents / step) * step);
  return fromCents(rounded);
}

function suggestionFor(average, cap) {
  const avgText = formatRM(average);
  const capText = formatRM(cap);
  const avgCents = toCents(average) ?? 0;
  const capCents = toCents(cap) ?? 0;
  if (capCents <= 0) {
    return `Your monthly average is ${avgText}. Set a cap in Settings when you want a limit.`;
  }
  if (avgCents > capCents) {
    const suggested = formatRM(roundSuggestedCap(average));
    return `Your monthly average is ${avgText}, above the ${capText} cap. You could set the cap to ${suggested} to match it, or leave ${capText} in place so the limit keeps slowing new buys.`;
  }
  if (avgCents * 5 < capCents * 4) {
    const suggested = formatRM(roundSuggestedCap(average));
    return `Your monthly average is ${avgText}, below the ${capText} cap. You could lower the cap to ${suggested} if you want it closer to what you spend, or keep ${capText} if the extra room is useful.`;
  }
  return `Your monthly average is ${avgText}, close to the ${capText} cap. No change needed.`;
}

// Shows once the first logged purchase is at least 30 Malaysia days ago.
// The average is total spent since that day, scaled to a 30-day month.
export function paceInsight(purchases, todayYmd, cap) {
  const past = purchases.filter((purchase) => isYMD(purchase.date) && purchase.date <= todayYmd);
  if (!past.length) return null;
  const first = past.map((purchase) => purchase.date).sort()[0];
  const days = daysBetween(first, todayYmd);
  if (days < 30) return null;
  const totalCents = past.reduce((sum, purchase) => sum + (toCents(purchase.price) ?? 0), 0);
  const average = fromCents(Math.round((totalCents * 30) / days));
  return {
    first,
    days,
    total: fromCents(totalCents),
    average,
    suggestion: suggestionFor(average, cap)
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

export function waitStatus(addedAt, waitHours, at) {
  const hours = Number(waitHours);
  if (!Number.isFinite(hours) || hours <= 0) {
    return { enabled: false, ready: true, text: '' };
  }
  const start = Date.parse(addedAt);
  if (Number.isNaN(start)) return { enabled: true, ready: true, text: 'Ready to buy' };
  const remaining = start + hours * 60 * 60 * 1000 - at.getTime();
  if (remaining <= 0) return { enabled: true, ready: true, text: 'Ready to buy' };
  return { enabled: true, ready: false, text: `Ready in ${formatRemain(remaining)}` };
}

function formatRemain(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

export function wishlistModel(data, date) {
  const home = homeModel(data, date);
  const items = sortWishlist(data.wishlist).map((item) => ({
    ...item,
    priorityLabel: priorityLabel(item.priority),
    fitLabel: fitLabel(item.price, home.month.room),
    fit: fitFor(item.price, home.month.room),
    wait: waitStatus(item.addedAt, data.settings.waitHours, date)
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
