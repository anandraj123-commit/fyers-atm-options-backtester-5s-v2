# FYERS ATM Options Backtester 5S V2

The existing Node.js/Express app and its two-tab UI are retained. No trading orders are sent.
Run on Node 22+: `npm install`, configure `.env` from `.env.example`, then `npm run dev`.
Open http://127.0.0.1:3000 and connect FYERS. Run all automated tests with `npm test`.

## Connecting FYERS

Set the app ID, secret and registered redirect URI in server-side `.env`. The redirect path must be `/api/fyers/callback`. Click **Connect FYERS**, authorize on FYERS, and the callback exchanges the code on the backend before redirecting back to the app. No code/token copy and paste is required. The frontend checks `/api/status` on load and focus and displays a green **● FYERS Connected** indicator when a token is held by the server. Expired JWT tokens are discarded; opaque tokens cannot be validated for remote revocation through this local status check. Restarting the server requires reconnecting.

The login route first aligns the browser with the configured callback origin, preventing a localhost/127.0.0.1 cookie mismatch. State is random, short-lived, cookie-bound and single-use. Authentication errors never include provider response bodies or credentials. `.env.example` contains placeholders only.

## Data contracts and diagnostics

Verified against the official [FYERS v3 API documentation](https://myapi.fyers.in/docsv3) and its
[published schema](https://myapi.fyers.in/static/media/v3.fe8a9cf93cee802f58b4.yaml) on 2026-10-04.
The expired APIs were added to these docs on 2026-09-06.

- Regular `/data/history`: `symbol`, `resolution`, `date_format=1`, ISO `range_from/range_to`, `cont_flag=0` for indices.
- Expired `/history/fno/expired/expiry-dates`: `symbol`, ISO date range, `date_format=1`; response uses **data.expiry_dates.options**, separately from futures and request-range dates.
- Expired `/history/fno/expired/underlying-symbols`: `symbol`, ISO `expiry_date`; response uses **data.contracts.options**, which can contain plain symbol strings.
- Expired `/history/fno/expired/historical-data`: contract `symbol`, its own resolution allowlist, ISO date range, `date_format=1`, `include_oi=0`, `include_greeks=0`. No regular-history continuity flag is sent.
- Active, not-yet-expired expiries/contracts are discovered from FYERS `/options-chain-v3` `expiryData` and actual `optionsChain` symbols; active option premiums use regular `/history`. The expired-only expiry, symbol and candle endpoints reject today/future ranges locally. Expired expiry discovery starts at the selected backtest Start Date, covers the selected trading window plus only the next daily/weekly or next-month contract horizon, and clamps `range_to` to yesterday IST.
- Both endpoints document **5S support**, but seconds history is available only for the **last 30 trading days**. Expired historical data is for **expired contracts only**. Regular minute requests are chunked at 100 days; the shared market loader requests stable daily chunks. Expiry requests are chunked at 366 days.
- Underlying monitoring is always **5S**, never interpolated and never replaced with minutes. A day with strategy candles must have every 5-second session observation through the 15:15 opening observation; otherwise the run stops and names the missing timestamp. This intentionally rejects partial sessions/data gaps.
- Option premiums are explicitly selected as **1 minute** (default) or **5S**. This is separate from the fixed **1-minute strategy resolution** and mandatory **5-second SPOT execution**. Neither is optimised. No automatic option-resolution substitution occurs.
- Completed historical dates only: today's partial session is rejected. Weekends are excluded; days with neither strategy nor monitor data produce no trades. EMA can use earlier candles.

Errors retain the endpoint, HTTP status, FYERS numeric code, redacted message, safe parameters and safe field validation details. Raw non-JSON bodies and credentials are not returned or logged. Authentication failures are separate. OAuth state is validated, tokens remain in server memory, and `.env` is excluded from git. The callback immediately redirects to a URL with no auth code; it sets no-referrer/no-store headers. The OAuth protocol necessarily delivers the provider's authorization code to the server callback URL; application JavaScript never reads or persists it.

FYERS History responses are parsed as the documented `[epoch-seconds, open, high, low, close, volume]` arrays. Numeric strings and zero volume are accepted. A controlled live request for NIFTY 5S on 2026-09-09 returned two impossible OHLC rows at 09:08:00 and 09:08:25 IST, before the 09:15 trading start; for example, the first row had `low=23635.1` and `close=23525.45`. FYERS' published array order is unchanged. The 5S parser reports and excludes malformed rows only when their timestamp is on that requested IST date and strictly outside 09:15–15:15. Any malformed row within that required session still fails the request with its endpoint, safe parameters, index, raw candle, length and per-field reason; required 5S gaps are then rejected by the session completeness check. Empty `candles` remains no data and is never treated as a successful trading session. In a non-production environment, authenticated `GET /api/debug/fyers-history?symbol=NIFTY&date=YYYY-MM-DD&resolution=5S` (or `BANKNIFTY`) safely checks a date and returns request parameters, candle counts, edge samples and malformed out-of-session count without credentials.

**The exact cause of a past generic `Invalid input` cannot be proven from its discarded payload.** The old code omitted all diagnostic context. Its date-range handling, response parsing, fill timing, and expiry classification were independently defective. `5S` itself is not an unsupported resolution according to the current expired-F&O schema. Unsupported dates/retention, access restrictions and live validation errors now remain visible rather than being bypassed.

## Strategy and time ordering

All four setup definitions are unchanged in `src/strategy.js`:

- BUY A: EMA slope up, Open < EMA, Close > EMA.
- BUY B: EMA slope up, Open > EMA, Close > EMA, Low <= EMA.
- SELL A: EMA slope down, Open > EMA, Close < EMA.
- SELL B: EMA slope down, Open < EMA, Close < EMA, High >= EMA.

Slope compares the current completed candle EMA with EMA N completed strategy candles earlier. EMA retains the existing first-close seed/recursive formula; warm-up is loaded before the requested trading dates. An optimisation run uses one shared warm-up start derived from its maximum EMA/slope ranges, so each EMA series is calculated once. This `emaSeedDate` is returned in the run context and passed unchanged by Apply Best to detailed backtesting. Both paths use the same EMA function and seed candles. A standalone backtest derives its warm-up start from its own parameters unless this recorded context is supplied.

T0 never executes. Only monitoring bars starting after T0 closes are eligible. BUY crosses strictly above T0 high; SELL strictly below T0 low. Pending lasts T1 through TN, capped at 15:15, ignoring new/opposite setups. A candidate whose close occurs while pending/open is never replayed later. One position at a time. Net losing trades increment the daily consecutive-loss guard; non-losing completed trades reset it, and it resets each trading day.

SL/target remain underlying-based: BUY SL=signalLow, target=signalHigh+risk*RR; SELL SL=signalHigh, target=signalLow-risk*RR. Risk is signalHigh-signalLow. Both options are LONG. No slippage is added.

## Conservative observed-price fill model

1. If the 5S **open** already crosses a level, the event is known at that open timestamp and its observed price is used. Otherwise high/low only proves the event somewhere within that bar: confirmation is its **end**, five seconds later.
2. Intrabar breakout ATM reference uses the confirming 5S **close**, explicitly labelled `CONFIRMING_5S_CLOSE_PROXY`; the exact intrabar crossing tick is unavailable. The old made-up `level +/- 0.01` price is removed.
3. Entry uses the first positive-volume, positive-premium option candle **open at or after confirmation**, strictly before pending expiry/15:15. Never a containing candle's earlier open. If none is available, the unavailable trade is reported. The position starts at the actual option fill; SL/target checks start then, not in pre-entry candles.
4. Exit uses the first such option open at/after the confirmed SL/target event, no later than 15:15. The position remains occupied until that fill. Forced closure uses the **15:15 option open**; if it is missing, the run stops rather than using a stale price, a later fill or overnight data.
5. Underlying entry/exit spot fields are actual 5S opens at the option fill timestamps. Breakout confirmation and exit event times are separate metadata. Candle opens are coarse historical observations, not proven tick-exact executions or a guarantee of worse P&L.
6. If SL and target are both touched in a 5S bar without a known opening touch, the event is explicitly ambiguous. As in the old conservative exclusion policy, it is excluded from P&L. The rest of that day is blocked because the unknown outcome also makes the loss guard uncertain. Exclusions/ambiguity counts are always visible; these results are conditional on the exclusion policy.

The exact fill rule, underlying/option resolution, source, event times, and lot/expiry provenance are returned with each completed trade.

## Actual contracts, expiry type and historical quantity

ATM chooses the nearest **returned** contract strike of the required CE/PE and expiry type; equal-distance ties choose the lower strike. There is no manual strike input. Both BUY/CE and SELL/PE P&L are `(exit premium - entry premium) * lots * historical lot size`.

Monthly/weekly classifications use actual contract metadata or the official monthly/weekly **symbol formats**, matched to the returned expiry date. No current weekday schedule, last-date-in-month guess or short-gap daily heuristic is used. DAILY requires explicit metadata identifying an actual daily contract. Missing requested expiry types are reported and are never replaced with another type.

The documented expired-contract response can contain plain symbol strings, **without historical lot sizes**. The app uses returned FYERS lot metadata first, an exact-expiry sourced `HISTORICAL_CONTRACTS_FILE` override second, then a finite date-effective NSE lot table where its coverage is verified. The bundled table covers documented NIFTY weekly/monthly and BANKNIFTY monthly expiry transitions from May 2024 onward; unsupported expiry periods fail safely. For those dates, configure `HISTORICAL_CONTRACTS_FILE` in `.env` to a server-side JSON file keyed by exact returned symbol. Each entry must contain:

- `expiryDate`: the exact historical expiry date;
- `lotSize`: the verified positive integer lot size for that contract;
- `source`: a nonempty citation/reference to your archived exchange/broker contract metadata;
- optionally `expiryType`: `DAILY`, `WEEKLY` or `MONTHLY`, supported by that source.

This file augments actual FYERS-returned contracts; it cannot create a nonexistent contract. Restart/reconnect after updating metadata if you want a fresh API snapshot. Bundled effective dates come from [NSE/FAOP/61415](https://nsearchives.nseindia.com/content/circulars/FAOP61415.pdf), [NSE/FAOP/64625](https://nsearchives.nseindia.com/content/circulars/FAOP64625.pdf), [NSE/FAOP/67372](https://nsearchives.nseindia.com/content/circulars/FAOP67372.pdf), and [NSE/FAOP/70616](https://nsearchives.nseindia.com/content/circulars/FAOP70616.pdf).

## Charges and ledger

Standard-plan NSE equity options: ₹20 per executed buy/sell order. Eight individual rounded components are exposed as separate ledger columns: brokerage, STT, exchange, clearing, SEBI, GST, stamp and IPFT. Total is the sum of these rounded components; net P&L is gross minus total. This is a per-trade estimator, not a reproduction of contract-note day-level tax rounding, special brokerage plans or exercise settlement charges. No generic Other Charges field or slippage.

Verified schedule:

| Effective date | STT on sell premium | Exchange on both premiums | IPFT on both premiums |
|---|---:|---:|---:|
| 2024-10-01 | 0.10% | 0.03503% | ₹50/crore |
| 2026-03-01 | 0.10% | 0.0355299% | ₹0.01/crore |
| 2026-04-01 | 0.15% | 0.0355299% | ₹0.01/crore |

Clearing: 0.009%; SEBI: ₹10/crore; buy-side stamp: 0.003%; GST: 18% of brokerage + exchange + clearing + SEBI + IPFT. Dates before 2024-10-01 are rejected because earlier full schedules have not been verified.

Sources:
- [FYERS pricing](https://fyers.in/pricing) and [brokerage calculator](https://fyers.in/calculator/brokerage).
- [FYERS October 2024 revision](https://fyers.in/notice-board/revision-of-brokerage-mtf-interest-and-other-charges-effective-october-1-2024).
- [FYERS component charge explanation](https://support.fyers.in/portal/en/kb/articles/what-are-the-brokerage-statutory-and-other-applicable-charges-at-fyers) (some indicative STT figures are stale; dated notices take precedence).
- [NSE FA73061, effective March 2026](https://nsearchives.nseindia.com/content/circulars/FA73061.pdf): exchange/IPFT redistribution. The old implementation combined the new exchange rate with the old IPFT, overcharging.
- [FYERS April 2026 STT revision](https://fyers.in/notice-board/revision-in-securities-transaction-tax-stt-effective-april-01-2026).

Every requested completed-trade field is flat in the HTML ledger. Times are ISO UTC timestamps (`Z`), while trading boundaries/date selection are IST. `tradeReturnPct` uses capital immediately before the trade, and is unavailable if that capital is non-positive. No capital/margin trade filter has been introduced. Summary includes all individual charge totals, independent gross/net profit and loss buckets, net profit factor, averages, extremes, streaks, and realised-equity max drawdown (not intratrade marked-to-market drawdown). A zero-loss profit factor is displayed as Infinity, or unavailable when there are no profits or losses.

## Optimisation jobs

Only EMA length, slope lookback, entry validity, RR, minimum spot stop-distance percent, and daily loss guard are searched. Strategy resolution is fixed at 1 minute; execution is fixed at 5-second SPOT; expiry is fixed at WEEKLY. Symbol, dates, capital, lots and option resolution stay fixed. Both modes call the same simulator as detailed Backtesting, including its existing charge calculation; this change adds no charge controls, rates or result columns.

- **FAST** is the default and explicitly non-exhaustive. It evaluates a deterministic coarse grid of up to four points per numeric dimension, then refines eight winning regions with shrinking grid-index radii and two final neighbour passes. It never leaves the user's stepped ranges. Its default candidate budget is 12,000. It reports **BEST RESULT FOUND — FAST MODE**, without a global-optimum guarantee.
- **EXHAUSTIVE** lazily evaluates every requested combination unless cancelled or a real runtime/cache/data failure interrupts it. The UI warns before starting large searches. It never switches to FAST, and only reports exhaustive completion when evaluated equals requested. Unavailable-data candidates are counted separately and cannot win; the UI does not claim best possible when any requested candidate was ineligible.

The default ranges request **296 × 50 × 20 × 19 × 20 × 1 = 112,480,000** combinations; the last dimension is the default single-value 0% minimum stop-distance filter. Neither mode rejects them because the result file would be too large. FAST evaluates a bounded subset; EXHAUSTIVE starts streaming evaluation and keeps the best result online. Evaluating all 337 million candidates may exceed desktop runtime/resources; an interrupted run is explicitly INCOMPLETE with its actual evaluated count and best parameters so far.

`src/market.js` creates a reusable market snapshot. Every FYERS history/expired-F&O request passes through one process-wide FIFO scheduler. Requests are deduplicated using endpoint, normalized safe parameters and a SHA-256 token identity; credentials never enter keys or diagnostics. Successful responses are process-cached for 24 hours (maximum 5,000 entries). API, transport and authentication failures are not cached; failed in-snapshot promises are removed so a later run may retry. Default concurrency is one (`FYERS_MAX_CONCURRENT_REQUESTS=1`) with a 1,000ms global minimum interval (`FYERS_HISTORY_MIN_INTERVAL_MS`). A 429 pauses the shared queue and gets at most two retries after the original attempt; valid `Retry-After` seconds/date are respected, otherwise exponential backoff with jitter uses `FYERS_RETRY_BASE_DELAY_MS` (default 1,000ms). Job cancellation aborts queued work and stops retry waits. Safe counters are available at authenticated, development-only `GET /api/debug/fyers-requests`; detailed request logs are emitted only with `NODE_ENV=development`.

Backtesting and optimisation use the same scheduler/cache. Each market snapshot fetches 1-minute SPOT from the EMA/slope warm-up start through End Date and a separate mandatory 5S SPOT stream from Start Date through End Date. Minute history is chunked at up to 100 calendar days; 5S history uses bounded 5-calendar-day chunks. Optimisation prepares the union of needed option contracts/premiums before candidate evaluation; candidate evaluation cannot make FYERS requests. All these requests share one scheduler, process cache and in-flight deduplication. If required preparation fails, backtesting returns **BACKTEST NOT RUN** and clears any prior visible ledger; optimisation ends in `failed` with zero candidates and the explicit preparation reason. During a 429 wait, optimiser status is `waiting_rate_limit` and no candidate evaluation is reported as underway.

The selected Start Date and End Date are authoritative trading bounds. Strategy candles use fixed 1-minute resolution from the calculated pre-start EMA/slope warm-up through End Date; signal generation only considers candles dated within the selected range. Mandatory 5S execution requests cover only Start Date through End Date. The expiry-discovery horizon is separate from both ranges and cannot be passed beyond yesterday to an expired-only endpoint. Completed results report the actual prepared candle, session, expiry and option-premium counts.

Results are ranked by the existing **net total return %** calculation. Exact ties prefer lower EMA, slope lookback, entry validity, RR, daily loss guard, then stop-distance percent. Expiry is always WEEKLY. The online best always retains all six winning parameter values. The same object drives the prominent return card and **Apply Best to Backtesting**. The optimization form context is copied to the detailed form when the optimization starts. Apply Best then changes only the winning strategy parameters and runs the detailed backtest if the market context still matches; it never changes dates, resolution, execution, or expiry.

Evaluation and retention are separate. Rows are buffered in groups of 1,000, written as sorted runs, then externally merged with at most 32 input files open. Until the retention budget is reached, every row remains accessible. Afterwards evaluation continues and the final best row is reserved even if it was outside the retained prefix. The UI separately shows **requested**, **evaluated** and **stored/displayable** counts and clearly identifies partial retention. Retained rows are sorted, paginated (100/page), and exportable as NDJSON. There is no user-facing Top Results setting, full Cartesian array, or requirement to retain every evaluation. Disk storage failure also leaves evaluation running and the best result available in job status, although export is then unavailable.

Server resource controls:

- `OPTIMISATION_MAX_RESULT_BYTES`: default 536,870,912 (512 MiB), or 0 for best-only retention. This bounds retained row bytes, not evaluation. One final best row is reserved in addition; external merge files may temporarily require roughly twice the retained bytes.
- `OPTIMISATION_MAX_SECONDS`: default 600. This is an actual elapsed runtime limit, not a projection-based rejection. Reaching it produces INCOMPLETE and preserves the best result.
- `OPTIMISATION_MAX_CACHE_BYTES`: default 268,435,456 (256 MiB), an estimated budget for reusable computation caches. It is not a total process-memory cap. Exceeding it produces INCOMPLETE rather than repeatedly evicting and recomputing EMA/signals.
- `OPTIMISATION_FAST_CANDIDATES`: default 12,000, bounds only the non-exhaustive FAST method.

Cooperative yields allow progress polling/cancellation between batches and during simulation. Cancellation is checked between network requests (each has a 30-second timeout); an in-flight FYERS request is not immediately aborted. Sorting of retained rows finishes before export becomes available. Jobs run in the existing server process, are not resumable after restart, and temporary result files may remain in the OS temp directory after exit. FAST stage one is labelled **Broad Search** and includes coarse points from every requested numeric dimension and every requested expiry before deterministic regional refinement.

POST `/api/optimise` returns `jobId` immediately. GET `/api/optimise/:id` reports status, mode, stage, evaluated/requested/stored counts, elapsed time, exhaustive progress/estimated remaining time and full `bestResult`. The requested count is calculated from validated ranges and remains authoritative in every job status. POST `/api/optimise/:id/cancel` stops further evaluation. Results/export use GET `/api/optimise/:id/results?page=0` and `/api/optimise/:id/export`. Only one optimisation job runs at a time. Tokens never enter job payloads/results. `/api/status` reports a safe build marker, and startup prints it with the source path to help identify a stale server process.

## Verification and limits

Tests use deliberately synthetic, identified fixtures and mocked FYERS payloads; those fixtures are never production market data. Tests cover strategy/execution, temporal fills, contracts/lot metadata, charges, ledger summaries, endpoint schemas/redaction, shared requests, huge-space FAST evaluation, streaming EXHAUSTIVE cancellation, best-only/disk-failure retention, deterministic tie breaking, cache reuse, external sorting/pagination, mocked OAuth success/failure/replay, HTTP routes, and exact Apply Best using the actual frontend code. Execution regressions cover BUY/SELL SL/target with 1-, 5- and 15-minute strategy candles and separate strict 5S monitoring.

An optional real-browser smoke test runs with `node test/browser-smoke.mjs` (installed Google Chrome required; set `CHROME_PATH` for a different executable). It uses a local mock server, checks OAuth redirects/status, desktop/mobile controls, the best card and exact Apply Best auto-run, and writes screenshots to the OS temp directory. It makes no FYERS requests.

A successful **authenticated live FYERS backtest is not claimed**. No live token/session was available during implementation. Actual account permissions, API responses, retained 5S coverage and historical lot metadata still determine whether a requested live run can complete. OHLC cannot recover intrabar tick ordering or exact crossing prices. The app reports these limits rather than inventing data.
# fyers-atm-options-backtester-5s-v2

## Separate 1-minute spot workflows

**1-Minute Backtesting** and **1-Minute Backtesting & Optimisation** use only
`NSE:NIFTY50-INDEX` or `NSE:NIFTYBANK-INDEX` with FYERS `resolution=1`.
The existing ATM options workflow keeps its 1-minute signals, 5-second spot
execution, weekly contracts and actual option premiums.

Both new tabs run the same spot simulator and the existing EMA/signal functions.
T0 is a completed signal candle; only T1 through T(N) may break its high/low
strictly. Entry is the signal high for BUY or low for SELL. SL is the opposite
signal extreme and target is entry ± signal range × RR. Only one setup or
position is active. New signals are ignored while either is active.

The stop-distance filter is signal range / signal high × 100 for BUY, or signal
range / signal low × 100 for SELL. Zero disables it; fractional percentages are
supported. OHLC cannot reveal intrabar order: SL takes precedence over target,
including on a breakout candle. A stop touched on the breakout candle is treated
conservatively as a loss even if its ordering relative to entry is unknown.

The 15:14 candle remains eligible for entry. At its completion (15:15), pending
setups are cancelled and unresolved trades exit at that candle's close as EOD.
No position carries overnight. Event timestamps use candle completion times;
holding durations are minute-level estimates, not inferred tick times. TARGET
resets the daily consecutive-SL counter, SL increments it, and EOD leaves it
unchanged. The counter resets each trading day; the reported maximum streak is
also measured within trading days.

Signal totals count all signal candles in the trading window; accepted pending
setups count only signals accepted while flat, without an existing pending setup,
and below the daily loss limit. Warmup candles never trade. EMA seeding uses a
deterministic warmup date for each parameter set, even when an optimisation has
fetched a wider common dataset. Partial sessions fail validation; dates with no
candles are treated as no-data/holiday dates and are never synthesized.

Resolved win rate = TARGET / (TARGET + SL). Resolved loss rate = SL / (TARGET + SL).
Expectancy R = resolved win fraction × RR − resolved loss fraction. EOD is
excluded from both; target hit rate over all entries includes EOD in its
denominator. With no resolved trades these statistics are reported as zero.

Optimisation prepares one shared dataset and caches indicators/signals with
bounded retention. FAST performs a deterministic coarse search and refinement
(default limit: 12,000 candidates, configurable with `SPOT_FAST_CANDIDATE_LIMIT`).
It is labelled non-exhaustive. EXHAUSTIVE streams every combination; cancellation
retains evaluated results and cannot claim completion. The best 10,000 candidate
records are retained, ranked by:

1. Expectancy R descending.
2. Resolved trade count descending.
3. Resolved win rate descending.
4. EMA, slope lookback, entry validity, RR, minimum stop distance and daily loss
   limit, each ascending in that order.

Apply Best copies only the six spot strategy parameters into the spot backtest
form. Market and dates remain user controlled. It does not change options inputs.
Request diagnostics are scoped to each spot job, including cache hits, in-flight
deduplication, retries and 429 responses. Network attempts are attributed to the
job that starts the shared request; other callers record a deduplication. Options
traffic running concurrently does not affect spot counters.

Run `npm test` for the complete suite. `node test/browser-smoke.mjs` also exercises
both spot tabs and the existing options workflow in installed Google Chrome.
These automated checks mock FYERS; they do not establish live data availability.
