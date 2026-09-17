# B2B card RevOps analytics

A revenue-operations pipeline for a B2B corporate card business: synthetic
data generation, a cleanup engine, a metrics layer, and a dashboard — plus a
full port of the same engine to Google Apps Script so the two implementations
can be checked against each other.

**All data here is synthetic.** Vantis is a fictional company. No figure in
this repository comes from any real business.

📄 **[docs/dashboard.html](docs/dashboard.html)** — the dashboard
📄 **[docs/dashboard.pdf](docs/dashboard.pdf)** — the same thing, one long page

---

## The finding

The same quarter has two defensible win rates.

| | |
|---|---|
| Against closed deals only | **32.9%** |
| Counting abandoned deals | **27.2%** |
| Gap | **5.7 points** |

The first number is what the CRM returns by default: won divided by won plus
lost. The second one adds the 1,037 referrals that have been open past the
stale threshold and that nobody ever marked lost. In practice those are lost.

Neither number is wrong. But if a partner is evaluated on the first while the
credit team plans on the second, the two functions are looking at different
businesses. Before building a dashboard, someone has to decide which one gets
reported — and that is a business decision, not a data one.

The same denominator problem shows up again in quota attainment, one table
over. See the design notes below.

## What is modelled

| | |
|---|---|
| Deals | 11,404 in the reportable universe, 776 quarantined |
| Account-months | 26,060 |
| Markets | 17 countries, 12 currencies |
| Monthly card spend | $54.2M |
| Modelled net revenue | $848k, a 1.57% net take rate |

Revenue is a take rate on what the account spends, not a fee billed to the
client — so the chain has to end in volume, not in signature. Rates used:
1.45% interchange, 0.90% FX spread on cross-border spend, 2.00% monthly on
revolved balances, less 0.45% of spend in network, processing and rewards.
All four live in one config, not scattered through the code.

## The cleanup engine

Fifteen rules over a HubSpot-style deal export and a monthly usage table.
Each row that a rule touches gets one of three outcomes, written to an audit
log with the rule that fired and what changed:

- **FLAG** — reported, left in the data
- **CORRECT** — repaired, original value retained in the log
- **QUARANTINE** — removed from the reportable universe, kept in a separate file

| | Rule | Action |
|---|---|---|
| R01 | Test record | quarantine |
| R02 | Duplicate deal | quarantine |
| R03 | Stage vs closed flag | correct |
| R04 | Won with no amount | quarantine |
| R05 | FX not applied | correct |
| R06 | USD amount blank | correct |
| R07 | Currency vs country | flag |
| R08 | Close date before create date | quarantine |
| R09 | Stale open deal | flag |
| R10 | Partner name not normalized | correct |
| R11 | Unattributed partnership | flag |
| R12 | No owner assigned | flag |
| R13 | Lost with no reason | flag |
| R14 | Limit outside segment band | flag |
| R15 | Orphaned usage row | quarantine |

## Design notes

**Nothing is dropped silently.** Every exclusion is a row in the audit log
with the rule that caused it. Silent exclusion is how trust in a dashboard
breaks: the number moves, nobody can say why, and from then on every number
is suspect.

**Referential integrity across tables (R15).** Quarantining a deal also
removes that account's spend history — 1,414 account-months and $48.8M of
spend. Cleaning one table and not the other is how a dashboard ends up
internally consistent and externally wrong.

**Quota attainment is measured against new volume.** The quota is monthly new
volume, so the actual has to be new volume too: spend from accounts the rep
activated inside the quarter, not spend from every account they have ever
owned. Measured against the whole book, a rep with two years of tenure clears
quota on installed base alone and the table stops saying anything about the
quarter. An earlier version of this pipeline did exactly that and produced
attainment figures above 2,800%.

**Business decisions live in config, not in code.** FX table, country-currency
map, revenue rates, stale threshold, duplicate window and segment bands are
all parameters. In the Apps Script version they live in a `parametros` tab
that a non-engineer can edit, behind strict validation: a rate written as
`1.45` instead of `0.0145`, a blank FX cell, a country with no rate, USD not
equal to 1, or an inverted band all fail loudly before a single row is
processed.

**Rounding happens at the presentation edge.** Cells and JSON keep full
precision; the number format and the template shorten it. Rounding in the
data means the error compounds in anything that aggregates it later.

**Two independent implementations that agree is evidence; one is a hope.**
The Apps Script port recomputes every metric from the same CSVs, and
`tests/test_gas.js` runs it in Node and compares rule by rule with the Python
output. In the spreadsheet, `verifyFormulas()` does the same against the live
formulas and writes the comparison to its own tab.

## Two bugs the cross-check caught

**A stale config the tests could not see.** The Python FX/country table had
been left at seven currencies from an earlier, smaller dataset, silently
skipping five of them. Nothing failed; the totals just quietly excluded those
markets. Writing the config out in full for the Apps Script port and diffing
the two engines is what exposed it.

**A date that was not a string.** On import, Sheets parsed the `month` column
`2026-08` as a date. `slice(0,7)` then returned `Wed Jul`, the SUMIFS matched
nothing, and spend rendered as $0 while the other five figures on the page
looked perfect. `verifyFormulas()` caught it, not a manual review. Fixed with
a `monthStr()` normalizer tested against six input shapes.

Both are the same class of failure: the file is produced without error and
the number looks plausible until someone checks it against a second source.

## Running it

```bash
pip install pandas numpy

python3 pipeline/01_generate_export.py   # synthetic raw tables -> data/
python3 pipeline/02_cleanup_engine.py    # fifteen rules + audit log
python3 pipeline/03_metrics.py           # metrics.json
python3 pipeline/04_build_dashboard.py   # docs/dashboard.html

node tests/test_gas.js                   # Apps Script engine vs Python, rule by rule
```

To regenerate the PDF (needs `wkhtmltopdf`):

```bash
python3 pipeline/05_make_print_pdf.py    # translates CSS grid, gradients, chart heights
bash  pipeline/06_render_pdf.sh 1670 docs/dashboard.pdf
```

The print step exists because the PDF engine runs on an older layout engine
that supports neither CSS grid nor the `inset` shorthand, and because
gradients render as white in some PDF viewers. The rewrite happens in a
separate stylesheet so the browser version is never touched.

## Apps Script version

`apps_script/` holds the same pipeline as a Google Sheets add-on: config,
cleanup engine, metrics, a parameters tab with validation, a metric
dictionary that reads its values live from that tab, and a formula layer that
rewrites the metric sheets as SUMIFS/COUNTIFS pointing at the cleaned data —
so every number on the sheet can be clicked and traced back to its rows.
See `apps_script/README.md` for installation.

## Layout

```
pipeline/      generation, cleanup, metrics, dashboard, PDF
apps_script/   the same engine for Google Sheets
tests/         Node harness comparing both engines
docs/          dashboard.html, dashboard.pdf (served by GitHub Pages)
data/          generated CSVs and metrics.json (produced by the pipeline)
```

## License

MIT
