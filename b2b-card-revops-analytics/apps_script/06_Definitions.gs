/**
 * 06_Definitions.gs
 *
 * The metric dictionary: what each number means, how it is computed, which
 * tables it comes from, and which of them rest on a decision somebody made
 * rather than on the data.
 *
 * Two entry points:
 *   showDefinitions()        opens it as a readable modal
 *   writeDefinitionsSheet()  writes it to a tab, so it can be linked from a
 *                            dashboard or shared with someone who does not
 *                            open the script
 *
 * The definitions read their thresholds and rates live from CFG, which the
 * `parametros` tab overrides. So if someone changes the stale threshold from
 * 180 to 365 days, this dictionary says 365 the next time it is opened. A
 * definition that can drift from the code it describes is worse than no
 * definition at all.
 */

/**
 * Every metric the pipeline produces.
 *   name      what it is called on the dashboard
 *   sheet     where the computed value lands
 *   plain     what it means, in a sentence a non-analyst can use
 *   formula   how it is computed
 *   source    which raw tables feed it
 *   decision  present only when the number depends on a business decision
 */
function metricDefinitions() {
  loadParams();   // so thresholds and rates below are the ones in use
  const R = CFG.RATES;
  const pct = v => (v * 100).toFixed(2) + '%';

  return [

  { group: 'Win rate and pipeline' },

  { name: 'Win rate (closed only)',
    sheet: 'm_kpi, m_partner_types, m_segments',
    plain: 'Of the deals that reached a conclusion, the share that was won.',
    formula: 'Closed Won ÷ (Closed Won + Closed Lost)',
    source: 'deals_clean',
    decision: 'This is the default the CRM reports. It ignores every deal still ' +
              'sitting open, which is why it always reads higher than the one below.' },

  { name: 'Win rate (conservative)',
    sheet: 'm_kpi, m_partner_types',
    plain: 'The same thing, but treating long-abandoned referrals as losses.',
    formula: 'Closed Won ÷ (Closed Won + Closed Lost + stale open deals)',
    source: 'deals_clean',
    decision: 'Rests entirely on the stale threshold, currently ' + CFG.STALE_DAYS +
              ' days. Nobody has ruled on which of the two definitions is the ' +
              'official one, so both are reported side by side rather than one ' +
              'being picked silently.' },

  { name: 'Stale open deal',
    sheet: 'flagged by rule R09 in deals_clean',
    plain: 'A referral still marked open long after anyone stopped working it.',
    formula: 'Not Closed Won or Closed Lost, and created more than ' +
             CFG.STALE_DAYS + ' days ago',
    source: 'deals_clean',
    decision: 'The threshold lives in the parametros tab under ' +
              '"dias_deal_estancado". Raising it shrinks the gap between the two ' +
              'win rates; lowering it widens the gap.' },

  { name: 'Live pipeline',
    sheet: 'm_kpi',
    plain: 'Credit limit sitting in deals that are genuinely still in play.',
    formula: 'Sum of approved_limit_usd for open deals that are not stale',
    source: 'deals_clean' },

  { name: 'Funnel conversion',
    sheet: 'm_funnel',
    plain: 'What share of deals made it from one stage to the next.',
    formula: 'Deals at or beyond stage N ÷ deals at or beyond stage N-1. Won ' +
             'deals count as having passed every stage.',
    source: 'deals_clean' },

  { name: 'Median cycle',
    sheet: 'm_kpi, m_partner_types, m_segments',
    plain: 'How long a won referral takes from arrival to close.',
    formula: 'Median of days_to_close among Closed Won deals',
    source: 'deals_clean',
    decision: 'Median, not average, because a handful of enterprise deals that ' +
              'take a year would drag an average somewhere nobody recognizes.' },

  { group: 'Volume and revenue' },

  { name: 'Card spend (TPV)',
    sheet: 'm_kpi, m_markets, m_trend',
    plain: 'What activated accounts actually transacted. In this business this ' +
           'is the metric that matters: a won account is only worth what it spends.',
    formula: 'Sum of spend_usd for the reference month',
    source: 'usage_clean',
    decision: 'The reference month is the last complete month, not the newest one ' +
              'in the data. The newest is always partial and would read as a crash.' },

  { name: 'Interchange',
    sheet: 'm_revenue_build',
    plain: 'The cut of each card transaction that comes back to Vantis as issuer.',
    formula: 'spend_usd × ' + pct(R.INTERCHANGE),
    source: 'usage_clean, parametros',
    decision: 'A modelled rate, not an observed one. Real interchange varies by ' +
              'network, card type and country.' },

  { name: 'FX spread',
    sheet: 'm_revenue_build',
    plain: 'The margin taken when a client pays in a currency other than its own.',
    formula: 'spend_usd × cross_border_share × ' + pct(R.FX_SPREAD),
    source: 'usage_clean, parametros' },

  { name: 'Financing revenue',
    sheet: 'm_revenue_build',
    plain: 'Interest earned when a client carries a balance instead of paying in full.',
    formula: 'spend_usd × revolved_share × ' + pct(R.FIN_YIELD) + ' per month',
    source: 'usage_clean, parametros',
    decision: 'Gross interest. It does not subtract cost of funding or expected ' +
              'losses, so it is not a margin.' },

  { name: 'Net revenue',
    sheet: 'm_kpi, m_revenue_build, m_markets',
    plain: 'What is left after paying the network, the processor and card rewards.',
    formula: 'Interchange + FX spread + financing − (spend_usd × ' + pct(R.COST) + ')',
    source: 'usage_clean, parametros',
    decision: 'Modelled throughout. It is a take rate applied to volume, not a P&L, ' +
              'and should be presented that way.' },

  { name: 'Take rate',
    sheet: 'm_kpi, m_products',
    plain: 'How many cents of net revenue each dollar of spend produces.',
    formula: 'Net revenue ÷ card spend',
    source: 'usage_clean' },

  { name: 'Accounts transacting',
    sheet: 'm_kpi, m_markets',
    plain: 'Accounts that actually spent in the reference month.',
    formula: 'Distinct record_id in usage_clean for that month',
    source: 'usage_clean',
    decision: 'Counts spending accounts, not activated ones. An account that ' +
              'activated and never spent is not counted here, on purpose.' },

  { group: 'Cohorts and partners' },

  { name: 'Spend retention index',
    sheet: 'm_cohorts',
    plain: 'Whether accounts spend more or less than they did when they started. ' +
           'Above 100 means they grew.',
    formula: '(spend ÷ surviving accounts in month N) ÷ (spend ÷ accounts in month 0) × 100',
    source: 'usage_clean',
    decision: 'Measured per surviving account, so churn does not show up here. ' +
              'A cohort can look healthy while losing accounts. Read it alongside ' +
              'the account count in the first column.' },

  { name: 'Cohort',
    sheet: 'm_cohorts',
    plain: 'Accounts grouped by the quarter they first transacted.',
    formula: 'Quarter of the earliest month present for that record_id',
    source: 'usage_clean',
    decision: 'Grouped by first spend, not by close date. An account that closed ' +
              'in March and first spent in April belongs to Q2.' },

  { name: 'Partner share',
    sheet: 'm_markets',
    plain: 'How much of a market\'s spend arrived through the partner channel.',
    formula: 'Partnership spend ÷ total spend in that country',
    source: 'usage_clean' },

  { name: 'Win rate gap',
    sheet: 'm_partner_types',
    plain: 'The distance between the two win-rate definitions for a partner type.',
    formula: 'Win rate (closed only) − win rate (conservative)',
    source: 'deals_clean',
    decision: 'A wide gap usually means CRM hygiene is worse for that type, not ' +
              'that the partner is worse. Worth checking before acting on it.' },

  { group: 'Reps and targets' },

  { name: 'Attainment',
    sheet: 'm_attainment',
    plain: 'How much of quota a rep delivered.',
    formula: 'Average monthly spend from that rep\'s accounts in the quarter ÷ ' +
             'their quota for that quarter',
    source: 'usage_clean, rep_quotas, deals_clean',
    decision: 'Measured in activated spend, not bookings. A rep who closes a large ' +
              'account that never spends does not get credit here. That is ' +
              'deliberate, and it is a compensation decision as much as a ' +
              'reporting one.' },

  { name: 'Ramp',
    sheet: 'm_ramp',
    plain: 'Average attainment grouped by how long the rep has been here.',
    formula: 'Mean attainment within each tenure bucket',
    source: 'm_attainment, reps',
    decision: 'Why a hiring plan cannot be read off headcount alone: a rep hired ' +
              'this quarter does not carry a full quota.' },

  { name: 'Spend per account',
    sheet: 'm_segments',
    plain: 'Average monthly spend of an account in that segment.',
    formula: 'Segment spend ÷ distinct accounts transacting in that segment',
    source: 'usage_clean' },

  { group: 'Data quality' },

  { name: 'Reportable universe',
    sheet: 'deals_clean',
    plain: 'The deals every number above is computed on.',
    formula: 'Raw deals minus everything quarantined by the cleanup rules',
    source: 'deals_raw',
    decision: 'Quarantine removes a deal from reporting but never deletes it. ' +
              'Everything removed sits in deals_quarantine with the rule that ' +
              'caught it.' },

  { name: 'Orphaned spend',
    sheet: 'audit_log, rule R15',
    plain: 'Spend history belonging to a deal that failed validation.',
    formula: 'Usage rows whose record_id is not in deals_clean',
    source: 'usage_raw, deals_clean',
    decision: 'Removed too. Cleaning one table and not the other is how a ' +
              'dashboard ends up internally consistent and externally wrong.' },

  { name: 'Duplicate window',
    sheet: 'audit_log, rule R02',
    plain: 'How close together two identical entries have to be to count as the ' +
           'same deal typed twice.',
    formula: 'Same account, country and amount, created within ' +
             CFG.DUPLICATE_WINDOW_DAYS + ' days',
    source: 'deals_raw',
    decision: 'Widening the window catches more duplicates but risks merging two ' +
              'genuine deals with the same client.' }
  ];
}


/** Opens the dictionary as a modal. */
function showDefinitions() {
  const t = HtmlService.createTemplateFromFile('Definitions');
  t.defs = metricDefinitions();
  t.refs = {
    stale: CFG.STALE_DAYS,
    dup: CFG.DUPLICATE_WINDOW_DAYS,
    rates: CFG.RATES
  };
  SpreadsheetApp.getUi().showModalDialog(
    t.evaluate().setWidth(940).setHeight(760),
    'How every metric is calculated'
  );
}


/**
 * Writes the dictionary to a tab. Useful for linking from a dashboard, and
 * for the people who will never open the script editor.
 */
function writeDefinitionsSheet() {
  const defs = metricDefinitions();
  const rows = [];
  let group = '';

  defs.forEach(d => {
    if (d.group) { group = d.group; return; }
    rows.push([group, d.name, d.plain, d.formula, d.source, d.sheet,
               d.decision || '']);
  });

  const sh = writeMatrix('diccionario_metricas',
    ['grupo', 'metrica', 'que_significa', 'como_se_calcula',
     'tablas_fuente', 'donde_aparece', 'decision_de_negocio'], rows);

  sh.setColumnWidth(1, 150);
  sh.setColumnWidth(2, 190);
  sh.setColumnWidth(3, 300);
  sh.setColumnWidth(4, 300);
  sh.setColumnWidth(5, 190);
  sh.setColumnWidth(6, 190);
  sh.setColumnWidth(7, 380);
  sh.getRange(2, 3, rows.length, 5).setWrap(true).setVerticalAlignment('top');
  sh.getRange(2, 7, rows.length, 1).setWrap(true).setVerticalAlignment('top')
    .setFontColor('#B8873A');

  SpreadsheetApp.getUi().alert(
    'Metric dictionary written',
    rows.length + ' metrics documented in the "diccionario_metricas" tab.\n\n' +
    'The definitions read the live values from the parametros tab, so rerun ' +
    'this after changing a threshold or a rate.',
    SpreadsheetApp.getUi().ButtonSet.OK);
  return sh;
}
