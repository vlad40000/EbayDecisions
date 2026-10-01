# EbayDecisions — eBay Market Research Tracker

Internal appliance-parts research and prioritization tool for Road Runner Appliance.

**Stack:** Next.js 16 App Router · React 19 · Neon Postgres · Drizzle · Recharts · Vercel.

## Product purpose

EbayDecisions answers one operational question:

> Of the parts I already own, which MPNs show enough real SOLD activity on eBay to deserve research and listing time right now?

The app supports the decision. It does not make the decision for the user.

Primary workflow:

1. **Market Opportunities** — search, filter, sort and paginate the catalogue using the latest dated SOLD research.
2. **Research Queue** — identify MPNs that have never been researched or whose research is stale.
3. **Market Tracker** — enter or review the five eBay Product Research lookback windows and press **SAVE RESEARCH**.
4. **Part History** — compare the current five-window shape with true calendar history from repeated research sessions.
5. **Inventory** — lightweight context only: MPN, description, category and quantity on hand.

The legacy `/decisions` route redirects to Market Opportunities.

## Research model

The five SOLD lookback windows are:

- 7 days
- 30 days
- 90 days
- 6 months
- 1 year

For each window the primary fields are:

- average sold price
- average buyer-paid shipping
- total sold

Optional Product Research fields are also supported:

- sold-price low/high
- total sellers
- sell-through %
- free-shipping %

Delivered sold price is:

```text
avg sold price + avg buyer-paid shipping
```

`total_sold` always means units sold inside that lookback window. Active listing count is never stored as sold quantity.

## Dated research sessions

One **SAVE RESEARCH** creates one `market_research_sessions` row plus the supplied five lookback-window observations.

Research is append-only. Repeating the same research later creates a new dated session instead of overwriting the previous session.

Legacy and automated snapshot rows that predate the session model remain valid with `research_session_id = NULL`. The migration does not invent historical sessions.

## MPN-only eBay research

The primary research workflow follows the proven Roadrunner Parts Ledger pattern: every MPN has direct **Active eBay** and **Sold eBay** research links.

The search query is deliberately restricted to the supplied MPN only.

Do not append:

- brand
- machine model
- part description
- category
- compatibility terms
- appliance type
- inferred keywords

Active research uses:

```text
https://www.ebay.com/sch/i.html?_nkw=<MPN>
```

Sold research uses the same MPN-only query with eBay's completed/sold filters:

```text
https://www.ebay.com/sch/i.html?_nkw=<MPN>&LH_Sold=1&LH_Complete=1
```

The user reviews those results, enters the five Product Research windows, and presses **SAVE RESEARCH**. There is no autosave, polling, scheduled catalogue sweep, or automatic 40,000-part research loop.

## Market Opportunities

The Opportunities surface is designed for a 40,000+ part catalogue.

Search, filters, sorting, latest-session selection, pagination and total result count are performed in Postgres. The browser does not receive the entire catalogue.

Current filters include:

- MPN / description search
- in-stock only
- Never researched / Stale / Current
- configurable stale threshold
- minimum 30-day sold volume
- minimum 30-day average sold price
- minimum inventory

No black-box opportunity score is used.

## Research Queue

Research Queue answers: **What should I research next?**

Default behavior:

- in-stock MPNs only
- Never researched first
- Stale rows next, oldest first
- 30-day stale threshold by default
- working sets capped at 20 MPNs
- selection is local-only until the user opens Tracker
- selection does not trigger eBay calls or Neon writes

## Market Tracker

Tracker is the explicit research-entry surface.

The compact table shows:

- MPN
- quantity
- description
- 7d / 30d / 90d / 6m / 1y total SOLD
- last researched state

The expanded editor supports the full Product Research fields for each window.

All edits stay in the browser until **SAVE RESEARCH**. There is no autosave, save-on-blur, polling or heartbeat.

## Part History

Part History separates two different concepts.

### Current cross-window shape

The three primary charts are:

1. Average Sold Price by Lookback Window
2. Avg Sold Price vs Avg Shipping
3. Units Sold by Period

These are nested lookback aggregates. They are not a calendar time series.

### True calendar history

Repeated dated sessions create:

- 30-day Avg Sold Price History
- 30-day Units Sold History

Same-day corrections remain stored but collapse to the latest value for chart/trend math.

A mature trend requires:

- at least 3 distinct research dates
- at least 14 days from first to last

With fewer than 2 dates, the UI shows an explicit insufficient-history state. It never fabricates chart data.

## Inventory boundary

Inventory is context, not a second warehouse system.

Retained here:

- MPN
- description
- category
- quantity on hand
- import/export
- part notes/reference metadata

Inventory search and pagination are server-side.

Operational listing, reserved/sold state, warehouse state and sales ledger functionality belong in Roadrunner Parts Ledger rather than being duplicated here.

## Database and migrations

Current migration sequence includes:

- `0000_*.sql`
- `0001_*.sql`
- `0002_market_semantics.sql`
- `0003_market_research_sessions.sql`

Migration `0002` separates sold demand from point-in-time active competition.

Migration `0003` adds:

- `market_research_sessions`
- nullable `research_session_id` on sold snapshots
- optional Product Research metrics
- research-session and catalogue search indexes

Production `0003` has been applied.

## Neon compute discipline

The application is intentionally conservative with Neon compute:

- lazy database connection
- no client polling or heartbeat
- no autosave
- no per-keystroke writes
- explicit quantity saves in Inventory
- explicit SAVE RESEARCH in Tracker
- server-side pagination instead of full-catalogue reads
- no scheduled eBay research cron
- no automatic 40,000-part research sweep

## Authentication

`APP_PASSWORD` is the shared sign-in password.

`AUTH_SECRET` independently signs expiring sessions. Server actions and protected data routes re-check authentication at the data boundary.

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

eBay credentials are optional and are not required for the manual Product Research workflow.

## Verification

```bash
pnpm verify
```

runs:

1. ESLint
2. TypeScript
3. Vitest
4. production Next.js build

PGlite query tests exercise the real migration SQL and Postgres-oriented query semantics, including research sessions, pagination, research freshness and explicit saves.

## Primary routes

```text
/                  -> /opportunities
/opportunities     Market Opportunities
/research          Research Queue
/tracker           Market Tracker
/inventory         Inventory context
/inventory/[mpn]   Part History dashboard
/settings          Connections, import/export and retained compatibility settings
/decisions         -> /opportunities
```
