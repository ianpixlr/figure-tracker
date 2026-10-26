// Figure Cap sheet sync.
// Deploy as a web app: Execute as me, Who has access: Anyone.
// Then paste the /exec URL into DEFAULT_SYNC_URL in js/sync.js.
// SYNC_TOKEN must match js/sync.js. The spreadsheet id is Ian's sheet.

var SPREADSHEET_ID = '1T6r59M_WNSqRt6nfQhOyVwyHVuQtlvi6JabgwLnfk60';
var SYNC_TOKEN = 'fc-sync-4e91c7b2';
var TIMEZONE = 'Asia/Kuala_Lumpur';

var SHEETS = {
  'Purchases': [
    'id', 'date', 'name', 'series', 'brand', 'type', 'bought_as', 'condition',
    'original_amount', 'currency', 'fx_rate', 'fx_date', 'amount_rm', 'fx_overridden', 'fx_cached',
    'shop', 'status', 'notes', 'mood', 'created_at', 'updated_at'
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
  sold_fx_date: true
};

var DATETIME_COLUMNS = {
  created_at: true,
  updated_at: true,
  added_at: true,
  checked_at: true
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
  var rows = Math.max(sheet.getMaxRows() - 1, 1);
  headers.forEach(function (header, index) {
    var range = sheet.getRange(2, index + 1, rows, 1);
    if (header === 'amount_rm' || header === 'sold_amount_rm' || header === 'low_rm' || header === 'typical_rm' || header === 'high_rm') {
      range.setNumberFormat('"RM" #,##0.00');
    } else if (header === 'original_amount' || header === 'sold_original_amount') {
      range.setNumberFormat('#,##0.00');
    } else if (header === 'fx_rate' || header === 'sold_fx_rate') {
      range.setNumberFormat('0.000000');
    } else if (header === 'listing_count') {
      range.setNumberFormat('0');
    } else if (DATE_COLUMNS[header]) {
      range.setNumberFormat('yyyy-mm-dd');
    } else if (DATETIME_COLUMNS[header]) {
      range.setNumberFormat('yyyy-mm-dd hh:mm');
    }
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
  if (value == null || value === '') return '';
  if (DATE_COLUMNS[header]) return asDateOnly(value);
  if (DATETIME_COLUMNS[header]) return asDateTime(value);
  if (typeof value === 'number' && isFinite(value)) return value;
  if (header.indexOf('amount') !== -1 || header.indexOf('fx_rate') !== -1 || header === 'listing_count' || header === 'original_amount' || header === 'sold_original_amount') {
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
  headers.forEach(function (header, index) {
    if (!Object.prototype.hasOwnProperty.call(row, header)) return;
    sheet.getRange(line, index + 1).setValue(outgoing(header, row[header]));
  });
}

function deleteById(sheet, headers, id) {
  var idIndex = headers.indexOf('id');
  if (idIndex === -1 || !id) return;
  var line = findRow(sheet, idIndex, id);
  if (line) sheet.deleteRow(line);
}

function syncTable(ss, name, rows) {
  var repaired = repairSheet(ss, name, SHEETS[name]);
  var keep = {};
  (rows || []).forEach(function (row) {
    if (!row || !row.id) return;
    keep[String(row.id)] = true;
    upsertRow(repaired.sheet, repaired.headers, row);
  });
  var idIndex = repaired.headers.indexOf('id');
  var last = repaired.sheet.getLastRow();
  if (idIndex === -1 || last < 2) return;
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
