// Figure Cap sheet sync.
// Deploy as a web app: Execute as me, Who has access: Anyone.
// DEFAULT_SYNC_URL in js/sync.js points at the deployed /exec URL.
// SYNC_TOKEN must match js/sync.js. The spreadsheet id is Ian's sheet.

var SPREADSHEET_ID = '1T6r59M_WNSqRt6nfQhOyVwyHVuQtlvi6JabgwLnfk60';
var SYNC_TOKEN = 'fc-sync-4e91c7b2';
var TIMEZONE = 'Asia/Kuala_Lumpur';

var SHEETS = {
  'Purchases': [
    'id', 'date', 'name', 'series', 'brand', 'type', 'bought_as', 'condition',
    'original_amount', 'currency', 'fx_rate', 'fx_date', 'amount_rm', 'fx_overridden', 'fx_cached',
    'shop', 'status', 'notes',
    'est_full_original_amount', 'est_full_currency', 'est_full_fx_rate', 'est_full_fx_date', 'est_full_price', 'est_full_fx_overridden', 'est_full_fx_cached',
    'deposit_original_amount', 'deposit_currency', 'deposit_fx_rate', 'deposit_fx_date', 'deposit_amount_rm', 'deposit_fx_overridden', 'deposit_fx_cached', 'deposit_date',
    'balance_due_rm',
    'balance_paid_original_amount', 'balance_paid_currency', 'balance_paid_fx_rate', 'balance_paid_fx_date', 'balance_paid_rm', 'balance_paid_fx_overridden', 'balance_paid_fx_cached', 'balance_paid_date',
    'final_total_rm', 'preorder_status',
    'created_at', 'updated_at'
  ],
  'Wishlist': [
    'id', 'name', 'original_amount', 'currency', 'fx_rate', 'fx_date', 'amount_rm',
    'fx_overridden', 'fx_cached', 'priority', 'added_at', 'updated_at'
  ],
  'For Sale': [
    'id', 'name', 'brand', 'series', 'condition',
    'original_amount', 'currency', 'fx_rate', 'fx_date', 'amount_rm', 'fx_overridden', 'fx_cached',
    'notes', 'status',
    'sold_original_amount', 'sold_currency', 'sold_fx_rate', 'sold_fx_date', 'sold_amount_rm',
    'sold_fx_overridden', 'sold_fx_cached', 'sold_date', 'created_at', 'updated_at'
  ],
  'Price Checks': [
    'for_sale_id', 'figure', 'rrp', 'rrp_source', 'condition',
    'low_rm', 'typical_rm', 'high_rm', 'listing_count', 'sample_links', 'sources', 'checked_at'
  ]
};

var WRITABLE = {
  'Purchases': true,
  'Wishlist': true,
  'For Sale': true
};

var DATE_COLUMNS = {
  date: true,
  fx_date: true,
  sold_date: true,
  sold_fx_date: true,
  est_full_fx_date: true,
  deposit_fx_date: true,
  deposit_date: true,
  balance_paid_fx_date: true,
  balance_paid_date: true
};

var RETIRED = {
  'Purchases': ['mood']
};

var DATETIME_COLUMNS = {
  created_at: true,
  updated_at: true,
  added_at: true,
  checked_at: true
};

// Free text that Sheets will turn into a date if the column is General.
// 1/6 and 1/12 in type, and a series such as 1/6, have to stay plain text.
var TEXT_COLUMNS = {
  name: true,
  series: true,
  brand: true,
  type: true,
  condition: true
};

function json(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var token = e && e.parameter ? e.parameter.token : '';
  if (token !== SYNC_TOKEN) return json({ ok: false, error: 'unauthorized' });
  try {
    var ss = openSheet();
    return json({
      ok: true,
      purchases: readTable(ss, 'Purchases'),
      wishlist: readTable(ss, 'Wishlist'),
      forSale: readTable(ss, 'For Sale'),
      priceChecks: readTable(ss, 'Price Checks')
    });
  } catch (error) {
    return json({ ok: false, error: String(error) });
  }
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '{}');
  } catch (error) {
    return json({ ok: false, error: 'invalid json' });
  }
  if (body.token !== SYNC_TOKEN) return json({ ok: false, error: 'unauthorized' });
  try {
    var ss = openSheet();
    if (body.action === 'syncAll') {
      syncTable(ss, 'Purchases', body.purchases || []);
      syncTable(ss, 'Wishlist', body.wishlist || []);
      syncTable(ss, 'For Sale', body.forSale || []);
      return json({ ok: true });
    }
    // Price Checks has no id column, so upsert cannot write it. Append only.
    // This action is new: redeploy the web app or the phone cannot save a check to the sheet.
    if (body.action === 'appendCheck') {
      var checks = repairSheet(ss, 'Price Checks', SHEETS['Price Checks']);
      appendCheckRow(checks.sheet, checks.headers, body.row || {});
      return json({ ok: true });
    }
    if (!WRITABLE[body.sheet]) return json({ ok: false, error: 'sheet not writable' });
    var repaired = repairSheet(ss, body.sheet, SHEETS[body.sheet]);
    if (body.action === 'delete') {
      deleteById(repaired.sheet, repaired.headers, body.id);
      return json({ ok: true });
    }
    if (body.action === 'upsert') {
      if (!body.row || !body.row.id) return json({ ok: false, error: 'missing id' });
      upsertRow(repaired.sheet, repaired.headers, body.row);
      return json({ ok: true });
    }
    return json({ ok: false, error: 'unknown action' });
  } catch (error) {
    return json({ ok: false, error: String(error) });
  }
}

function openSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  ss.setSpreadsheetTimeZone(TIMEZONE);
  Object.keys(SHEETS).forEach(function (name) {
    repairSheet(ss, name, SHEETS[name]);
  });
  return ss;
}

function headerCells(sheet) {
  var cols = sheet.getLastColumn();
  if (!cols) return [];
  return sheet.getRange(1, 1, 1, cols).getValues()[0].map(function (cell) {
    return String(cell || '').trim();
  });
}

function repairSheet(ss, name, wanted) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  (RETIRED[name] || []).forEach(function (header) {
    var current = headerCells(sheet);
    var index = current.indexOf(header);
    if (index !== -1) sheet.deleteColumn(index + 1);
  });
  var headers = headerCells(sheet).filter(function (header, index, list) {
    return header || list.slice(index).some(Boolean);
  });
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  var blank = !headers.length || headers.every(function (header) { return !header; });
  if (blank) {
    sheet.getRange(1, 1, 1, wanted.length).setValues([wanted]);
    headers = wanted.slice();
  } else {
    wanted.forEach(function (header) {
      if (headers.indexOf(header) === -1) {
        headers.push(header);
        sheet.getRange(1, headers.length).setValue(header);
      }
    });
  }
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  applyFormats(sheet, headers);
  return { sheet: sheet, headers: headers };
}

function applyFormats(sheet, headers) {
  // The whole column, including blank rows below the last purchase, so a row
  // appended later is already plain text. getLastRow() would leave those cells
  // on General, and Sheets would turn the next 1/6 into a date.
  var rows = Math.max(sheet.getMaxRows() - 1, 1);
  headers.forEach(function (header, index) {
    var range = sheet.getRange(2, index + 1, rows, 1);
    if (/_rm$/.test(header) || header === 'est_full_price') {
      range.setNumberFormat('"RM" #,##0.00');
    } else if (/original_amount$/.test(header)) {
      range.setNumberFormat('#,##0.00');
    } else if (/fx_rate$/.test(header)) {
      range.setNumberFormat('0.000000');
    } else if (header === 'listing_count') {
      range.setNumberFormat('0');
    } else if (DATE_COLUMNS[header]) {
      range.setNumberFormat('yyyy-mm-dd');
    } else if (DATETIME_COLUMNS[header]) {
      range.setNumberFormat('yyyy-mm-dd hh:mm');
    } else if (TEXT_COLUMNS[header]) {
      range.setNumberFormat('@');
    }
  });
}

function ensureRow(sheet, headers, line) {
  var max = sheet.getMaxRows();
  if (line <= max) return;
  sheet.insertRowsAfter(max, line - max);
  headers.forEach(function (header, index) {
    if (!TEXT_COLUMNS[header]) return;
    sheet.getRange(max + 1, index + 1, line - max, 1).setNumberFormat('@');
  });
}

function writeRow(sheet, line, headers, row) {
  ensureRow(sheet, headers, line);
  var textWrites = [];
  headers.forEach(function (header, index) {
    if (!Object.prototype.hasOwnProperty.call(row, header)) return;
    var value = outgoing(header, row[header]);
    var cell = sheet.getRange(line, index + 1);
    if (TEXT_COLUMNS[header]) {
      cell.setNumberFormat('@');
      textWrites.push({
        cell: cell,
        value: value == null || value === '' ? '' : String(value)
      });
      return;
    }
    cell.setValue(value);
  });
  if (!textWrites.length) return;
  // Commit the @ format before the value is parsed, or 1/6 is still a date.
  SpreadsheetApp.flush();
  textWrites.forEach(function (item) {
    item.cell.setValue(item.value);
  });
}

function asDateOnly(value) {
  var match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '';
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0));
}

function asDateTime(value) {
  var parsed = new Date(value);
  if (isNaN(parsed.getTime())) return asDateOnly(value) || '';
  return parsed;
}

function outgoing(header, value) {
  // Blank money and rates stay blank. Number('') is 0, so an empty cell must not be coerced.
  if (value == null || String(value).trim() === '') return '';
  if (DATE_COLUMNS[header]) return asDateOnly(value);
  if (DATETIME_COLUMNS[header]) return asDateTime(value);
  if (typeof value === 'number' && isFinite(value)) return value;
  if (header.indexOf('amount') !== -1 || header.indexOf('fx_rate') !== -1 || header === 'listing_count' || header === 'est_full_price' || /_rm$/.test(header)) {
    var numeric = Number(value);
    if (isFinite(numeric) && String(value).trim() !== '') return numeric;
  }
  return value;
}

function findRow(sheet, idIndex, id) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var ids = sheet.getRange(2, idIndex + 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

function upsertRow(sheet, headers, row) {
  var idIndex = headers.indexOf('id');
  if (idIndex === -1) throw new Error('missing id column');
  var line = findRow(sheet, idIndex, row.id);
  if (!line) line = Math.max(sheet.getLastRow(), 1) + 1;
  writeRow(sheet, line, headers, row);
}

function appendCheckRow(sheet, headers, row) {
  var line = Math.max(sheet.getLastRow(), 1) + 1;
  writeRow(sheet, line, headers, row);
}

function deleteById(sheet, headers, id) {
  var idIndex = headers.indexOf('id');
  if (idIndex === -1 || !id) return;
  var line = findRow(sheet, idIndex, id);
  if (line) sheet.deleteRow(line);
}

function sheetHasIds(sheet, idIndex) {
  var last = sheet.getLastRow();
  if (idIndex === -1 || last < 2) return false;
  var ids = sheet.getRange(2, idIndex + 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '')) return true;
  }
  return false;
}

function syncTable(ss, name, rows) {
  var repaired = repairSheet(ss, name, SHEETS[name]);
  var incoming = [];
  (rows || []).forEach(function (row) {
    if (row && row.id) incoming.push(row);
  });
  var idIndex = repaired.headers.indexOf('id');
  if (idIndex === -1) throw new Error('missing id column');
  // Safari and the home-screen app do not share storage. A phone whose table
  // is empty must not erase rows the other one already stored. One-row deletes
  // still arrive as action "delete". Redeploy the web app for this guard.
  if (!incoming.length && sheetHasIds(repaired.sheet, idIndex)) return;
  var keep = {};
  incoming.forEach(function (row) {
    keep[String(row.id)] = true;
    upsertRow(repaired.sheet, repaired.headers, row);
  });
  var last = repaired.sheet.getLastRow();
  if (last < 2) return;
  var ids = repaired.sheet.getRange(2, idIndex + 1, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    var id = String(ids[i][0] || '');
    if (id && !keep[id]) repaired.sheet.deleteRow(i + 2);
  }
}

function formatIncoming(header, value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    var pattern = DATETIME_COLUMNS[header] ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd';
    return Utilities.formatDate(value, TIMEZONE, pattern);
  }
  return value === '' ? '' : value;
}

function readTable(ss, name) {
  var repaired = repairSheet(ss, name, SHEETS[name]);
  var last = repaired.sheet.getLastRow();
  if (last < 2) return [];
  var values = repaired.sheet.getRange(2, 1, last - 1, repaired.headers.length).getValues();
  var rows = [];
  values.forEach(function (cells) {
    var row = {};
    var any = false;
    repaired.headers.forEach(function (header, index) {
      var value = formatIncoming(header, cells[index]);
      if (value !== '' && value != null) any = true;
      row[header] = value === '' ? '' : value;
    });
    if (any) rows.push(row);
  });
  return rows;
}
