/**
 * Test harness: runs the Apps Script engines in Node against the same CSVs,
 * with readTable/writeTable swapped for file-backed versions, and compares
 * the output with the Python pipeline.
 */
const fs = require('fs');
const vm = require('vm');
// Rutas relativas a la raiz del repositorio: el arnes se corre con
// `node tests/test_gas.js` desde ahi.
const path = 'data/';
const gasPath = 'apps_script/';

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const FILES = {
  deals_raw: 'hubspot_deals_export_RAW.csv',
  usage_raw: 'account_usage_RAW.csv',
  rep_quotas: 'rep_quotas.csv',
  reps: 'reps.csv'
};

const store = {};   // sheetName -> {headers, rows(objects)}

function loadCsv(sheet, file) {
  const m = parseCsv(fs.readFileSync(path + file, 'utf8'));
  const headers = m[0].map(h => h.trim());
  const rows = [];
  for (let i = 1; i < m.length; i++) {
    if (m[i].length === 1 && m[i][0] === '') continue;
    const o = {};
    for (let c = 0; c < headers.length; c++) {
      let v = m[i][c];
      if (v === '' || v === undefined) v = '';
      else if (v === 'True') v = true;
      else if (v === 'False') v = false;
      else if (v !== '' && !isNaN(Number(v)) && /^-?[\d.]+(e-?\d+)?$/i.test(v)) v = Number(v);
      o[headers[c]] = v;
    }
    rows.push(o);
  }
  store[sheet] = { headers, rows };
}

Object.keys(FILES).forEach(s => loadCsv(s, FILES[s]));

// ---- a fake parametros sheet, backed by a matrix ----
let PARAM_MATRIX = null;

function fakeSheet(matrix) {
  return {
    getLastRow: () => matrix.length,
    getLastColumn: () => matrix[0].length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => matrix.slice(r - 1, r - 1 + nr)
                             .map(row => row.slice(c - 1, c - 1 + nc))
    })
  };
}

// ---- sandbox ----
const sandbox = {
  Logger: { log: m => console.log('    ' + String(m)) },
  console,
  Set, Map, Date, Math, Number, String, Object, Array, JSON, isNaN,
  Session: { getScriptTimeZone: () => 'America/Bogota' },
  Utilities: {
    formatDate: (d) => d.toISOString().slice(0, 10)
  },
  SpreadsheetApp: {
    getActive: () => ({
      getSheetByName: (n) => (n === 'parametros' && PARAM_MATRIX)
        ? fakeSheet(PARAM_MATRIX) : null
    })
  }
};
vm.createContext(sandbox);

['00_Config.gs', '01_Lib.gs', '05_Params.gs', '02_CleanupEngine.gs',
 '03_Metrics.gs', '06_Definitions.gs']
  .forEach(f => {
    const src = fs.readFileSync(gasPath + f, 'utf8');
    try { vm.runInContext(src, sandbox, { filename: f }); }
    catch (e) { console.error('PARSE FAIL in ' + f + ': ' + e.message); process.exit(1); }
  });

console.log('All six .gs files parsed cleanly under V8.\n');

// ---- swap the sheet I/O for file-backed versions ----
vm.runInContext(`
  readTable = function(name) {
    const t = __store[name];
    if (!t) throw new Error('Sheet not found: ' + name);
    return { headers: t.headers.slice(), rows: t.rows.map(r => Object.assign({}, r)) };
  };
  writeTable = function(name, headers, rows) {
    __store[name] = { headers: headers.slice(), rows: rows };
    __written[name] = rows.length;
    return { getRange: function(){ return {
      setNumberFormat: function(){ return this; },
      setValues: function(){ return this; },
      setFontWeight: function(){ return this; },
      setBackground: function(){ return this; },
      setFontColor: function(){ return this; },
      setWrap: function(){ return this; },
      setVerticalAlignment: function(){ return this; },
      setHorizontalAlignment: function(){ return this; }
    }; },
      setColumnWidth: function(){ return this; },
      setFrozenRows: function(){ return this; } };
  };
  writeMatrix = function(name, headers, matrix) {
    const _stub = { getRange: function(){ return {
      setNumberFormat: function(){ return this; },
      setWrap: function(){ return this; },
      setVerticalAlignment: function(){ return this; },
      setFontColor: function(){ return this; },
      setFontWeight: function(){ return this; },
      setBackground: function(){ return this; }
    }; }, setColumnWidth: function(){ return this; },
      setFrozenRows: function(){ return this; } };
    const rows = matrix.map(line => {
      const o = {};
      headers.forEach((h, i) => o[h] = line[i]);
      return o;
    });
    __store[name] = { headers: headers.slice(), rows: rows };
    __written[name] = rows.length;
    return _stub;
  };
`, sandbox);
sandbox.__store = store;
sandbox.__written = {};

// =====================================================================
// monthStr: the column arrives as a string in one sheet and a Date in another
console.log('=== monthStr normalization ===');
const monthCases = [
  ['2026-08', '2026-08'],
  ['2026-8', '2026-08'],
  ['2026-08-01', '2026-08'],
  [new Date('2026-08-01T00:00:00'), '2026-08'],
  [new Date(2026, 6, 1), '2026-07'],
  ['', '']
];
let mOk = true;
monthCases.forEach(c => {
  sandbox.__mv = c[0];
  const got = vm.runInContext('monthStr(__mv)', sandbox);
  const ok = got === c[1];
  mOk = mOk && ok;
  const shown = Object.prototype.toString.call(c[0]) === '[object Date]'
    ? 'Date(' + c[0].toDateString() + ')' : JSON.stringify(c[0]);
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + shown + ' -> ' + JSON.stringify(got));
});
console.log(mOk ? '  All month formats normalize correctly.\n'
                : '  MONTH NORMALIZATION BROKEN\n');

// =====================================================================
// Parameter tab tests
// =====================================================================
const HDR = ['seccion', 'clave', 'valor', 'valor_2', 'nota'];

function goodParams() {
  const rows = [HDR];
  rows.push(['regla', 'dias_deal_estancado', 180, '', '']);
  rows.push(['regla', 'ventana_duplicados_dias', 7, '', '']);
  rows.push(['regla', 'fecha_de_corte', '2026-09-13', '', '']);
  rows.push(['tasa_ingreso', 'interchange', 0.0145, '', '']);
  rows.push(['tasa_ingreso', 'spread_fx', 0.0090, '', '']);
  rows.push(['tasa_ingreso', 'rendimiento_financiamiento', 0.0200, '', '']);
  rows.push(['tasa_ingreso', 'costo', 0.0045, '', '']);
  const fx = { BRL:5.40, MXN:18.20, COP:4100, CLP:940, PEN:3.75, ARS:1180,
               USD:1, CAD:1.37, GBP:0.79, EUR:0.92, PLN:3.95, AED:3.67 };
  Object.keys(fx).forEach(c => rows.push(['fx', c, fx[c], '', '']));
  const cc = { 'Brazil':'BRL','Mexico':'MXN','Colombia':'COP','Chile':'CLP',
    'Peru':'PEN','Argentina':'ARS','United States':'USD','Canada':'CAD',
    'United Kingdom':'GBP','Spain':'EUR','Germany':'EUR','Netherlands':'EUR',
    'France':'EUR','Poland':'PLN','United Arab Emirates':'AED','Ireland':'EUR',
    'Portugal':'EUR' };
  Object.keys(cc).forEach(k => rows.push(['pais_moneda', k, cc[k], '', '']));
  const bands = { 'Startup':[1000,40000], 'SMB':[5000,140000],
    'Mid-Market':[25000,600000], 'Enterprise':[100000,2400000] };
  Object.keys(bands).forEach(k =>
    rows.push(['banda_segmento', k, bands[k][0], bands[k][1], '']));
  return rows;
}

console.log('=== parameter validation ===');

function expectProblems(label, mutate) {
  const m = goodParams();
  mutate(m);
  PARAM_MATRIX = m;
  const problems = vm.runInContext('loadParams()', sandbox);
  console.log('  ' + label);
  problems.slice(0, 3).forEach(p => console.log('     -> ' + p));
  if (!problems.length) console.log('     -> NOT CAUGHT');
  return problems.length > 0;
}

let allCaught = true;
allCaught &= expectProblems('rate typed as a percentage',
  m => { m[4][2] = 1.45; });
allCaught &= expectProblems('FX cell left blank',
  m => { m.find(r => r[1] === 'COP')[2] = ''; });
allCaught &= expectProblems('country mapped to a currency with no rate',
  m => { m.push(['pais_moneda', 'Uruguay', 'UYU', '', '']); });
allCaught &= expectProblems('USD rate not 1',
  m => { m.find(r => r[1] === 'USD' && r[0] === 'fx')[2] = 4100; });
allCaught &= expectProblems('segment band inverted',
  m => { const b = m.find(r => r[0] === 'banda_segmento'); b[2] = 99999; b[3] = 1000; });
console.log(allCaught ? '  All five bad-parameter cases were caught.\n'
                      : '  SOME CASES SLIPPED THROUGH\n');

// A changed threshold has to move the number, or the tab is decorative
PARAM_MATRIX = goodParams();
PARAM_MATRIX.find(r => r[1] === 'dias_deal_estancado')[2] = 365;
vm.runInContext('loadParams()', sandbox);
console.log('=== stale threshold 365 days instead of 180 ===');
const alt = vm.runInContext('runCleanup()', sandbox);
const altWr = vm.runInContext('winRates(__store["deals_clean"].rows.filter(r => r.deal_source === "Partnerships"))', sandbox);
console.log('  stale flagged: ' + altWr.stale +
            '   conservative win rate: ' + altWr.conservative + '%\n');

// ---- run ----
PARAM_MATRIX = goodParams();
const t0 = Date.now();
const res = vm.runInContext('runCleanup()', sandbox);
const msg = vm.runInContext('runMetrics()', sandbox);
console.log('\n--- metrics ---\n' + msg);
console.log('\nRuntime: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

console.log('\n--- audit log from Apps Script ---');
store['audit_log'].rows.forEach(r =>
  console.log(String(r.rows).padStart(6) + '  ' + r.action.padEnd(11) + r.rule));

console.log('\n--- KPIs ---');
store['m_kpi'].rows.forEach(r => console.log('  ' + String(r.metric).padEnd(36) + r.value));

// ---- metric dictionary ----
const defs = vm.runInContext('metricDefinitions()', sandbox);
const metrics = defs.filter(d => !d.group);
const groups = defs.filter(d => d.group).length;
const missing = metrics.filter(d => !d.name || !d.plain || !d.formula || !d.source);
console.log('\n--- metric dictionary ---');
console.log('  ' + metrics.length + ' metrics in ' + groups + ' groups, ' +
            metrics.filter(d => d.decision).length + ' carrying a business decision');
console.log('  incomplete entries: ' + (missing.length || 'none'));
const staleNow = vm.runInContext('CFG.STALE_DAYS', sandbox);
const live = metrics.filter(d =>
  String(d.formula + (d.decision || '')).indexOf(String(staleNow)) >= 0);
console.log('  entries quoting the live stale threshold (' + staleNow + '): ' + live.length);

// the dictionary must follow the parametros tab, not a hardcoded string
PARAM_MATRIX = goodParams();
PARAM_MATRIX.find(r => r[1] === 'dias_deal_estancado')[2] = 365;
const defs365 = vm.runInContext('metricDefinitions()', sandbox);
const quotes365 = defs365.filter(d => !d.group &&
  String(d.formula + (d.decision || '')).indexOf('365') >= 0).length;
console.log('  after changing the tab to 365 days, entries quoting 365: ' + quotes365);
PARAM_MATRIX = goodParams();
vm.runInContext('loadParams()', sandbox);

console.log('\nSheets written: ' + Object.keys(sandbox.__written).length);
fs.writeFileSync(path + 'gas_audit_out.json',
  JSON.stringify({ audit: store['audit_log'].rows, kpi: store['m_kpi'].rows }, null, 1));
