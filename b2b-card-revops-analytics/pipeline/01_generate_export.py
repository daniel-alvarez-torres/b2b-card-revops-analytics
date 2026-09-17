"""
Synthetic data generator for the Vantis partnerships channel.

Produces three related tables:
  1. deals          - HubSpot-style deal export (referral -> activated account)
  2. account_usage  - monthly card spend per activated account, in local currency
  3. rep_quotas     - quarterly quota per rep, so attainment is computable

100% SYNTHETIC DATA. Vantis is a fictional company. No figure here
comes from any real business.
All rates below are deliberately conservative and documented inline.
"""
import numpy as np, pandas as pd, random
from datetime import date, timedelta
import os
os.makedirs("data", exist_ok=True)

SEED = 20260913
random.seed(SEED); np.random.seed(SEED)

TODAY = date(2026, 9, 13)
START = date(2024, 7, 1)          # two-year window
N_DEALS = 12_000

# ---------------------------------------------------------------
# Markets. Sized to look like a mid-stage LatAm-first card issuer:
# a long tail of countries, most volume in a handful of them
# weighted toward the markets it names publicly.
# fx = units of local currency per 1 USD (rounded synthetic reference)
# ---------------------------------------------------------------
MARKETS = {
    "Brazil":         {"cur": "BRL", "fx": 5.40,    "w": 0.155, "region": "LATAM"},
    "Mexico":         {"cur": "MXN", "fx": 18.20,   "w": 0.150, "region": "LATAM"},
    "Colombia":       {"cur": "COP", "fx": 4100.00, "w": 0.105, "region": "LATAM"},
    "Chile":          {"cur": "CLP", "fx": 940.00,  "w": 0.038, "region": "LATAM"},
    "Peru":           {"cur": "PEN", "fx": 3.75,    "w": 0.026, "region": "LATAM"},
    "Argentina":      {"cur": "ARS", "fx": 1180.00, "w": 0.024, "region": "LATAM"},
    "United States":  {"cur": "USD", "fx": 1.00,    "w": 0.150, "region": "NORTAM"},
    "Canada":         {"cur": "CAD", "fx": 1.37,    "w": 0.058, "region": "NORTAM"},
    "United Kingdom": {"cur": "GBP", "fx": 0.79,    "w": 0.070, "region": "EMEA"},
    "Spain":          {"cur": "EUR", "fx": 0.92,    "w": 0.055, "region": "EMEA"},
    "Germany":        {"cur": "EUR", "fx": 0.92,    "w": 0.044, "region": "EMEA"},
    "Netherlands":    {"cur": "EUR", "fx": 0.92,    "w": 0.030, "region": "EMEA"},
    "France":         {"cur": "EUR", "fx": 0.92,    "w": 0.028, "region": "EMEA"},
    "Poland":         {"cur": "PLN", "fx": 3.95,    "w": 0.020, "region": "EMEA"},
    "United Arab Emirates": {"cur": "AED", "fx": 3.67, "w": 0.018, "region": "EMEA"},
    "Ireland":        {"cur": "EUR", "fx": 0.92,    "w": 0.014, "region": "EMEA"},
    "Portugal":       {"cur": "EUR", "fx": 0.92,    "w": 0.015, "region": "EMEA"},
}
_wsum = sum(m["w"] for m in MARKETS.values())
for m in MARKETS.values():
    m["w"] /= _wsum

# Partner ecosystem. Names are invented; any resemblance is coincidental.
PARTNERS = {
    "Accounting firms": ["Contorno Fiscal", "Beltran Advisory", "LedgerLab",
                         "Nexo Contable", "Praxis Books", "Verde Contadores",
                         "Northgate Accounting", "Cifra Partners"],
    "Insurance & benefits brokers": ["Andes Broker Group", "Pilar Benefits",
                                     "Corredores del Sur", "Meridian Benefits",
                                     "Atlas Risk Partners"],
    "VC funds (portfolio)": ["Cordillera Ventures", "Sertao Capital", "Batch Collective",
                             "Puerto Fund", "Northwind Seed"],
    "Marketplaces / embedded": ["Mercagon Business", "FleetOne Partners", "Tiendita Cloud",
                                "LogiPar Network", "Comercia Hub"],
    "Banks & neobanks": ["Banco Aurora Alianzas", "Violeta Business", "Spark Banking",
                         "Caja Central Partners", "Nordbank SME"],
    "Consultancies / BPO": ["Quorum Consulting", "Delta BPO", "Ribeira Advisory",
                            "Talos Operations"],
}
PARTNER_TO_TYPE = {n: t for t, ns in PARTNERS.items() for n in ns}
ALL_PARTNERS = list(PARTNER_TO_TYPE)
# Each partner gets a latent quality score; drives referral quality realistically
PARTNER_Q = {p: np.random.beta(4, 4) for p in ALL_PARTNERS}

STAGES = ["Referral Received", "Qualified", "KYB / Underwriting",
          "Credit Approved", "Contract Sent", "Closed Won", "Closed Lost"]
STAGE_PROB = {"Referral Received": 0.10, "Qualified": 0.25, "KYB / Underwriting": 0.45,
              "Credit Approved": 0.65, "Contract Sent": 0.85, "Closed Won": 1.0,
              "Closed Lost": 0.0}
LOSS_REASONS = ["Failed underwriting", "Went with competitor", "No budget / not now",
                "Unresponsive", "Country not supported", "Pricing", "Compliance / KYB docs"]

SEGMENTS = ["Startup", "SMB", "Mid-Market", "Enterprise"]
SEG_W = [0.32, 0.41, 0.21, 0.06]
SEG_LIMIT = {"Startup": (3_000, 18_000), "SMB": (10_000, 70_000),
             "Mid-Market": (50_000, 300_000), "Enterprise": (200_000, 1_100_000)}

PRODUCTS = ["Corporate cards", "Cards + cross-border payments", "Cards + credit line"]
PROD_W = [0.52, 0.30, 0.18]

# Reps, with a hire date so ramp is measurable
REPS = []
for name, region, hired in [
    ("camila.restrepo", "LATAM", date(2024, 3, 1)), ("diego.ferraz", "LATAM", date(2024, 1, 15)),
    ("ana.lucia.mtz", "LATAM", date(2024, 8, 1)),   ("rafael.dourado", "LATAM", date(2025, 2, 10)),
    ("sofia.beltran", "LATAM", date(2025, 6, 1)),   ("julian.paez", "LATAM", date(2026, 1, 12)),
    ("tom.hargreaves", "EMEA", date(2024, 5, 6)),   ("marta.nowak", "EMEA", date(2025, 4, 1)),
    ("liam.oconnell", "EMEA", date(2025, 9, 15)),   ("yasmin.haddad", "EMEA", date(2026, 2, 2)),
    ("grace.whitfield", "NORTAM", date(2024, 2, 5)),("peter.nakamura", "NORTAM", date(2025, 3, 3)),
    ("dana.kowalczyk", "NORTAM", date(2026, 3, 16)),
]:
    REPS.append({"owner": name, "region": region, "hire_date": hired})
REP_DF = pd.DataFrame(REPS)
HIRE = {r["owner"]: r["hire_date"] for r in REPS}
REP_BY_REGION = {r: [x["owner"] for x in REPS if x["region"] == r]
                 for r in {x["region"] for x in REPS}}


def rand_date(a, b):
    return a + timedelta(days=random.randint(0, max((b - a).days, 0)))


def ramp_factor(owner, when):
    """Conservative ramp: 35% of full productivity in month 1, full at month 6."""
    h = HIRE[owner]
    months = (when.year - h.year) * 12 + (when.month - h.month)
    if months < 0:
        return 0.0
    return float(min(1.0, 0.35 + 0.65 * min(months, 6) / 6))


# =================================================================
# 1. DEALS
# =================================================================
rows = []
market_names = list(MARKETS)
market_w = [MARKETS[m]["w"] for m in market_names]

for i in range(N_DEALS):
    market = random.choices(market_names, weights=market_w)[0]
    m = MARKETS[market]
    seg = random.choices(SEGMENTS, weights=SEG_W)[0]

    source = "Partnerships" if random.random() < 0.58 else "Direct"
    partner = random.choice(ALL_PARTNERS) if source == "Partnerships" else None
    pq = PARTNER_Q[partner] if partner else 0.5

    created = rand_date(START, TODAY - timedelta(days=3))
    age = (TODAY - created).days

    owner = random.choice(REP_BY_REGION[m["region"]])
    rf = ramp_factor(owner, created)

    # Win propensity rises with partner quality, rep ramp and segment maturity
    lift = 0.55 + 0.9 * pq + 0.5 * rf + (0.15 if seg in ("Mid-Market", "Enterprise") else 0)
    if age > 150:
        w = np.array([1.5, 4, 5, 4, 3, 20 * lift, 55])
    elif age > 75:
        w = np.array([5, 12, 16, 11, 7, 13 * lift, 30])
    elif age > 30:
        w = np.array([16, 22, 19, 12, 8, 8 * lift, 16])
    else:
        w = np.array([38, 25, 15, 8, 5, 3 * lift, 6])
    stage = random.choices(STAGES, weights=w / w.sum())[0]

    closed = stage in ("Closed Won", "Closed Lost")
    cycle = int(np.random.gamma(4.2, 24) + 12)
    close_dt = min(created + timedelta(days=cycle), TODAY) if closed \
        else created + timedelta(days=random.randint(20, 170))

    lo, hi = SEG_LIMIT[seg]
    limit_usd = round(np.random.triangular(lo, lo + (hi - lo) * 0.33, hi), -2)
    amount_local = round(limit_usd * m["fx"], 2)

    rows.append({
        "record_id": 4_000_000 + i,
        "dealname": f"{seg} · {market} · {random.randint(10000,99999)}",
        "pipeline": "Partnerships Pipeline" if source == "Partnerships" else "Direct Sales",
        "dealstage": stage,
        "hs_deal_stage_probability": STAGE_PROB[stage],
        "hs_is_closed_won": stage == "Closed Won",
        "closed_lost_reason": random.choice(LOSS_REASONS) if stage == "Closed Lost" else None,
        "amount": amount_local,
        "deal_currency_code": m["cur"],
        "hs_exchange_rate": round(1 / m["fx"], 8),
        "amount_in_home_currency": round(limit_usd, 2),
        "createdate": created.isoformat(),
        "closedate": close_dt.isoformat(),
        "days_to_close": cycle if closed else None,
        "hubspot_owner_id": owner,
        "country": market,
        "region": m["region"],
        "segment": seg,
        "product_line": random.choices(PRODUCTS, weights=PROD_W)[0],
        "deal_source": source,
        "partner_name": partner,
        "partner_type": PARTNER_TO_TYPE.get(partner) if partner else None,
        "approved_limit_usd": round(limit_usd, 2),
    })

df = pd.DataFrame(rows)

# =================================================================
# 2. MONTHLY ACCOUNT USAGE (won deals only)
# Conservative assumptions, stated openly:
#   - utilization of the approved limit starts at 28%, matures toward 62%
#   - 2.5% of accounts churn per month after month 3
#   - +/-22% random monthly variation, mild June/December seasonality
# =================================================================
UTIL_START, UTIL_MATURE, RAMP_MONTHS = 0.28, 0.62, 8
MONTHLY_CHURN = 0.025

won = df[df["dealstage"].eq("Closed Won")].copy()
won["activation"] = pd.to_datetime(won["closedate"]) + pd.to_timedelta(
    np.random.randint(3, 25, len(won)), unit="D")

usage = []
end = pd.Timestamp(TODAY).to_period("M")
for r in won.itertuples():
    p0 = pd.Timestamp(r.activation).to_period("M")
    if p0 > end:
        continue
    for k, p in enumerate(pd.period_range(p0, end, freq="M")):
        if k >= 3 and random.random() < MONTHLY_CHURN:
            break
        util = UTIL_START + (UTIL_MATURE - UTIL_START) * min(k, RAMP_MONTHS) / RAMP_MONTHS
        util *= np.random.uniform(0.78, 1.22)
        if p.month in (6, 12):
            util *= 1.12
        spend_usd = max(0.0, r.approved_limit_usd * util)
        fx = MARKETS[r.country]["fx"]
        usage.append({
            "record_id": r.record_id,
            "month": str(p),
            "months_since_activation": k,
            "country": r.country,
            "region": r.region,
            "segment": r.segment,
            "product_line": r.product_line,
            "deal_source": r.deal_source,
            "partner_name": r.partner_name,
            "partner_type": r.partner_type,
            "currency": MARKETS[r.country]["cur"],
            "spend_local": round(spend_usd * fx, 2),
            "fx_rate_used": round(1 / fx, 8),
            "spend_usd": round(spend_usd, 2),
            "txn_count": int(max(1, np.random.poisson(spend_usd / 420))),
            "cross_border_share": round(
                np.random.beta(2, 6) if r.product_line != "Corporate cards"
                else np.random.beta(1.2, 9), 4),
            "revolved_share": round(np.random.beta(1.6, 6), 4),
        })

usage = pd.DataFrame(usage)

# =================================================================
# 3. REP QUOTAS (quarterly, in activated monthly volume USD)
# =================================================================
q_rows = []
for q in pd.period_range("2024Q3", "2026Q3", freq="Q"):
    for r in REPS:
        hire = pd.Timestamp(r["hire_date"]).to_period("Q")
        if q < hire:
            continue
        tenure_q = (q - hire).n
        base = {"LATAM": 260_000, "EMEA": 300_000, "NORTAM": 340_000}[r["region"]]
        quota = base * min(1.0, 0.4 + 0.6 * min(tenure_q, 3) / 3) * (1 + 0.04 * tenure_q)
        q_rows.append({"quarter": str(q), "owner": r["owner"], "region": r["region"],
                       "quota_monthly_volume_usd": round(quota, -2)})
quotas = pd.DataFrame(q_rows)

# =================================================================
# DEFECT INJECTION - each block simulates a real CRM failure
# =================================================================
defects = {}
idx = df.index.to_numpy()
used = set()


def pick(n):
    global used
    pool = np.array([i for i in idx if i not in used])
    n = min(n, len(pool))
    d = list(np.random.choice(pool, size=n, replace=False))
    used |= set(d)
    return d


d = pick(190)
df.loc[d, "dealname"] = [random.choice(
    ["TEST - do not use", "QA prueba", "DEMO ACCOUNT", "test deal ignore",
     "Duplicate - delete", "sandbox record", "dummy account"]) for _ in d]
defects["Test records"] = len(d)

d = pick(150)
df.loc[d, "dealstage"] = "Closed Won"; df.loc[d, "hs_is_closed_won"] = True
df.loc[d, "amount"] = 0; df.loc[d, "amount_in_home_currency"] = 0
defects["Closed Won with amount 0"] = len(d)

d = pick(175)
df.loc[d, "dealstage"] = "Closed Won"; df.loc[d, "hs_is_closed_won"] = False
defects["Stage vs closed flag conflict"] = len(d)

d = pick(255)
df.loc[d, "hs_exchange_rate"] = 1.0
df.loc[d, "amount_in_home_currency"] = df.loc[d, "amount"]
defects["Exchange rate = 1 (never converted)"] = len(d)

d = pick(220)
df.loc[d, "amount_in_home_currency"] = np.nan
defects["USD amount blank"] = len(d)

d = pick(165)
df.loc[d, "deal_currency_code"] = "USD"
defects["Currency inconsistent with country"] = len(d)

d = pick(120)
df.loc[d, "closedate"] = (pd.to_datetime(df.loc[d, "createdate"]) -
                          pd.to_timedelta(np.random.randint(5, 110, len(d)), unit="D")
                          ).dt.strftime("%Y-%m-%d")
defects["Close date before create date"] = len(d)

d = pick(430)
df.loc[d, "dealstage"] = random.choices(
    ["Qualified", "KYB / Underwriting", "Credit Approved"], k=len(d))
df.loc[d, "hs_is_closed_won"] = False
df.loc[d, "createdate"] = (pd.Timestamp(TODAY) - pd.to_timedelta(
    np.random.randint(200, 640, len(d)), unit="D")).strftime("%Y-%m-%d")
stale_total = int(((~df.dealstage.isin(["Closed Won", "Closed Lost"])) &
                   (pd.to_datetime(df.createdate) <
                    pd.Timestamp(TODAY - timedelta(days=180)))).sum())
defects["Stale open deals (>180 days)"] = stale_total

d = pick(640)
for i in d:
    p = df.at[i, "partner_name"]
    if isinstance(p, str) and p.strip():
        df.at[i, "partner_name"] = random.choice(
            [p.upper(), f"  {p} ", f"{p} S.A.S.", p.lower(), f"{p}  Ltda", f"{p}, Inc."])
    else:
        df.at[i, "deal_source"] = random.choice(["partnerships", "DIRECT", " Direct"])
defects["Partner name not normalized"] = len(d)

# Fat-finger on the approved limit: one extra digit
d = pick(95)
mult = np.random.choice([10, 100], size=len(d))
df.loc[d, "amount_in_home_currency"] = df.loc[d, "amount_in_home_currency"].to_numpy() * mult
df.loc[d, "approved_limit_usd"] = df.loc[d, "approved_limit_usd"].to_numpy() * mult
df.loc[d, "amount"] = df.loc[d, "amount"].to_numpy() * mult
defects["Approved limit off by a digit"] = len(d)

d = pick(180)
dupes = df.loc[d].copy()
dupes["record_id"] = dupes["record_id"] + 500_000
dupes["createdate"] = (pd.to_datetime(dupes["createdate"]) + pd.to_timedelta(
    np.random.randint(1, 6, len(dupes)), unit="D")).dt.strftime("%Y-%m-%d")
df = pd.concat([df, dupes], ignore_index=True)
defects["Duplicate deals"] = len(dupes)

d = pick(240)
df.loc[d, "deal_source"] = "Partnerships"
df.loc[d, "partner_name"] = None
df.loc[d, "partner_type"] = None
defects["Partnerships with no partner attributed"] = len(d)

d = pick(310)
df.loc[d, "hubspot_owner_id"] = None
defects["No owner assigned"] = len(d)

d = pick(140)
df.loc[d, "dealstage"] = "Closed Lost"
df.loc[d, "hs_is_closed_won"] = False
df.loc[d, "closed_lost_reason"] = None
defects["Closed Lost with no reason"] = len(d)

df = df.sample(frac=1, random_state=SEED).reset_index(drop=True)

df.to_csv("data/hubspot_deals_export_RAW.csv", index=False)
usage.to_csv("data/account_usage_RAW.csv", index=False)
quotas.to_csv("data/rep_quotas.csv", index=False)
REP_DF.to_csv("data/reps.csv", index=False)

print(f"deals          {len(df):>8,}")
print(f"usage months   {len(usage):>8,}")
print(f"quota rows     {len(quotas):>8,}")
print(f"markets {len(MARKETS)}   currencies {len({m['cur'] for m in MARKETS.values()})}"
      f"   partners {len(ALL_PARTNERS)}   reps {len(REPS)}")
print("\nInjected defects:")
for k, v in defects.items():
    print(f"  {v:>5}  {k}")
print(f"\nTotal flagged rows: {sum(defects.values()):,}")
