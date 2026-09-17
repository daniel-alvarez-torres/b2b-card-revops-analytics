"""
Data cleanup engine for the deal export.

Design: each rule is a function that takes the dataframe and returns a mask.
Nothing is dropped silently. Every affected row is written to an audit log
with the rule that touched it and the action applied.

Three possible actions:
  FLAG        -> marked, still counted
  CORRECT     -> value repaired, original retained
  QUARANTINE  -> removed from the reported universe, written to a separate file

The distinction matters: silent exclusion is how trust in a dashboard dies.
Visible quarantine is auditable.
"""
import numpy as np, pandas as pd, re, unicodedata
from datetime import date
import os
os.makedirs("data", exist_ok=True)

TODAY = pd.Timestamp(date(2026, 9, 13))
STALE_DAYS = 180

FX_REF = {"BRL": 5.40, "MXN": 18.20, "COP": 4100.00, "CLP": 940.00,
          "PEN": 3.75, "ARS": 1180.00, "USD": 1.00, "CAD": 1.37,
          "GBP": 0.79, "EUR": 0.92, "PLN": 3.95, "AED": 3.67}
COUNTRY_CUR = {"Brazil": "BRL", "Mexico": "MXN", "Colombia": "COP",
               "Chile": "CLP", "Peru": "PEN", "Argentina": "ARS",
               "United States": "USD", "Canada": "CAD",
               "United Kingdom": "GBP", "Spain": "EUR", "Germany": "EUR",
               "Netherlands": "EUR", "France": "EUR", "Poland": "PLN",
               "United Arab Emirates": "AED", "Ireland": "EUR",
               "Portugal": "EUR"}

# Dictionary of phrases that give away a record that is not a real deal.
# Matched against the normalized name (accents stripped, lowercased).
TEST_PATTERNS = [
    r"\btest\b", r"\bprueba\b", r"\bdemo\b", r"\bqa\b",
    r"no usar", r"do not use", r"ignore", r"\bborrar\b", r"\bdelete\b",
    r"\bduplicad", r"\bdummy\b", r"\bsandbox\b",
]
TEST_RE = re.compile("|".join(TEST_PATTERNS))

# Legal suffixes and noise that prevent grouping by partner
LEGAL_SUFFIX = re.compile(
    r"\b(s\.?a\.?s\.?|s\.?a\.?|ltda\.?|ltd\.?|llc|inc\.?|s\.?l\.?|gmbh|corp\.?)\b")


def norm_text(s):
    if not isinstance(s, str):
        return None
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", s).strip().lower()


def norm_partner(s):
    n = norm_text(s)
    if not n:
        return None
    n = LEGAL_SUFFIX.sub("", n)
    n = re.sub(r"[^a-z0-9 &]", " ", n)
    n = re.sub(r"\s+", " ", n).strip()
    return " ".join(w.capitalize() for w in n.split()) or None


class Engine:
    def __init__(self, df):
        self.df = df.copy()
        self.log = []
        self.df["_quarantine"] = False
        self.df["_flags"] = [[] for _ in range(len(self.df))]

    def record(self, rule, action, mask, note):
        n = int(mask.sum())
        if n:
            for i in self.df.index[mask]:
                self.df.at[i, "_flags"].append(rule)
            if action == "QUARANTINE":
                self.df.loc[mask, "_quarantine"] = True
        self.log.append({"rule": rule, "action": action, "rows": n, "detail": note})
        return n

    # ---------------- rules ----------------

    def r01_test_records(self):
        m = self.df["dealname"].map(norm_text).fillna("").str.contains(TEST_RE)
        self.record("R01 Test record", "QUARANTINE", m,
                    "Name matches the test-pattern dictionary")

    def r02_business_duplicates(self):
        """Same deal entered twice: same account, amount and a 7-day window."""
        d = self.df.copy()
        d["_cd"] = pd.to_datetime(d["createdate"], errors="coerce")
        d["_key"] = (d["dealname"].map(norm_text).fillna("") + "|" +
                     d["country"].fillna("") + "|" +
                     d["amount"].round(0).astype("Int64").astype(str))
        d = d.sort_values("_cd")
        dup = d.duplicated(subset="_key", keep="first")
        # only if the second entry falls within 7 days of the first
        first = d.groupby("_key")["_cd"].transform("min")
        near = (d["_cd"] - first).dt.days.le(7)
        m = pd.Series(False, index=self.df.index)
        m.loc[d.index[dup & near]] = True
        self.record("R02 Duplicate deal", "QUARANTINE", m,
                    "Same account, amount and country entered <=7 days apart")

    def r03_closed_flag_conflict(self):
        m = (self.df["dealstage"].eq("Closed Won") & ~self.df["hs_is_closed_won"].astype(bool))
        self.df.loc[m, "hs_is_closed_won"] = True
        self.record("R03 Stage vs closed flag", "CORRECT", m,
                    "dealstage wins over hs_is_closed_won; the flag was rewritten")

    def r04_won_zero_amount(self):
        m = self.df["dealstage"].eq("Closed Won") & (
            self.df["amount"].fillna(0).le(0))
        self.record("R04 Won with no amount", "QUARANTINE", m,
                    "Closed Won with amount <= 0: cannot enter the revenue numerator")

    def r05_fx_not_applied(self):
        """Exchange rate of 1.0 on a non-USD deal: the amount was never converted."""
        m = self.df["deal_currency_code"].ne("USD") & self.df["hs_exchange_rate"].eq(1.0)
        self.df.loc[m, "_amount_usd_original"] = self.df.loc[m, "amount_in_home_currency"]
        fx = self.df.loc[m, "deal_currency_code"].map(FX_REF)
        self.df.loc[m, "amount_in_home_currency"] = (self.df.loc[m, "amount"] / fx).round(2)
        self.df.loc[m, "hs_exchange_rate"] = (1 / fx).round(8)
        self.record("R05 FX not applied", "CORRECT", m,
                    "Reconverted using the reference FX table; original value retained")

    def r06_usd_missing(self):
        m = self.df["amount_in_home_currency"].isna() & self.df["amount"].notna()
        fx = self.df.loc[m, "deal_currency_code"].map(FX_REF)
        self.df.loc[m, "amount_in_home_currency"] = (self.df.loc[m, "amount"] / fx).round(2)
        self.record("R06 USD amount blank", "CORRECT", m,
                    "Derived amount_in_home_currency from the local amount")

    def r07_currency_country_mismatch(self):
        expected = self.df["country"].map(COUNTRY_CUR)
        m = expected.notna() & self.df["deal_currency_code"].ne(expected)
        self.record("R07 Currency vs country", "FLAG", m,
                    "May be legitimate (client bills in USD): flagged, not corrected")

    def r08_close_before_create(self):
        cd = pd.to_datetime(self.df["createdate"], errors="coerce")
        xd = pd.to_datetime(self.df["closedate"], errors="coerce")
        m = xd.notna() & cd.notna() & (xd < cd)
        self.record("R08 Close date before create date", "QUARANTINE", m,
                    "Impossible date: breaks every sales-cycle calculation")

    def r09_zombie_deals(self):
        """The key finding: old open deals never marked lost. They inflate the
        denominator and artificially depress the win rate."""
        cd = pd.to_datetime(self.df["createdate"], errors="coerce")
        open_ = ~self.df["dealstage"].isin(["Closed Won", "Closed Lost"])
        m = open_ & cd.notna() & ((TODAY - cd).dt.days > STALE_DAYS)
        self.record("R09 Stale open deal", "FLAG", m,
                    f"Open for more than {STALE_DAYS} days; reported separately from live pipeline")

    def r10_partner_normalize(self):
        raw = self.df["partner_name"]
        clean = raw.map(norm_partner)
        m = raw.notna() & clean.notna() & raw.ne(clean)
        self.df["partner_name_clean"] = clean
        self.record("R10 Partner name not normalized", "CORRECT", m,
                    "Unified spacing, casing and legal suffixes")

    def r11_unattributed_partnership(self):
        src = self.df["deal_source"].map(norm_text)
        self.df["deal_source"] = src.map({"partnerships": "Partnerships", "direct": "Direct"})
        m = self.df["deal_source"].eq("Partnerships") & self.df["partner_name_clean"].isna()
        self.record("R11 Unattributed partnership", "FLAG", m,
                    "Enters the channel but cannot be attributed to a partner")

    def r12_owner_missing(self):
        m = self.df["hubspot_owner_id"].isna()
        self.record("R12 No owner assigned", "FLAG", m,
                    "Without an owner there is no accountability and no attainment calculation")

    def r13_lost_no_reason(self):
        m = self.df["dealstage"].eq("Closed Lost") & self.df["closed_lost_reason"].isna()
        self.record("R13 Lost with no reason", "FLAG", m,
                    "Closed Lost with no reason: the loss cannot be coached or fed back to the partner")

    def r14_limit_out_of_band(self):
        """Approved limit far outside the band for its segment: almost always a
        typo of a digit, and a single one distorts any average."""
        band = {"Startup": (1_000, 40_000), "SMB": (5_000, 140_000),
                "Mid-Market": (25_000, 600_000), "Enterprise": (100_000, 2_400_000)}
        lo = self.df["segment"].map(lambda s: band.get(s, (0, 1e12))[0])
        hi = self.df["segment"].map(lambda s: band.get(s, (0, 1e12))[1])
        v = self.df["amount_in_home_currency"]
        m = v.notna() & ((v < lo) | (v > hi)) & v.gt(0)
        self.record("R14 Limit outside segment band", "FLAG", m,
                    "Approved limit outside the plausible band for its segment")

    def run(self):
        for r in ["r01_test_records", "r02_business_duplicates", "r03_closed_flag_conflict",
                  "r04_won_zero_amount", "r05_fx_not_applied", "r06_usd_missing",
                  "r07_currency_country_mismatch", "r08_close_before_create",
                  "r09_zombie_deals", "r10_partner_normalize",
                  "r11_unattributed_partnership", "r12_owner_missing",
                  "r13_lost_no_reason", "r14_limit_out_of_band"]:
            getattr(self, r)()
        return self


def win_rate(d):
    won = d["dealstage"].eq("Closed Won").sum()
    lost = d["dealstage"].eq("Closed Lost").sum()
    return won / (won + lost) if (won + lost) else np.nan


if __name__ == "__main__":
    raw = pd.read_csv("data/hubspot_deals_export_RAW.csv")
    eng = Engine(raw).run()
    df = eng.df

    clean = df[~df["_quarantine"]].copy()
    quar = df[df["_quarantine"]].copy()

    log = pd.DataFrame(eng.log)
    print(log.to_string(index=False))

    # --- impact on the metric leadership actually looks at ---
    wr_raw = win_rate(raw.assign(dealstage=raw["dealstage"]))
    wr_clean = win_rate(clean)
    zombie = clean["_flags"].map(lambda f: "R09 Stale open deal" in f)
    wr_zombie_as_lost = (clean["dealstage"].eq("Closed Won").sum() /
                         (clean["dealstage"].eq("Closed Won").sum() +
                          clean["dealstage"].eq("Closed Lost").sum() + zombie.sum()))

    print(f"\nRaw rows            {len(raw)}")
    print(f"Quarantined         {len(quar)}")
    print(f"Reportable universe {len(clean)}")
    print(f"\nWin rate, uncleaned                 {wr_raw:6.1%}")
    print(f"Win rate, cleaned                   {wr_clean:6.1%}")
    print(f"Win rate, stale counted as lost     {wr_zombie_as_lost:6.1%}")
    print(f"  -> a {abs(wr_clean-wr_zombie_as_lost)*100:.1f} point range depending on the definition")

    # --- referential integrity: usage rows must point at a surviving deal ---
    usage = pd.read_csv("data/account_usage_RAW.csv")
    valid = set(clean["record_id"])
    orphan = ~usage["record_id"].isin(valid)
    print(f"\nUsage rows                {len(usage):,}")
    print(f"Orphaned by quarantine    {int(orphan.sum()):,}"
          f"  (${usage.loc[orphan, 'spend_usd'].sum():,.0f} of spend removed)")
    usage[~orphan].to_csv("data/account_usage_CLEAN.csv", index=False)
    eng.log.append({"rule": "R15 Orphaned usage row", "action": "QUARANTINE",
                    "rows": int(orphan.sum()),
                    "detail": "Monthly spend tied to a deal that failed validation"})
    log = pd.DataFrame(eng.log)
    log.to_csv("data/audit_log.csv", index=False)

    clean.drop(columns=["_quarantine"]).to_csv(
        "data/deals_CLEAN.csv", index=False)
    quar.to_csv("data/deals_QUARANTINE.csv", index=False)
