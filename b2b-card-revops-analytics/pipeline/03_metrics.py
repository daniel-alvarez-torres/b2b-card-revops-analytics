"""
Aggregations for the partnerships dashboard.

Revenue assumptions are deliberately conservative and declared here so the
number can be challenged rather than trusted:
  gross interchange      1.45% of card spend
  FX spread              0.90% on the cross-border share of spend
  financing yield        2.00% monthly on the revolved share of spend
  network + processing
  + rewards cost         0.45% of card spend
Everything is a modelled take rate on synthetic volume, not a P&L.
"""
import pandas as pd, numpy as np, json
import os
os.makedirs("data", exist_ok=True)

INTERCHANGE, FX_SPREAD, FIN_YIELD, COST = 0.0145, 0.0090, 0.0200, 0.0045
CUR_NAME = {"BRL": "Brazilian real", "MXN": "Mexican peso", "COP": "Colombian peso",
            "USD": "US dollar", "CAD": "Canadian dollar", "GBP": "pound sterling",
            "EUR": "euro", "CLP": "Chilean peso", "PEN": "Peruvian sol",
            "ARS": "Argentine peso", "PLN": "Polish zloty", "AED": "UAE dirham"}

d = pd.read_csv("data/deals_CLEAN.csv")
d["_flags"] = d["_flags"].apply(eval)
d["createdate"] = pd.to_datetime(d["createdate"])
d["closedate"] = pd.to_datetime(d["closedate"])
d["stale"] = d["_flags"].map(lambda f: "R09 Stale open deal" in f)

u = pd.read_csv("data/account_usage_CLEAN.csv")
u["month_p"] = pd.PeriodIndex(u["month"], freq="M")
quotas = pd.read_csv("data/rep_quotas.csv")
reps = pd.read_csv("data/reps.csv")

# Revenue per usage row
u["interchange"] = u["spend_usd"] * INTERCHANGE
u["fx_rev"] = u["spend_usd"] * u["cross_border_share"] * FX_SPREAD
u["fin_rev"] = u["spend_usd"] * u["revolved_share"] * FIN_YIELD
u["cost"] = u["spend_usd"] * COST
u["net_rev"] = u["interchange"] + u["fx_rev"] + u["fin_rev"] - u["cost"]

LAST = u["month_p"].max() - 1          # last full month
last = u[u["month_p"].eq(LAST)]
P = d[d["deal_source"].eq("Partnerships")]
uP = u[u["deal_source"].eq("Partnerships")]
lastP = last[last["deal_source"].eq("Partnerships")]

out = {"assumptions": {"interchange": INTERCHANGE, "fx": FX_SPREAD,
                       "fin": FIN_YIELD, "cost": COST, "month": str(LAST)}}

# ---------------- headline KPIs ----------------
w = int(P["dealstage"].eq("Closed Won").sum())
l = int(P["dealstage"].eq("Closed Lost").sum())
z = int(P["stale"].sum())
live = P[~P["dealstage"].isin(["Closed Won", "Closed Lost"]) & ~P["stale"]]
cycle = P.loc[P["dealstage"].eq("Closed Won"), "days_to_close"].dropna()

out["kpi"] = {
    "tpv_month": float(lastP["spend_usd"].sum()),
    "net_rev_month": float(lastP["net_rev"].sum()),
    "take_rate": float(lastP["net_rev"].sum() / lastP["spend_usd"].sum() * 100),
    "active_accounts": int(lastP["record_id"].nunique()),
    "wr_closed": round(w / (w + l) * 100, 1),
    "wr_conservative": round(w / (w + l + z) * 100, 1),
    "stale_count": z,
    "pipeline_limit": float(live["approved_limit_usd"].sum()),
    "live_deals": int(len(live)),
    "median_cycle": int(cycle.median()),
    "channel_share": round(len(P) / len(d) * 100, 1),
    "total_deals": int(len(d)),
    "usage_rows": int(len(u)),
    "countries": int(d["country"].nunique()),
    "currencies": int(d["deal_currency_code"].nunique()),
}

# ---------------- revenue build ----------------
out["rev_build"] = [
    {"k": "Card spend", "v": float(lastP["spend_usd"].sum()), "type": "base"},
    {"k": "Interchange", "v": float(lastP["interchange"].sum()), "type": "up"},
    {"k": "FX spread", "v": float(lastP["fx_rev"].sum()), "type": "up"},
    {"k": "Financing", "v": float(lastP["fin_rev"].sum()), "type": "up"},
    {"k": "Network, processing, rewards", "v": -float(lastP["cost"].sum()), "type": "down"},
    {"k": "Net revenue", "v": float(lastP["net_rev"].sum()), "type": "total"},
]

# ---------------- funnel ----------------
STAGES = ["Referral Received", "Qualified", "KYB / Underwriting",
          "Credit Approved", "Contract Sent", "Closed Won"]
order = {s: i for i, s in enumerate(STAGES)}
base, funnel, prev = len(P), [], len(P)
for i, s in enumerate(STAGES):
    n = base if i == 0 else int(P[P["dealstage"].map(lambda x: order.get(x, 99)).ge(i)].shape[0])
    funnel.append({"stage": s, "n": n, "conv": round(n / prev * 100, 1) if prev else 0,
                   "of_top": round(n / base * 100, 1)})
    prev = max(n, 1)
out["funnel"] = funnel

# ---------------- monthly trend ----------------
tr = u.groupby(["month", "deal_source"])["spend_usd"].sum().unstack(fill_value=0)
tr = tr[tr.index >= "2024-10"]
nr = u.groupby("month")["net_rev"].sum()
out["trend"] = [{"m": m,
                 "partners": float(r.get("Partnerships", 0)),
                 "direct": float(r.get("Direct", 0)),
                 "net": float(nr.get(m, 0))} for m, r in tr.iterrows()]

# ---------------- cohort retention (activation quarter x month index) ----------------
first = u.groupby("record_id")["month_p"].min().rename("act")
uc = u.join(first, on="record_id")
uc["cohort"] = uc["act"].dt.asfreq("Q").astype(str)
uc["k"] = (uc["month_p"] - uc["act"]).apply(lambda x: x.n)
piv = uc.pivot_table(index="cohort", columns="k", values="spend_usd", aggfunc="sum")
cnt = uc.pivot_table(index="cohort", columns="k", values="record_id", aggfunc="nunique")
coh = []
for c in piv.index[-7:]:
    row = piv.loc[c].dropna()
    n0 = cnt.loc[c, 0] if 0 in cnt.columns else np.nan
    base_v = row.iloc[0] / n0 if n0 else np.nan
    coh.append({"cohort": c, "accounts": int(n0),
                "vals": [round(float(row[k]) / cnt.loc[c, k] / base_v * 100, 1)
                         for k in sorted(row.index)[:13]
                         if not pd.isna(cnt.loc[c, k]) and cnt.loc[c, k] > 0]})
out["cohorts"] = coh

# ---------------- markets ----------------
mk = []
for c, g in last.groupby("country"):
    gd = d[d["country"].eq(c)]
    gp = g[g["deal_source"].eq("Partnerships")]
    mk.append({"country": c,
               "region": gd["region"].mode().iat[0],
               "cur": gd["deal_currency_code"].mode().iat[0],
               "accounts": int(g["record_id"].nunique()),
               "tpv": float(g["spend_usd"].sum()),
               "net": float(g["net_rev"].sum()),
               "partner_share": round(gp["spend_usd"].sum() / g["spend_usd"].sum() * 100, 1)
               if g["spend_usd"].sum() else 0})
out["markets"] = sorted(mk, key=lambda r: -r["tpv"])

# ---------------- region rollup ----------------
rg = []
for r, g in last.groupby("region"):
    gd = d[d["region"].eq(r) & d["deal_source"].eq("Partnerships")]
    ww = int(gd["dealstage"].eq("Closed Won").sum()); ll = int(gd["dealstage"].eq("Closed Lost").sum())
    rg.append({"region": r, "tpv": float(g["spend_usd"].sum()),
               "net": float(g["net_rev"].sum()),
               "accounts": int(g["record_id"].nunique()),
               "wr": round(ww / (ww + ll) * 100, 1) if ww + ll else 0})
out["regions"] = sorted(rg, key=lambda x: -x["tpv"])

# ---------------- partner types ----------------
tt = []
for t, g in P[P["partner_type"].notna()].groupby("partner_type"):
    ww = int(g["dealstage"].eq("Closed Won").sum())
    ll = int(g["dealstage"].eq("Closed Lost").sum())
    zz = int(g["stale"].sum())
    gu = lastP[lastP["partner_type"].eq(t)]
    tt.append({"type": t, "refs": int(len(g)), "won": ww,
               "wr": round(ww / (ww + ll) * 100, 1) if ww + ll else 0,
               "wr_cons": round(ww / (ww + ll + zz) * 100, 1) if ww + ll + zz else 0,
               "tpv": float(gu["spend_usd"].sum()),
               "cycle": int(g.loc[g["dealstage"].eq("Closed Won"), "days_to_close"].median())
               if ww else 0})
for t in tt:
    t["gap"] = round(t["wr"] - t["wr_cons"], 1)
out["ptypes"] = sorted(tt, key=lambda r: -r["tpv"])

# ---------------- partner leaderboard ----------------
pl = []
for p, g in P[P["partner_name_clean"].notna()].groupby("partner_name_clean"):
    ww = int(g["dealstage"].eq("Closed Won").sum())
    ll = int(g["dealstage"].eq("Closed Lost").sum())
    gu = lastP[lastP["partner_name"].notna() &
               lastP["partner_name"].str.strip().str.lower().eq(p.lower())]
    pl.append({"partner": p, "type": g["partner_type"].mode().iat[0]
               if g["partner_type"].notna().any() else "",
               "refs": int(len(g)), "won": ww,
               "wr": round(ww / (ww + ll) * 100, 1) if ww + ll else 0,
               "tpv": float(gu["spend_usd"].sum())})
out["partners"] = sorted(pl, key=lambda r: -r["refs"])[:12]

# ---------------- rep attainment, latest full quarter ----------------
# The quota is monthly NEW volume, so the actual has to be new volume too:
# spend from accounts this rep activated inside the quarter, not spend from
# every account the rep has ever owned. Measured against the whole book, a rep
# with two years of tenure clears quota on installed base alone and the table
# stops saying anything about the quarter. This is the same denominator
# problem as the win rate, one table over.
LASTQ = str((LAST).asfreq("Q"))
won_q = d[d["dealstage"].eq("Closed Won")].copy()
won_q["_q"] = pd.to_datetime(won_q["closedate"], errors="coerce").dt.to_period("Q").astype(str)
new_in_q = set(won_q.loc[won_q["_q"].eq(LASTQ), "record_id"])
qm = u[u["month_p"].dt.asfreq("Q").astype(str).eq(LASTQ) &
       u["record_id"].isin(new_in_q)]
att = []
for o, g in qm.groupby(qm["record_id"].map(
        d.set_index("record_id")["hubspot_owner_id"]).rename("owner")):
    q = quotas[(quotas["quarter"].eq(LASTQ)) & (quotas["owner"].eq(o))]
    if q.empty:
        continue
    months = g["month_p"].nunique() or 1
    actual = g["spend_usd"].sum() / months
    quota = float(q["quota_monthly_volume_usd"].iat[0])
    hire = pd.Timestamp(reps.set_index("owner").loc[o, "hire_date"])
    tenure = int((pd.Timestamp("2026-09-01") - hire).days / 30.4)
    att.append({"owner": o, "region": str(q["region"].iat[0]), "tenure_m": tenure,
                "actual": float(actual), "quota": quota,
                "att": round(actual / quota * 100, 1)})
out["attainment"] = sorted(att, key=lambda r: -r["att"])

# ---------------- ramp curve: attainment by tenure bucket ----------------
buckets = [(0, 6, "0-6 months"), (6, 12, "6-12 months"),
           (12, 24, "1-2 years"), (24, 99, "2+ years")]
rc = []
for lo, hi, lab in buckets:
    sel = [a for a in att if lo <= a["tenure_m"] < hi]
    if sel:
        rc.append({"bucket": lab, "n": len(sel),
                   "att": round(float(np.mean([a["att"] for a in sel])), 1)})
out["ramp"] = rc

# ---------------- loss reasons ----------------
lr = P[P["dealstage"].eq("Closed Lost")]["closed_lost_reason"].value_counts(dropna=False)
out["losses"] = [{"reason": ("Not recorded" if pd.isna(k) else k), "n": int(v)}
                 for k, v in lr.items()]

# ---------------- segments & products ----------------
sg = []
for s, g in P.groupby("segment"):
    ww = int(g["dealstage"].eq("Closed Won").sum()); ll = int(g["dealstage"].eq("Closed Lost").sum())
    gu = lastP[lastP["segment"].eq(s)]
    acc = gu["record_id"].nunique()
    sg.append({"segment": s, "refs": int(len(g)),
               "wr": round(ww / (ww + ll) * 100, 1) if ww + ll else 0,
               "tpv": float(gu["spend_usd"].sum()),
               "avg_acct": float(gu["spend_usd"].sum() / acc) if acc else 0,
               "cycle": int(g.loc[g["dealstage"].eq("Closed Won"), "days_to_close"].median())
               if ww else 0})
order_seg = {"Startup": 0, "SMB": 1, "Mid-Market": 2, "Enterprise": 3}
out["segments"] = sorted(sg, key=lambda r: order_seg[r["segment"]])

pr = []
for p, g in lastP.groupby("product_line"):
    pr.append({"product": p, "tpv": float(g["spend_usd"].sum()),
               "net": float(g["net_rev"].sum()),
               "take": round(g["net_rev"].sum() / g["spend_usd"].sum() * 100, 2),
               "accounts": int(g["record_id"].nunique())})
out["products"] = sorted(pr, key=lambda r: -r["tpv"])

# ---------------- currency exposure ----------------
cx = last.groupby("currency")["spend_usd"].sum().sort_values(ascending=False)
tot = cx.sum()
out["currencies"] = [{"cur": c, "name": CUR_NAME.get(c, c), "tpv": float(v),
                      "share": round(v / tot * 100, 1)} for c, v in cx.items()]

# ---------------- data quality ----------------
log = pd.read_csv("data/audit_log.csv")
out["quality"] = log.to_dict("records")
raw = pd.read_csv("data/hubspot_deals_export_RAW.csv")
rawu = pd.read_csv("data/account_usage_RAW.csv")
out["quality_totals"] = {
    "raw": int(len(raw)), "quarantined": int(len(raw) - len(d)), "reportable": int(len(d)),
    "no_owner": int(d["_flags"].map(lambda f: "R12 No owner assigned" in f).sum()),
    "unattributed": int(d["_flags"].map(lambda f: "R11 Unattributed partnership" in f).sum()),
    "stale": int(d["stale"].sum()),
    "usage_raw": int(len(rawu)), "usage_clean": int(len(u)),
    "spend_removed": float(rawu["spend_usd"].sum() - u["spend_usd"].sum()),
}

json.dump(out, open("data/metrics.json", "w"), indent=1, default=float)
print(json.dumps(out["kpi"], indent=1))
print("cohorts", len(out["cohorts"]), "| markets", len(out["markets"]),
      "| reps", len(out["attainment"]), "| partners", len(out["partners"]),
      "| trend months", len(out["trend"]))
