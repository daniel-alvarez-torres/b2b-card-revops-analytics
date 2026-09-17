/**
 * 02_CleanupEngine.gs
 *
 * Data cleanup engine for the deal export.
 *
 * Design: each rule is a function that walks the rows once and marks them.
 * Nothing is dropped silently. Every affected row keeps the rule that
 * touched it in a `_flags` column, and everything removed lands in a
 * quarantine sheet anyone can open.
 *
 * Three actions:
 *   FLAG        marked, still counted
 *   CORRECT     value repaired, original retained in a _original column
 *   QUARANTINE  removed from the reported universe
 *
 * The distinction matters. Silent exclusion is how trust in a dashboard
 * dies; visible quarantine is auditable.
 */

function runCleanup() {
  const t0 = new Date();
  loadParamsOrThrow();          // the parametros tab wins over the code defaults
  const asOf = asOfDate();

  const deals = readTable(CFG.SHEETS.DEALS_RAW).rows;
  if (!deals.length) throw new Error('No rows in ' + CFG.SHEETS.DEALS_RAW);

  // Working state on each row
  for (let i = 0; i < deals.length; i++) {
    deals[i]._flags = [];
    deals[i]._quarantine = false;
    deals[i]._original = '';
  }

  const log = [];

  function record(rule, action, hits, detail) {
    for (let i = 0; i < hits.length; i++) {
      hits[i]._flags.push(rule);
      if (action === 'QUARANTINE') hits[i]._quarantine = true;
    }
    log.push({ rule: rule, action: action, rows: hits.length, detail: detail });
  }

  // ------------------------------------------------------------------
  // R01  Test records
  // ------------------------------------------------------------------
  let hits = deals.filter(r => looksLikeTestRecord(r.dealname));
  record('R01 Test record', 'QUARANTINE', hits,
         'Name matches the test-pattern dictionary');

  // ------------------------------------------------------------------
  // R02  Duplicate deals: same account, country and amount, entered
  //      within the configured window
  // ------------------------------------------------------------------
  const seen = new Map();
  hits = [];
  const byDate = deals.slice().sort((a, b) => {
    const da = toDate(a.createdate), db = toDate(b.createdate);
    return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
  });
  for (let i = 0; i < byDate.length; i++) {
    const r = byDate[i];
    const d = toDate(r.createdate);
    if (!d) continue;
    const key = normText(r.dealname) + '|' + r.country + '|' +
                Math.round(num(r.amount) || 0);
    if (!seen.has(key)) {
      seen.set(key, d);
    } else if (daysBetween(seen.get(key), d) <= CFG.DUPLICATE_WINDOW_DAYS) {
      hits.push(r);
    }
  }
  record('R02 Duplicate deal', 'QUARANTINE', hits,
         'Same account, amount and country entered <=' +
         CFG.DUPLICATE_WINDOW_DAYS + ' days apart');

  // ------------------------------------------------------------------
  // R03  Stage says won, flag says otherwise. The stage wins.
  // ------------------------------------------------------------------
  hits = [];
  for (let i = 0; i < deals.length; i++) {
    const r = deals[i];
    const flagTrue = r.hs_is_closed_won === true ||
                     normText(r.hs_is_closed_won) === 'true';
    if (r.dealstage === 'Closed Won' && !flagTrue) {
      r.hs_is_closed_won = true;
      hits.push(r);
    }
  }
  record('R03 Stage vs closed flag', 'CORRECT', hits,
         'dealstage wins over hs_is_closed_won; the flag was rewritten');

  // ------------------------------------------------------------------
  // R04  Won with no amount: cannot enter a revenue numerator
  // ------------------------------------------------------------------
  hits = deals.filter(r =>
    r.dealstage === 'Closed Won' && (num(r.amount) || 0) <= 0);
  record('R04 Won with no amount', 'QUARANTINE', hits,
         'Closed Won with amount <= 0: cannot enter the revenue numerator');

  // ------------------------------------------------------------------
  // R05  FX never applied: rate of 1.0 on a non-USD deal
  // ------------------------------------------------------------------
  hits = [];
  for (let i = 0; i < deals.length; i++) {
    const r = deals[i];
    const cur = String(r.deal_currency_code || '');
    if (cur !== 'USD' && num(r.hs_exchange_rate) === 1) {
      const fx = CFG.FX[cur];
      if (!fx) continue;
      r._original = 'amount_in_home_currency=' + r.amount_in_home_currency;
      r.amount_in_home_currency = round((num(r.amount) || 0) / fx, 2);
      r.hs_exchange_rate = round(1 / fx, 8);
      hits.push(r);
    }
  }
  record('R05 FX not applied', 'CORRECT', hits,
         'Reconverted using the reference FX table; original value retained');

  // ------------------------------------------------------------------
  // R06  USD amount blank but local amount present
  // ------------------------------------------------------------------
  hits = [];
  for (let i = 0; i < deals.length; i++) {
    const r = deals[i];
    if (num(r.amount_in_home_currency) === null && num(r.amount) !== null) {
      const fx = CFG.FX[String(r.deal_currency_code || '')];
      if (!fx) continue;
      r.amount_in_home_currency = round(num(r.amount) / fx, 2);
      hits.push(r);
    }
  }
  record('R06 USD amount blank', 'CORRECT', hits,
         'Derived amount_in_home_currency from the local amount');

  // ------------------------------------------------------------------
  // R07  Currency does not match the country. Flagged, not corrected:
  //      a client that genuinely bills in USD is legitimate.
  // ------------------------------------------------------------------
  hits = deals.filter(r => {
    const exp = CFG.COUNTRY_CURRENCY[r.country];
    return exp && String(r.deal_currency_code) !== exp;
  });
  record('R07 Currency vs country', 'FLAG', hits,
         'May be legitimate (client bills in USD): flagged, not corrected');

  // ------------------------------------------------------------------
  // R08  Close date before create date
  // ------------------------------------------------------------------
  hits = deals.filter(r => {
    const c = toDate(r.createdate), x = toDate(r.closedate);
    return c && x && x.getTime() < c.getTime();
  });
  record('R08 Close date before create date', 'QUARANTINE', hits,
         'Impossible date: breaks every sales-cycle calculation');

  // ------------------------------------------------------------------
  // R09  Stale open deals. The win-rate denominator problem: old open
  //      referrals nobody ever marked lost.
  // ------------------------------------------------------------------
  hits = deals.filter(r => {
    if (CFG.CLOSED.indexOf(r.dealstage) >= 0) return false;
    const c = toDate(r.createdate);
    return c && daysBetween(c, asOf) > CFG.STALE_DAYS;
  });
  record('R09 Stale open deal', 'FLAG', hits,
         'Open for more than ' + CFG.STALE_DAYS +
         ' days; reported separately from live pipeline');

  // ------------------------------------------------------------------
  // R10  Partner names: spacing, casing, legal suffixes
  // ------------------------------------------------------------------
  hits = [];
  for (let i = 0; i < deals.length; i++) {
    const r = deals[i];
    const clean = normPartner(r.partner_name);
    r.partner_name_clean = clean;
    if (r.partner_name && clean && String(r.partner_name) !== clean) hits.push(r);
  }
  record('R10 Partner name not normalized', 'CORRECT', hits,
         'Unified spacing, casing and legal suffixes');

  // ------------------------------------------------------------------
  // R11  Partnership deals with no partner attributed
  // ------------------------------------------------------------------
  hits = [];
  for (let i = 0; i < deals.length; i++) {
    const r = deals[i];
    const src = normText(r.deal_source);
    r.deal_source = src === 'partnerships' ? 'Partnerships'
                  : src === 'direct' ? 'Direct' : r.deal_source;
    if (r.deal_source === 'Partnerships' && !r.partner_name_clean) hits.push(r);
  }
  record('R11 Unattributed partnership', 'FLAG', hits,
         'Enters the channel but cannot be attributed to a partner');

  // ------------------------------------------------------------------
  // R12  No owner assigned
  // ------------------------------------------------------------------
  hits = deals.filter(r => !r.hubspot_owner_id);
  record('R12 No owner assigned', 'FLAG', hits,
         'Without an owner there is no accountability and no attainment calculation');

  // ------------------------------------------------------------------
  // R13  Lost with no reason: the loss cannot be coached or fed back
  // ------------------------------------------------------------------
  hits = deals.filter(r =>
    r.dealstage === 'Closed Lost' && !r.closed_lost_reason);
  record('R13 Lost with no reason', 'FLAG', hits,
         'Closed Lost with no reason: the loss cannot be coached or fed back to the partner');

  // ------------------------------------------------------------------
  // R14  Approved limit outside the plausible band for its segment.
  //      Usually one extra typed digit, and one row moves every average.
  // ------------------------------------------------------------------
  hits = deals.filter(r => {
    const band = CFG.SEGMENT_BAND[r.segment];
    const v = num(r.amount_in_home_currency);
    return band && v !== null && v > 0 && (v < band[0] || v > band[1]);
  });
  record('R14 Limit outside segment band', 'FLAG', hits,
         'Approved limit outside the plausible band for its segment');

  // ==================================================================
  // Split and write the deal tables
  // ==================================================================
  const clean = [], quar = [];
  for (let i = 0; i < deals.length; i++) {
    deals[i]._flags = deals[i]._flags.join(' | ');
    (deals[i]._quarantine ? quar : clean).push(deals[i]);
  }

  const headers = readTable(CFG.SHEETS.DEALS_RAW).headers
    .concat(['partner_name_clean', '_flags', '_original']);

  writeTable(CFG.SHEETS.DEALS_CLEAN, headers, clean);
  writeTable(CFG.SHEETS.QUARANTINE, headers.concat([]), quar);

  // ==================================================================
  // R15  Referential integrity: a usage row must point at a deal that
  //      survived validation. Cleaning one table and not the other is
  //      exactly how a dashboard ends up internally consistent and
  //      externally wrong.
  // ==================================================================
  const usageTable = readTable(CFG.SHEETS.USAGE_RAW);
  const usage = usageTable.rows;
  const valid = new Set(clean.map(r => String(r.record_id)));

  const usageClean = [], orphans = [];
  for (let i = 0; i < usage.length; i++) {
    (valid.has(String(usage[i].record_id)) ? usageClean : orphans).push(usage[i]);
  }
  const spendRemoved = sumBy(orphans, r => num(r.spend_usd) || 0);

  // Month is compared as text everywhere downstream, so it is normalized once
  // here. Sheets parses "2026-08" as a date on import; left alone, every
  // SUMIFS on month would silently match nothing and report zero.
  for (let i = 0; i < usageClean.length; i++) {
    usageClean[i].month = monthStr(usageClean[i].month);
  }

  const ucSheet = writeTable(CFG.SHEETS.USAGE_CLEAN, usageTable.headers, usageClean);
  const monthCol = usageTable.headers.indexOf('month') + 1;
  if (monthCol > 0 && usageClean.length) {
    // Plain-text format, so Sheets does not re-parse it back into a date
    ucSheet.getRange(2, monthCol, usageClean.length, 1).setNumberFormat('@');
  }
  log.push({
    rule: 'R15 Orphaned usage row', action: 'QUARANTINE', rows: orphans.length,
    detail: 'Monthly spend tied to a deal that failed validation (' +
            Math.round(spendRemoved).toLocaleString('en-US') + ' USD removed)'
  });

  // ==================================================================
  // Audit log
  // ==================================================================
  writeTable(CFG.SHEETS.AUDIT, ['rule', 'action', 'rows', 'detail'], log);

  const secs = round((new Date() - t0) / 1000, 1);
  const msg = 'Raw ' + deals.length + '  |  quarantined ' + quar.length +
              '  |  reportable ' + clean.length +
              '\nUsage rows ' + usage.length + '  |  orphaned ' + orphans.length +
              '\nFinished in ' + secs + 's';
  Logger.log(msg);
  return { clean: clean, quarantine: quar, usage: usageClean, log: log, message: msg };
}


/**
 * Win rate under both definitions. Kept separate from the engine because
 * it is the number people argue about, and the argument is about the
 * denominator, not the data.
 */
function winRates(deals) {
  const won  = countWhere(deals, r => r.dealstage === 'Closed Won');
  const lost = countWhere(deals, r => r.dealstage === 'Closed Lost');
  const stale = countWhere(deals, r =>
    String(r._flags || '').indexOf('R09 Stale open deal') >= 0);
  return {
    won: won, lost: lost, stale: stale,
    closedOnly:   won + lost ? round(won / (won + lost) * 100, 1) : 0,
    conservative: won + lost + stale ?
                  round(won / (won + lost + stale) * 100, 1) : 0
  };
}
