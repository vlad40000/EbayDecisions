import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { revalidatePath } from 'next/cache'
import { NextRequest } from 'next/server'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { captureActiveResearch, saveResearch } from '@/app/(app)/tracker/actions'
import { GET as cronSync } from '@/app/api/cron/sync/route'
import { GET as preview } from '@/app/api/ebay/preview/[mpn]/route'
import { GET as soldResearch } from '@/app/api/ebay/research/[mpn]/route'
import { POST as manualSync } from '@/app/api/ebay/sync/route'
import { POST as marketFacts } from '@/app/api/integrations/market-facts/route'
import { POST as register } from '@/app/api/integrations/parts/register/route'
import { POST as research } from '@/app/api/integrations/research/route'
import { ResearchTracker, type ResearchTrackerRow } from '@/components/research-tracker'
import { setDatabaseForTests } from '@/db/index'
import { createPart, saveMarketResearchSession } from '@/db/queries'
import * as schema from '@/db/schema'
import { activeMarketSnapshots } from '@/db/schema'
import {
  AUTOMATED_EBAY_RESEARCH_DISABLED,
  AutomatedEbayResearchDisabledError,
  isAutomatedEbayResearchEnabled,
} from '@/lib/ebay/automation-gate'
import { fetchActiveMarket } from '@/lib/ebay/browse'
import { ebayGet, getAccessToken } from '@/lib/ebay/client'
import { researchExactMpns } from '@/lib/ebay/exact-mpn-research'
import { fetchSoldWindows } from '@/lib/ebay/insights'
import { buildEbayActiveResearchUrl, buildEbaySoldResearchUrl } from '@/lib/ebay/research-links'
import { runSync } from '@/lib/ebay/sync'
import type { MarketFactsEnvelopeV1 } from '@/lib/market-facts'
import type { PartRegistrationEnvelopeV1 } from '@/lib/part-registration'
import { PERIODS } from '@/lib/types'

/*
 * The session check reads next/headers and the Tracker actions revalidate
 * through next/cache; neither works outside a Next request, so both are
 * stubbed. The Tracker component's router is stubbed for server rendering.
 */
vi.mock('@/lib/session', () => ({
  isSignedIn: async () => true,
  requireSession: async () => {},
  hasValidSession: async () => true,
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const client = new PGlite()
const testDb = drizzle({ client, schema })
setDatabaseForTests(testDb)

const KEY = 'integration-test-key-0123456789'
const CRON_SECRET = 'cron-secret-for-tests-0123456789'
const MPN = 'W11204517'
const BROWSE_SCOPE = 'https://api.ebay.com/oauth/api_scope'
const DAY_MS = 86_400_000

/*
 * Credentials, the integration key, and the cron flag and secret are all set,
 * so in manual-only tests the automation gate is the only thing standing
 * between each path and eBay.
 */
const ENV: Record<string, string> = {
  INTEGRATION_API_KEY: KEY,
  EBAY_CLIENT_ID: 'ebay-client-id',
  EBAY_CLIENT_SECRET: 'ebay-client-secret',
  EBAY_CRON_ENABLED: 'true',
  CRON_SECRET,
}

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
  Object.assign(process.env, ENV)
  delete process.env.EBAY_AUTOMATED_RESEARCH_ENABLED
})
afterEach(() => {
  for (const key of [...Object.keys(ENV), 'EBAY_AUTOMATED_RESEARCH_ENABLED']) delete process.env[key]
  vi.restoreAllMocks()
  vi.clearAllMocks()
})
afterAll(async () => client.close())

// ─── Database helpers ────────────────────────────────────────────────────────

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

/** A part with stored manual facts, so "writes nothing" also covers "erases nothing". */
async function seedPart() {
  const part = await createPart({ mpn: MPN, description: 'Control board', inventoryQty: 2 })
  await saveMarketResearchSession({
    partId: part.id,
    researchedAt: new Date('2026-09-01T00:00:00Z'),
    windows: [{ period: '90d', avgSoldPrice: 85, avgShipping: 5, totalSold: 6 }],
  })
  await testDb.insert(activeMarketSnapshots).values({ partId: part.id, activeQty: 7, askingPrice: '95.00', source: 'manual', truncated: false })
  return part
}

// ─── Fake eBay (official API paths only) ─────────────────────────────────────

type EbayCall = { kind: 'token' | 'browse' | 'insights' | 'other'; scope?: string; q?: string }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * Records every fetch, eBay or not. Browse and Insights each answer with two
 * exact-MPN results: listings at $80 + $0 and $100 + $10 shipping, and sales
 * of $100 + $10 two days ago and $80 + $0 twenty days ago.
 */
function fakeEbay(options: { tokenTtlSeconds?: number } = {}): EbayCall[] {
  const calls: EbayCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const q = url.searchParams.get('q') ?? ''
    if (url.pathname === '/identity/v1/oauth2/token') {
      const scope = new URLSearchParams(String(init?.body ?? '')).get('scope') ?? ''
      calls.push({ kind: 'token', scope })
      // expires_in 0 keeps the client's module-level token cache from carrying
      // a grant from one test into the next.
      return json({ access_token: 'fake-ebay-token', expires_in: options.tokenTtlSeconds ?? 0 })
    }
    if (url.pathname === '/buy/browse/v1/item_summary/search') {
      calls.push({ kind: 'browse', q })
      const listing = (title: string, price: string, shipping: string) => ({
        title,
        price: { value: price, currency: 'USD' },
        shippingOptions: [{ shippingCost: { value: shipping } }],
      })
      return json({ total: 2, itemSummaries: [listing(`Whirlpool ${q} control board`, '80.00', '0.00'), listing(`OEM ${q}`, '100.00', '10.00')] })
    }
    if (url.pathname === '/buy/marketplace_insights/v1_beta/item_sales/search') {
      calls.push({ kind: 'insights', q })
      const sale = (title: string, price: string, daysAgo: number, shipping: string) => ({
        title,
        lastSoldPrice: { value: price, currency: 'USD' },
        lastSoldDate: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
        shippingOptions: [{ shippingCost: { value: shipping } }],
      })
      return json({ total: 2, itemSales: [sale(`${q} board`, '100.00', 2, '10.00'), sale(`Genuine ${q}`, '80.00', 20, '0.00')] })
    }
    calls.push({ kind: 'other' })
    throw new Error(`Unexpected fetch: ${url.pathname}`)
  })
  return calls
}

// ─── Request helpers ─────────────────────────────────────────────────────────

function postJson(handler: (request: Request) => Promise<Response>, url: string, body: unknown) {
  return handler(
    new Request(`https://ebd.example${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    }),
  )
}

const mpnParams = () => ({ params: Promise.resolve({ mpn: MPN }) })
const callIntegrationResearch = () => postJson(research, '/api/integrations/research', { mpns: [MPN] })
const callPreview = () => preview(new Request(`https://ebd.example/api/ebay/preview/${MPN}`), mpnParams())
const callSoldResearch = () => soldResearch(new Request(`https://ebd.example/api/ebay/research/${MPN}`), mpnParams())
const callCron = (secret = CRON_SECRET) =>
  cronSync(new NextRequest('https://ebd.example/api/cron/sync', { headers: { authorization: `Bearer ${secret}` } }))

// ─── The flag ────────────────────────────────────────────────────────────────

describe('EBAY_AUTOMATED_RESEARCH_ENABLED', () => {
  it('is on only when exactly "true"; unset and every other value is manual-only', () => {
    expect(isAutomatedEbayResearchEnabled()).toBe(false)
    for (const value of ['', 'false', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true ']) {
      process.env.EBAY_AUTOMATED_RESEARCH_ENABLED = value
      expect(isAutomatedEbayResearchEnabled(), JSON.stringify(value)).toBe(false)
    }
    process.env.EBAY_AUTOMATED_RESEARCH_ENABLED = 'true'
    expect(isAutomatedEbayResearchEnabled()).toBe(true)
  })
})

// ─── Manual-only mode ────────────────────────────────────────────────────────

describe('manual-only mode: every eBay path returns before contacting eBay', () => {
  it('POST /api/integrations/research answers 503 before any part lookup or eBay call', async () => {
    await seedPart()
    const calls = fakeEbay()
    const before = await dumpState()

    const response = await callIntegrationResearch()
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: AUTOMATED_EBAY_RESEARCH_DISABLED })

    expect(calls).toEqual([])
    expect(await dumpState()).toBe(before)
  })

  it('Tracker captureActiveResearch refuses without calling eBay or writing an Active snapshot', async () => {
    const part = await seedPart()
    const calls = fakeEbay()
    const before = await dumpState()

    expect(await captureActiveResearch({ partId: part.id, mpn: MPN })).toEqual({
      ok: false,
      error: AUTOMATED_EBAY_RESEARCH_DISABLED,
    })

    expect(calls).toEqual([])
    expect(await dumpState()).toBe(before)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('GET /api/ebay/preview/[mpn] and GET /api/ebay/research/[mpn] answer 503 without calling eBay', async () => {
    await seedPart()
    const calls = fakeEbay()
    const before = await dumpState()

    for (const response of [await callPreview(), await callSoldResearch()]) {
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: AUTOMATED_EBAY_RESEARCH_DISABLED })
    }

    expect(calls).toEqual([])
    expect(await dumpState()).toBe(before)
  })

  it('POST /api/ebay/sync is skipped: no eBay call, no sync run, no snapshots', async () => {
    await seedPart()
    const calls = fakeEbay()
    const before = await dumpState()

    const response = await manualSync()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'skipped',
      message: AUTOMATED_EBAY_RESEARCH_DISABLED,
      runId: null,
      snapshotsWritten: 0,
    })

    expect(calls).toEqual([])
    expect(await dumpState()).toBe(before)
  })

  it('GET /api/cron/sync is skipped even with EBAY_CRON_ENABLED and a valid CRON_SECRET', async () => {
    await seedPart()
    const calls = fakeEbay()
    const before = await dumpState()

    const response = await callCron()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'skipped', message: AUTOMATED_EBAY_RESEARCH_DISABLED })

    // The existing cron flag is still checked first.
    delete process.env.EBAY_CRON_ENABLED
    expect(await (await callCron()).json()).toEqual({ status: 'skipped', message: 'Scheduled eBay sync is disabled.' })

    expect(calls).toEqual([])
    expect(await dumpState()).toBe(before)
  })

  it('the sync and research services and the eBay client refuse before any lookup or request', async () => {
    await seedPart()
    const calls = fakeEbay()
    const before = await dumpState()

    expect(await runSync('manual')).toMatchObject({ status: 'skipped', message: AUTOMATED_EBAY_RESEARCH_DISABLED, runId: null })
    expect(await runSync('cron')).toMatchObject({ status: 'skipped', message: AUTOMATED_EBAY_RESEARCH_DISABLED, runId: null })
    await expect(researchExactMpns([MPN])).rejects.toBeInstanceOf(AutomatedEbayResearchDisabledError)
    await expect(fetchActiveMarket(MPN)).rejects.toBeInstanceOf(AutomatedEbayResearchDisabledError)
    await expect(fetchSoldWindows(MPN)).rejects.toBeInstanceOf(AutomatedEbayResearchDisabledError)
    await expect(getAccessToken(BROWSE_SCOPE)).rejects.toBeInstanceOf(AutomatedEbayResearchDisabledError)
    await expect(ebayGet('/buy/browse/v1/item_summary/search', { q: MPN }, BROWSE_SCOPE)).rejects.toBeInstanceOf(
      AutomatedEbayResearchDisabledError,
    )

    expect(calls).toEqual([])
    expect(await dumpState()).toBe(before)
  })

  it('never reuses an eBay token minted while the flag was on', async () => {
    const scope = 'https://api.ebay.com/oauth/api_scope/manual-only-gate-test'
    process.env.EBAY_AUTOMATED_RESEARCH_ENABLED = 'true'
    const calls = fakeEbay({ tokenTtlSeconds: 7200 })
    await getAccessToken(scope)
    expect(calls).toEqual([{ kind: 'token', scope }])

    delete process.env.EBAY_AUTOMATED_RESEARCH_ENABLED
    await expect(getAccessToken(scope)).rejects.toBeInstanceOf(AutomatedEbayResearchDisabledError)
    await expect(ebayGet('/buy/browse/v1/item_summary/search', { q: MPN }, scope)).rejects.toBeInstanceOf(
      AutomatedEbayResearchDisabledError,
    )
    expect(calls).toHaveLength(1)
  })

  it.each(['', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true '])(
    'treats EBAY_AUTOMATED_RESEARCH_ENABLED=%j as manual-only on every path',
    async (value) => {
      process.env.EBAY_AUTOMATED_RESEARCH_ENABLED = value
      const part = await seedPart()
      const calls = fakeEbay()
      const before = await dumpState()

      expect((await callIntegrationResearch()).status).toBe(503)
      expect(await captureActiveResearch({ partId: part.id, mpn: MPN })).toMatchObject({ ok: false })
      expect((await callPreview()).status).toBe(503)
      expect((await callSoldResearch()).status).toBe(503)
      expect(await (await manualSync()).json()).toMatchObject({ status: 'skipped' })
      expect(await (await callCron()).json()).toMatchObject({ status: 'skipped' })

      expect(calls).toEqual([])
      expect(await dumpState()).toBe(before)
    },
  )
})

describe('manual-only mode keeps the manual workflow', () => {
  it('SAVE RESEARCH still records a dated research session without calling eBay', async () => {
    const part = await seedPart()
    const calls = fakeEbay()

    const result = await saveResearch({
      partId: part.id,
      windows: PERIODS.map((period) => ({
        period,
        avgSoldPrice: '90',
        avgShipping: '5',
        totalSold: '4',
        soldPriceMin: '',
        soldPriceMax: '',
        totalSellers: '',
        sellThroughPct: '',
        freeShippingPct: '',
      })),
    })

    expect(result).toMatchObject({ ok: true, written: PERIODS.length })
    expect(await count('market_research_sessions')).toBe(2)
    expect(calls).toEqual([])
  })

  it('registration and stored market-facts reads still work without calling eBay', async () => {
    await seedPart()
    const calls = fakeEbay()

    const registered = await postJson(register, '/api/integrations/parts/register', { parts: [{ mpn: 'DC47-00019A' }] })
    expect(registered.status).toBe(200)
    expect(((await registered.json()) as PartRegistrationEnvelopeV1).results).toEqual([
      { mpnKey: 'DC4700019A', mpnDisplay: 'DC47-00019A', status: 'inserted' },
    ])

    const facts = await postJson(marketFacts, '/api/integrations/market-facts', { mpns: [MPN] })
    expect(facts.status).toBe(200)
    const [fact] = ((await facts.json()) as MarketFactsEnvelopeV1).facts
    expect(fact).toMatchObject({
      mpnKey: MPN,
      status: 'found',
      sold90: { soldQty: 6, avgSoldPrice: 85, source: 'manual' },
      active: { activeQty: 7, askingPrice: 95, source: 'manual' },
    })

    expect(calls).toEqual([])
  })
})

describe('Tracker Capture Active', () => {
  const row: ResearchTrackerRow = {
    partId: 1,
    mpn: MPN,
    description: 'Control board',
    inventoryQty: 2,
    lastResearchedAt: null,
    periods: {},
    activeMarket: null,
  }
  // A single row renders expanded, so the research editor is in the markup.
  const render = (captureActiveEnabled: boolean) =>
    renderToStaticMarkup(createElement(ResearchTracker, { rows: [row], captureActiveEnabled }))
  const attribute = (value: string) => value.replaceAll('&', '&amp;')

  it('is hidden in manual-only mode while the MPN-only eBay links and SAVE RESEARCH remain', () => {
    const html = render(false)
    expect(html).not.toMatch(/<button[^>]*>Capture Active/)
    expect(html).toContain('Manual-only')
    expect(html).toContain(`href="${attribute(buildEbayActiveResearchUrl(MPN))}"`)
    expect(html).toContain(`href="${attribute(buildEbaySoldResearchUrl(MPN))}"`)
    expect(html).toMatch(/<button[^>]*>SAVE RESEARCH<\/button>/)
  })

  it('is offered when automated research is enabled', () => {
    expect(render(true)).toMatch(/<button[^>]*>Capture Active<\/button>/)
  })
})

// ─── Flag on: existing adapter behavior ──────────────────────────────────────
// POST /api/integrations/research with the flag on is covered by
// integration-provider.test.ts.

describe('EBAY_AUTOMATED_RESEARCH_ENABLED="true" keeps the existing adapter behavior (fake eBay)', () => {
  beforeEach(() => {
    process.env.EBAY_AUTOMATED_RESEARCH_ENABLED = 'true'
  })

  it('Capture Active saves one MPN-only Browse snapshot', async () => {
    const part = await createPart({ mpn: MPN, description: 'Control board' })
    const calls = fakeEbay()

    expect(await captureActiveResearch({ partId: part.id, mpn: MPN })).toMatchObject({ ok: true })
    expect(calls).toEqual([
      { kind: 'token', scope: BROWSE_SCOPE },
      { kind: 'browse', q: MPN },
    ])
    expect(
      await rows(
        `select active_qty, asking_price, asking_shipping, source, sample_size, broad_match_count, truncated
         from active_market_snapshots`,
      ),
    ).toEqual([
      { active_qty: 2, asking_price: '90.00', asking_shipping: '5.00', source: 'ebay_browse', sample_size: 2, broad_match_count: 2, truncated: false },
    ])
    expect(revalidatePath).toHaveBeenCalledWith('/tracker')
  })

  it('GET /api/ebay/preview/[mpn] returns the Browse summary and writes nothing', async () => {
    await createPart({ mpn: MPN, description: 'Control board' })
    const calls = fakeEbay()
    const before = await dumpState()

    const response = await callPreview()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      askingPrice: 90,
      askingShipping: 5,
      activeQty: 2,
      sampleSize: 2,
      broadMatchCount: 2,
      mpnRejectedCount: 0,
      conditionRejectedCount: 0,
      truncated: false,
    })
    expect(calls.filter((call) => call.kind !== 'token')).toEqual([{ kind: 'browse', q: MPN }])
    expect(await dumpState()).toBe(before)
  })

  it('GET /api/ebay/research/[mpn] returns exact-MPN Insights windows and writes nothing', async () => {
    await createPart({ mpn: MPN, description: 'Control board' })
    const calls = fakeEbay()
    const before = await dumpState()

    const response = await callSoldResearch()
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      source: string
      exactMpnVerified: boolean
      windows: Record<string, { avgSoldPrice: number | null; totalSold: number | null }>
    }
    expect(body.source).toBe('ebay_marketplace_insights')
    expect(body.exactMpnVerified).toBe(true)
    expect(body.windows['30d']).toMatchObject({ avgSoldPrice: 90, totalSold: 2 })
    expect(body.windows['7d']).toMatchObject({ avgSoldPrice: 100, totalSold: 1 })
    expect(calls.filter((call) => call.kind !== 'token')).toEqual([{ kind: 'insights', q: MPN }])
    expect(await dumpState()).toBe(before)
  })

  it('POST /api/ebay/sync runs the catalogue sync through the adapters', async () => {
    await createPart({ mpn: MPN, description: 'Control board' })
    const calls = fakeEbay()

    const response = await manualSync()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'success',
      adapter: 'insights',
      partsProcessed: 1,
      soldSnapshotsWritten: 3,
      activeSnapshotsWritten: 0,
    })
    expect(calls.filter((call) => call.kind !== 'token')).toEqual([{ kind: 'insights', q: MPN }])
    expect(await rows(`select trigger, status from ebay_sync_runs`)).toEqual([{ trigger: 'manual', status: 'success' }])
    expect(await count('market_snapshots')).toBe(3)
  })

  it('GET /api/cron/sync still needs EBAY_CRON_ENABLED and CRON_SECRET', async () => {
    await createPart({ mpn: MPN, description: 'Control board' })
    const calls = fakeEbay()

    delete process.env.EBAY_CRON_ENABLED
    expect(await (await callCron()).json()).toEqual({ status: 'skipped', message: 'Scheduled eBay sync is disabled.' })
    process.env.EBAY_CRON_ENABLED = 'true'
    expect((await callCron('wrong-secret')).status).toBe(401)
    expect(calls).toEqual([])

    const response = await callCron()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'success', adapter: 'insights', soldSnapshotsWritten: 3 })
    expect(await rows(`select trigger, status from ebay_sync_runs`)).toEqual([{ trigger: 'cron', status: 'success' }])
  })
})
