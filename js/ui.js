// Screens, forms, and the small dialogs. Calculations live in budget.js.

import {
  CAP_USED_MESSAGE,
  PRIORITY_OPTIONS,
  barWidth,
  fitFor,
  historyModel,
  homeModel,
  planModel,
  statusLine,
  waitStatus,
  wishlistModel
} from './budget.js';
import { formatRM, parseMoney } from './money.js';
import {
  MAX_MONEY,
  MAX_WAIT_HOURS,
  MOODS,
  PURCHASE_TYPES,
  clear,
  exportPayload,
  load,
  looksLikeData,
  moodLabel,
  normalizeData,
  save,
  typeLabel,
  uid
} from './store.js';
import {
  currentMonth,
  formatDay,
  formatFullDay,
  formatMonth,
  formatMonthShort,
  formatToday,
  isYMD,
  now,
  todayYMD
} from './time.js';

const planIds = new Set();
let undoItem = null;
let toastTimer = 0;
let pendingToastAction = null;
let pendingImport = null;
let lastRouteKey = '';

export function start() {
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  window.addEventListener('hashchange', () => render());
  const dialog = document.getElementById('dialog');
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog();
  });
  if (!location.hash) location.hash = '#home';
  render();
}

export function render() {
  const route = parseRoute();
  const routeKey = `${route.name}:${route.id || ''}`;
  const routeChanged = routeKey !== lastRouteKey;
  lastRouteKey = routeKey;

  const today = todayYMD();
  document.getElementById('today-line').textContent = formatToday(now());
  setNav(route.name);

  const main = document.getElementById('main');
  const loaded = load(currentMonth());
  if (loaded.corrupt && route.name !== 'settings') {
    main.innerHTML = corruptView();
  } else if (loaded.corrupt) {
    main.innerHTML = settingsView(loaded.data, true);
  } else {
    main.innerHTML = viewFor(route, loaded.data, today);
  }

  if (routeChanged) {
    const heading = main.querySelector('h2');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  }
}

function parseRoute() {
  const hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('edit/')) {
    return { name: 'edit', id: decodeURIComponent(hash.slice(5)) };
  }
  if (['home', 'log', 'wish', 'plan', 'history', 'settings'].includes(hash)) {
    return { name: hash, id: null };
  }
  return { name: 'home', id: null };
}

function setNav(name) {
  const current = name === 'plan' ? 'wish'
    : name === 'edit' ? 'history'
      : name === 'log' ? 'home'
        : name;
  document.querySelectorAll('.nav a').forEach((link) => {
    const on = link.dataset.route === current;
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function viewFor(route, data, today) {
  if (route.name === 'log') return purchaseFormView(null, today);
  if (route.name === 'edit') return editView(data, route.id, today);
  if (route.name === 'wish' || route.name === 'plan') return wishView(data, route.name);
  if (route.name === 'history') return historyView(data);
  if (route.name === 'settings') return settingsView(data, false);
  return homeView(data);
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function currentData() {
  return load(currentMonth());
}

function persist(data) {
  try {
    save(data);
    return true;
  } catch {
    showToast('Could not save on this device.');
    return false;
  }
}

function homeView(data) {
  const model = homeModel(data, now());
  const month = model.month;
  const capLine = data.settings.rollover && month.rollover > 0
    ? `Cap ${formatRM(month.cap)} · ${formatRM(data.settings.monthlyCap)} plus ${formatRM(month.rollover)} rolled over`
    : `Cap ${formatRM(month.cap)}`;
  const pace = model.pace
    ? `<section class="card" id="pace-card">
        <h2>Your pace</h2>
        <p class="meta">${model.pace.days} days since ${esc(formatFullDay(model.pace.first))}</p>
        <p class="stat-label">Monthly average</p>
        <p class="stat-value">${formatRM(model.pace.average)}</p>
        <p>${esc(model.pace.suggestion)}</p>
      </section>`
    : '';

  return `
    <section class="home" data-state="${month.state}">
      <h2 id="month-title">${esc(formatMonth(model.ym))}</h2>
      <div class="stats">
        <div>
          <p class="stat-label">Spent</p>
          <p class="stat-value" id="spent-value">${formatRM(month.spent)}</p>
        </div>
        <div>
          <p class="stat-label">Left</p>
          <p class="stat-value" id="left-value">${formatRM(month.room)}</p>
          ${month.over > 0 ? `<p class="stat-note">${formatRM(month.over)} over</p>` : ''}
        </div>
      </div>
      <p class="cap-line" id="cap-line">${esc(capLine)}</p>
      <div class="bar" data-state="${month.state}" role="progressbar"
        aria-valuemin="0" aria-valuemax="${Math.max(month.cap, month.spent, 0)}"
        aria-valuenow="${month.spent}" aria-label="Spent this month">
        <div class="bar-fill" style="width:${barWidth(month).toFixed(2)}%"></div>
      </div>
      <p class="status" id="cap-status" data-state="${month.state}">${esc(statusLine(month))}</p>
      ${month.usedUp ? `<p class="banner" id="cap-message">${esc(CAP_USED_MESSAGE)}</p>` : ''}
      <a class="btn btn-primary" id="log-link" href="#log">Log a purchase</a>
      <section class="card">
        <h2>Year to date</h2>
        <p class="meta">${esc(model.year)}</p>
        <p class="stat-value" id="ytd-value">${formatRM(model.ytd)}</p>
      </section>
      ${pace}
      <section class="card rules">
        <h2>Rules</h2>
        <h3>One in, one out</h3>
        <p>When a figure comes in, let one go.</p>
        <h3>Unspent money can roll over</h3>
        <p>${esc(rolloverRule(data.settings, month))}</p>
      </section>
    </section>
  `;
}

function rolloverRule(settings, month) {
  if (!settings.rollover) {
    return 'Off. Leftover from last month stays last month. Turn it on in Settings if you want it added to this month.';
  }
  if (month.rollover > 0) {
    return `On. ${formatRM(month.rollover)} left from last month is included in this month's cap.`;
  }
  return 'On. Last month had nothing left to add, so this month is the normal cap.';
}

function purchaseFormView(purchase, today) {
  const editing = Boolean(purchase);
  const value = purchase || {
    name: '',
    price: '',
    date: today,
    type: 'bought',
    note: '',
    mood: ''
  };
  const price = value.price === '' ? '' : Number(value.price).toFixed(2);
  return `
    <section>
      <h2>${editing ? 'Edit purchase' : 'Log a purchase'}</h2>
      ${editing ? '<p><a href="#history">Back to history</a></p>' : ''}
      <form id="${editing ? 'edit-form' : 'log-form'}" ${editing ? `data-id="${esc(purchase.id)}"` : ''} novalidate>
        <label class="field" for="field-name">Figure name
          <input id="field-name" name="name" maxlength="80" autocomplete="off" autocapitalize="words" value="${esc(value.name)}" required>
        </label>
        <label class="field" for="field-price">Price (RM)
          <input id="field-price" name="price" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(price)}" required>
        </label>
        <label class="field" for="field-date">Date
          <input id="field-date" name="date" type="date" value="${esc(value.date)}" required>
        </label>
        <fieldset>
          <legend>Type</legend>
          <div class="choices">
            ${choices('type', PURCHASE_TYPES, value.type)}
          </div>
          <p class="meta">A pre-order counts toward the month you pay, at the full price.</p>
        </fieldset>
        <label class="field" for="field-note">Note (optional)
          <textarea id="field-note" name="note" maxlength="280" rows="3">${esc(value.note)}</textarea>
        </label>
        <fieldset>
          <legend>Mood (optional)</legend>
          <div class="choices moods">
            ${choices('mood', MOODS, value.mood || '')}
          </div>
        </fieldset>
        <p class="form-error" role="alert" hidden></p>
        <button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Save purchase'}</button>
      </form>
      ${editing ? `<button class="btn btn-ghost danger" type="button" data-action="delete-purchase" data-id="${esc(purchase.id)}">Delete purchase</button>` : ''}
    </section>
  `;
}

function editView(data, id, today) {
  const purchase = data.purchases.find((item) => item.id === id);
  if (!purchase) {
    return `
      <section>
        <h2>Purchase not found</h2>
        <p>That entry is not in the log.</p>
        <p><a href="#history">Back to history</a></p>
      </section>
    `;
  }
  return purchaseFormView(purchase, today);
}

function wishView(data, mode) {
  const model = wishlistModel(data, now());
  for (const id of planIds) {
    if (!data.wishlist.some((item) => item.id === id)) planIds.delete(id);
  }
  const countLabel = model.count === 1 ? '1 figure' : `${model.count} figures`;
  const list = mode === 'plan' ? planList(model) : wishList(model);
  const form = mode === 'wish' ? wishForm() : '';
  const summary = mode === 'plan' ? `<div class="plan-summary" id="plan-summary">${planSummary(data)}</div>` : '';
  return `
    <section>
      <h2>${mode === 'plan' ? 'Plan the month' : 'Wishlist'}</h2>
      <p class="stat-label">Wishlist total</p>
      <p class="stat-value" id="wish-total">${formatRM(model.total)}</p>
      <p class="meta" id="wish-count">${countLabel}</p>
      <div class="segment" role="tablist" aria-label="Wishlist views">
        <a href="#wish" role="tab" aria-selected="${mode === 'wish'}">Items</a>
        <a href="#plan" role="tab" aria-selected="${mode === 'plan'}">Plan the month</a>
      </div>
      ${summary}
      ${form}
      <div id="wish-list">${list}</div>
    </section>
  `;
}

function wishForm() {
  return `
    <form id="wish-form" novalidate>
      <label class="field" for="wish-name">Figure name
        <input id="wish-name" name="name" maxlength="80" autocomplete="off" autocapitalize="words">
      </label>
      <label class="field" for="wish-price">Price (RM)
        <input id="wish-price" name="price" inputmode="decimal" autocomplete="off" placeholder="0.00">
      </label>
      <label class="field" for="wish-priority">Priority (optional)
        <select id="wish-priority" name="priority">
          ${PRIORITY_OPTIONS.map((option) => `
            <option value="${option.value}" ${option.value === 'really' ? 'selected' : ''}>${esc(option.label)}</option>
          `).join('')}
        </select>
      </label>
      <p class="form-error" role="alert" hidden></p>
      <button class="btn btn-primary" type="submit">Add to wishlist</button>
    </form>
  `;
}

function wishList(model) {
  if (!model.items.length) {
    return '<p class="empty">No figures here yet. Add one with a name and a price.</p>';
  }
  return model.items.map((item) => `
    <article class="item" data-id="${esc(item.id)}">
      <div class="item-top">
        <h3>${esc(item.name)}</h3>
        <p>${formatRM(item.price)}</p>
      </div>
      <p class="meta">${esc(item.priorityLabel)} · ${esc(item.fitLabel)}</p>
      ${item.wait.enabled ? `<p class="meta wait" data-countdown data-added="${esc(item.addedAt)}">${esc(item.wait.text)}</p>` : ''}
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-action="log-wish" data-id="${esc(item.id)}" ${item.wait.ready ? '' : 'disabled'}>Log purchase</button>
        <button class="btn btn-ghost" type="button" data-action="remove-wish" data-id="${esc(item.id)}" aria-label="Remove ${esc(item.name)}">Remove</button>
      </div>
    </article>
  `).join('');
}

function planList(model) {
  if (!model.items.length) {
    return '<p class="empty">Your wishlist is empty, so there is nothing to plan yet.</p>';
  }
  return model.items.map((item) => `
    <label class="pick">
      <input type="checkbox" data-action="plan-toggle" data-id="${esc(item.id)}" ${planIds.has(item.id) ? 'checked' : ''}>
      <span class="pick-body">
        <span class="pick-top">
          <span class="pick-name">${esc(item.name)}</span>
          <span class="pick-price">${formatRM(item.price)}</span>
        </span>
        <span class="meta">${esc(item.priorityLabel)} · ${esc(item.fitLabel)}</span>
      </span>
    </label>
  `).join('');
}

function planSummary(data) {
  const model = wishlistModel(data, now());
  const plan = planModel(model.items, planIds, model.room);
  let detail = 'Pick figures to see the total against what is left.';
  if (plan.count > 0 && plan.fits) detail = `${formatRM(plan.remaining)} would still be left.`;
  if (plan.count > 0 && !plan.fits) detail = `${formatRM(plan.over)} over what's left this month.`;
  const overNote = model.over > 0 ? ` · already ${formatRM(model.over)} over the cap` : '';
  return `
    <p class="meta">Left this month: ${formatRM(model.room)}${esc(overNote)}</p>
    <p class="plan-headline">${plan.count === 0 ? 'Nothing picked' : `${formatRM(plan.total)} selected`}</p>
    <p id="plan-detail">${esc(detail)}</p>
  `;
}

function historyView(data) {
  const model = historyModel(data, now());
  const chart = model.charts.map((snapshot) => `
    <div class="chart-row">
      <div class="chart-top">
        <span>${esc(formatMonthShort(snapshot.ym))}</span>
        <span>${formatRM(snapshot.spent)}</span>
      </div>
      <div class="chart-track" data-state="${snapshot.state}" aria-hidden="true">
        <div class="chart-fill" style="width:${barWidth(snapshot).toFixed(2)}%"></div>
      </div>
      <p class="meta">Cap ${formatRM(snapshot.cap)}</p>
    </div>
  `).join('');
  const groups = model.groups.length
    ? model.groups.map((group) => `
      <section class="month-group">
        <header class="group-head">
          <h3>${esc(formatMonth(group.ym))}</h3>
          <p>${formatRM(group.spent)}</p>
        </header>
        <p class="meta">Cap ${formatRM(group.cap)}</p>
        ${group.purchases.map(purchaseCard).join('')}
      </section>
    `).join('')
    : '<p class="empty">No purchases yet.</p>';

  return `
    <section>
      <h2>History</h2>
      <section class="card" id="chart">
        <h3>Monthly spend</h3>
        <p class="meta">Each bar is that month's spend against its cap.${model.truncated ? ' Showing the latest 8 months.' : ''}</p>
        ${chart}
      </section>
      ${groups}
    </section>
  `;
}

function purchaseCard(purchase) {
  const mood = moodLabel(purchase.mood);
  return `
    <article class="item" data-id="${esc(purchase.id)}">
      <div class="item-top">
        <h3>${esc(purchase.name)}</h3>
        <p>${formatRM(purchase.price)}</p>
      </div>
      <p class="meta">${esc(formatDay(purchase.date))} · ${esc(typeLabel(purchase.type))}${mood ? ` · ${esc(mood)}` : ''}</p>
      ${purchase.note ? `<p class="note">${esc(purchase.note)}</p>` : ''}
      <div class="btn-row">
        <a class="btn btn-ghost" href="#edit/${encodeURIComponent(purchase.id)}">Edit</a>
        <button class="btn btn-ghost" type="button" data-action="delete-purchase" data-id="${esc(purchase.id)}">Delete</button>
      </div>
    </article>
  `;
}

function settingsView(data, corrupt) {
  const settings = data.settings;
  const preview = corrupt
    ? 'Saved data could not be read. Import a backup, or erase the unreadable copy.'
    : settingsPreview(settings, data.purchases);
  return `
    <section>
      <h2>Settings</h2>
      ${corrupt ? '<p class="banner" id="corrupt-note">Saved data on this device could not be read.</p>' : ''}
      <form id="settings-form" novalidate>
        <label class="field" for="field-cap">Monthly cap (RM)
          <input id="field-cap" name="cap" inputmode="decimal" autocomplete="off" value="${esc(settings.monthlyCap.toFixed(2))}">
          <span class="meta">The limit for each calendar month, in Malaysia time. It starts at RM 400.00.</span>
        </label>
        <label class="field" for="field-wait">Cooling-off wait (hours)
          <input id="field-wait" name="wait" inputmode="numeric" autocomplete="off" value="${esc(String(settings.waitHours))}">
          <span class="meta">Optional. At 0, a wishlist item can be logged right away and no waiting time is shown. Set hours only if you want the Log purchase button to stay off for that long after you add a figure.</span>
        </label>
        <label class="checkline">
          <input id="field-rollover" name="rollover" type="checkbox" ${settings.rollover ? 'checked' : ''}>
          <span>
            <span class="check-title">Unspent money rolls over</span>
            <span class="meta">Adds whatever you did not spend last month to this month's cap. Going over the cap does not shrink next month. Off unless you turn it on.</span>
          </span>
        </label>
        <p class="meta" id="settings-preview">${esc(preview)}</p>
        <p class="form-error" role="alert" hidden></p>
        <button class="btn btn-primary" type="submit">Save settings</button>
      </form>
      <section class="backup">
        <h3>Backup</h3>
        <p class="meta">Export a JSON file to keep a copy. Import replaces the purchases, wishlist, and settings on this device.</p>
        <div class="btn-row">
          <button class="btn btn-ghost" type="button" data-action="export" ${corrupt ? 'disabled' : ''}>Export JSON</button>
          <button class="btn btn-ghost" type="button" data-action="pick-import">Import JSON</button>
        </div>
        <input id="import-file" type="file" accept="application/json,.json">
        ${corrupt ? '<button class="btn btn-ghost danger" type="button" data-action="reset-corrupt">Erase unreadable data</button>' : ''}
      </section>
    </section>
  `;
}

function settingsPreview(settings, purchases) {
  const month = homeModel({ settings, purchases, wishlist: [] }, now()).month;
  if (settings.rollover && month.rollover > 0) {
    return `This month's cap would be ${formatRM(month.cap)}, including ${formatRM(month.rollover)} rolled over.`;
  }
  return `This month's cap would be ${formatRM(month.cap)}.`;
}

function corruptView() {
  return `
    <section>
      <h2>Saved data could not be read</h2>
      <p>The copy on this device is not a Figure Cap backup. You can import a file, or erase the unreadable copy and start again.</p>
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-action="pick-import">Import JSON</button>
        <button class="btn btn-ghost danger" type="button" data-action="reset-corrupt">Erase unreadable data</button>
      </div>
      <input id="import-file" type="file" accept="application/json,.json">
    </section>
  `;
}

function choices(name, options, selected) {
  return options.map((option) => `
    <label class="choice">
      <input type="radio" name="${name}" value="${esc(option.value)}" ${option.value === selected ? 'checked' : ''}>
      <span>${esc(option.label)}</span>
    </label>
  `).join('');
}

function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.id === 'log-form') savePurchase(form, null);
  if (form.id === 'edit-form') savePurchase(form, form.dataset.id);
  if (form.id === 'wish-form') addWish(form);
  if (form.id === 'settings-form') saveSettings(form);
}

function onInput(event) {
  const form = event.target.form;
  if (form && form.id === 'settings-form') updateSettingsPreview(form);
}

function onChange(event) {
  const target = event.target;
  if (target.matches?.('[data-action="plan-toggle"]')) {
    if (target.checked) planIds.add(target.dataset.id);
    else planIds.delete(target.dataset.id);
    const slot = document.getElementById('plan-summary');
    const loaded = currentData();
    if (slot && !loaded.corrupt) slot.innerHTML = planSummary(loaded.data);
    return;
  }
  if (target.id === 'import-file') {
    const file = target.files && target.files[0];
    target.value = '';
    if (file) stageImport(file);
    return;
  }
  const form = target.form;
  if (form && form.id === 'settings-form') updateSettingsPreview(form);
}

function onClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'toast-action') {
    const run = pendingToastAction;
    hideToast();
    if (run) run();
    return;
  }
  if (action === 'close-dialog') {
    closeDialog();
    return;
  }
  if (action === 'remove-wish') removeWish(button.dataset.id);
  if (action === 'log-wish') askLogWish(button.dataset.id);
  if (action === 'confirm-log') confirmLogWish(button.dataset.id);
  if (action === 'delete-purchase') askDelete(button.dataset.id);
  if (action === 'confirm-delete') confirmDelete(button.dataset.id);
  if (action === 'export') exportJson();
  if (action === 'pick-import') document.getElementById('import-file')?.click();
  if (action === 'confirm-import') confirmImport();
  if (action === 'reset-corrupt') resetCorrupt();
}

function fieldValue(form, name) {
  const field = form.elements.namedItem(name);
  return field ? String(field.value ?? '') : '';
}

function fieldChecked(form, name) {
  const field = form.elements.namedItem(name);
  return Boolean(field && field.checked);
}

function readPurchase(form) {
  const name = fieldValue(form, 'name').trim();
  const price = parseMoney(fieldValue(form, 'price'));
  const date = fieldValue(form, 'date');
  const type = fieldValue(form, 'type');
  const mood = fieldValue(form, 'mood');
  const note = fieldValue(form, 'note').trim();
  if (!name) return { error: 'Enter a figure name.' };
  if (name.length > 80) return { error: 'Use a shorter name.' };
  if (price == null || price <= 0) return { error: 'Enter a price above RM 0.00.' };
  if (price > MAX_MONEY) return { error: `Enter a price of ${formatRM(MAX_MONEY)} or less.` };
  if (!isYMD(date)) return { error: 'Choose a valid date.' };
  if (type !== 'bought' && type !== 'preorder') return { error: 'Choose Bought or Pre-order paid in full.' };
  if (note.length > 280) return { error: 'Use a shorter note.' };
  const moodOk = MOODS.some((item) => item.value === mood);
  return {
    purchase: {
      name,
      price,
      date,
      type,
      note,
      mood: moodOk ? mood : ''
    }
  };
}

function savePurchase(form, id) {
  const result = readPurchase(form);
  if (result.error) {
    showFormError(form, result.error);
    return;
  }
  const loaded = currentData();
  if (loaded.corrupt) return;
  const data = loaded.data;
  if (id) {
    const existing = data.purchases.find((item) => item.id === id);
    if (!existing) {
      showFormError(form, 'That purchase is no longer in the log.');
      return;
    }
    Object.assign(existing, result.purchase);
    if (!persist(data)) return;
    showToast('Purchase updated.');
    go('#history');
    return;
  }
  data.purchases.push({
    id: uid(),
    ...result.purchase,
    createdAt: now().toISOString()
  });
  if (!persist(data)) return;
  showToast(`Logged ${result.purchase.name}.`);
  go('#home');
}

function addWish(form) {
  const name = fieldValue(form, 'name').trim();
  const price = parseMoney(fieldValue(form, 'price'));
  const priorityValue = fieldValue(form, 'priority');
  const priority = ['must', 'really', 'nice'].includes(priorityValue) ? priorityValue : 'really';
  if (!name) {
    showFormError(form, 'Enter a figure name.');
    return;
  }
  if (price == null || price <= 0) {
    showFormError(form, 'Enter a price above RM 0.00.');
    return;
  }
  if (price > MAX_MONEY) {
    showFormError(form, `Enter a price of ${formatRM(MAX_MONEY)} or less.`);
    return;
  }
  const loaded = currentData();
  if (loaded.corrupt) return;
  loaded.data.wishlist.push({
    id: uid(),
    name: name.slice(0, 80),
    price,
    priority,
    addedAt: now().toISOString()
  });
  if (!persist(loaded.data)) return;
  showToast(`Added ${name}.`);
  render();
}

function saveSettings(form) {
  const cap = parseMoney(fieldValue(form, 'cap'));
  const waitText = fieldValue(form, 'wait').trim();
  const wait = Number(waitText);
  if (cap == null || cap < 0) {
    showFormError(form, 'Enter a cap of RM 0.00 or more.');
    return;
  }
  if (cap > MAX_MONEY) {
    showFormError(form, `Enter a cap of ${formatRM(MAX_MONEY)} or less.`);
    return;
  }
  if (!/^\d+$/.test(waitText) || wait > MAX_WAIT_HOURS) {
    showFormError(form, `Enter a wait from 0 to ${MAX_WAIT_HOURS} hours. Use 0 to leave it off.`);
    return;
  }
  const loaded = currentData();
  if (loaded.corrupt) return;
  loaded.data.settings.monthlyCap = cap;
  loaded.data.settings.waitHours = wait;
  loaded.data.settings.rollover = fieldChecked(form, 'rollover');
  if (!persist(loaded.data)) return;
  showToast('Settings saved.');
  render();
}

function updateSettingsPreview(form) {
  const slot = document.getElementById('settings-preview');
  if (!slot) return;
  const cap = parseMoney(fieldValue(form, 'cap'));
  if (cap == null || cap < 0 || cap > MAX_MONEY) {
    slot.textContent = 'Enter a cap of RM 0.00 or more.';
    return;
  }
  const loaded = currentData();
  if (loaded.corrupt) return;
  const settings = {
    ...loaded.data.settings,
    monthlyCap: cap,
    rollover: fieldChecked(form, 'rollover')
  };
  slot.textContent = settingsPreview(settings, loaded.data.purchases);
}

function removeWish(id) {
  const loaded = currentData();
  if (loaded.corrupt) return;
  const item = loaded.data.wishlist.find((entry) => entry.id === id);
  if (!item) return;
  loaded.data.wishlist = loaded.data.wishlist.filter((entry) => entry.id !== id);
  planIds.delete(id);
  if (!persist(loaded.data)) return;
  undoItem = item;
  showToast(`Removed ${item.name}.`, 'Undo', () => {
    const itemToRestore = undoItem;
    undoItem = null;
    if (!itemToRestore) return;
    const latest = currentData();
    if (latest.corrupt) return;
    if (!latest.data.wishlist.some((entry) => entry.id === itemToRestore.id)) {
      latest.data.wishlist.push(itemToRestore);
      if (!persist(latest.data)) return;
    }
    render();
  });
  render();
}

function askLogWish(id) {
  const loaded = currentData();
  if (loaded.corrupt) return;
  const item = loaded.data.wishlist.find((entry) => entry.id === id);
  if (!item) return;
  const status = waitStatus(item.addedAt, loaded.data.settings.waitHours, now());
  if (!status.ready) return;
  const today = todayYMD();
  const room = homeModel(loaded.data, now()).month.room;
  const fit = fitFor(item.price, room);
  const warning = fit.fits
    ? ''
    : `<p class="warn">This would go past what's left by ${formatRM(fit.short)}.</p>`;
  openDialog(`
    <h2 id="dialog-title">${fit.fits ? 'Log this figure?' : 'This goes past the cap'}</h2>
    <p><strong>${esc(item.name)}</strong></p>
    <p>${formatRM(item.price)} · ${esc(formatFullDay(today))} · Bought</p>
    ${warning}
    <p class="meta">You can change the date, type, note, or mood later in History.</p>
    <div class="btn-row">
      <button class="btn btn-primary" type="button" data-action="confirm-log" data-id="${esc(item.id)}">${fit.fits ? 'Log purchase' : 'Log it anyway'}</button>
      <button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button>
    </div>
  `);
}

function confirmLogWish(id) {
  const loaded = currentData();
  if (loaded.corrupt) return;
  const item = loaded.data.wishlist.find((entry) => entry.id === id);
  if (!item) {
    closeDialog();
    return;
  }
  const status = waitStatus(item.addedAt, loaded.data.settings.waitHours, now());
  if (!status.ready) {
    closeDialog();
    return;
  }
  loaded.data.purchases.push({
    id: uid(),
    name: item.name,
    price: item.price,
    date: todayYMD(),
    type: 'bought',
    note: '',
    mood: '',
    createdAt: now().toISOString()
  });
  loaded.data.wishlist = loaded.data.wishlist.filter((entry) => entry.id !== id);
  planIds.delete(id);
  if (undoItem && undoItem.id === id) undoItem = null;
  if (!persist(loaded.data)) return;
  closeDialog();
  showToast(`Logged ${item.name}.`);
  go('#home');
}

function askDelete(id) {
  const loaded = currentData();
  if (loaded.corrupt) return;
  const purchase = loaded.data.purchases.find((item) => item.id === id);
  if (!purchase) return;
  openDialog(`
    <h2 id="dialog-title">Delete this purchase?</h2>
    <p><strong>${esc(purchase.name)}</strong> · ${formatRM(purchase.price)} will leave the log. This month's totals will update.</p>
    <div class="btn-row">
      <button class="btn btn-primary danger" type="button" data-action="confirm-delete" data-id="${esc(id)}">Delete</button>
      <button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button>
    </div>
  `);
}

function confirmDelete(id) {
  const loaded = currentData();
  if (loaded.corrupt) return;
  loaded.data.purchases = loaded.data.purchases.filter((item) => item.id !== id);
  if (!persist(loaded.data)) return;
  closeDialog();
  showToast('Purchase deleted.');
  go('#history');
}

function exportJson() {
  const loaded = currentData();
  if (loaded.corrupt) {
    showToast('Unreadable data cannot be exported.');
    return;
  }
  const payload = exportPayload(loaded.data, now().toISOString());
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `figure-cap-${todayYMD()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function stageImport(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(String(reader.result));
    } catch {
      showToast('That file is not valid JSON.');
      return;
    }
    if (!looksLikeData(parsed)) {
      showToast('That file is not a Figure Cap backup.');
      return;
    }
    pendingImport = parsed;
    openDialog(`
      <h2 id="dialog-title">Replace data on this device?</h2>
      <p>This replaces purchases, the wishlist, and settings with the file. Export a backup first if you want to keep what is here now.</p>
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-action="confirm-import">Replace</button>
        <button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button>
      </div>
    `);
  };
  reader.onerror = () => showToast('That file could not be read.');
  reader.readAsText(file);
}

function confirmImport() {
  if (!pendingImport) {
    closeDialog();
    return;
  }
  const data = normalizeData(pendingImport, currentMonth());
  pendingImport = null;
  planIds.clear();
  undoItem = null;
  if (!persist(data)) return;
  closeDialog();
  showToast('Backup imported.');
  go('#home');
}

function resetCorrupt() {
  try {
    clear();
  } catch {
    showToast('Could not erase the stored data.');
    return;
  }
  planIds.clear();
  undoItem = null;
  showToast('Stored data was erased.');
  go('#home');
}

function showFormError(form, message) {
  const slot = form.querySelector('.form-error');
  if (!slot) return;
  slot.hidden = false;
  slot.textContent = message;
}

function openDialog(html) {
  const dialog = document.getElementById('dialog');
  dialog.innerHTML = html;
  if (!dialog.open) dialog.showModal();
}

function closeDialog() {
  const dialog = document.getElementById('dialog');
  pendingImport = null;
  if (dialog.open) dialog.close();
  dialog.innerHTML = '';
}

function showToast(message, actionLabel, onAction) {
  const toast = document.getElementById('toast');
  toast.hidden = false;
  toast.replaceChildren();
  const text = document.createElement('p');
  text.textContent = message;
  toast.append(text);
  pendingToastAction = onAction || null;
  if (actionLabel && onAction) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost toast-btn';
    button.dataset.action = 'toast-action';
    button.textContent = actionLabel;
    toast.append(button);
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideToast(), actionLabel ? 6000 : 2600);
}

function hideToast() {
  const toast = document.getElementById('toast');
  toast.hidden = true;
  toast.replaceChildren();
  pendingToastAction = null;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}
