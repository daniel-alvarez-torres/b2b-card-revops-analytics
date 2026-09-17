/**
 * 03_Metrics.gs
 *
 * Aggregation layer. Reads the cleaned tables and writes one sheet per
 * view, so each Tableau or Looker Studio extract points at a flat table
 * instead of recomputing logic in the BI tool.
 *
 * Revenue is a modelled take rate on spend, never billed to the client.
 * The rates live in CFG.RATES so anyone can challenge them.
 */

function runMetrics() {
  const t0 = new Date();
  loadParamsOrThrow();          // the parametros tab wins over the code defaults
  const asOf = asOfDate();
  const R = CFG.RATES;

  const deals = readTable(CFG.SHEETS.DEALS_CLEAN).rows;
  const usage = readTable(CFG.SHEETS.USAGE_CLEAN).rows;
  const quotas = readTable(CFG.SHEETS.QUOTAS).rows;
  const reps = readTable(CFG.SHEETS.REPS).rows;

  // ---- derive revenue on every usage row ---------------------------
  let maxMonth = '';
  for (let i = 0; i < usage.length; i++) {
    const u = usage[i];
    const spend = num(u.spend_usd) || 0;
    const xb = num(u.cross_border_share) || 0;
    const rev = num(u.revolved_share) || 0;
    u._spend = spend;
    u._interchange = spend * R.INTERCHANGE;
    u._fx = spend * xb * R.FX_SPREAD;
    u._fin = spend * rev * R.FIN_YIELD;
    u._cost = spend * R.COST;
    u._net = u._interchange + u._fx + u._fin - u._cost;
    u._month = monthStr(u.month);
    if (u._month > maxMonth) maxMonth = u._month;
  }

  // Last full month: the newest month in the data is partial.
  const months = Array.from(new Set(usage.map(u => u._month))).sort();
  const LAST = months.length > 1 ? months[months.length - 2] : months[0];

  const last = usage.filter(u => u._month === LAST);
  const P = deals.filter(r => r.deal_source === 'Partnerships');
  const lastP = last.filter(u => u.deal_source === 'Partnerships');

  const isStale = r => String(r._flags || '').indexOf('R09 Stale open deal') >= 0;
  const wr = winRates(P);

  // ================= KPIs =================
  const live = P.filter(r =>
    CFG.CLOSED.indexOf(r.dealstage) < 0 && !isStale(r));
  const cycles = P.filter(r => r.dealstage === 'Closed Won')
                  .map(r => num(r.days_to_close));
  const tpv = sumBy(lastP, u => u._spend);
  const net = sumBy(lastP, u => u._net);

  const kpi = [
    ['Reference month', LAST],
    ['Card spend, partnerships', round(tpv, 0)],
    ['Modelled net revenue', round(net, 0)],
    ['Net take rate on spend %', tpv ? round(net / tpv * 100, 2) : 0],
    ['Accounts transacting', new Set(lastP.map(u => u.record_id)).size],
    ['Win rate, closed only %', wr.closedOnly],
    ['Win rate, conservative %', wr.conservative],
    ['Win rate gap, points', round(wr.closedOnly - wr.conservative, 1)],
    ['Stale open referrals', wr.stale],
    ['Approved limit in live pipeline', round(
      sumBy(live, r => num(r.approved_limit_usd) || 0), 0)],
    ['Live deals', live.length],
    ['Median days referral to close', median(cycles)],
    ['Share of deals via partners %', round(P.length / deals.length * 100, 1)],
    ['Deals in reportable universe', deals.length],
    ['Account-months', usage.length],
    ['Countries', new Set(deals.map(r => r.country)).size],
    ['Currencies', new Set(deals.map(r => r.deal_currency_code)).size]
  ];
  writeMatrix(CFG.SHEETS.KPI, ['metric', 'value'], kpi);

  // ================= revenue build =================
  const build = [
    ['Card spend', round(tpv, 0), 'base'],
    ['Interchange', round(sumBy(lastP, u => u._interchange), 0), 'up'],
    ['FX spread', round(sumBy(lastP, u => u._fx), 0), 'up'],
    ['Financing', round(sumBy(lastP, u => u._fin), 0), 'up'],
    ['Network, processing, rewards', -round(sumBy(lastP, u => u._cost), 0), 'down'],
    ['Net revenue', round(net, 0), 'total']
  ];
  writeMatrix('m_revenue_build', ['line', 'usd', 'type'], build);

  // ================= funnel =================
  const idx = {};
  CFG.STAGES.forEach((s, i) => idx[s] = i);
  const funnel = [];
  let prev = P.length;
  for (let i = 0; i < CFG.STAGES.length; i++) {
    const n = i === 0 ? P.length
      : countWhere(P, r => (idx[r.dealstage] !== undefined ? idx[r.dealstage] : 99) >= i);
    funnel.push([CFG.STAGES[i], n,
                 prev ? round(n / prev * 100, 1) : 0,
                 round(n / P.length * 100, 1)]);
    prev = Math.max(n, 1);
  }
  writeMatrix(CFG.SHEETS.FUNNEL,
              ['stage', 'deals', 'conv_from_prior_pct', 'pct_of_top'], funnel);

  // ================= monthly trend =================
  const trendMap = new Map();
  for (let i = 0; i < usage.length; i++) {
    const u = usage[i];
    if (!trendMap.has(u._month)) trendMap.set(u._month, { p: 0, d: 0, n: 0 });
    const t = trendMap.get(u._month);
    if (u.deal_source === 'Partnerships') t.p += u._spend; else t.d += u._spend;
    t.n += u._net;
  }
  const trend = Array.from(trendMap.keys()).sort().map(m => {
    const t = trendMap.get(m);
    return [m, round(t.p, 0), round(t.d, 0), round(t.p + t.d, 0), round(t.n, 0)];
  });
  writeMatrix(CFG.SHEETS.TREND,
              ['month', 'partnerships_usd', 'direct_usd', 'total_usd', 'net_revenue_usd'],
              trend);

  // ================= cohort retention =================
  // Average spend per surviving account, indexed to the cohort's first month.
  const firstMonth = new Map();
  for (let i = 0; i < usage.length; i++) {
    const u = usage[i];
    const cur = firstMonth.get(u.record_id);
    if (!cur || u._month < cur) firstMonth.set(u.record_id, u._month);
  }
  const cohAgg = new Map();   // cohort -> k -> {spend, accounts:Set}
  for (let i = 0; i < usage.length; i++) {
    const u = usage[i];
    const f = firstMonth.get(u.record_id);
    const d = new Date(f + '-01T00:00:00');
    const cohort = quarterKey(d);
    const k = monthDiff(f, u._month);
    if (!cohAgg.has(cohort)) cohAgg.set(cohort, new Map());
    const km = cohAgg.get(cohort);
    if (!km.has(k)) km.set(k, { spend: 0, acc: new Set() });
    const cell = km.get(k);
    cell.spend += u._spend;
    cell.acc.add(u.record_id);
  }
  const MAXK = 12;
  const cohHeaders = ['cohort', 'accounts'];
  for (let k = 0; k <= MAXK; k++) cohHeaders.push('M' + k);
  const cohRows = [];
  Array.from(cohAgg.keys()).sort().forEach(c => {
    const km = cohAgg.get(c);
    const base = km.get(0);
    if (!base) return;
    const baseAvg = base.spend / base.acc.size;
    const row = [c, base.acc.size];
    for (let k = 0; k <= MAXK; k++) {
      const cell = km.get(k);
      row.push(cell && cell.acc.size
        ? round(cell.spend / cell.acc.size / baseAvg * 100, 1) : '');
    }
    cohRows.push(row);
  });
  writeMatrix(CFG.SHEETS.COHORTS, cohHeaders, cohRows);

  // ================= markets =================
  const mkByCountry = groupBy(last, u => u.country);
  const markets = [];
  mkByCountry.forEach((g, country) => {
    const gp = g.filter(u => u.deal_source === 'Partnerships');
    const spend = sumBy(g, u => u._spend);
    markets.push([
      country,
      (g[0] && g[0].region) || '',
      CFG.COUNTRY_CURRENCY[country] || '',
      new Set(g.map(u => u.record_id)).size,
      round(spend, 0),
      round(sumBy(g, u => u._net), 0),
      spend ? round(sumBy(gp, u => u._spend) / spend * 100, 1) : 0
    ]);
  });
  markets.sort((a, b) => b[4] - a[4]);
  writeMatrix(CFG.SHEETS.MARKETS,
    ['country', 'region', 'currency', 'accounts', 'spend_usd',
     'net_revenue_usd', 'partner_share_pct'], markets);

  // ================= currency exposure =================
  const curMap = groupBy(last, u => u.currency);
  const totalSpend = sumBy(last, u => u._spend);
  const curRows = [];
  curMap.forEach((g, c) => {
    const s = sumBy(g, u => u._spend);
    curRows.push([c, CFG.CURRENCY_NAME[c] || c, round(s, 0),
                  totalSpend ? round(s / totalSpend * 100, 1) : 0]);
  });
  curRows.sort((a, b) => b[2] - a[2]);
  writeMatrix(CFG.SHEETS.CURRENCIES,
              ['currency', 'name', 'spend_usd', 'share_pct'], curRows);

  // ================= partner types =================
  const ptMap = groupBy(P, r => r.partner_type);
  const ptRows = [];
  ptMap.forEach((g, t) => {
    const w = winRates(g);
    const gu = lastP.filter(u => u.partner_type === t);
    ptRows.push([t, g.length, w.won, w.closedOnly, w.conservative,
                 round(w.closedOnly - w.conservative, 1),
                 median(g.filter(r => r.dealstage === 'Closed Won')
                         .map(r => num(r.days_to_close))),
                 round(sumBy(gu, u => u._spend), 0)]);
  });
  ptRows.sort((a, b) => b[7] - a[7]);
  writeMatrix(CFG.SHEETS.PTYPES,
    ['partner_type', 'referrals', 'won', 'wr_closed_pct', 'wr_conservative_pct',
     'gap_points', 'median_cycle_days', 'spend_usd'], ptRows);

  // ================= partner leaderboard =================
  const spendByPartner = new Map();
  for (let i = 0; i < lastP.length; i++) {
    const k = normPartner(lastP[i].partner_name);
    if (!k) continue;
    spendByPartner.set(k, (spendByPartner.get(k) || 0) + lastP[i]._spend);
  }
  const plMap = groupBy(P, r => r.partner_name_clean);
  const plRows = [];
  plMap.forEach((g, p) => {
    const w = winRates(g);
    plRows.push([p, (g[0] && g[0].partner_type) || '', g.length, w.won,
                 w.closedOnly, round(spendByPartner.get(p) || 0, 0)]);
  });
  plRows.sort((a, b) => b[2] - a[2]);
  writeMatrix(CFG.SHEETS.PARTNERS,
    ['partner', 'type', 'referrals', 'won', 'wr_closed_pct', 'spend_usd'], plRows);

  // ================= rep attainment, latest full quarter =================
  const LASTQ = quarterKey(new Date(LAST + '-01T00:00:00'));
  const ownerOf = new Map();
  for (let i = 0; i < deals.length; i++) {
    ownerOf.set(String(deals[i].record_id), deals[i].hubspot_owner_id);
  }
  const quotaOf = new Map();
  for (let i = 0; i < quotas.length; i++) {
    if (String(quotas[i].quarter) === LASTQ) {
      quotaOf.set(String(quotas[i].owner), {
        quota: num(quotas[i].quota_monthly_volume_usd) || 0,
        region: quotas[i].region
      });
    }
  }
  const hireOf = new Map();
  for (let i = 0; i < reps.length; i++) {
    hireOf.set(String(reps[i].owner), toDate(reps[i].hire_date));
  }

  // The quota is monthly NEW volume, so the actual has to be new volume too:
  // spend from accounts the rep activated inside this quarter, not spend from
  // every account the rep has ever owned. Against the whole book a rep with two
  // years of tenure clears quota on installed base alone and the table stops
  // saying anything about the quarter. Same denominator problem as the win
  // rate, one table over.
  const newInQ = new Set();
  for (let i = 0; i < deals.length; i++) {
    if (String(deals[i].dealstage) !== 'Closed Won') continue;
    const cd = toDate(deals[i].closedate);
    if (cd && quarterKey(cd) === LASTQ) newInQ.add(String(deals[i].record_id));
  }
  const qUsage = usage.filter(u =>
    quarterKey(new Date(u._month + '-01T00:00:00')) === LASTQ &&
    newInQ.has(String(u.record_id)));
  const byOwner = groupBy(qUsage, u => ownerOf.get(String(u.record_id)));

  const attRows = [];
  byOwner.forEach((g, owner) => {
    const q = quotaOf.get(String(owner));
    if (!q) return;
    const nMonths = new Set(g.map(u => u._month)).size || 1;
    const actual = sumBy(g, u => u._spend) / nMonths;
    const hire = hireOf.get(String(owner));
    const tenure = hire ? Math.round(daysBetween(hire, asOf) / 30.4) : '';
    attRows.push([owner, q.region, tenure, round(q.quota, 0), round(actual, 0),
                  q.quota ? round(actual / q.quota * 100, 1) : 0]);
  });
  attRows.sort((a, b) => b[5] - a[5]);
  writeMatrix(CFG.SHEETS.ATTAINMENT,
    ['owner', 'region', 'tenure_months', 'quota_monthly_usd',
     'actual_monthly_usd', 'attainment_pct'], attRows);

  // ---- ramp curve by tenure bucket ----
  const buckets = [[0, 6, '0-6 months'], [6, 12, '6-12 months'],
                   [12, 24, '1-2 years'], [24, 999, '2+ years']];
  const rampRows = buckets.map(b => {
    const sel = attRows.filter(r => r[2] !== '' && r[2] >= b[0] && r[2] < b[1]);
    return [b[2], sel.length,
            sel.length ? round(sel.reduce((s, r) => s + r[5], 0) / sel.length, 1) : ''];
  }).filter(r => r[1] > 0);
  writeMatrix('m_ramp', ['tenure_bucket', 'reps', 'avg_attainment_pct'], rampRows);

  // ================= segments =================
  const segOrder = { 'Startup': 0, 'SMB': 1, 'Mid-Market': 2, 'Enterprise': 3 };
  const segMap = groupBy(P, r => r.segment);
  const segRows = [];
  segMap.forEach((g, s) => {
    const w = winRates(g);
    const gu = lastP.filter(u => u.segment === s);
    const acc = new Set(gu.map(u => u.record_id)).size;
    const sp = sumBy(gu, u => u._spend);
    segRows.push([s, g.length, w.closedOnly,
                  median(g.filter(r => r.dealstage === 'Closed Won')
                          .map(r => num(r.days_to_close))),
                  acc ? round(sp / acc, 0) : 0, round(sp, 0)]);
  });
  segRows.sort((a, b) => (segOrder[a[0]] || 9) - (segOrder[b[0]] || 9));
  writeMatrix(CFG.SHEETS.SEGMENTS,
    ['segment', 'referrals', 'wr_closed_pct', 'median_cycle_days',
     'spend_per_account_usd', 'spend_usd'], segRows);

  // ================= product lines =================
  const prodMap = groupBy(lastP, u => u.product_line);
  const prodRows = [];
  prodMap.forEach((g, p) => {
    const sp = sumBy(g, u => u._spend);
    const nr = sumBy(g, u => u._net);
    prodRows.push([p, new Set(g.map(u => u.record_id)).size,
                   round(sp, 0), round(nr, 0), sp ? round(nr / sp * 100, 2) : 0]);
  });
  prodRows.sort((a, b) => b[2] - a[2]);
  writeMatrix(CFG.SHEETS.PRODUCTS,
    ['product_line', 'accounts', 'spend_usd', 'net_revenue_usd', 'take_rate_pct'],
    prodRows);

  // ================= loss reasons =================
  const lostRows = P.filter(r => r.dealstage === 'Closed Lost');
  const lossMap = new Map();
  for (let i = 0; i < lostRows.length; i++) {
    const k = lostRows[i].closed_lost_reason || 'Not recorded';
    lossMap.set(k, (lossMap.get(k) || 0) + 1);
  }
  const lossRows = Array.from(lossMap.entries())
    .map(e => [e[0], e[1], round(e[1] / lostRows.length * 100, 1)])
    .sort((a, b) => b[1] - a[1]);
  writeMatrix(CFG.SHEETS.LOSSES, ['reason', 'deals', 'share_pct'], lossRows);

  const secs = round((new Date() - t0) / 1000, 1);
  const msg = 'Metrics written for ' + LAST + ' in ' + secs + 's\n' +
              'Win rate ' + wr.closedOnly + '% closed-only vs ' +
              wr.conservative + '% conservative (' +
              round(wr.closedOnly - wr.conservative, 1) + ' point gap)';
  Logger.log(msg);
  return msg;
}
