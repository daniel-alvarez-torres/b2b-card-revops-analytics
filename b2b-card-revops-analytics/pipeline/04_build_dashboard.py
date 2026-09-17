import json, html
import os
os.makedirs("docs", exist_ok=True)

M = json.load(open("data/metrics.json"))
K, Q, A = M["kpi"], M["quality_totals"], M["assumptions"]


def usd(x, d=1):
    n = abs(x)
    s = "-" if x < 0 else ""
    if n >= 1_000_000: return f"{s}${n/1_000_000:.{d}f}M"
    if n >= 1_000: return f"{s}${n/1_000:.0f}k"
    return f"{s}${n:,.0f}"


def esc(x): return html.escape(str(x))


MONTH_LBL = {"01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr", "05": "May", "06": "Jun",
             "07": "Jul", "08": "Aug", "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec"}


def mlbl(m):
    y, mo = m.split("-")
    return f"{MONTH_LBL[mo]} {y[2:]}"


# ---------- revenue build ----------
rb_max = max(abs(r["v"]) for r in M["rev_build"] if r["type"] != "base")
rb = ""
for r in M["rev_build"]:
    if r["type"] == "base":
        rb += f'''<div class="rb-base"><span>{esc(r["k"])}</span>
        <b>{usd(r["v"])}</b></div>'''
        continue
    wpc = abs(r["v"]) / rb_max * 100
    cls = {"up": "up", "down": "down", "total": "tot"}[r["type"]]
    rb += f'''<div class="rb-row {cls}">
      <div class="rb-k">{esc(r["k"])}</div>
      <div class="rb-t"><div class="rb-b" style="width:{wpc:.1f}%"></div></div>
      <div class="rb-v">{usd(r["v"])}</div></div>'''

# ---------- trend ----------
tmax = max(t["partners"] + t["direct"] for t in M["trend"])
trend = ""
for i, t in enumerate(M["trend"]):
    hp = t["partners"] / tmax * 100
    hd = t["direct"] / tmax * 100
    show = (len(M["trend"]) - 1 - i) % 3 == 0
    trend += f'''<div class="tcol" title="{mlbl(t['m'])}: {usd(t['partners']+t['direct'])}">
      <div class="tstack"><div class="td" style="height:{hd:.1f}%"></div>
      <div class="tp" style="height:{hp:.1f}%"></div></div>
      <div class="tq">{mlbl(t['m']) if show else '&nbsp;'}</div></div>'''

# ---------- funnel ----------
fmax = M["funnel"][0]["n"]
fun = ""
for i, f in enumerate(M["funnel"]):
    pct = f["n"] / fmax * 100
    step = "" if i == 0 else f'<span class="step">{f["conv"]}% of prior · {f["of_top"]}% of top</span>'
    fun += f'''<div class="frow"><div class="flabel">{esc(f["stage"])}</div>
      <div class="ftrack"><div class="fbar" style="width:{pct:.1f}%"></div></div>
      <div class="fval">{f["n"]:,}{step}</div></div>'''

# ---------- cohorts ----------
maxk = max(len(c["vals"]) for c in M["cohorts"])
head = "".join(f"<th>M{k}</th>" for k in range(min(maxk, 13)))
coh = ""
for c in M["cohorts"]:
    cells = ""
    for v in c["vals"][:13]:
        o = max(0.10, min(1.0, v / 135))
        cells += f'<td class="heat" style="background:rgba(224,182,92,{o:.2f})">{v:.0f}</td>'
    cells += "<td></td>" * (min(maxk, 13) - len(c["vals"][:13]))
    coh += f'<tr><th scope="row">{esc(c["cohort"])}<span class="cur">{c["accounts"]} accounts</span></th>{cells}</tr>'

# ---------- markets ----------
mmax = max(m["tpv"] for m in M["markets"])
mkt = ""
for m in M["markets"]:
    w = m["tpv"] / mmax * 100
    pw = w * m["partner_share"] / 100
    mkt += f'''<tr><th scope="row">{esc(m["country"])}
      <span class="cur">{m["cur"]} · {esc(m["region"])}</span></th>
      <td class="num">{m["accounts"]:,}</td>
      <td class="barcell"><div class="stack"><div class="s-tot" style="width:{w:.1f}%"></div>
      <div class="s-par" style="width:{pw:.1f}%"></div></div></td>
      <td class="num">{usd(m["tpv"])}</td>
      <td class="num">{usd(m["net"])}</td>
      <td class="num dim">{m["partner_share"]}%</td></tr>'''

# ---------- regions ----------
reg = "".join(f'''<tr><th scope="row">{esc(r["region"])}</th>
  <td class="num">{r["accounts"]:,}</td><td class="num">{usd(r["tpv"])}</td>
  <td class="num">{usd(r["net"])}</td><td class="num">{r["wr"]}%</td></tr>''' for r in M["regions"])

# ---------- currencies ----------
cur = ""
for c in M["currencies"]:
    cur += f'''<div class="crow"><span class="ccode">{esc(c["cur"])}</span>
      <div class="ctrack"><div class="cbar" style="width:{c["share"]*2.6:.1f}%"></div></div>
      <span class="cshare">{c["share"]}%</span>
      <span class="cname">{esc(c["name"])}</span></div>'''

# ---------- partner types ----------
pt = "".join(f'''<tr><th scope="row">{esc(t["type"])}</th>
  <td class="num">{t["refs"]:,}</td><td class="num">{t["won"]:,}</td>
  <td class="num">{t["wr"]}%</td><td class="num alt">{t["wr_cons"]}%</td>
  <td class="num gap">{t["gap"]:+.1f}</td><td class="num">{t["cycle"]}d</td>
  <td class="num">{usd(t["tpv"])}</td></tr>''' for t in M["ptypes"])

# ---------- partner leaderboard ----------
pb = "".join(f'''<tr><th scope="row">{esc(p["partner"])}
  <span class="cur">{esc(p["type"])}</span></th>
  <td class="num">{p["refs"]:,}</td><td class="num">{p["won"]:,}</td>
  <td class="num">{p["wr"]}%</td><td class="num">{usd(p["tpv"])}</td></tr>'''
  for p in M["partners"])

# ---------- attainment ----------
att = ""
for a in M["attainment"]:
    w = min(a["att"], 160) / 160 * 100
    cls = "over" if a["att"] >= 100 else ("mid" if a["att"] >= 70 else "low")
    att += f'''<tr><th scope="row">{esc(a["owner"])}
      <span class="cur">{esc(a["region"])} · {a["tenure_m"]} mo tenure</span></th>
      <td class="num">{usd(a["quota"])}</td><td class="num">{usd(a["actual"])}</td>
      <td class="barcell"><div class="stack"><div class="s-att {cls}" style="width:{w:.1f}%"></div>
      <div class="s-mark"></div></div></td>
      <td class="num {cls}">{a["att"]}%</td></tr>'''

ramp = "".join(f'''<div class="node"><b>{r["att"]}%</b>
  <span>{esc(r["bucket"])} · {r["n"]} reps</span></div>''' for r in M["ramp"])

# ---------- segments / products ----------
seg = "".join(f'''<tr><th scope="row">{esc(s["segment"])}</th>
  <td class="num">{s["refs"]:,}</td><td class="num">{s["wr"]}%</td>
  <td class="num">{s["cycle"]}d</td><td class="num">{usd(s["avg_acct"])}</td>
  <td class="num">{usd(s["tpv"])}</td></tr>''' for s in M["segments"])

prod = "".join(f'''<tr><th scope="row">{esc(p["product"])}</th>
  <td class="num">{p["accounts"]:,}</td><td class="num">{usd(p["tpv"])}</td>
  <td class="num">{usd(p["net"])}</td><td class="num alt">{p["take"]}%</td></tr>'''
  for p in M["products"])

# ---------- losses ----------
lmax = max(l["n"] for l in M["losses"])
loss = ""
for l in M["losses"]:
    w = l["n"] / lmax * 100
    nr = "nr" if l["reason"] == "Not recorded" else ""
    loss += f'''<div class="frow"><div class="flabel {nr}">{esc(l["reason"])}</div>
      <div class="ftrack"><div class="fbar {nr}" style="width:{w:.1f}%"></div></div>
      <div class="fval">{l["n"]:,}</div></div>'''

# ---------- quality ledger ----------
ACC = {"QUARANTINE": ("quarantined", "q"), "CORRECT": ("corrected", "c"), "FLAG": ("flagged", "f")}
led = ""
for r in M["quality"]:
    if r["rows"] == 0:
        continue
    lab, cls = ACC[r["action"]]
    led += f'''<li class="led {cls}"><div class="led-h">
      <span class="led-r">{esc(r["rule"])}</span><span class="led-n">{r["rows"]:,}</span></div>
      <div class="led-a">{lab}</div><p>{esc(r["detail"])}</p></li>'''

HTML = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vantis — Partnerships channel</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
:root{{--ink:#07070A;--panel:#111015;--line:#242229;--line2:#1a181f;
--gold:#E0B65C;--gold-d:#8E7236;--txt:#EDEAE3;--dim:#8C877E;
--teal:#5F9E97;--clay:#C0603B;--f:"Helvetica Neue",Helvetica,Arial,sans-serif}}
body{{background:var(--ink);color:var(--txt);font-family:var(--f);font-size:15px;
line-height:1.5;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}}
.wrap{{max-width:1120px;margin:0 auto;padding:28px 20px 80px}}
h2{{font-size:15px;font-weight:600;margin-bottom:4px}}
.sub{{color:var(--dim);font-size:13px;line-height:1.45;max-width:66ch}}
section{{margin-top:46px}}
.num{{text-align:right}} .dim{{color:var(--dim)}} .alt{{color:var(--teal)}}
.gap{{color:var(--clay)}}

.mast{{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;
flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:18px}}
.mark{{display:flex;align-items:center;gap:11px}}
.brand{{font-size:19px;font-weight:700;letter-spacing:.14em;color:var(--gold)}}
.role{{font-size:13px;color:var(--dim);margin-top:3px}}
.synth{{border:1px solid var(--clay);color:#E0A183;border-radius:2px;padding:5px 9px;
font-size:11.5px;line-height:1.35;max-width:250px}}

.hero{{margin-top:34px;border:1px solid var(--line);background:var(--panel);
border-radius:3px;overflow:hidden}}
.hero-top{{padding:22px 22px 6px}}
.hero-q{{font-size:20px;font-weight:600;line-height:1.3;max-width:32ch}}
.hero-q em{{font-style:normal;color:var(--gold)}}
.duo{{display:flex;flex-wrap:wrap}}
.pane{{flex:1 1 240px;padding:20px 22px 24px}}
.pane+.pane{{border-left:1px solid var(--line)}}
.big{{font-size:58px;font-weight:300;line-height:1;letter-spacing:-.02em}}
.pane.a .big{{color:var(--gold)}} .pane.b .big{{color:var(--teal)}}
.pane h3{{font-size:13.5px;font-weight:600;margin:9px 0 5px}}
.pane p{{font-size:12.5px;color:var(--dim);line-height:1.5}}
.bridge{{border-top:1px solid var(--line);background:#0C0B0F;padding:13px 22px;
font-size:13px;color:var(--dim)}} .bridge b{{color:var(--txt);font-weight:600}}

.kpis{{display:grid;grid-template-columns:repeat(auto-fit,minmax(142px,1fr));gap:1px;
background:var(--line);border:1px solid var(--line);margin-top:1px}}
.kpi{{background:var(--panel);padding:15px 16px}}
.kpi .v{{font-size:24px;font-weight:400}}
.kpi .k{{font-size:12px;color:var(--dim);margin-top:3px}}

.rb{{margin-top:14px}}
.rb-base{{display:flex;justify-content:space-between;align-items:baseline;
padding:11px 0;border-bottom:1px solid var(--line)}}
.rb-base b{{font-size:22px;font-weight:400}}
.rb-row{{display:grid;grid-template-columns:200px 1fr 92px;gap:12px;align-items:center;
padding:7px 0;border-bottom:1px solid var(--line2);font-size:13.5px}}
.rb-t{{height:9px;background:#17161B}}
.rb-b{{height:100%}}
.rb-row.up .rb-b{{background:var(--gold)}}
.rb-row.down .rb-b{{background:var(--clay)}}
.rb-row.tot .rb-b{{background:var(--teal)}}
.rb-row.tot{{border-bottom:0;font-weight:600}}
.rb-v{{text-align:right}}

.trend{{display:flex;gap:2px;align-items:flex-end;height:180px;margin-top:16px}}
.tcol{{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%}}
.tstack{{flex:1;display:flex;flex-direction:column;justify-content:flex-end}}
.tp{{background:var(--gold)}} .td{{background:var(--gold-d)}}
.tq{{font-size:10px;color:var(--dim);text-align:center;margin-top:6px;white-space:nowrap}}
.legend{{display:flex;gap:16px;font-size:12px;color:var(--dim);margin-top:10px}}
.sw{{display:inline-block;width:10px;height:10px;margin-right:5px;vertical-align:-1px}}

.frow{{display:grid;grid-template-columns:186px 1fr 132px;gap:12px;align-items:center;
padding:8px 0;border-bottom:1px solid var(--line2)}}
.flabel{{font-size:13px}} .flabel.nr{{color:var(--clay)}}
.ftrack{{height:9px;background:#17161B}}
.fbar{{height:100%;background:linear-gradient(90deg,var(--gold-d),var(--gold))}}
.fbar.nr{{background:var(--clay)}}
.fval{{text-align:right;font-size:14px}}
.step{{display:block;font-size:11px;color:var(--dim)}}

table{{width:100%;border-collapse:collapse;margin-top:12px;font-size:13.5px}}
thead th{{font-size:11.5px;color:var(--dim);font-weight:500;text-align:right;
padding:0 0 8px;border-bottom:1px solid var(--line)}}
thead th:first-child{{text-align:left}}
tbody th{{text-align:left;font-weight:500;padding:9px 8px 9px 0;
border-bottom:1px solid var(--line2)}}
tbody td{{padding:9px 0 9px 12px;border-bottom:1px solid var(--line2)}}
.cur{{display:block;font-size:11px;color:var(--dim);font-weight:400}}
.barcell{{width:22%;min-width:80px}}
.stack{{position:relative;height:9px;background:#17161B}}
.s-tot{{position:absolute;inset:0 auto 0 0;background:var(--gold-d)}}
.s-par{{position:absolute;inset:0 auto 0 0;background:var(--gold)}}
.s-att{{position:absolute;inset:0 auto 0 0}}
.s-att.over{{background:var(--teal)}} .s-att.mid{{background:var(--gold)}}
.s-att.low{{background:var(--clay)}}
.s-mark{{position:absolute;top:-2px;bottom:-2px;left:62.5%;width:1px;background:#4A4750}}
td.over,.over{{color:var(--teal)}} td.low,.low{{color:var(--clay)}}

.heat{{text-align:center;padding:7px 4px;font-size:12px;color:#0B0A0D;font-weight:600;
border-bottom:1px solid var(--ink)}}
.cohort-tbl th{{white-space:nowrap}}

.crow{{display:grid;grid-template-columns:44px 1fr 48px 1fr;gap:10px;align-items:center;
padding:6px 0;border-bottom:1px solid var(--line2);font-size:13px}}
.ccode{{font-weight:600}}
.ctrack{{height:8px;background:#17161B}}
.cbar{{height:100%;background:var(--gold)}}
.cshare{{text-align:right}} .cname{{color:var(--dim);font-size:12px}}

.ledger{{list-style:none;display:grid;
grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;margin-top:14px}}
.led{{background:var(--panel);border:1px solid var(--line);border-left-width:3px;
padding:12px 13px;border-radius:2px}}
.led.q{{border-left-color:var(--clay)}} .led.c{{border-left-color:var(--teal)}}
.led.f{{border-left-color:var(--gold)}}
.led-h{{display:flex;justify-content:space-between;gap:10px;align-items:baseline}}
.led-r{{font-size:13px;font-weight:600}} .led-n{{font-size:17px}}
.led-a{{font-size:11.5px;color:var(--dim);margin:1px 0 6px}}
.led p{{font-size:12px;color:var(--dim);line-height:1.45}}

.flow{{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin-top:14px;font-size:13px}}
.node{{border:1px solid var(--line);background:var(--panel);padding:8px 12px;border-radius:2px}}
.node b{{display:block;font-size:17px;font-weight:400}}
.node span{{font-size:11.5px;color:var(--dim)}}
.arrow{{color:var(--gold-d)}}
.cols{{display:grid;grid-template-columns:1fr 1fr;gap:34px}}
footer{{margin-top:54px;padding-top:18px;border-top:1px solid var(--line);
font-size:12px;color:var(--dim);line-height:1.6}}
@media(max-width:760px){{.cols{{grid-template-columns:1fr;gap:40px}}}}
@media(max-width:620px){{
.frow{{grid-template-columns:120px 1fr 86px;gap:8px}} .flabel{{font-size:12px}}
.big{{font-size:46px}} .pane+.pane{{border-left:0;border-top:1px solid var(--line)}}
.barcell{{display:none}} .rb-row{{grid-template-columns:130px 1fr 78px}}
table{{font-size:12.5px}} .heat{{font-size:10px;padding:5px 2px}}
.crow{{grid-template-columns:38px 1fr 44px}} .cname{{display:none}}}}
</style></head><body><div class="wrap">

<div class="mast">
  <div class="mark">
    <div><div class="brand">VANTIS</div>
    <div class="role">Partnerships channel &middot; proposal by Daniel Álvarez</div></div>
  </div>
  <div class="synth">Synthetic data. No figure comes from Vantis.
  {K['total_deals']:,} deals and {K['usage_rows']:,} account-months generated to show
  the model structure and the cleanup engine.</div>
</div>

<div class="hero">
  <div class="hero-top">
    <div class="hero-q">The same quarter has <em>two defensible win rates</em>.
    Before building the dashboard, someone has to decide which one gets reported.</div>
  </div>
  <div class="duo">
    <div class="pane a"><div class="big">{K['wr_closed']}%</div>
      <h3>Against closed deals only</h3>
      <p>Denominator: won plus lost. This is what HubSpot returns by default and
      what almost always gets presented to leadership.</p></div>
    <div class="pane b"><div class="big">{K['wr_conservative']}%</div>
      <h3>Counting abandoned deals</h3>
      <p>Adds the {K['stale_count']:,} referrals open more than 180 days that nobody
      marked lost. In practice they are already lost.</p></div>
  </div>
  <div class="bridge">The gap is
  <b>{round(K['wr_closed']-K['wr_conservative'],1)} points</b>. If a partner is
  evaluated on the first number while the credit team plans on the second, the two
  functions are looking at different businesses.</div>
</div>

<div class="kpis">
  <div class="kpi"><div class="v">{usd(K['tpv_month'])}</div>
    <div class="k">Card spend, {A['month']}</div></div>
  <div class="kpi"><div class="v">{usd(K['net_rev_month'])}</div>
    <div class="k">Modelled net revenue</div></div>
  <div class="kpi"><div class="v">{K['take_rate']:.2f}%</div>
    <div class="k">Net take rate on spend</div></div>
  <div class="kpi"><div class="v">{K['active_accounts']:,}</div>
    <div class="k">Accounts transacting</div></div>
  <div class="kpi"><div class="v">{usd(K['pipeline_limit'])}</div>
    <div class="k">Limit in live pipeline ({K['live_deals']:,} deals)</div></div>
  <div class="kpi"><div class="v">{K['median_cycle']}d</div>
    <div class="k">Median referral to close</div></div>
  <div class="kpi"><div class="v">{K['channel_share']}%</div>
    <div class="k">Of all deals via partners</div></div>
</div>

<section>
  <h2>Where the revenue actually comes from</h2>
  <p class="sub">Nothing here is billed to the client. Revenue is a take rate on
  what the account spends, so the chain has to end in volume, not in signature.
  Rates used: {A['interchange']*100:.2f}% interchange, {A['fx']*100:.2f}% FX spread
  on cross-border spend, {A['fin']*100:.2f}% monthly on revolved balances, less
  {A['cost']*100:.2f}% of spend in network, processing and rewards.</p>
  <div class="rb">{rb}</div>
</section>

<section>
  <h2>Card spend by month</h2>
  <p class="sub">Twenty-four months of activated accounts. The channel compounds
  because activated accounts keep spending, not because new deals keep closing.</p>
  <div class="trend">{trend}</div>
  <div class="legend"><span><span class="sw" style="background:var(--gold)"></span>
  Partnerships</span><span><span class="sw" style="background:var(--gold-d)"></span>
  Direct</span></div>
</section>

<section>
  <h2>Channel funnel</h2>
  <p class="sub">Underwriting is where most referrals fall out. It is the one step
  the rep does not control, which is why it belongs on its own line.</p>
  {fun}
</section>

<section>
  <h2>Spend retention by activation cohort</h2>
  <p class="sub">Average monthly spend per surviving account, indexed to its first
  month. Above 100 means accounts are spending more than they did at activation.
  This is the number that decides whether a partner is worth its commission.</p>
  <table class="cohort-tbl"><thead><tr><th>Cohort</th>{head}</tr></thead>
  <tbody>{coh}</tbody></table>
</section>

<section>
  <h2>Markets</h2>
  <p class="sub">{K['countries']} countries, {K['currencies']} currencies. Each amount
  is converted using the deal's own rate, not one month-end rate. The lighter bar is
  the share partners bring in.</p>
  <table><thead><tr><th>Country</th><th>Accounts</th><th></th><th>Spend</th>
  <th>Net rev</th><th>Via partners</th></tr></thead><tbody>{mkt}</tbody></table>
</section>

<div class="cols">
  <section style="margin-top:46px">
    <h2>Region rollup</h2>
    <table><thead><tr><th>Region</th><th>Accounts</th><th>Spend</th><th>Net rev</th>
    <th>Win rate</th></tr></thead><tbody>{reg}</tbody></table>
  </section>
  <section style="margin-top:46px">
    <h2>Currency exposure</h2>
    <p class="sub">Share of monthly spend by billing currency.</p>
    <div style="margin-top:12px">{cur}</div>
  </section>
</div>

<section>
  <h2>Performance by partner type</h2>
  <p class="sub">The gap column shows how much each type's reading moves with the
  definition. Where the gap is wide, it is the CRM hygiene that is worse, not
  necessarily the partner.</p>
  <table><thead><tr><th>Type</th><th>Referrals</th><th>Won</th><th>WR closed</th>
  <th>WR conservative</th><th>Gap</th><th>Cycle</th><th>Spend</th></tr></thead>
  <tbody>{pt}</tbody></table>
</section>

<section>
  <h2>Partner leaderboard</h2>
  <p class="sub">Ranked by referral volume, which is what a partner controls.
  Spend is what it actually produced.</p>
  <table><thead><tr><th>Partner</th><th>Referrals</th><th>Won</th><th>Win rate</th>
  <th>Spend</th></tr></thead><tbody>{pb}</tbody></table>
</section>

<section>
  <h2>Quota attainment, {A['month'][:4]} latest full quarter</h2>
  <p class="sub">Measured in activated monthly spend, not bookings. The tick on each
  bar marks 100%.</p>
  <table><thead><tr><th>Rep</th><th>Quota</th><th>Actual</th><th>vs quota</th>
  <th>Attainment</th></tr></thead><tbody>{att}</tbody></table>
  <p class="sub" style="margin-top:20px">Average attainment by tenure. The ramp is
  the reason a hiring plan cannot be read off headcount alone.</p>
  <div class="flow">{ramp}</div>
</section>

<div class="cols">
  <section style="margin-top:46px">
    <h2>By segment</h2>
    <table><thead><tr><th>Segment</th><th>Refs</th><th>WR</th><th>Cycle</th>
    <th>Per account</th><th>Spend</th></tr></thead><tbody>{seg}</tbody></table>
  </section>
  <section style="margin-top:46px">
    <h2>By product line</h2>
    <table><thead><tr><th>Product</th><th>Accounts</th><th>Spend</th><th>Net rev</th>
    <th>Take</th></tr></thead><tbody>{prod}</tbody></table>
  </section>
</div>

<section>
  <h2>Why referrals are lost</h2>
  <p class="sub">The largest bar should worry the team: a loss with no reason
  recorded cannot be coached, and cannot be fed back to the partner who sent it.</p>
  {loss}
</section>

<section>
  <h2>What the cleanup engine found</h2>
  <p class="sub">Of {Q['raw']:,} raw deal rows, {Q['quarantined']:,} left the reportable
  universe and {Q['reportable']:,} remained. Quarantining a deal also removes its
  spend history: {Q['usage_raw']-Q['usage_clean']:,} account-months and
  {usd(Q['spend_removed'])} of spend came out with them. Nothing is dropped silently
  — every affected row keeps the rule that touched it.</p>
  <ul class="ledger">{led}</ul>
</section>

<section>
  <h2>What I would ask before building this for real</h2>
  <p class="sub">A dashboard inherits the decisions nobody made. These four are still
  open, and each one moves every number above.</p>
  <ul class="ledger">
    <li class="led f"><div class="led-h"><span class="led-r">Win rate definition</span></div>
      <div class="led-a">a business decision, not a data one</div>
      <p>After how many days does an open referral count as lost? Without that rule
      every function reports a different number and all of them are right.</p></li>
    <li class="led f"><div class="led-h"><span class="led-r">Channel attribution</span></div>
      <div class="led-a">{Q['unattributed']:,} cases with no partner</div>
      <p>If a partner refers and the client closes through direct sales three months
      later, whose deal is it? The answer decides whether the channel looks
      profitable.</p></li>
    <li class="led f"><div class="led-h"><span class="led-r">FX timing</span></div>
      <div class="led-a">{K['currencies']} currencies</div>
      <p>Convert at the deal-date rate or the month-end rate? In COP, ARS and BRL the
      difference is material, and it is not an accounting detail.</p></li>
    <li class="led f"><div class="led-h"><span class="led-r">What a partner is paid on</span></div>
      <div class="led-a">referrals, activations or spend</div>
      <p>Paying on referrals rewards volume, on activations rewards quality, on spend
      rewards patience. The cohort table above argues for the third.</p></li>
  </ul>
</section>

<footer>
  Built on synthetic data generated for this exercise: {K['total_deals']:,} deals,
  {K['usage_rows']:,} account-months, {K['countries']} countries,
  {K['currencies']} currencies. Cleanup engine in Python, fifteen rules, auditable
  output. This HTML mirrors the structure I would carry into Tableau or Power BI.
</footer>
</div></body></html>"""

open("docs/dashboard.html", "w").write(HTML)
print("ok", len(HTML))
