/**
 * 05_Params.gs
 *
 * Lets the business edit the numbers that change without opening the code.
 *
 * A single tab named `parametros` drives the FX table, the country-to-currency
 * map, the revenue rates, the segment bands and the two rule thresholds.
 * On every run the pipeline reads that tab, validates it, and overwrites the
 * defaults in CFG.
 *
 * Validation is not decoration here. A blank FX cell or a rate typed as 1.45
 * instead of 0.0145 would not crash anything: it would silently produce a
 * dashboard that is wrong by two orders of magnitude. So a bad parameter
 * stops the run and says which cell is wrong.
 */

const PARAMS_SHEET = 'parametros';

const PARAM_HEADERS = ['seccion', 'clave', 'valor', 'valor_2', 'nota'];

/** Sections the loader understands. Anything else in the tab is ignored. */
const PARAM_SECTIONS = {
  FX: 'fx',
  COUNTRY: 'pais_moneda',
  RATE: 'tasa_ingreso',
  RULE: 'regla',
  BAND: 'banda_segmento'
};


/**
 * Build the parameters tab from the defaults in CFG.
 * Safe to run again: it asks before overwriting an existing tab.
 */
function createParamsSheet(force) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(PARAMS_SHEET);

  if (sh && !force) {
    const ui = SpreadsheetApp.getUi();
    const answer = ui.alert(
      'Parameters tab already exists',
      'Rebuilding it from the code defaults will discard any edits made in ' +
      'the tab. Continue?', ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) return;
  }
  if (!sh) sh = ss.insertSheet(PARAMS_SHEET);
  sh.clear();

  const rows = [];

  rows.push(['regla', 'dias_deal_estancado', CFG.STALE_DAYS, '',
             'Days open after which a referral counts as abandoned in the conservative win rate']);
  rows.push(['regla', 'ventana_duplicados_dias', CFG.DUPLICATE_WINDOW_DAYS, '',
             'Two rows are the same deal if entered within this many days']);
  rows.push(['regla', 'fecha_de_corte', CFG.AS_OF, '',
             'Reference date. Leave blank to use today']);

  rows.push(['tasa_ingreso', 'interchange', CFG.RATES.INTERCHANGE, '',
             'Share of card spend. 0.0145 = 1.45%']);
  rows.push(['tasa_ingreso', 'spread_fx', CFG.RATES.FX_SPREAD, '',
             'Applied to the cross-border share of spend']);
  rows.push(['tasa_ingreso', 'rendimiento_financiamiento', CFG.RATES.FIN_YIELD, '',
             'Monthly, on the revolved share of spend']);
  rows.push(['tasa_ingreso', 'costo', CFG.RATES.COST, '',
             'Network, processing and rewards, as a share of spend']);

  Object.keys(CFG.FX).forEach(cur => {
    rows.push(['fx', cur, CFG.FX[cur], '',
               CFG.CURRENCY_NAME[cur] || '']);
  });

  Object.keys(CFG.COUNTRY_CURRENCY).forEach(c => {
    rows.push(['pais_moneda', c, CFG.COUNTRY_CURRENCY[c], '', '']);
  });

  Object.keys(CFG.SEGMENT_BAND).forEach(s => {
    rows.push(['banda_segmento', s, CFG.SEGMENT_BAND[s][0], CFG.SEGMENT_BAND[s][1],
               'Plausible approved limit in USD; outside this band R14 flags the row']);
  });

  const out = [PARAM_HEADERS].concat(rows);
  sh.getRange(1, 1, out.length, PARAM_HEADERS.length).setValues(out);

  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, PARAM_HEADERS.length)
    .setFontWeight('bold').setBackground('#111015').setFontColor('#E0B65C');
  sh.getRange(2, 1, rows.length, 1).setFontColor('#8C877E');
  sh.getRange(2, 5, rows.length, 1).setFontColor('#8C877E').setFontSize(9);
  sh.getRange(2, 3, rows.length, 2).setHorizontalAlignment('right');
  sh.setColumnWidth(1, 130);
  sh.setColumnWidth(2, 190);
  sh.setColumnWidth(3, 90);
  sh.setColumnWidth(4, 90);
  sh.setColumnWidth(5, 420);
  sh.getRange(2, 5, rows.length, 1).setWrap(true);

  // FX cells carry more precision than the default display
  const fxStart = rows.findIndex(r => r[0] === 'fx') + 2;
  const fxCount = Object.keys(CFG.FX).length;
  sh.getRange(fxStart, 3, fxCount, 1).setNumberFormat('0.00####');

  const rateStart = rows.findIndex(r => r[0] === 'tasa_ingreso') + 2;
  sh.getRange(rateStart, 3, 4, 1).setNumberFormat('0.0000');

  return sh;
}


/**
 * Read the parameters tab and overwrite CFG. Returns a list of problems.
 * If the tab is missing the code defaults stand, which keeps the pipeline
 * runnable on a fresh copy.
 */
function loadParams() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(PARAMS_SHEET);
  if (!sh) {
    Logger.log('No ' + PARAMS_SHEET + ' tab; using code defaults. ' +
               'Run createParamsSheet() to create it.');
    return [];
  }

  const last = sh.getLastRow();
  if (last < 2) return ['The ' + PARAMS_SHEET + ' tab is empty'];

  const values = sh.getRange(2, 1, last - 1, PARAM_HEADERS.length).getValues();
  const problems = [];

  const fx = {}, countryCur = {}, bands = {};
  const rates = {}, rules = {};

  for (let i = 0; i < values.length; i++) {
    const rowNo = i + 2;
    const section = normText(values[i][0]);
    const key = String(values[i][1]).trim();
    const v1 = values[i][2];
    const v2 = values[i][3];
    if (!section || !key) continue;

    switch (section) {

      case PARAM_SECTIONS.FX: {
        const n = num(v1);
        if (n === null || n <= 0) {
          problems.push('Row ' + rowNo + ': FX rate for ' + key +
                        ' must be a number greater than zero (found "' + v1 + '")');
        } else {
          fx[key.toUpperCase()] = n;
        }
        break;
      }

      case PARAM_SECTIONS.COUNTRY: {
        const cur = String(v1).trim().toUpperCase();
        if (!cur) problems.push('Row ' + rowNo + ': ' + key + ' has no currency');
        else countryCur[key] = cur;
        break;
      }

      case PARAM_SECTIONS.RATE: {
        const n = num(v1);
        if (n === null) {
          problems.push('Row ' + rowNo + ': rate "' + key + '" is not a number');
        } else if (n < 0 || n > 1) {
          problems.push('Row ' + rowNo + ': rate "' + key + '" is ' + n +
                        '. Rates are decimals, so 1.45% is written 0.0145');
        } else {
          rates[key] = n;
        }
        break;
      }

      case PARAM_SECTIONS.RULE: {
        rules[key] = v1;
        break;
      }

      case PARAM_SECTIONS.BAND: {
        const lo = num(v1), hi = num(v2);
        if (lo === null || hi === null) {
          problems.push('Row ' + rowNo + ': segment band for ' + key +
                        ' needs a minimum and a maximum');
        } else if (lo >= hi) {
          problems.push('Row ' + rowNo + ': segment band for ' + key +
                        ' has a minimum (' + lo + ') above its maximum (' + hi + ')');
        } else {
          bands[key] = [lo, hi];
        }
        break;
      }
    }
  }

  // ---- cross-checks -------------------------------------------------
  Object.keys(countryCur).forEach(c => {
    if (!fx[countryCur[c]]) {
      problems.push('Country "' + c + '" maps to currency ' + countryCur[c] +
                    ', which has no FX rate in the tab');
    }
  });

  if (Object.keys(fx).length && !fx.USD) {
    problems.push('The FX table has no USD row. USD must be present with a rate of 1');
  } else if (fx.USD && fx.USD !== 1) {
    problems.push('USD is the reporting currency, so its FX rate must be 1 (found ' +
                  fx.USD + ')');
  }

  const staleDays = num(rules['dias_deal_estancado']);
  if (rules['dias_deal_estancado'] !== undefined &&
      (staleDays === null || staleDays < 1)) {
    problems.push('dias_deal_estancado must be a positive whole number');
  }
  const dupWindow = num(rules['ventana_duplicados_dias']);
  if (rules['ventana_duplicados_dias'] !== undefined &&
      (dupWindow === null || dupWindow < 0)) {
    problems.push('ventana_duplicados_dias must be zero or a positive number');
  }

  if (problems.length) return problems;

  // ---- apply --------------------------------------------------------
  if (Object.keys(fx).length) CFG.FX = fx;
  if (Object.keys(countryCur).length) CFG.COUNTRY_CURRENCY = countryCur;
  if (Object.keys(bands).length) CFG.SEGMENT_BAND = bands;

  if (rates['interchange'] !== undefined) CFG.RATES.INTERCHANGE = rates['interchange'];
  if (rates['spread_fx'] !== undefined) CFG.RATES.FX_SPREAD = rates['spread_fx'];
  if (rates['rendimiento_financiamiento'] !== undefined)
    CFG.RATES.FIN_YIELD = rates['rendimiento_financiamiento'];
  if (rates['costo'] !== undefined) CFG.RATES.COST = rates['costo'];

  if (staleDays !== null) CFG.STALE_DAYS = staleDays;
  if (dupWindow !== null) CFG.DUPLICATE_WINDOW_DAYS = dupWindow;

  const asOf = rules['fecha_de_corte'];
  if (asOf === '' || asOf === undefined || asOf === null) {
    CFG.AS_OF = null;
  } else {
    const d = toDate(asOf);
    if (!d) return ['fecha_de_corte is not a valid date: "' + asOf + '"'];
    CFG.AS_OF = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  Logger.log('Parameters loaded: ' + Object.keys(fx).length + ' currencies, ' +
             Object.keys(countryCur).length + ' countries, stale threshold ' +
             CFG.STALE_DAYS + ' days');
  return [];
}


/**
 * Load parameters or stop the run. Called at the top of each engine so a
 * typo in the tab never reaches a dashboard.
 */
function loadParamsOrThrow() {
  const problems = loadParams();
  if (problems.length) {
    throw new Error('Check the "' + PARAMS_SHEET + '" tab:\n  • ' +
                    problems.join('\n  • '));
  }
}


/** Menu action: validate the tab without running anything. */
function validateParams() {
  const ui = SpreadsheetApp.getUi();
  const problems = loadParams();
  if (!problems.length) {
    ui.alert('Parameters look good',
             Object.keys(CFG.FX).length + ' currencies, ' +
             Object.keys(CFG.COUNTRY_CURRENCY).length + ' countries.\n' +
             'Stale threshold ' + CFG.STALE_DAYS + ' days, duplicate window ' +
             CFG.DUPLICATE_WINDOW_DAYS + ' days.\n' +
             'Interchange ' + (CFG.RATES.INTERCHANGE * 100).toFixed(2) + '%, ' +
             'FX spread ' + (CFG.RATES.FX_SPREAD * 100).toFixed(2) + '%.',
             ui.ButtonSet.OK);
  } else {
    ui.alert('Problems in the parameters tab',
             '• ' + problems.join('\n• '), ui.ButtonSet.OK);
  }
}
