/**
 * 07_Formulas.gs
 *
 * Rewrites the metric sheets as live spreadsheet formulas pointing at
 * deals_clean and usage_clean, instead of numbers the script computed and
 * pasted in.
 *
 * Why it matters: a pasted number is an assertion. A formula is an argument
 * anyone can click into and follow back to the rows behind it. When someone
 * asks "where does 32.9% come from", the answer should be visible in the
 * cell, not in a script they cannot open.
 *
 * Two layers:
 *   1. addDerivedColumns()   appends ARRAYFORMULA columns to the clean tables
 *                            (won/lost/stale flags, revenue lines, cohort,
 *                            owner) so the metric formulas have something
 *                            simple to aggregate over
 *   2. writeFormulaMetrics() rewrites each m_* sheet with SUMIFS / COUNTIFS
 *
 * One ARRAYFORMULA per column rather than one formula per row: 26,000 rows
 * times eight columns would be 208,000 formulas and a spreadsheet that
 * recalculates for a minute. Eight array formulas recalculate instantly.
 *
 * Then verifyFormulas() reads the formula results back and compares them with
 * what the JavaScript computed. Two independent implementations that agree is
 * evidence; one implementation is a hope.
 */


/** Column letter for a 1-based index: 1 -> A, 27 -> AA. */
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}


/** Map of header name -> column letter for a sheet. */
function colMap(sheetName) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  if (!sh) throw new Error('Sheet not found: ' + sheetName);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const m = {};
  headers.forEach((h, i) => {
    const name = String(h).trim();
    if (name) m[name] = colLetter(i + 1);
  });
  m._lastCol = sh.getLastColumn();
  m._lastRow = sh.getLastRow();
  m._sheet = sh;
  return m;
}


/** A1 range for a whole data column, header excluded. */
function dataRange(sheetName, letter, lastRow) {
  return "'" + sheetName + "'!" + letter + '2:' + letter + lastRow;
}


/**
 * Reference to a rate in the parametros tab, by its key. Written as INDEX/MATCH
 * so the formula follows the tab rather than freezing a number into itself.
 */
function paramRef(key) {
  return "INDEX(parametros!$C:$C,MATCH(\"" + key + "\",parametros!$B:$B,0))";
}


// =====================================================================
// Layer 1: derived columns
// =====================================================================

function addDerivedColumns() {
  loadParamsOrThrow();
  const ss = SpreadsheetApp.getActive();
  const DC = CFG.SHEETS.DEALS_CLEAN;
  const UC = CFG.SHEETS.USAGE_CLEAN;

  // ---------- deals_clean ----------
  let d = colMap(DC);
  const dLast = d._lastRow;
  let col = d._lastCol;

  const dealCols = [
    ['is_won',
     '=ARRAYFORMULA(IF(ROW(A2:A' + dLast + ')>' + dLast + ',"",' +
     'IF(' + d.dealstage + '2:' + d.dealstage + dLast + '="Closed Won",1,0)))'],

    ['is_lost',
     '=ARRAYFORMULA(IF(ROW(A2:A' + dLast + ')>' + dLast + ',"",' +
     'IF(' + d.dealstage + '2:' + d.dealstage + dLast + '="Closed Lost",1,0)))'],

    // Stale is recomputed here from the threshold in parametros, not copied
    // from the _flags column, so changing the threshold moves this too.
    ['is_stale',
     '=ARRAYFORMULA(IF(ROW(A2:A' + dLast + ')>' + dLast + ',"",' +
     'IF((' + d.dealstage + '2:' + d.dealstage + dLast + '<>"Closed Won")*' +
     '(' + d.dealstage + '2:' + d.dealstage + dLast + '<>"Closed Lost")*' +
     '((' + paramRef('fecha_de_corte') + '-' +
     d.createdate + '2:' + d.createdate + dLast + ')>' +
     paramRef('dias_deal_estancado') + '),1,0)))'],

    ['is_open_live',
     '=ARRAYFORMULA(IF(ROW(A2:A' + dLast + ')>' + dLast + ',"",' +
     'IF((' + d.dealstage + '2:' + d.dealstage + dLast + '<>"Closed Won")*' +
     '(' + d.dealstage + '2:' + d.dealstage + dLast + '<>"Closed Lost"),1,0)))']
  ];

  dealCols.forEach(c => {
    col++;
    d._sheet.getRange(1, col).setValue(c[0]);
    d._sheet.getRange(2, col).setFormula(c[1]);
  });
  d._sheet.getRange(1, d._lastCol + 1, 1, dealCols.length)
    .setFontWeight('bold').setBackground('#0D1716').setFontColor('#5F9E97');

  SpreadsheetApp.flush();
  d = colMap(DC);

  // ---------- usage_clean ----------
  let u = colMap(UC);
  const uLast = u._lastRow;
  let ucol = u._lastCol;

  const sp = "'" + UC + "'!" + u.spend_usd + '2:' + u.spend_usd + uLast;
  const xb = "'" + UC + "'!" + u.cross_border_share + '2:' + u.cross_border_share + uLast;
  const rv = "'" + UC + "'!" + u.revolved_share + '2:' + u.revolved_share + uLast;
  const guard = 'IF(ROW(A2:A' + uLast + ')>' + uLast + ',"",';

  const usageCols = [
    ['interchange_usd',
     '=ARRAYFORMULA(' + guard + sp + '*' + paramRef('interchange') + '))'],

    ['fx_revenue_usd',
     '=ARRAYFORMULA(' + guard + sp + '*' + xb + '*' + paramRef('spread_fx') + '))'],

    ['financing_usd',
     '=ARRAYFORMULA(' + guard + sp + '*' + rv + '*' +
     paramRef('rendimiento_financiamiento') + '))'],

    ['cost_usd',
     '=ARRAYFORMULA(' + guard + sp + '*' + paramRef('costo') + '))'],

    // Owner comes from the deal, so attainment can be aggregated without a
    // second lookup in every downstream formula.
    ['owner',
     '=ARRAYFORMULA(' + guard + 'IFERROR(INDEX(' +
     dataRange(CFG.SHEETS.DEALS_CLEAN, d.hubspot_owner_id, d._lastRow) +
     ',MATCH(' + u.record_id + '2:' + u.record_id + uLast + ',' +
     dataRange(CFG.SHEETS.DEALS_CLEAN, d.record_id, d._lastRow) + ',0)),"")))'],

    ['quarter',
     '=ARRAYFORMULA(' + guard + 'LEFT(' + u.month + '2:' + u.month + uLast +
     ',4)&"Q"&ROUNDUP(VALUE(MID(' + u.month + '2:' + u.month + uLast +
     ',6,2))/3,0)))'],

    // Quarter the account was activated in, blank if the deal never closed won.
    // Attainment needs it: the quota is on new volume, so the actual has to be
    // restricted to accounts the rep brought in during the quarter, not the
    // whole book they happen to own.
    ['activation_quarter', (function () {
      const ids = u.record_id + '2:' + u.record_id + uLast;
      const key = ',MATCH(' + ids + ',' +
        dataRange(CFG.SHEETS.DEALS_CLEAN, d.record_id, d._lastRow) + ',0))';
      const stage = 'INDEX(' +
        dataRange(CFG.SHEETS.DEALS_CLEAN, d.dealstage, d._lastRow) + key;
      const cd = 'INDEX(' +
        dataRange(CFG.SHEETS.DEALS_CLEAN, d.closedate, d._lastRow) + key;
      return '=ARRAYFORMULA(' + guard + 'IFERROR(IF(' + stage + '="Closed Won",' +
        'YEAR(' + cd + ')&"Q"&ROUNDUP(MONTH(' + cd + ')/3,0),""),"")))';
    })()]
  ];

  usageCols.forEach(c => {
    ucol++;
    u._sheet.getRange(1, ucol).setValue(c[0]);
    u._sheet.getRange(2, ucol).setFormula(c[1]);
  });

  // net_revenue depends on the four lines above, so it is added after them
  SpreadsheetApp.flush();
  u = colMap(UC);
  ucol++;
  u._sheet.getRange(1, ucol).setValue('net_revenue_usd');
  u._sheet.getRange(2, ucol).setFormula(
    '=ARRAYFORMULA(' + guard +
    u.interchange_usd + '2:' + u.interchange_usd + uLast + '+' +
    u.fx_revenue_usd + '2:' + u.fx_revenue_usd + uLast + '+' +
    u.financing_usd + '2:' + u.financing_usd + uLast + '-' +
    u.cost_usd + '2:' + u.cost_usd + uLast + '))');

  u._sheet.getRange(1, u._lastCol - usageCols.length + 1, 1, usageCols.length + 1)
    .setFontWeight('bold').setBackground('#0D1716').setFontColor('#5F9E97');

  SpreadsheetApp.flush();
  Logger.log('Derived columns added: ' + dealCols.length + ' on ' + DC +
             ', ' + (usageCols.length + 1) + ' on ' + UC);
}


// =====================================================================
// Layer 2: metric sheets as formulas
// =====================================================================

function writeFormulaMetrics() {
  loadParamsOrThrow();
  const DC = CFG.SHEETS.DEALS_CLEAN;
  const UC = CFG.SHEETS.USAGE_CLEAN;
  const d = colMap(DC);
  const u = colMap(UC);

  if (!d.is_won || !u.net_revenue_usd) {
    throw new Error('Derived columns are missing. Run addDerivedColumns() first.');
  }

  const dR = n => dataRange(DC, d[n], d._lastRow);
  const uR = n => dataRange(UC, u[n], u._lastRow);

  // Reference month: last complete month present in usage_clean
  const months = SpreadsheetApp.getActive().getSheetByName(UC)
    .getRange(2, columnIndexOf(u.month), u._lastRow - 1, 1).getValues()
    .map(r => monthStr(r[0]));
  const uniq = Array.from(new Set(months)).sort();
  const LAST = uniq.length > 1 ? uniq[uniq.length - 2] : uniq[0];
  const LASTQ = LAST.slice(0, 4) + 'Q' + Math.ceil(Number(LAST.slice(5, 7)) / 3);

  const P = '"Partnerships"';
  const M = '"' + LAST + '"';

  // ---------------- m_kpi ----------------
  const wonP  = 'SUMIFS(' + dR('is_won')  + ',' + dR('deal_source') + ',' + P + ')';
  const lostP = 'SUMIFS(' + dR('is_lost') + ',' + dR('deal_source') + ',' + P + ')';
  const stalP = 'SUMIFS(' + dR('is_stale') + ',' + dR('deal_source') + ',' + P + ')';
  const spendM = 'SUMIFS(' + uR('spend_usd') + ',' + uR('month') + ',' + M +
                 ',' + uR('deal_source') + ',' + P + ')';
  const netM   = 'SUMIFS(' + uR('net_revenue_usd') + ',' + uR('month') + ',' + M +
                 ',' + uR('deal_source') + ',' + P + ')';

  const kpi = [
    ['Reference month', '="' + LAST + '"'],
    ['Card spend, partnerships', '=' + spendM],
    ['Modelled net revenue', '=' + netM],
    ['Net take rate on spend %', '=IFERROR(' + netM + '/' + spendM + '*100,0)'],
    ['Accounts transacting', '=COUNTIFS(' + uR('month') + ',' + M + ',' +
      uR('deal_source') + ',' + P + ')'],
    ['Win rate, closed only %',
      '=IFERROR(' + wonP + '/(' + wonP + '+' + lostP + ')*100,0)'],
    ['Win rate, conservative %',
      '=IFERROR(' + wonP + '/(' + wonP + '+' + lostP + '+' + stalP + ')*100,0)'],
    ['Win rate gap, points',
      '=IFERROR(' + wonP + '/(' + wonP + '+' + lostP + ')*100-' +
      wonP + '/(' + wonP + '+' + lostP + '+' + stalP + ')*100,0)'],
    ['Stale open referrals', '=' + stalP],
    ['Approved limit in live pipeline',
      '=SUMIFS(' + dR('approved_limit_usd') + ',' + dR('deal_source') + ',' + P +
      ',' + dR('is_open_live') + ',1,' + dR('is_stale') + ',0)'],
    ['Live deals', '=COUNTIFS(' + dR('deal_source') + ',' + P + ',' +
      dR('is_open_live') + ',1,' + dR('is_stale') + ',0)'],
    ['Median days referral to close',
      '=IFERROR(MEDIAN(IF((' + dR('deal_source') + '=' + P + ')*(' +
      dR('is_won') + '=1),' + dR('days_to_close') + ')),0)'],
    ['Share of deals via partners %',
      '=COUNTIF(' + dR('deal_source') + ',' + P + ')/COUNTA(' +
      dR('record_id') + ')*100'],
    ['Deals in reportable universe', '=COUNTA(' + dR('record_id') + ')'],
    ['Account-months', '=COUNTA(' + uR('record_id') + ')'],
    ['Countries', '=COUNTA(UNIQUE(' + dR('country') + '))'],
    ['Currencies', '=COUNTA(UNIQUE(' + dR('deal_currency_code') + '))']
  ];
  writeFormulaSheet(CFG.SHEETS.KPI, ['metric', 'value'], kpi, [12]);

  // The median needs array evaluation
  const kpiSh = SpreadsheetApp.getActive().getSheetByName(CFG.SHEETS.KPI);
  kpiSh.getRange(13, 2).setFormula(kpi[11][1].replace('=', '=ARRAYFORMULA(') + ')');

  // ---------------- m_revenue_build ----------------
  const line = c => 'SUMIFS(' + uR(c) + ',' + uR('month') + ',' + M + ',' +
                    uR('deal_source') + ',' + P + ')';
  writeFormulaSheet('m_revenue_build', ['line', 'usd', 'type'], [
    ['Card spend', '=' + spendM, 'base'],
    ['Interchange', '=' + line('interchange_usd'), 'up'],
    ['FX spread', '=' + line('fx_revenue_usd'), 'up'],
    ['Financing', '=' + line('financing_usd'), 'up'],
    ['Network, processing, rewards', '=-' + line('cost_usd'), 'down'],
    ['Net revenue', '=' + netM, 'total']
  ]);

  // ---------------- m_funnel ----------------
  // Stage order lives in a helper column so COUNTIFS can compare against it
  const stageIdx = {};
  CFG.STAGES.forEach((s, i) => stageIdx[s] = i);
  const funnelRows = CFG.STAGES.map((s, i) => {
    const atOrBeyond = i === 0
      ? 'COUNTIF(' + dR('deal_source') + ',' + P + ')'
      : CFG.STAGES.slice(i).concat(['Closed Won'])
          .filter((v, k, a) => a.indexOf(v) === k)
          .map(st => 'COUNTIFS(' + dR('deal_source') + ',' + P + ',' +
                     dR('dealstage') + ',"' + st + '")').join('+');
    return [s, '=' + atOrBeyond, '', ''];
  });
  writeFormulaSheet(CFG.SHEETS.FUNNEL,
    ['stage', 'deals', 'conv_from_prior_pct', 'pct_of_top'], funnelRows);
  const fSh = SpreadsheetApp.getActive().getSheetByName(CFG.SHEETS.FUNNEL);
  for (let i = 0; i < CFG.STAGES.length; i++) {
    const r = i + 2;
    if (i > 0) fSh.getRange(r, 3).setFormula('=IFERROR(B' + r + '/B' + (r - 1) + '*100,0)');
    fSh.getRange(r, 4).setFormula('=IFERROR(B' + r + '/$B$2*100,0)');
  }

  // ---------------- m_markets ----------------
  const countries = uniqueValues(DC, d.country, d._lastRow);
  const mktRows = countries.map(c => {
    const q = '"' + c + '"';
    const sAll = 'SUMIFS(' + uR('spend_usd') + ',' + uR('month') + ',' + M + ',' +
                 uR('country') + ',' + q + ')';
    const sPar = 'SUMIFS(' + uR('spend_usd') + ',' + uR('month') + ',' + M + ',' +
                 uR('country') + ',' + q + ',' + uR('deal_source') + ',' + P + ')';
    return [c,
      '=IFERROR(INDEX(' + dR('region') + ',MATCH(' + q + ',' + dR('country') + ',0)),"")',
      '=IFERROR(INDEX(parametros!$C:$C,MATCH(' + q + ',parametros!$B:$B,0)),"")',
      '=COUNTIFS(' + uR('month') + ',' + M + ',' + uR('country') + ',' + q + ')',
      '=' + sAll,
      '=SUMIFS(' + uR('net_revenue_usd') + ',' + uR('month') + ',' + M + ',' +
        uR('country') + ',' + q + ')',
      '=IFERROR(' + sPar + '/' + sAll + '*100,0)'];
  });
  writeFormulaSheet(CFG.SHEETS.MARKETS,
    ['country', 'region', 'currency', 'accounts', 'spend_usd',
     'net_revenue_usd', 'partner_share_pct'], mktRows);

  // ---------------- m_partner_types ----------------
  const types = uniqueValues(DC, d.partner_type, d._lastRow);
  const ptRows = types.map(t => {
    const q = '"' + t + '"';
    const w = 'SUMIFS(' + dR('is_won') + ',' + dR('partner_type') + ',' + q + ')';
    const l = 'SUMIFS(' + dR('is_lost') + ',' + dR('partner_type') + ',' + q + ')';
    const z = 'SUMIFS(' + dR('is_stale') + ',' + dR('partner_type') + ',' + q + ')';
    return [t,
      '=COUNTIF(' + dR('partner_type') + ',' + q + ')',
      '=' + w,
      '=IFERROR(' + w + '/(' + w + '+' + l + ')*100,0)',
      '=IFERROR(' + w + '/(' + w + '+' + l + '+' + z + ')*100,0)',
      '', // gap, filled below as a cell-to-cell difference
      '=IFERROR(ARRAYFORMULA(MEDIAN(IF((' + dR('partner_type') + '=' + q +
        ')*(' + dR('is_won') + '=1),' + dR('days_to_close') + '))),0)',
      '=SUMIFS(' + uR('spend_usd') + ',' + uR('month') + ',' + M + ',' +
        uR('partner_type') + ',' + q + ')'];
  });
  writeFormulaSheet(CFG.SHEETS.PTYPES,
    ['partner_type', 'referrals', 'won', 'wr_closed_pct', 'wr_conservative_pct',
     'gap_points', 'median_cycle_days', 'spend_usd'], ptRows);
  const ptSh = SpreadsheetApp.getActive().getSheetByName(CFG.SHEETS.PTYPES);
  for (let i = 0; i < types.length; i++) {
    ptSh.getRange(i + 2, 6).setFormula('=D' + (i + 2) + '-E' + (i + 2));
  }

  // ---------------- m_segments ----------------
  const segOrder = ['Startup', 'SMB', 'Mid-Market', 'Enterprise'];
  const segs = uniqueValues(DC, d.segment, d._lastRow)
    .sort((a, b) => segOrder.indexOf(a) - segOrder.indexOf(b));
  const segRows = segs.map(s => {
    const q = '"' + s + '"';
    const w = 'SUMIFS(' + dR('is_won') + ',' + dR('segment') + ',' + q + ',' +
              dR('deal_source') + ',' + P + ')';
    const l = 'SUMIFS(' + dR('is_lost') + ',' + dR('segment') + ',' + q + ',' +
              dR('deal_source') + ',' + P + ')';
    const sp = 'SUMIFS(' + uR('spend_usd') + ',' + uR('month') + ',' + M + ',' +
               uR('segment') + ',' + q + ',' + uR('deal_source') + ',' + P + ')';
    const ac = 'COUNTIFS(' + uR('month') + ',' + M + ',' + uR('segment') + ',' + q +
               ',' + uR('deal_source') + ',' + P + ')';
    return [s,
      '=COUNTIFS(' + dR('segment') + ',' + q + ',' + dR('deal_source') + ',' + P + ')',
      '=IFERROR(' + w + '/(' + w + '+' + l + ')*100,0)',
      '=IFERROR(ARRAYFORMULA(MEDIAN(IF((' + dR('segment') + '=' + q + ')*(' +
        dR('is_won') + '=1),' + dR('days_to_close') + '))),0)',
      '=IFERROR(' + sp + '/' + ac + ',0)',
      '=' + sp];
  });
  writeFormulaSheet(CFG.SHEETS.SEGMENTS,
    ['segment', 'referrals', 'wr_closed_pct', 'median_cycle_days',
     'spend_per_account_usd', 'spend_usd'], segRows);

  // ---------------- m_products ----------------
  const prods = uniqueValues(UC, u.product_line, u._lastRow);
  const prodRows = prods.map(p => {
    const q = '"' + p + '"';
    const sp = 'SUMIFS(' + uR('spend_usd') + ',' + uR('month') + ',' + M + ',' +
               uR('product_line') + ',' + q + ',' + uR('deal_source') + ',' + P + ')';
    const nr = 'SUMIFS(' + uR('net_revenue_usd') + ',' + uR('month') + ',' + M + ',' +
               uR('product_line') + ',' + q + ',' + uR('deal_source') + ',' + P + ')';
    return [p,
      '=COUNTIFS(' + uR('month') + ',' + M + ',' + uR('product_line') + ',' + q +
        ',' + uR('deal_source') + ',' + P + ')',
      '=' + sp, '=' + nr, '=IFERROR(' + nr + '/' + sp + '*100,0)'];
  });
  writeFormulaSheet(CFG.SHEETS.PRODUCTS,
    ['product_line', 'accounts', 'spend_usd', 'net_revenue_usd', 'take_rate_pct'],
    prodRows);

  // ---------------- m_currency_exposure ----------------
  const curs = uniqueValues(UC, u.currency, u._lastRow);
  const totalM = 'SUMIFS(' + uR('spend_usd') + ',' + uR('month') + ',' + M + ')';
  const curRows = curs.map(c => {
    const q = '"' + c + '"';
    const s = 'SUMIFS(' + uR('spend_usd') + ',' + uR('month') + ',' + M + ',' +
              uR('currency') + ',' + q + ')';
    return [c,
      '=IFERROR(INDEX(parametros!$E:$E,MATCH(' + q + ',parametros!$B:$B,0)),"")',
      '=' + s, '=IFERROR(' + s + '/' + totalM + '*100,0)'];
  });
  writeFormulaSheet(CFG.SHEETS.CURRENCIES,
    ['currency', 'name', 'spend_usd', 'share_pct'], curRows);

  // ---------------- m_loss_reasons ----------------
  const reasons = uniqueValues(DC, d.closed_lost_reason, d._lastRow)
    .filter(String);
  const lostTotal = 'COUNTIFS(' + dR('deal_source') + ',' + P + ',' +
                    dR('dealstage') + ',"Closed Lost")';
  const lossRows = reasons.map(r => {
    const q = '"' + r + '"';
    const n = 'COUNTIFS(' + dR('deal_source') + ',' + P + ',' +
              dR('dealstage') + ',"Closed Lost",' + dR('closed_lost_reason') + ',' + q + ')';
    return [r, '=' + n, '=IFERROR(' + n + '/' + lostTotal + '*100,0)'];
  });
  const blank = 'COUNTIFS(' + dR('deal_source') + ',' + P + ',' +
                dR('dealstage') + ',"Closed Lost",' + dR('closed_lost_reason') + ',"")';
  lossRows.push(['Not recorded', '=' + blank,
                 '=IFERROR(' + blank + '/' + lostTotal + '*100,0)']);
  writeFormulaSheet(CFG.SHEETS.LOSSES, ['reason', 'deals', 'share_pct'], lossRows);

  // ---------------- m_trend ----------------
  const trendRows = uniq.map(m => {
    const q = '"' + m + '"';
    return [m,
      '=SUMIFS(' + uR('spend_usd') + ',' + uR('month') + ',' + q + ',' +
        uR('deal_source') + ',' + P + ')',
      '=SUMIFS(' + uR('spend_usd') + ',' + uR('month') + ',' + q + ',' +
        uR('deal_source') + ',"Direct")',
      '=SUMIFS(' + uR('spend_usd') + ',' + uR('month') + ',' + q + ')',
      '=SUMIFS(' + uR('net_revenue_usd') + ',' + uR('month') + ',' + q + ')'];
  });
  writeFormulaSheet(CFG.SHEETS.TREND,
    ['month', 'partnerships_usd', 'direct_usd', 'total_usd', 'net_revenue_usd'],
    trendRows);

  // ---------------- m_attainment ----------------
  const owners = uniqueValues(UC, u.owner, u._lastRow).filter(String);
  const attRows = owners.map(o => {
    const q = '"' + o + '"';
    // Three criteria, not two: spend in the quarter, owned by this rep, from an
    // account activated in that same quarter. And the divisor is the months
    // that rep's new accounts actually transacted in, which is what the engine
    // divides by; a fixed quarter length would quietly punish anyone who
    // activated an account in the third month.
    const filt = ',' + uR('quarter') + ',"' + LASTQ + '",' + uR('owner') + ',' + q +
                 ',' + uR('activation_quarter') + ',"' + LASTQ + '"';
    const actual = 'IFERROR(SUMIFS(' + uR('spend_usd') + filt + ')/' +
                   'MAX(1,COUNTUNIQUEIFS(' + uR('month') + filt + ')),0)';
    const quota = 'IFERROR(SUMIFS(rep_quotas!$D$2:$D,rep_quotas!$A$2:$A,"' + LASTQ +
                  '",rep_quotas!$B$2:$B,' + q + '),0)';
    return [o,
      '=IFERROR(INDEX(reps!$B$2:$B,MATCH(' + q + ',reps!$A$2:$A,0)),"")',
      '=IFERROR(ROUND((' + paramRef('fecha_de_corte') +
        '-INDEX(reps!$C$2:$C,MATCH(' + q + ',reps!$A$2:$A,0)))/30.4,0),"")',
      '=' + quota,
      '=' + actual,
      '=IFERROR((' + actual + ')/(' + quota + ')*100,0)'];
  });
  writeFormulaSheet(CFG.SHEETS.ATTAINMENT,
    ['owner', 'region', 'tenure_months', 'quota_monthly_usd',
     'actual_monthly_usd', 'attainment_pct'], attRows);

  applyNumberFormats();

  SpreadsheetApp.flush();
  Logger.log('Metric sheets rewritten as formulas. Reference month ' + LAST);
  return { month: LAST, quarter: LASTQ };
}


/**
 * Number formats for the metric sheets.
 *
 * A formula returns full float precision: 32.93522267206478 is the same number
 * as 32.9%, but only one of them can be read aloud in a meeting. Formatting is
 * applied to the cell, not baked into the formula with ROUND(), so the
 * underlying precision survives for anything that aggregates these sheets
 * later.
 */
function applyNumberFormats() {
  const PCT = '0.0"%"';
  const PCT2 = '0.00"%"';
  const USD = '$#,##0';
  const INT = '#,##0';
  const DEC = '0.0';

  const spec = {};
  spec[CFG.SHEETS.FUNNEL]     = { B: INT, C: PCT, D: PCT };
  spec[CFG.SHEETS.MARKETS]    = { D: INT, E: USD, F: USD, G: PCT };
  spec[CFG.SHEETS.PTYPES]     = { B: INT, C: INT, D: PCT, E: PCT, F: DEC,
                                  G: INT, H: USD };
  spec[CFG.SHEETS.PARTNERS]   = { C: INT, D: INT, E: PCT, F: USD };
  spec[CFG.SHEETS.SEGMENTS]   = { B: INT, C: PCT, D: INT, E: USD, F: USD };
  spec[CFG.SHEETS.PRODUCTS]   = { B: INT, C: USD, D: USD, E: PCT2 };
  spec[CFG.SHEETS.CURRENCIES] = { C: USD, D: PCT };
  spec[CFG.SHEETS.LOSSES]     = { B: INT, C: PCT };
  spec[CFG.SHEETS.TREND]      = { B: USD, C: USD, D: USD, E: USD };
  spec[CFG.SHEETS.ATTAINMENT] = { C: INT, D: USD, E: USD, F: PCT };
  spec['m_revenue_build']     = { B: USD };
  spec['m_ramp']              = { B: INT, C: PCT };

  const ss = SpreadsheetApp.getActive();
  Object.keys(spec).forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    const n = sh.getLastRow() - 1;
    Object.keys(spec[name]).forEach(col => {
      sh.getRange(col + '2:' + col + sh.getLastRow()).setNumberFormat(spec[name][col]);
    });
  });

  // m_kpi is a two-column list, so its format depends on the metric name
  const kpiSh = ss.getSheetByName(CFG.SHEETS.KPI);
  if (kpiSh && kpiSh.getLastRow() > 1) {
    const names = kpiSh.getRange(2, 1, kpiSh.getLastRow() - 1, 1).getValues();
    for (let i = 0; i < names.length; i++) {
      const label = String(names[i][0]);
      let f = INT;
      if (/%$/.test(label)) f = /take rate/i.test(label) ? PCT2 : PCT;
      else if (/points$/.test(label)) f = DEC;
      else if (/spend|revenue|limit/i.test(label)) f = USD;
      else if (/^Reference month$/.test(label)) f = '@';
      kpiSh.getRange(i + 2, 2).setNumberFormat(f);
    }
  }

  // The cohort grid is an index, not a percentage
  const cohSh = ss.getSheetByName(CFG.SHEETS.COHORTS);
  if (cohSh && cohSh.getLastRow() > 1 && cohSh.getLastColumn() > 2) {
    cohSh.getRange(2, 3, cohSh.getLastRow() - 1, cohSh.getLastColumn() - 2)
         .setNumberFormat('0');
  }
}


/** Distinct non-empty values of a column, in first-seen order. */
function uniqueValues(sheetName, letter, lastRow) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  const vals = sh.getRange(2, columnIndexOf(letter), lastRow - 1, 1).getValues();
  const seen = new Set();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i][0];
    if (v === '' || v === null || v === undefined) continue;
    const s = String(v);
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}


/** Column index from a letter: A -> 1, AA -> 27. */
function columnIndexOf(letter) {
  let n = 0;
  for (let i = 0; i < letter.length; i++) {
    n = n * 26 + (letter.charCodeAt(i) - 64);
  }
  return n;
}


/**
 * Writes a sheet where cells starting with "=" become formulas and everything
 * else becomes a literal.
 */
function writeFormulaSheet(name, headers, rows, skipCols) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();

  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) {
    const body = rows.map(r => {
      const line = new Array(headers.length);
      for (let c = 0; c < headers.length; c++) {
        const v = r[c];
        line[c] = (v === undefined || v === null) ? '' : v;
      }
      return line;
    });
    // setValues interprets a leading "=" as a formula, so one call does both
    sh.getRange(2, 1, body.length, headers.length).setValues(body);
  }
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setBackground('#111015').setFontColor('#E0B65C');
  return sh;
}


// =====================================================================
// Verification
// =====================================================================

/**
 * Compares what the formulas evaluate to against what runMetrics computed in
 * JavaScript. Two independent implementations that agree is evidence; one is
 * a hope.
 *
 * Run runMetrics() first (values), then addDerivedColumns() and
 * writeFormulaMetrics() (formulas), then this.
 */
function verifyFormulas() {
  SpreadsheetApp.flush();
  const checks = [];

  const kpi = readTable(CFG.SHEETS.KPI).rows;
  const byMetric = {};
  kpi.forEach(r => byMetric[r.metric] = r.value);

  // Recompute the same handful in JavaScript, straight from the clean tables
  const deals = readTable(CFG.SHEETS.DEALS_CLEAN).rows;
  const usage = readTable(CFG.SHEETS.USAGE_CLEAN).rows;
  const P = deals.filter(r => r.deal_source === 'Partnerships');
  const wr = winRates(P);

  const months = Array.from(new Set(usage.map(r => monthStr(r.month)))).sort();
  const LAST = months.length > 1 ? months[months.length - 2] : months[0];
  const lastP = usage.filter(r =>
    monthStr(r.month) === LAST && r.deal_source === 'Partnerships');

  checks.push(['Win rate, closed only %', wr.closedOnly,
               num(byMetric['Win rate, closed only %'])]);
  checks.push(['Win rate, conservative %', wr.conservative,
               num(byMetric['Win rate, conservative %'])]);
  checks.push(['Stale open referrals', wr.stale,
               num(byMetric['Stale open referrals'])]);
  checks.push(['Card spend, partnerships',
               round(sumBy(lastP, r => num(r.spend_usd) || 0), 0),
               round(num(byMetric['Card spend, partnerships']) || 0, 0)]);
  checks.push(['Deals in reportable universe', deals.length,
               num(byMetric['Deals in reportable universe'])]);
  checks.push(['Account-months', usage.length,
               num(byMetric['Account-months'])]);

  const rows = checks.map(c => {
    const js = Number(c[1]), fx = Number(c[2]);
    const diff = Math.abs(js - fx);
    const tol = Math.max(1, Math.abs(js) * 0.0005);   // 0.05%, for rounding
    return [c[0], js, fx, round(diff, 4), diff <= tol ? 'match' : 'MISMATCH'];
  });

  writeMatrix('verificacion_formulas',
    ['metric', 'javascript', 'formula', 'difference', 'result'], rows);

  const bad = rows.filter(r => r[4] !== 'match');
  const msg = bad.length
    ? bad.length + ' of ' + rows.length + ' checks disagree:\n' +
      bad.map(r => '  ' + r[0] + ': JS ' + r[1] + ' vs formula ' + r[2]).join('\n')
    : 'All ' + rows.length + ' checks agree. The formulas on the sheet reproduce ' +
      'what the engine computed.';
  Logger.log(msg);
  return msg;
}


/** Menu action: the whole formula layer, end to end. */
function buildFormulaLayer() {
  const ui = SpreadsheetApp.getUi();
  try {
    addDerivedColumns();
    const r = writeFormulaMetrics();
    const v = verifyFormulas();
    ui.alert('Formula layer built',
      'Metric sheets now hold live formulas pointing at ' + CFG.SHEETS.DEALS_CLEAN +
      ' and ' + CFG.SHEETS.USAGE_CLEAN + '.\nReference month ' + r.month + '.\n\n' + v,
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Formula layer failed', String(e), ui.ButtonSet.OK);
    throw e;
  }
}
