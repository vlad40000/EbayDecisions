import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as marketFacts } from '@/app/api/integrations/market-facts/route'
import { POST as register } from '@/app/api/integrations/parts/register/route'
import { POST as research } from '@/app/api/integrations/research/route'
import { setDatabaseForTests } from '@/db/index'
import * as schema from '@/db/schema'
import { createPart, saveMarketResearchSession } from '@/db/queries'
import { activeMarketSnapshots } from '@/db/schema'
import type { MarketFactsEnvelopeV1 } from '@/lib/market-facts'
import type { PartRegistrationEnvelopeV1 } from '@/lib/part-registration'
import type { TargetedResearchEnvelopeV1 } from '@/lib/targeted-research'

const client = new PGlite()
const testDb = drizzle({ client, schema })
setDatabaseForTests(testDb)

const KEY = 'integration-test-key-0123456789'
const EBAY_SECRET = 'ebay-client-secret-must-not-leak'
const INSIGHTS_SCOPE = 'https://api.ebay.com/oauth/api_scope/buy.marketplace.insights'
const DAY_MS = 86_400_000

function migrationFiles(): string[] {
  const dir = path.resolve(import.meta.dirname, '../drizzle')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(path.join(dir, name), 'utf8'))
}

async function resetSchema() {
  await client.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  for (const sql of migrationFiles()) {
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) await client.exec(trimmed)
    }
  }
}

beforeEach(async () => {
  await resetSchema()
  process.env.INTEGRATION_API_KEY = KEY
  process.env.EBAY_CLIENT_ID = 'ebay-client-id'
  process.env.EBAY_CLIENT_SECRET = EBAY_SECRET
  // These suites exercise the eBay adapters, which run only with automated
  // research on. Manual-only mode is covered in manual-only-ebay-gate.test.ts.
  process.env.EBAY_AUTOMATED_RESEARCH_ENABLED = 'true'
})
afterEach(() => {
  delete process.env.INTEGRATION_API_KEY
  delete process.env.EBAY_CLIENT_ID
  delete process.env.EBAY_CLIENT_SECRET
  delete process.env.EBAY_AUTOMATED_RESEARCH_ENABLED
  vi.restoreAllMocks()
})
afterAll(async () => client.close())

// ─── Request helpers ─────────────────────────────────────────────────────────

type Handler = (request: Request) => Promise<Response>

function post(handler: Handler, url: string, body: unknown, authorization: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authorization != null) headers.authorization = authorization
  return handler(
    new Request(`https://ebd.example${url}`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

const callRegister = (body: unknown, authorization: string | null = `Bearer ${KEY}`) =>
  post(register, '/api/integrations/parts/register', body, authorization)
const callResearch = (body: unknown, authorization: string | null = `Bearer ${KEY}`) =>
  post(research, '/api/integrations/research', body, authorization)

async function registered(parts: { mpn: string; description?: string | null }[]) {
  const response = await callRegister({ parts })
  expect(response.status).toBe(200)
  return (await response.json()) as PartRegistrationEnvelopeV1
}

async function researched(mpns: string[]) {
  const response = await callResearch({ mpns })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  return (await response.json()) as TargetedResearchEnvelopeV1
}

async function rows<T>(sql: string): Promise<T[]> {
  return (await client.query<T>(sql)).rows
}

async function count(table: string): Promise<number> {
  const [row] = await rows<{ n: number }>(`select count(*)::int as n from ${table}`)
  return row?.n ?? 0
}

async function dumpState(): Promise<string> {
  const tables = ['parts', 'market_research_sessions', 'market_snapshots', 'active_market_snapshots', 'settings', 'ebay_sync_runs']
  const out: Record<string, unknown> = {}
  for (const table of tables) out[table] = await rows(`select * from ${table} order by 1`)
  return JSON.stringify(out)
}

// ─── Fake eBay (official API paths only) ─────────────────────────────────────

type Listing = { title: string; price: number; shipping?: number }
type Sale = { title?: string; price: number; daysAgo: number; shipping?: number }
type EbayCall = { kind: 'token' | 'browse' | 'insights'; scope?: string; q?: string }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function browseResponse(items: Listing[], total = items.length) {
  return json({
    total,
    itemSummaries: items.map((item, index) => ({
      itemId: `b${index}`,
      title: item.title,
      price: { value: item.price.toFixed(2), currency: 'USD' },
      shippingOptions: [{ shippingCost: { value: (item.shipping ?? 0).toFixed(2) } }],
    })),
  })
}

function insightsResponse(sales: Sale[], total = sales.length) {
  return json({
    total,
    itemSales: sales.map((sale, index) => ({
      itemId: `s${index}`,
      ...(sale.title === undefined ? {} : { title: sale.title }),
      lastSoldPrice: { value: sale.price.toFixed(2), currency: 'USD' },
      lastSoldDate: new Date(Date.now() - sale.daysAgo * DAY_MS).toISOString(),
      shippingOptions: [{ shippingCost: { value: (sale.shipping ?? 0).toFixed(2) } }],
    })),
  })
}

function fakeEbay(fake: {
  deniedScopes?: string[]
  browse?: (q: string) => Response
  insights?: (q: string) => Response
}): EbayCall[] {
  const calls: EbayCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === '/identity/v1/oauth2/token') {
      const scope = new URLSearchParams(String(init?.body ?? '')).get('scope') ?? ''
      calls.push({ kind: 'token', scope })
      if (fake.deniedScopes?.includes(scope)) return json({ error: 'invalid_scope' }, 400)
      // expires_in 0 keeps the client's module-level token cache from carrying
      // a grant from one test into the next.
      return json({ access_token: 'fake-ebay-token', expires_in: 0 })
    }
    const q = url.searchParams.get('q') ?? ''
    if (url.pathname === '/buy/browse/v1/item_summary/search') {
      calls.push({ kind: 'browse', q })
      return fake.browse ? fake.browse(q) : browseResponse([])
    }
    if (url.pathname === '/buy/marketplace_insights/v1_beta/item_sales/search') {
      calls.push({ kind: 'insights', q })
      return fake.insights ? fake.insights(q) : insightsResponse([])
    }
    throw new Error(`Unexpected fetch: ${url.pathname}`)
  })
  return calls
}

type SoldRow = {
  period: string
  price: string | null
  shipping: string | null
  sold_qty: number | null
  source: string
  price_basis: string
  sample_size: number | null
  sell_through_pct: string | null
  research_session_id: number | null
}

const soldRows = () =>
  rows<SoldRow>(
    `select period, price, shipping, sold_qty, source, price_basis, sample_size, sell_through_pct, research_session_id
     from market_snapshots order by part_id, period`,
  )

type ActiveRow = {
  active_qty: number | null
  asking_price: string | null
  asking_shipping: string | null
  source: string
  sample_size: number | null
  broad_match_count: number | null
  mpn_rejected_count: number | null
  truncated: boolean
}

const activeRows = () =>
  rows<ActiveRow>(
    `select active_qty, asking_price, asking_shipping, source, sample_size, broad_match_count, mpn_rejected_count, truncated
     from active_market_snapshots order by id`,
  )

// ─── Auth ────────────────────────────────────────────────────────────────────

describe('integration auth on the registration and research endpoints', () => {
  const endpoints = [
    { name: 'register', call: callRegister, body: { parts: [{ mpn: 'W1' }] } },
    { name: 'research', call: callResearch, body: { mpns: ['W1'] } },
  ]

  it.each(endpoints)('$name rejects a missing or wrong key with 401 and changes nothing', async ({ call, body }) => {
    await createPart({ mpn: 'W1', description: 'Board' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const before = await dumpState()

    expect((await call(body, null)).status).toBe(401)
    expect((await call(body, 'Bearer nope')).status).toBe(401)
    expect((await call(body, `Basic ${KEY}`)).status).toBe(401)

    expect(await dumpState()).toBe(before)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(endpoints)('$name answers 503 when INTEGRATION_API_KEY is not configured', async ({ call, body }) => {
    await createPart({ mpn: 'W1', description: 'Board' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const before = await dumpState()
    delete process.env.INTEGRATION_API_KEY

    const response = await call(body)
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).not.toContain('W1')
    expect(await dumpState()).toBe(before)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ─── Registration ────────────────────────────────────────────────────────────

describe('POST /api/integrations/parts/register', () => {
  it('inserts new MPNs with the supplied display spelling, inventory 0, and blank economics', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const response = await callRegister({
      parts: [{ mpn: ' DC47-00019A ', description: ' Thermal fuse ' }, { mpn: 'W11204517' }, { mpn: 'W10830046', description: null }],
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')

    const body = (await response.json()) as PartRegistrationEnvelopeV1
    expect(body.schemaVersion).toBe(1)
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false)
    expect(body.results).toEqual([
      { mpnKey: 'DC4700019A', mpnDisplay: 'DC47-00019A', status: 'inserted' },
      { mpnKey: 'W11204517', mpnDisplay: 'W11204517', status: 'inserted' },
      { mpnKey: 'W10830046', mpnDisplay: 'W10830046', status: 'inserted' },
    ])

    const blank = { category: null, inventory_qty: 0, cost_basis: null, ship_cost: null, target_margin_pct: null, source_url: null, notes: null, active: true }
    expect(
      await rows(
        `select mpn, mpn_key, description, category, inventory_qty, cost_basis, ship_cost, target_margin_pct, source_url, notes, active
         from parts order by id`,
      ),
    ).toEqual([
      { mpn: 'DC47-00019A', mpn_key: 'DC4700019A', description: 'Thermal fuse', ...blank },
      { mpn: 'W11204517', mpn_key: 'W11204517', description: '', ...blank },
      { mpn: 'W10830046', mpn_key: 'W10830046', description: '', ...blank },
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await count('market_snapshots')).toBe(0)
    expect(await count('active_market_snapshots')).toBe(0)
  })

  it('D1-dedupes equivalent spellings, drops blank keys, and is idempotent', async () => {
    const first = await registered([
      { mpn: 'DC47-00019A', description: 'Fuse' },
      { mpn: 'dc47 00019a', description: 'Other description' },
      { mpn: 'DC47/00019A' },
      { mpn: '---' },
    ])
    expect(first.results).toEqual([{ mpnKey: 'DC4700019A', mpnDisplay: 'DC47-00019A', status: 'inserted' }])

    const again = await registered([{ mpn: 'dc4700019a', description: 'Changed' }])
    expect(again.results).toEqual([{ mpnKey: 'DC4700019A', mpnDisplay: 'DC47-00019A', status: 'existing' }])

    const concurrent = await Promise.all([registered([{ mpn: 'W-55' }]), registered([{ mpn: 'w55' }])])
    expect(concurrent.flatMap((body) => body.results.map((result) => result.status)).sort()).toEqual(['existing', 'inserted'])

    expect(await rows(`select mpn, mpn_key, description from parts order by id`)).toEqual([
      { mpn: 'DC47-00019A', mpn_key: 'DC4700019A', description: 'Fuse' },
      { mpn: 'W-55', mpn_key: 'W55', description: '' },
    ])
  })

  it('keeps superseding MPNs as distinct identities', async () => {
    const body = await registered([{ mpn: 'DC47-00019A' }, { mpn: 'DC47-00019B' }])
    expect(body.results.map((result) => [result.mpnKey, result.status])).toEqual([
      ['DC4700019A', 'inserted'],
      ['DC4700019B', 'inserted'],
    ])
  })

  it('never overwrites an existing part’s description, inventory, economics, or state', async () => {
    await createPart({
      mpn: 'W10830046',
      description: 'Door gasket',
      category: 'Gaskets',
      inventoryQty: 4,
      costBasis: 12.5,
      shipCost: 9,
      targetMarginPct: 30,
      sourceUrl: 'https://example.test/part',
      notes: 'Shelf B',
      active: false,
    })
    const before = await rows(`select * from parts order by id`)

    const body = await registered([{ mpn: 'w10830046', description: 'Parts Engine description' }, { mpn: 'NEW-1' }])
    expect(body.results).toEqual([
      { mpnKey: 'W10830046', mpnDisplay: 'W10830046', status: 'existing' },
      { mpnKey: 'NEW1', mpnDisplay: 'NEW-1', status: 'inserted' },
    ])
    expect(await rows(`select * from parts where mpn_key = 'W10830046'`)).toEqual(before)
  })

  it('rejects Parts Engine-owned fields instead of copying them', async () => {
    for (const extra of [{ inventoryQty: 3 }, { donorCount: 7 }, { costBasis: 10 }, { machineIds: ['M-1'] }]) {
      const response = await callRegister({ parts: [{ mpn: 'W1', ...extra }] })
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toMatch(/Unrecognized key/)
    }
    expect((await callRegister({ parts: [{ mpn: 'W1' }], donorCounts: { W1: 7 } })).status).toBe(400)
    expect(await count('parts')).toBe(0)
  })

  it('rejects malformed and oversized requests with 400', async () => {
    expect((await callRegister('not json')).status).toBe(400)
    expect((await callRegister({ mpns: ['W1'] })).status).toBe(400)
    expect((await callRegister({ parts: ['W1'] })).status).toBe(400)
    expect((await callRegister({ parts: [{ description: 'No MPN' }] })).status).toBe(400)
    expect((await callRegister({ parts: Array.from({ length: 101 }, (_, i) => ({ mpn: `P${i}` })) })).status).toBe(400)
    expect(await count('parts')).toBe(0)
  })
})

// ─── Targeted research ───────────────────────────────────────────────────────

describe('POST /api/integrations/research', () => {
  it('rejects malformed, empty, and oversized requests before any eBay call', async () => {
    await createPart({ mpn: 'W1', description: 'Board' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const before = await dumpState()

    expect((await callResearch('not json')).status).toBe(400)
    expect((await callResearch({})).status).toBe(400)
    expect((await callResearch({ mpns: [] })).status).toBe(400)
    expect((await callResearch({ mpns: ['---', ''] })).status).toBe(400)
    expect((await callResearch({ mpns: ['W1'], inventoryQty: 1 })).status).toBe(400)
    expect((await callResearch({ mpns: Array.from({ length: 21 }, (_, i) => `P${i}`) })).status).toBe(400)

    expect(await dumpState()).toBe(before)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('answers 503 without touching anything when eBay credentials are not configured', async () => {
    await createPart({ mpn: 'W1', description: 'Board' })
    delete process.env.EBAY_CLIENT_ID
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const before = await dumpState()

    expect((await callResearch({ mpns: ['W1'] })).status).toBe(503)
    expect(await dumpState()).toBe(before)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports unknown MPNs as unregistered and never registers them', async () => {
    const calls = fakeEbay({})
    const body = await researched(['W99999999', 'w-99999999'])
    expect(body.schemaVersion).toBe(1)
    expect(body.results).toEqual([
      {
        mpnKey: 'W99999999',
        mpnDisplay: null,
        registration: 'unregistered',
        sold: null,
        active: null,
        overall: 'failed',
        notes: ['Not registered. Register the MPN first; research never registers parts.'],
      },
    ])
    expect(await count('parts')).toBe(0)
    expect(calls).toEqual([])
  })

  it('saves exact-MPN Browse competition and verified Insights sold windows with the MPN-only query', async () => {
    await createPart({ mpn: 'W11204517', description: 'Control board' })
    const calls = fakeEbay({
      browse: () =>
        browseResponse([
          { title: 'Whirlpool W11204517 control board', price: 80, shipping: 0 },
          { title: 'OEM W11204517', price: 100, shipping: 10 },
          { title: 'W112045170 different part', price: 5 },
        ]),
      insights: () =>
        insightsResponse([
          { title: 'W11204517 board', price: 100, daysAgo: 2, shipping: 10 },
          { title: 'Genuine W11204517', price: 80, daysAgo: 20, shipping: 0 },
          { title: 'W112045170 different part', price: 5, daysAgo: 1 },
          { title: 'W11204517 control', price: 60, daysAgo: 60, shipping: 5 },
        ]),
    })

    const body = await researched(['w11204517', 'W11204517', 'UNKNOWN-1'])
    expect(body.results.map((result) => [result.mpnKey, result.registration, result.active, result.sold, result.overall])).toEqual([
      ['W11204517', 'registered', 'saved', 'saved', 'success'],
      ['UNKNOWN1', 'unregistered', null, null, 'failed'],
    ])
    expect(body.results[0]?.notes).toEqual([])

    expect(calls.filter((call) => call.kind !== 'token')).toEqual([
      { kind: 'browse', q: 'W11204517' },
      { kind: 'insights', q: 'W11204517' },
    ])

    expect(await activeRows()).toEqual([
      { active_qty: 2, asking_price: '90.00', asking_shipping: '5.00', source: 'ebay_browse', sample_size: 2, broad_match_count: 3, mpn_rejected_count: 1, truncated: false },
    ])

    const sold = { source: 'ebay_insights', price_basis: 'sold', sell_through_pct: null, research_session_id: null }
    expect(await soldRows()).toEqual([
      { period: '90d', price: '80.00', shipping: '5.00', sold_qty: 3, sample_size: 3, ...sold },
      { period: '30d', price: '90.00', shipping: '5.00', sold_qty: 2, sample_size: 2, ...sold },
      { period: '7d', price: '100.00', shipping: '10.00', sold_qty: 1, sample_size: 1, ...sold },
    ])
  })

  it('keeps a truncated Browse result’s active count unknown but its price sample', async () => {
    await createPart({ mpn: 'W11204517', description: 'Control board' })
    fakeEbay({
      browse: () => browseResponse([{ title: 'W11204517', price: 70 }, { title: 'W11204517 board', price: 90 }], 450),
      insights: () => insightsResponse([{ title: 'W11204517', price: 75, daysAgo: 3 }]),
    })

    const [result] = (await researched(['W11204517'])).results
    expect(result).toMatchObject({ active: 'saved', sold: 'saved', overall: 'success' })
    expect(result?.notes).toEqual(['Active: more listings than one page; active count left unknown, asking-price sample kept.'])
    expect(await activeRows()).toEqual([
      { active_qty: null, asking_price: '80.00', asking_shipping: '0.00', source: 'ebay_browse', sample_size: 2, broad_match_count: 450, mpn_rejected_count: 0, truncated: true },
    ])
  })

  it('keeps sold quantities unknown but sampled sold prices when Insights is truncated', async () => {
    await createPart({ mpn: 'W11204517', description: 'Control board' })
    fakeEbay({
      insights: () =>
        insightsResponse(
          [
            { title: 'W11204517', price: 100, daysAgo: 2 },
            { title: 'W11204517', price: 60, daysAgo: 10 },
          ],
          900,
        ),
    })

    const [result] = (await researched(['W11204517'])).results
    expect(result?.sold).toBe('saved')
    expect(result?.notes).toContain('Sold: more sales than one page; sold quantities left unknown, sampled sold prices kept.')
    expect((await soldRows()).map((row) => [row.period, row.price, row.sold_qty, row.sample_size])).toEqual([
      ['90d', '80.00', null, 2],
      ['30d', '80.00', null, 2],
      ['7d', '100.00', null, 1],
    ])
  })

  it('saves no sold research when exact-MPN verification fails, but still saves active', async () => {
    await createPart({ mpn: 'W11204517', description: 'Control board' })
    await createPart({ mpn: 'W10830046', description: 'Gasket' })
    fakeEbay({
      browse: (q) => browseResponse([{ title: `${q} part`, price: 50 }]),
      insights: (q) =>
        q === 'W11204517'
          ? insightsResponse([{ title: 'W11204517 board', price: 100, daysAgo: 2 }, { price: 40, daysAgo: 3 }])
          : insightsResponse([]),
    })

    const body = await researched(['W11204517', 'W10830046'])
    for (const result of body.results) {
      expect(result).toMatchObject({ registration: 'registered', active: 'saved', sold: 'unverified', overall: 'partial' })
      expect(result.notes).toEqual([
        'Sold: exact-MPN verification was not possible (a returned sale had no title, or none were returned); nothing saved.',
      ])
    }
    // An untitled sale and an empty answer both stay unknown — never zero sold.
    expect(await count('market_snapshots')).toBe(0)
    expect(await count('active_market_snapshots')).toBe(2)
  })

  it('returns partial with active saved when Marketplace Insights access is unavailable', async () => {
    await createPart({ mpn: 'W11204517', description: 'Control board' })
    await createPart({ mpn: 'W10830046', description: 'Gasket' })
    const calls = fakeEbay({
      deniedScopes: [INSIGHTS_SCOPE],
      browse: (q) => browseResponse([{ title: q, price: 30 }]),
    })

    const body = await researched(['W11204517', 'W10830046'])
    for (const result of body.results) {
      expect(result).toMatchObject({ active: 'saved', sold: 'unavailable', overall: 'partial' })
      expect(result.notes).toEqual(['Sold: these eBay credentials have no Marketplace Insights access; nothing saved.'])
    }
    expect(calls.filter((call) => call.kind === 'insights')).toEqual([])
    expect(calls.filter((call) => call.kind === 'token' && call.scope === INSIGHTS_SCOPE)).toHaveLength(1)
    expect(await count('market_snapshots')).toBe(0)
    expect(await count('active_market_snapshots')).toBe(2)
  })

  it('treats a 403 from the Insights data call as unavailable and stops calling it', async () => {
    await createPart({ mpn: 'W11204517', description: 'Control board' })
    await createPart({ mpn: 'W10830046', description: 'Gasket' })
    const calls = fakeEbay({
      browse: (q) => browseResponse([{ title: q, price: 30 }]),
      insights: () => json({ errors: [{ message: 'Insufficient permissions' }] }, 403),
    })

    const body = await researched(['W11204517', 'W10830046'])
    expect(body.results.map((result) => [result.active, result.sold, result.overall])).toEqual([
      ['saved', 'unavailable', 'partial'],
      ['saved', 'unavailable', 'partial'],
    ])
    expect(calls.filter((call) => call.kind === 'insights')).toHaveLength(1)
    expect(await count('market_snapshots')).toBe(0)
  })

  it('saves sold research when Browse fails, and the streams stay independent', async () => {
    await createPart({ mpn: 'W11204517', description: 'Control board' })
    fakeEbay({
      browse: () => json({ errors: [] }, 429),
      insights: () => insightsResponse([{ title: 'W11204517', price: 90, daysAgo: 5 }]),
    })

    const [result] = (await researched(['W11204517'])).results
    expect(result).toMatchObject({ active: 'failed', sold: 'saved', overall: 'partial' })
    expect(result?.notes).toEqual(['Active: eBay answered HTTP 429; nothing saved.'])
    expect(await count('active_market_snapshots')).toBe(0)
    expect(await count('market_snapshots')).toBe(3)
  })

  it('one MPN failing neither erases its stored facts nor blocks the others, and leaks no eBay body or key', async () => {
    const failing = await createPart({ mpn: 'A-100', description: 'Board' })
    await createPart({ mpn: 'B-200', description: 'Pump' })
    await saveMarketResearchSession({
      partId: failing.id,
      researchedAt: new Date('2026-03-01T00:00:00Z'),
      windows: [{ period: '90d', avgSoldPrice: 45, avgShipping: 5, totalSold: 4, sellThroughPct: 22 }],
    })
    await testDb.insert(activeMarketSnapshots).values({ partId: failing.id, activeQty: 6, askingPrice: '55.00', source: 'manual', truncated: false })
    const failingBefore = JSON.stringify([
      await rows(`select * from market_snapshots where part_id = ${failing.id} order by id`),
      await rows(`select * from active_market_snapshots where part_id = ${failing.id} order by id`),
    ])

    fakeEbay({
      browse: (q) => (q === 'A-100' ? json({ detail: 'EBAY-BODY-SECRET' }, 500) : browseResponse([{ title: 'B-200 pump', price: 40 }])),
      insights: (q) =>
        q === 'A-100'
          ? new Response('EBAY-BODY-SECRET upstream failure', { status: 502 })
          : insightsResponse([{ title: 'B200', price: 42, daysAgo: 4 }]),
    })

    const response = await callResearch({ mpns: ['A-100', 'B-200'] })
    expect(response.status).toBe(200)
    const text = await response.text()
    for (const secret of ['EBAY-BODY-SECRET', EBAY_SECRET, KEY, 'fake-ebay-token']) expect(text).not.toContain(secret)

    const body = JSON.parse(text) as TargetedResearchEnvelopeV1
    expect(body.results).toEqual([
      {
        mpnKey: 'A100',
        mpnDisplay: 'A-100',
        registration: 'registered',
        sold: 'failed',
        active: 'failed',
        overall: 'failed',
        notes: ['Active: eBay answered HTTP 500; nothing saved.', 'Sold: eBay answered HTTP 502; nothing saved.'],
      },
      { mpnKey: 'B200', mpnDisplay: 'B-200', registration: 'registered', sold: 'saved', active: 'saved', overall: 'success', notes: [] },
    ])

    expect(
      JSON.stringify([
        await rows(`select * from market_snapshots where part_id = ${failing.id} order by id`),
        await rows(`select * from active_market_snapshots where part_id = ${failing.id} order by id`),
      ]),
    ).toBe(failingBefore)
  })

  it('writes only snapshot rows: no part, inventory, session, settings, or sync-run changes', async () => {
    await createPart({ mpn: 'W11204517', description: 'Control board', inventoryQty: 2, costBasis: 10 })
    const partsBefore = await rows(`select * from parts order by id`)
    fakeEbay({
      browse: () => browseResponse([{ title: 'W11204517', price: 60 }]),
      insights: () => insightsResponse([{ title: 'W11204517', price: 65, daysAgo: 1 }]),
    })

    await researched(['W11204517'])
    expect(await rows(`select * from parts order by id`)).toEqual(partsBefore)
    expect(await count('market_research_sessions')).toBe(0)
    expect(await count('settings')).toBe(0)
    expect(await count('ebay_sync_runs')).toBe(0)
  })

  it('register -> research -> market-facts: facts arrive, sell-through is never derived', async () => {
    expect((await registered([{ mpn: 'W11204517', description: 'Control board' }])).results[0]?.status).toBe('inserted')
    fakeEbay({
      browse: () => browseResponse([{ title: 'W11204517', price: 60 }, { title: 'W11204517 OEM', price: 80 }]),
      insights: () =>
        insightsResponse([
          { title: 'W11204517', price: 70, daysAgo: 1 },
          { title: 'W11204517', price: 50, daysAgo: 40 },
          { title: 'W11204517', price: 60, daysAgo: 80 },
        ]),
    })
    expect((await researched(['W11204517'])).results[0]?.overall).toBe('success')

    const response = await marketFacts(
      new Request('https://ebd.example/api/integrations/market-facts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ mpns: ['W11204517'] }),
      }),
    )
    const [fact] = ((await response.json()) as MarketFactsEnvelopeV1).facts
    // 3 sold and 2 active are both known, and still no sell-through appears.
    expect(fact?.sold90).toMatchObject({ soldQty: 3, avgSoldPrice: 60, sellThroughPct: null, source: 'ebay_insights', priceBasis: 'sold' })
    expect(fact?.active).toMatchObject({ activeQty: 2, askingPrice: 70, source: 'ebay_browse', truncated: false })
    expect(await rows(`select 1 from market_snapshots where sell_through_pct is not null`)).toEqual([])
    expect(await rows(`select inventory_qty from parts`)).toEqual([{ inventory_qty: 0 }])
  })
})
