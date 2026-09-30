# EbayDecisions

Appliance parts market tracker and listing decision engine for Road Runner Appliance.

Tracks what each MPN in stock is fetching on eBay across five lookback windows, works out
what you would actually net after fees and shipping, and tells you what to do with it:
**list now, list, hold, watch,** or **dump** — with the numbers behind every call.

Next.js 16 · Neon Postgres · Drizzle · Vercel.

---

## What changed from the prototype

This began as a Figma Make prototype: one 875-line `App.tsx`, 63 hard-coded MPNs, and market
data in `localStorage`. The shape of the thing was right. What it could not do was survive a
cleared browser, be opened from a second device, or tell you anything you had not typed in
yourself.

The substantive changes:

**Market data is append-only.** Every reading is kept. The spreadsheet held one number per
window — "the 30-day comp is $104." This holds the history of that number, so you can see it
slid from $118 to $104 over six weeks. Trends are computed from real movement rather than
asserted. The "current" grid is just the newest row per window, read with a single
`DISTINCT ON`.

**No invented data.** The prototype seeded the grid with randomly generated prices so the
charts had something to draw. In a tool you price inventory from, a fabricated comp is worse
than an empty cell: an empty cell tells you to go look, a fabricated one tells you a lie with
a chart attached. Every figure here comes from an eBay sync or from you.

**Sold comps and asking prices are never mixed silently.** See [eBay data](#ebay-data).

**It computes decisions, not just trends.** See [the decision engine](#the-decision-engine).

---

## Setup

### 1. Neon

Create a project at [neon.tech](https://neon.tech). From **Connect**, copy the **pooled**
connection string — the one with `-pooler` in the host. Pooled is what you want on serverless;
the direct string runs out of connections under load.

### 2. Environment

Copy `.env.example` to `.env.local` and fill it in:

```bash
cp .env.example .env.local
openssl rand -base64 48   # AUTH_SECRET
openssl rand -hex 32      # CRON_SECRET
```

`DATABASE_URL`, `APP_PASSWORD` and `AUTH_SECRET` are required. Everything else is optional.

### 3. Tables and seed data

```bash
pnpm install
pnpm db:migrate   # creates the tables
pnpm db:seed      # loads the 63 MPNs from the spreadsheet
pnpm dev
```

The seed loads part numbers, descriptions, quantities and reference URLs. It does **not** load
cost bases — only you know what each unit cost. Until a part has one, the board reports
"needs data" for it rather than guessing.

Fastest way to load 63 costs: Settings → Export CSV, fill in the `cost_basis` column in a
spreadsheet, then Settings → Import. Import matches on MPN and only touches the columns your
file contains.

### 4. Deploy to Vercel

Import `vlad40000/EbayDecisions` at [vercel.com/new](https://vercel.com/new). Add the same
environment variables under **Settings → Environment Variables** (all environments), then
deploy.

`vercel.json` registers a daily eBay sync at 08:00 UTC. It calls `/api/cron/sync` with
`CRON_SECRET` as a bearer token; without that variable set the route refuses every request
rather than defaulting open.

Run the migration against production once:

```bash
DATABASE_URL="<your neon pooled url>" pnpm db:migrate
DATABASE_URL="<your neon pooled url>" pnpm db:seed
```

---

## The decision engine

Everything lives in `src/lib/decisions.ts`. It is plain functions over plain data, with no
database or framework in it, which is what makes it straightforward to test — and it is
tested, against hand-computed figures.

### The economics

eBay's final value fee applies to the **whole order**, item plus the shipping the buyer pays.
A model that fees only the item price overstates margin on everything, and overstates it most
on the heavy parts where shipping is largest.

```
grossOrder  = price + shipping          what the buyer pays
fees        = grossOrder × feePct + feeFixed
netProceeds = grossOrder − fees − yourShipCost
margin$     = netProceeds − costBasis
margin%     = margin$ / netProceeds
```

A cost basis of `0` is real and common — a board pulled off a scrapped machine has no marginal
cost — and is treated as different from a blank one. Blank means unknown and blocks the
margin maths; zero means free and yields 100% margin.

The five assumptions (fee %, fixed fee, default ship cost, target margin, margin floor) live
in the database and are edited on the Settings page, so changing one re-reads the whole board
without a redeploy.

### The trends

Least-squares slope across the five windows, oldest to newest, normalised by the series mean
so a $2/window move on a $30 gasket is comparable to $2/window on a $200 board. Missing
windows keep their original spacing — a part missing its 6-month reading does not get a
falsely steep slope from having its remaining points bunched together.

Under 2%/window reads as flat; 6% or more reads as strong.

### The rules

Evaluated in order, first match wins. The ordering *is* the priority: losing money outranks a
thin margin, which outranks a healthy one.

| Verdict | When |
|---|---|
| **Needs data** | No comps, or no cost basis |
| **Dump** | Margin is negative |
| **Dump** | Margin under the floor **and** market falling |
| **Hold** | Margin under the floor **but** market rising |
| **Watch** | Margin under the floor, market flat |
| **List now** | Margin at/above target **and** market falling — take it before it erodes |
| **List now** | Margin at/above target **and** competing supply climbing fast |
| **Hold** | Margin at/above target **and** market climbing hard — waiting earns more |
| **List** | Margin at/above target, stable market |
| **Hold / List / Watch** | Between floor and target, by trend direction |

Each verdict carries the sentence that produced it, with its numbers. It also gives a
**suggested list price** — the item price that hits your target margin at the observed
shipping, solved backwards through the fee model. A recommendation you cannot audit is one you
should not follow.

---

## eBay data

The app is fully usable with no eBay credentials at all: you type the comps, it does the
maths, exactly as the spreadsheet did. Credentials add syncing on top.

Set `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` from
[developer.ebay.com](https://developer.ebay.com) → My Account → Application Keys.

There are two adapters, and the difference between them matters more than anything else in
this README:

| Adapter | What it sees | Requires |
|---|---|---|
| **Marketplace Insights** | Real **sold** comps, last 90 days | eBay to approve the `buy.marketplace.insights` scope for your app |
| **Browse** | **Active listings** — asking prices and how many sellers you are up against | Nothing beyond standard keys |

An unsold listing at $200 is evidence of one seller's optimism, not of what the part fetches.
So:

- Every stored reading records which adapter produced it.
- The UI labels them "Sold comps" and "Active listings" wherever a number appears.
- A part whose entire read rests on asking prices is flagged on the board and in its detail.

With `EBAY_ADAPTER=auto` (the default) the sync tries Insights and falls back to Browse if the
scope is not granted, recording which one actually ran in the sync log on the Settings page.

**The 6-month and 1-year windows cannot be synced.** Insights reaches back 90 days and no eBay
API goes further. Those two windows fill in by hand, or they accumulate as this app keeps
taking readings. Nothing here invents them.

---

## Layout

```
proxy.ts                  session gate for page routes (Next 16 renamed middleware → proxy)
drizzle/                  generated migrations
src/
  app/
    (app)/                the signed-in application
      decisions/          the board — what to do, ordered by what is at stake
      inventory/          catalogue with inline cost-basis editing
      inventory/[mpn]/    one part: recommendation, economics, charts, history
      tracker/            comps entry grid, saves as you type
      settings/           fee assumptions, eBay status, sync log, import/export
    api/
      cron/sync/          scheduled sync — CRON_SECRET bearer token
      ebay/sync/          manual sync
      parts/import|export CSV in and out
  components/             UI; charts in part-charts.tsx
  db/
    schema.ts             parts · market_snapshots · settings · ebay_sync_runs
    queries.ts            data access, including the latest-per-window read
  lib/
    decisions.ts          the engine
    stats.ts              least-squares trend, median
    ebay/                 OAuth client, browse + insights adapters, sync orchestrator
    auth.ts               HMAC session tokens
tests/                    engine unit tests + query integration tests
```

### Notes on a few choices

**Auth is a shared password**, signed into an HTTP-only cookie with an HMAC over its own
expiry — so a client cannot extend its session by editing the cookie. `proxy.ts` redirects
unauthenticated page loads, but that is a convenience, not the boundary: middleware does not
protect a server action reachable by direct POST, so every action and route handler re-checks
the session where it touches data.

**Neon over HTTP** (`drizzle-orm/neon-http`): one fetch per query, no pool to exhaust. It has
no interactive transactions, and nothing here needs one.

**The database handle connects lazily.** `next build` imports every route's module graph, so a
top-level connect would fail the build on a machine with no `DATABASE_URL`. Deferring it means
a missing variable shows up as a banner in the running app instead.

**Neon compute is treated as something you pay for.** It bills by active time and autosuspends
when idle, so the app never wakes it without cause: nothing polls, nothing runs on a heartbeat,
no query happens before a visitor is authenticated, and the signed-in layout does no data
access at all — each page loads its own data, so one page load is one query. The only scheduled
work is the daily eBay sync.

**Server modules are fenced off with `server-only`.** `src/db/*`, `src/lib/auth.ts`,
`src/lib/session.ts` and the eBay client import it, so pulling any of them into a client bundle
is a build error rather than a leaked connection string.

**Constraints live in the database too, not only in Zod.** The app is not the only writer — the
seed script, the CSV importer and a psql session all reach these tables — so ranges are enforced
in Postgres as well: non-negative quantities, cost and price ceilings, margins under 100%, a
margin floor that cannot exceed the target, and a single settings row.

**Charts are not zero-baselined.** Bars are — length is the encoding there. Lines are fitted to
the data range, because position is the encoding and a forced zero baseline flattens a real
28% move into a straight line. The series palette is validated for colour-vision deficiency
and deliberately avoids the app's green/red status hues, so a shipping-cost bar never looks
like a verdict.

---

## Commands

```bash
pnpm dev            # dev server
pnpm verify         # typecheck + tests + production build
pnpm test           # tests only
pnpm lint
pnpm db:generate    # new migration from a schema change
pnpm db:migrate     # apply migrations
pnpm db:seed        # load the parts catalogue (idempotent)
pnpm db:studio      # browse the data
```

### Tests

`tests/decisions.test.ts` checks the engine against hand-computed figures: the fee base, the
zero-versus-blank cost basis, and a round-trip proving the suggested list price actually
produces the target margin.

`tests/queries.test.ts` runs the real SQL against Postgres compiled to WebAssembly, in
process. It applies the same generated migration that runs against Neon — so it also proves
the migration applies cleanly — then exercises the `DISTINCT ON` read, the snapshot
coalescing, the carry-forward of untouched fields, and the cascade delete.
