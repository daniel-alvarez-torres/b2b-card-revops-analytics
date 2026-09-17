/**
 * 00_Config.gs
 *
 * Central configuration for the partnerships analytics pipeline.
 * Everything that a business decision could change lives here, not in the
 * rule code. If someone wants to argue about the stale-deal threshold or the
 * interchange rate, they should be able to find it in one place.
 */

const CFG = {

  // ---- Sheet names -------------------------------------------------
  SHEETS: {
    DEALS_RAW:   'deals_raw',
    USAGE_RAW:   'usage_raw',
    QUOTAS:      'rep_quotas',
    REPS:        'reps',

    DEALS_CLEAN: 'deals_clean',
    USAGE_CLEAN: 'usage_clean',
    QUARANTINE:  'deals_quarantine',
    AUDIT:       'audit_log',

    KPI:         'm_kpi',
    FUNNEL:      'm_funnel',
    MARKETS:     'm_markets',
    PTYPES:      'm_partner_types',
    PARTNERS:    'm_partners',
    COHORTS:     'm_cohorts',
    TREND:       'm_trend',
    ATTAINMENT:  'm_attainment',
    SEGMENTS:    'm_segments',
    PRODUCTS:    'm_products',
    LOSSES:      'm_loss_reasons',
    CURRENCIES:  'm_currency_exposure'
  },

  // ---- Business rules ----------------------------------------------
  // A deal open longer than this is treated as abandoned in the
  // conservative win-rate definition. This is a business decision.
  STALE_DAYS: 180,

  // Two rows are the same deal if same account, country and amount,
  // created within this many days of each other.
  DUPLICATE_WINDOW_DAYS: 7,

  // Reference date. Set to null to use today.
  AS_OF: '2026-09-13',

  // ---- Revenue model (declared so it can be challenged) ------------
  RATES: {
    INTERCHANGE: 0.0145,  // of card spend
    FX_SPREAD:   0.0090,  // on the cross-border share of spend
    FIN_YIELD:   0.0200,  // monthly, on the revolved share of spend
    COST:        0.0045   // network + processing + rewards, of spend
  },

  // ---- FX reference: units of local currency per 1 USD --------------
  FX: {
    BRL: 5.40, MXN: 18.20, COP: 4100.00, CLP: 940.00, PEN: 3.75,
    ARS: 1180.00, USD: 1.00, CAD: 1.37, GBP: 0.79, EUR: 0.92,
    PLN: 3.95, AED: 3.67
  },

  COUNTRY_CURRENCY: {
    'Brazil': 'BRL', 'Mexico': 'MXN', 'Colombia': 'COP', 'Chile': 'CLP',
    'Peru': 'PEN', 'Argentina': 'ARS', 'United States': 'USD',
    'Canada': 'CAD', 'United Kingdom': 'GBP', 'Spain': 'EUR',
    'Germany': 'EUR', 'Netherlands': 'EUR', 'France': 'EUR',
    'Poland': 'PLN', 'United Arab Emirates': 'AED', 'Ireland': 'EUR',
    'Portugal': 'EUR'
  },

  CURRENCY_NAME: {
    BRL: 'Brazilian real', MXN: 'Mexican peso', COP: 'Colombian peso',
    CLP: 'Chilean peso', PEN: 'Peruvian sol', ARS: 'Argentine peso',
    USD: 'US dollar', CAD: 'Canadian dollar', GBP: 'pound sterling',
    EUR: 'euro', PLN: 'Polish zloty', AED: 'UAE dirham'
  },

  // Plausible approved-limit band per segment, in USD. Anything outside
  // is almost always a typed digit, and one row distorts every average.
  SEGMENT_BAND: {
    'Startup':    [1000, 40000],
    'SMB':        [5000, 140000],
    'Mid-Market': [25000, 600000],
    'Enterprise': [100000, 2400000]
  },

  STAGES: ['Referral Received', 'Qualified', 'KYB / Underwriting',
           'Credit Approved', 'Contract Sent', 'Closed Won'],

  CLOSED: ['Closed Won', 'Closed Lost'],

  // Phrases that give away a record that is not a real deal.
  // Matched against the normalized deal name.
  TEST_PATTERNS: [
    'test', 'prueba', 'demo', 'qa', 'no usar', 'do not use',
    'ignore', 'borrar', 'delete', 'duplicad', 'duplicate',
    'dummy', 'sandbox'
  ],

  // Legal suffixes stripped when grouping partners
  LEGAL_SUFFIXES: [
    'sas', 's a s', 'sa', 's a', 'ltda', 'ltd', 'llc', 'inc',
    'sl', 's l', 'gmbh', 'corp'
  ]
};


/** Reference date as a Date object. */
function asOfDate() {
  return CFG.AS_OF ? new Date(CFG.AS_OF + 'T00:00:00') : new Date();
}
