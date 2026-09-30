# EbayDecisions — canonical rebuild

Internal appliance-parts market tracker and eBay listing decision engine for Road Runner Appliance.

**Stack:** Next.js 16 App Router · React 19 · Neon Postgres · Drizzle · Recharts · Vercel.

This rebuild uses the original EbayDecisions project as the engineering chassis and incorporates the corrected market model developed during the review session. It intentionally keeps the strong parts of the original project—Drizzle migrations, surrogate part IDs, CRUD, CSV import/export, HMAC sessions, database constraints, PGlite integration tests, sync auditing and eBay adapter orchestration—while replacing the ambiguous quantity/trend/autosave behavior.

## Product rules that are now binding

### 1. Sold demand and active competition are different data

`market_snapshots` stores the five **sold-market lookback aggregates**:

- 1 year
- 6 months
- 90 days
- 30 days
- 7 days

Each row may contain item price, buyer-paid shipping, **sold quantity**, price basis, source, sample size and capture time.

`active_market_snapshots` is a separate append-only stream for **point-in-time active competition**:

- median asking price
- median buyer-paid shipping
- active listing count
- sample / qualification metadata
- capture time

An active listing count is never stored as sold quantity, and sold volume is never interpreted as competing supply.

### 2. Historical trend means actual elapsed time

The five lookback windows are nested aggregates; they are not five equally spaced historical observations.

The app therefore has two distinct readings:

- **Current-window curve:** context across 365 / 182 / 90 / 30 / 7-day aggregates using their real spacing.
- **Historical trend:** repeated observations of the same metric across real `captured_at` dates.

Only the historical trend can influence timing recommendations. It must have:

- at least **3 distinct UTC capture dates**, and
- at least **14 days** from first to last.

Multiple corrections on the same UTC day remain in the append-only audit table, but trend math collapses that day to the latest reading so a correction made minutes later cannot become a huge extrapolated “30-day trend.”

### 3. Demand fallback is units per day

Until longitudinal demand history matures, unequal sold windows are compared as sales velocity:

```text
sold velocity = sold_qty / window_days
```

So 8 sold in 7 days is correctly stronger demand than 20 sold in 30 days, even though the raw count is smaller.

### 4. Explicit Save MPN; no autosave

The tracker does **not** persist on keystrokes, blur or timers.

- edit any fields locally
- optionally preview eBay Active data
- press **Save MPN**

Only fields touched in the browser are submitted. The database statement reads the live latest values and carries untouched fields forward, so an eBay sync that landed after the page loaded is not overwritten by stale browser state.

One Save MPN is one Postgres statement for all touched sold windows plus the active-market patch. Raw history remains append-only.

There is no polling or heartbeat.

### 5. eBay Browse is a preview of active asking prices

The Tracker's **Preview eBay Active** button:

- runs only on user request
- performs no Neon write
- filters the search to used items
- requires an exact normalized MPN title match
- rejects longer substring matches such as `W112045170` for `W11204517`
- records how many broad results were rejected
- withholds active quantity when the eBay result set is truncated rather than silently saving an undercount

Preview values only become persistent after **Save MPN**.

### 6. Marketplace Insights is a sold-data adapter, when authorized

With `EBAY_ADAPTER=auto`, the sync probes Marketplace Insights first and falls back to Browse if the account cannot use it.

Insights writes only sold-window observations. Browse writes only point-in-time active-market observations. The sync audit records which adapter actually ran and separate sold/active write counts.

If an Insights response exposes titles for all returned sales, exact-MPN filtering is applied. If the API response does not expose enough title metadata to verify that boundary, the sync records that limitation instead of claiming verification it did not perform. Truncated sales samples keep their median sample price but leave sold quantity unknown rather than storing a known undercount.

## Decision engine

The economics remain deliberately simple and auditable:

```text
grossOrder  = itemPrice + buyerShipping
fees        = grossOrder × feePct + fixedFee
netProceeds = grossOrder − fees − actualShipCost
margin$     = netProceeds − costBasis
margin%     = margin$ / netProceeds
```

A cost basis of `0` is valid and distinct from an unknown/null cost basis.

Settings are editable in the app:

- eBay percentage fee
- eBay fixed fee
- default actual shipping cost
- target margin
- minimum margin floor

The suggested list price is solved backwards through the same fee model to hit the selected target margin.

Timing rules use qualified historical signals only. A current-window curve is visible for context but cannot by itself force `LIST_NOW`, `HOLD` or `DUMP` based on trend.

## Data migration

Migration `0002_market_semantics.sql` converts the original overloaded `qty` model safely:

- old `ebay_insights.qty` → `sold_qty`
- old `ebay_browse` rows → `active_market_snapshots`
- old manual `qty` stays in `legacy_qty` for audit because its meaning cannot be inferred safely
- old Browse rows are removed from sold-window history after being copied to active-market history

The migration never guesses whether an ambiguous manual legacy quantity meant sold units or active listings.

## Neon compute discipline

The app is designed to avoid unnecessary Neon compute:

- lazy database connection
- no database work before an authenticated request needs it
- no autosave (market tracker or inventory economics)
- inventory rows use explicit **Save Part**; market rows use explicit **Save MPN**
- no client polling / heartbeat
- one explicit Save MPN statement
- eBay active preview does not touch Neon
- scheduled eBay sync is **off by default**

`vercel.json` retains the cron definition so it can be enabled later, but `/api/cron/sync` returns before reading from Neon unless:

```text
EBAY_CRON_ENABLED=true
```

When enabled, `CRON_SECRET` is also required.

## Charts

Part detail pages separate the meanings visually:

- **Area + fitted line:** current sold-window buyer-total curve using true lookback spacing; context only
- **Stacked bar:** item price vs buyer-paid shipping
- **Bar:** sold velocity in units/day
- **Calendar line:** repeated sold-price observations over actual capture dates
- **Calendar bar:** point-in-time active-listing competition over actual capture dates

No random market prices are seeded.

## Inventory and data operations

The stronger original workflows are preserved:

- add / edit / delete parts
- active / inactive inventory
- MPN is unique business data; internal relationships use surrogate `part_id`
- CSV bulk import
- full CSV export with sold/active fields and decision metadata
- 63-part seed catalogue, idempotent by MPN
- sync-run audit log

## Authentication

`APP_PASSWORD` is the shared sign-in password. `AUTH_SECRET` independently HMAC-signs a session payload containing its expiration time. `proxy.ts` handles page navigation, and server actions/routes re-check the session at the data boundary.

Changing `AUTH_SECRET` invalidates existing sessions.

## Setup

```bash
cp .env.example .env.local
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm verify
pnpm dev
```

Required:

```text
DATABASE_URL
APP_PASSWORD
AUTH_SECRET
```

Optional eBay and cron variables are documented in `.env.example`.

## Vercel

1. Create/import the GitHub repository in Vercel.
2. Add `DATABASE_URL`, `APP_PASSWORD`, and `AUTH_SECRET` to the intended environments.
3. Add eBay variables only if sync/preview is wanted.
4. Leave `EBAY_CRON_ENABLED=false` until scheduled sync is intentionally enabled.
5. Run the production migrations and seed once against the chosen Neon database.
6. Let CI and Vercel build the same committed source.

## Verification

```bash
pnpm verify
```

runs:

1. ESLint
2. TypeScript
3. Vitest
4. production Next.js build

The query integration tests run the real migration SQL and query layer against PGlite/Postgres semantics, including the sold/active split, legacy migration behavior, explicit-save carry-forward, constraints and historical trend qualification.

## Layout

```text
proxy.ts
vercel.json
.github/workflows/ci.yml

drizzle/
  0000_*.sql
  0001_*.sql
  0002_market_semantics.sql

src/
  app/(app)/
    decisions/
    inventory/
    inventory/[mpn]/
    tracker/
    settings/
  app/api/
    cron/sync/
    ebay/preview/[mpn]/
    ebay/sync/
    parts/import/
    parts/export/
  components/
  db/
    schema.ts
    queries.ts
    seed-data.ts
    seed.ts
  lib/
    decisions.ts
    stats.ts
    auth.ts
    session.ts
    ebay/
      browse.ts
      insights.ts
      match.ts
      sync.ts

tests/
  decisions.test.ts
  ebay-match.test.ts
  queries.test.ts
```
