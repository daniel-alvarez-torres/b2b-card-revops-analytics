/**
 * 04_Menu.gs
 *
 * Entry points. Everything a person clicks lives here; the engines above
 * stay callable from a trigger, from clasp, or from another script.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('RevOps')
    .addItem('Run full pipeline', 'runAll')
    .addSeparator()
    .addItem('1. Clean data', 'menuCleanup')
    .addItem('2. Build metrics', 'menuMetrics')
    .addItem('3. Rewrite metrics as formulas', 'buildFormulaLayer')
    .addSeparator()
    .addItem('Open dashboard', 'showDashboard')
    .addItem('Show data quality summary', 'showQualitySummary')
    .addSeparator()
    .addItem('How every metric is calculated', 'showDefinitions')
    .addItem('Write metric dictionary to a tab', 'writeDefinitionsSheet')
    .addSeparator()
    .addItem('Check parameters', 'validateParams')
    .addItem('Rebuild parameters tab from defaults', 'createParamsSheet')
    .addToUi();
}


function runAll() {
  const ui = SpreadsheetApp.getUi();
  try {
    const c = runCleanup();
    const m = runMetrics();
    addDerivedColumns();
    const f = writeFormulaMetrics();
    const v = verifyFormulas();
    ui.alert('Pipeline complete',
             c.message + '\n\n' + m + '\n\nFormulas written for ' + f.month +
             '.\n' + v, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Pipeline failed', String(e), ui.ButtonSet.OK);
    throw e;
  }
}


function menuCleanup() {
  const r = runCleanup();
  SpreadsheetApp.getUi().alert('Cleanup complete', r.message,
                               SpreadsheetApp.getUi().ButtonSet.OK);
}


function menuMetrics() {
  const msg = runMetrics();
  SpreadsheetApp.getUi().alert('Metrics complete', msg,
                               SpreadsheetApp.getUi().ButtonSet.OK);
}


/**
 * A weekday trigger. Install once by running installTrigger().
 * Refreshing before the workday means nobody opens the dashboard and
 * wonders whether it is yesterday's number.
 */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runAll')
    .timeBased().atHour(6).everyDays(1).create();
}


/** Data quality summary, straight from the audit log. */
function showQualitySummary() {
  const log = readTable(CFG.SHEETS.AUDIT).rows;
  let q = 0, c = 0, f = 0;
  const lines = log.map(r => {
    const n = num(r.rows) || 0;
    if (r.action === 'QUARANTINE') q += n;
    else if (r.action === 'CORRECT') c += n;
    else f += n;
    return '  ' + String(n).padStart(6) + '  ' + r.rule;
  });
  const msg = lines.join('\n') +
    '\n\nQuarantined ' + q + '   corrected ' + c + '   flagged ' + f;
  SpreadsheetApp.getUi().alert('Data quality', msg,
                               SpreadsheetApp.getUi().ButtonSet.OK);
}


/**
 * Renders the dashboard in a modal, reading the metric sheets the engines
 * wrote. Same structure as the standalone HTML, so the two never drift.
 */
function showDashboard() {
  const t = HtmlService.createTemplateFromFile('Dashboard');
  t.data = collectDashboardData();
  SpreadsheetApp.getUi().showModalDialog(
    t.evaluate().setWidth(1100).setHeight(800),
    'Partnerships channel'
  );
}


/** Everything the dashboard template needs, in one object. */
function collectDashboardData() {
  const kpiRows = readTable(CFG.SHEETS.KPI).rows;
  const kpi = {};
  kpiRows.forEach(r => kpi[r.metric] = r.value);

  return {
    kpi: kpi,
    revenue:   readTable('m_revenue_build').rows,
    funnel:    readTable(CFG.SHEETS.FUNNEL).rows,
    trend:     readTable(CFG.SHEETS.TREND).rows,
    cohorts:   readTable(CFG.SHEETS.COHORTS).rows,
    markets:   readTable(CFG.SHEETS.MARKETS).rows,
    currencies:readTable(CFG.SHEETS.CURRENCIES).rows,
    ptypes:    readTable(CFG.SHEETS.PTYPES).rows,
    partners:  readTable(CFG.SHEETS.PARTNERS).rows.slice(0, 12),
    attainment:readTable(CFG.SHEETS.ATTAINMENT).rows,
    ramp:      readTable('m_ramp').rows,
    segments:  readTable(CFG.SHEETS.SEGMENTS).rows,
    products:  readTable(CFG.SHEETS.PRODUCTS).rows,
    losses:    readTable(CFG.SHEETS.LOSSES).rows,
    audit:     readTable(CFG.SHEETS.AUDIT).rows
  };
}


/**
 * Import the four source CSVs from a Drive folder. Use this once to load
 * the synthetic files, or point it at a folder that a scheduled HubSpot
 * export drops into.
 */
function importCsvsFromFolder(folderId) {
  const map = {
    'hubspot_deals_export_RAW.csv': CFG.SHEETS.DEALS_RAW,
    'account_usage_RAW.csv':        CFG.SHEETS.USAGE_RAW,
    'rep_quotas.csv':               CFG.SHEETS.QUOTAS,
    'reps.csv':                     CFG.SHEETS.REPS
  };
  const folder = DriveApp.getFolderById(folderId);
  const loaded = [];

  Object.keys(map).forEach(fileName => {
    const it = folder.getFilesByName(fileName);
    if (!it.hasNext()) return;
    const csv = it.next().getBlob().getDataAsString();
    const data = Utilities.parseCsv(csv);
    if (!data.length) return;

    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(map[fileName]);
    if (!sh) sh = ss.insertSheet(map[fileName]);
    sh.clear();
    sh.getRange(1, 1, data.length, data[0].length).setValues(data);
    sh.setFrozenRows(1);
    loaded.push(fileName + ' (' + (data.length - 1) + ' rows)');
  });

  Logger.log('Loaded:\n' + loaded.join('\n'));
  return loaded;
}
