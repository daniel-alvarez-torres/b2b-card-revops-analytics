# Partnerships analytics — Apps Script project

A Google Sheets + Apps Script port of the cleanup and metrics engines.
Same fifteen rules, same aggregations, same dashboard, running where the
data already lives.

## Files

| File | What it does |
|---|---|
| `00_Config.gs` | Every business decision in one place: stale threshold, duplicate window, FX table, revenue rates, segment bands, test-pattern dictionary. Change behaviour here, not in the rules. |
| `01_Lib.gs` | Sheet I/O and text normalization. Each sheet is read with one `getValues()` and written with one `setValues()`. |
| `02_CleanupEngine.gs` | The fifteen rules. Each marks rows as FLAG, CORRECT or QUARANTINE and writes an audit log. |
| `03_Metrics.gs` | Aggregations. Writes one flat sheet per view so a BI tool never has to recompute logic. |
| `04_Menu.gs` | Menu, orchestration, daily trigger, CSV import from Drive. |
| `05_Params.gs` | Reads the `parametros` tab, validates it, and overrides the code defaults on every run. |
| `06_Definitions.gs` | The metric dictionary: what each number means, its formula, its source tables, and the business decision behind it. |
| `07_Formulas.gs` | Rewrites the metric sheets as live SUMIFS/COUNTIFS formulas over the clean tables, then verifies them against the engine's own numbers. |
| `Dashboard.html` | The dashboard, rendered in a modal from the metric sheets. |
| `Definitions.html` | The metric dictionary, rendered in a modal. |
| `appsscript.json` | Manifest. V8 runtime, narrow scopes. |

## Setup

1. Create a Google Sheet. Extensions → Apps Script.
2. Paste each `.gs` file into a file of the same name. Add `Dashboard.html`
   via **+ → HTML**, named exactly `Dashboard`.
3. Project settings → show `appsscript.json` → replace it with the one here.
4. Put the four CSVs in a Drive folder, then run
   `importCsvsFromFolder('<folder id>')` once from the editor.
5. Run `createParamsSheet()` once to build the `parametros` tab.
6. Reload the Sheet. A **RevOps** menu appears → *Run full pipeline*.

With `clasp`: `clasp create --type sheets` then `clasp push`.

## The `parametros` tab

FX rates, the country-to-currency map, the revenue rates, the segment bands
and the two rule thresholds live in a tab, not in the code. Finance updates a
rate without opening the editor, and the change is visible in the sheet's
version history instead of buried in a commit.

Columns: `seccion`, `clave`, `valor`, `valor_2`, `nota`.

| `seccion` | What it holds |
|---|---|
| `fx` | Units of local currency per 1 USD, one row per currency |
| `pais_moneda` | Which currency each country bills in |
| `tasa_ingreso` | Interchange, FX spread, financing yield, cost — as decimals |
| `regla` | Stale-deal threshold, duplicate window, reference date |
| `banda_segmento` | Plausible approved-limit range per segment (`valor` = min, `valor_2` = max) |

Both engines call `loadParamsOrThrow()` before they touch a row, so a bad
parameter stops the run instead of producing a plausible wrong number. The
validator catches a rate typed as `1.45` instead of `0.0145`, a blank FX cell,
a country pointing at a currency with no rate, a USD rate that is not 1, and an
inverted segment band. **RevOps → Check parameters** runs the same validation
without running the pipeline.

Leave `fecha_de_corte` blank to use today's date.

Changing `dias_deal_estancado` from 180 to 365 moves the conservative win rate
from 27.2% to 28.6% on this dataset. That is the point: the threshold is a
business decision, and it belongs somewhere the business can see it.

## Sheets it reads

`deals_raw`, `usage_raw`, `rep_quotas`, `reps`, `parametros`

## Sheets it writes

`deals_clean`, `deals_quarantine`, `usage_clean`, `audit_log`, and one
`m_*` sheet per view (`m_kpi`, `m_funnel`, `m_markets`, `m_cohorts`,
`m_trend`, `m_attainment`, `m_partner_types`, `m_partners`, `m_segments`,
`m_products`, `m_loss_reasons`, `m_currency_exposure`, `m_revenue_build`,
`m_ramp`).

## Performance

12,000 deal rows and 27,000 usage rows run inside the six-minute execution
quota because all I/O happens in two calls per sheet. If the dataset grows
past roughly 50,000 rows per sheet, move the source tables to BigQuery and
keep this script as the rule layer.

## The metric dictionary

**RevOps → How every metric is calculated** opens 23 metrics in five groups, each
with a plain-language meaning, the formula, the source tables, and — for the 17
where it applies — the business decision the number rests on.

The definitions read their thresholds and rates live from `parametros`. Change the
stale threshold to 365 and the dictionary says 365 the next time it opens. A
definition that can drift from the code it describes is worse than no definition.

**RevOps → Write metric dictionary to a tab** writes the same content to
`diccionario_metricas`, for the people who will never open the script editor.

## Formulas, not pasted numbers

**RevOps → 3. Rewrite metrics as formulas** replaces every computed value in the
`m_*` sheets with a live formula pointing at `deals_clean` and `usage_clean`.
Click any cell and you can follow the number back to the rows behind it.

It works in two layers:

1. **Derived columns.** `deals_clean` gets `is_won`, `is_lost`, `is_stale` and
   `is_open_live`; `usage_clean` gets `interchange_usd`, `fx_revenue_usd`,
   `financing_usd`, `cost_usd`, `net_revenue_usd`, `owner` and `quarter`. One
   `ARRAYFORMULA` per column, not one formula per row — 26,000 rows times eight
   columns would be 208,000 formulas and a sheet that recalculates for a minute.
2. **Metric sheets.** `SUMIFS` and `COUNTIFS` over those columns.

Rates and thresholds are referenced with `INDEX/MATCH` into `parametros`, never
typed into the formula. Change the interchange rate in the tab and every revenue
cell moves, without rerunning the script.

`is_stale` is recomputed from the threshold rather than copied from the `_flags`
column, so the formula layer and the rule engine cannot disagree about it.

### Verification

`verifyFormulas()` reads the evaluated formula results back and compares them
with what `runMetrics()` computed in JavaScript, writing the comparison to
`verificacion_formulas`. Two independent implementations that agree is evidence;
one implementation is a hope. Tolerance is 0.05%, for float rounding.

## Tests

`test_gas.js` runs these engines in Node against the same CSVs, with the sheet
I/O swapped for file-backed stubs, and compares every rule count with the
Python implementation. It also feeds five deliberately broken parameter tabs
through the validator. Run it with `node test_gas.js` from the folder holding
the CSVs.

## The one thing to read first

`winRates()` in `02_CleanupEngine.gs` returns two numbers, not one. The
difference between them is the stale threshold in the `parametros` tab, and
that threshold is a business decision nobody has made yet.
