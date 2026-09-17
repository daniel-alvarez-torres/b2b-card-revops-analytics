/**
 * 01_Lib.gs
 *
 * Shared helpers. The whole pipeline reads each sheet once with a single
 * getValues() and writes once with a single setValues(). Row-by-row calls
 * to the Sheets API are what make Apps Script slow, not the volume of data:
 * 12k deals and 27k usage rows run comfortably inside the 6-minute quota
 * when the I/O happens in two calls instead of forty thousand.
 */

/** Read a sheet into an array of plain objects keyed by header. */
function readTable(sheetName) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  if (!sh) throw new Error('Sheet not found: ' + sheetName);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2) return { headers: [], rows: [] };

  const values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(h => String(h).trim());
  const rows = new Array(values.length - 1);

  for (let i = 1; i < values.length; i++) {
    const o = {};
    for (let c = 0; c < headers.length; c++) o[headers[c]] = values[i][c];
    rows[i - 1] = o;
  }
  return { headers: headers, rows: rows };
}

/** Write an array of objects to a sheet, replacing whatever was there. */
function writeTable(sheetName, headers, rows) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(sheetName);
  if (!sh) sh = ss.insertSheet(sheetName);
  sh.clear();

  const out = new Array(rows.length + 1);
  out[0] = headers;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const line = new Array(headers.length);
    for (let c = 0; c < headers.length; c++) {
      const v = r[headers[c]];
      line[c] = (v === undefined || v === null) ? '' : v;
    }
    out[i + 1] = line;
  }
  if (out.length) {
    sh.getRange(1, 1, out.length, headers.length).setValues(out);
  }
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setBackground('#111015').setFontColor('#E0B65C');
  return sh;
}

/** Write a matrix (array of arrays) with a header row. */
function writeMatrix(sheetName, headers, matrix) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(sheetName);
  if (!sh) sh = ss.insertSheet(sheetName);
  sh.clear();
  const out = [headers].concat(matrix);
  sh.getRange(1, 1, out.length, headers.length).setValues(out);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setBackground('#111015').setFontColor('#E0B65C');
  return sh;
}

// ---------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------

/** Lowercase, strip accents, collapse whitespace. */
function normText(s) {
  if (s === null || s === undefined || s === '') return '';
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Canonical partner name: strips accents, punctuation and legal suffixes,
 * then title-cases. "  BANCO AURORA ALIANZAS S.A.S. " and
 * "banco aurora alianzas ltda" both land on "Banco Aurora Alianzas".
 */
function normPartner(s) {
  let n = normText(s);
  if (!n) return '';
  n = n.replace(/[^a-z0-9 &]/g, ' ').replace(/\s+/g, ' ').trim();

  const parts = n.split(' ');
  while (parts.length > 1) {
    const tail2 = parts.slice(-2).join(' ');
    const tail1 = parts[parts.length - 1];
    if (CFG.LEGAL_SUFFIXES.indexOf(tail2) >= 0) { parts.splice(-2, 2); continue; }
    if (CFG.LEGAL_SUFFIXES.indexOf(tail1) >= 0) { parts.pop(); continue; }
    break;
  }
  return parts
    .filter(String)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** True if the deal name matches any test pattern. */
function looksLikeTestRecord(name) {
  const n = normText(name);
  if (!n) return false;
  for (let i = 0; i < CFG.TEST_PATTERNS.length; i++) {
    if (n.indexOf(CFG.TEST_PATTERNS[i]) >= 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// Dates and numbers
// ---------------------------------------------------------------------

/** Parse a value that may be a Date, an ISO string, or blank. */
function toDate(v) {
  if (!v && v !== 0) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? null : v;
  }
  const d = new Date(String(v).slice(0, 10) + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Normalizes a month cell to the string 'YYYY-MM'.
 *
 * Sheets parses "2026-08" as a date on import, so the same column arrives as a
 * Date in one sheet and a string in another. Everything downstream compares it
 * as text, so it gets normalized once, here, rather than defended against in
 * every formula.
 */
function monthStr(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    const m = v.getMonth() + 1;
    return v.getFullYear() + '-' + (m < 10 ? '0' + m : m);
  }
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})/);
  if (iso) return iso[1] + '-' + (iso[2].length === 1 ? '0' + iso[2] : iso[2]);
  const d = toDate(s);
  if (d) {
    const m = d.getMonth() + 1;
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m);
  }
  return s;
}


/** 'YYYY-MM' for a date. */
function monthKey(d) {
  const m = d.getMonth() + 1;
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m);
}

/** 'YYYYQn' for a date. */
function quarterKey(d) {
  return d.getFullYear() + 'Q' + (Math.floor(d.getMonth() / 3) + 1);
}

/** Months elapsed between two 'YYYY-MM' keys. */
function monthDiff(from, to) {
  const a = from.split('-'), b = to.split('-');
  return (Number(b[0]) - Number(a[0])) * 12 + (Number(b[1]) - Number(a[1]));
}

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function round(v, d) {
  const f = Math.pow(10, d || 0);
  return Math.round(v * f) / f;
}

function median(arr) {
  const a = arr.filter(x => x !== null && !isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function sumBy(rows, f) {
  let t = 0;
  for (let i = 0; i < rows.length; i++) t += (f(rows[i]) || 0);
  return t;
}

/** Group an array into a Map keyed by f(row). */
function groupBy(rows, f) {
  const m = new Map();
  for (let i = 0; i < rows.length; i++) {
    const k = f(rows[i]);
    if (k === null || k === undefined || k === '') continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(rows[i]);
  }
  return m;
}

function countWhere(rows, f) {
  let n = 0;
  for (let i = 0; i < rows.length; i++) if (f(rows[i])) n++;
  return n;
}
