import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { POST as marketFacts } from '@/app/api/integrations/market-facts/route'
import { GET as fullExport } from '@/app/api/parts/export/route'
import { GET as sharedExport, POST as sharedImport } from '@/app/api/research/shared-csv/route'
import { setDatabaseForTests } from '@/db/index'
import { createPart, saveMarketResearchSession } from '@/db/queries'
import * as schema from '@/db/schema'
import { marketSnapshots } from '@/db/schema'
import { parseCsv } from '@/lib/csv'
import { isAutomatedEbayResearchEnabled } from '@/lib/ebay/automation-gate'
import type { MarketFactsEnvelopeV1 } from '@/lib/market-facts'
import {
  parseSharedResearchCsv,
  SHARED_RESEARCH_CSV_HEADERS,
  SHARED_RESEARCH_MAX_ROWS,
} from '@/lib/shared-research-csv'

/*
 * The session check reads next/headers and the route revalidates through
 * next/cache; neither works outside a Next request, so both are stubbed.
 */
const auth = vi.hoisted(() => ({ signedIn: true }))
vi.mock('@/lib/session', () => ({
  isSignedIn: async () => auth.signedIn,
  requireSession: async () => {},
  hasValidSession: async () => auth.signedIn,
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const client = new PGlite()
const testDb = drizzle({ client, schema })
setDatabaseForTests(testDb)

const KEY = 'integration-test-key-0123456789'
const HEADER = SHARED_RESEARCH_CSV_HEADERS.join(',')

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

/** Every fetch fails the test: nothing here may call eBay or anything else. */
let fetchSpy: MockInstance<typeof fetch>

beforeEach(async () => {
  await resetSchema()
  auth.signedIn = true
  process.env.INTEGRATION_API_KEY = KEY
  delete process.env.EBAY_AUTOMATED_RESEARCH_ENABLED
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    throw new Error(`Unexpected fetch: ${String(input)}`)
  })
})
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled()
  delete process.env.INTEGRATION_API_KEY
  vi.useRealTimers()
  vi.restoreAllMocks()
})
afterAll(async () => client.close())

// ─── Helpers ─────────────────────────────────────────────────────────────────

function csv(...lines: string[]): string {
  return `${lines.join('\r\n')}\r\n`
}

async function rows<T>(sql: string): Promise<T[]> {
  return (await client.query<T>(sql)).rows
}

async function count(table: string): Promise<number> {
  const [row] = await rows<{ n: number }>(`select count(*)::int as n from ${table}`)
  return row?.n ?? 0
}

type ImportBody = {
  error?: string
  errors?: string[]
  errorCount?: number
  rows?: number
  registered?: number
  existing?: number
  sessions?: number
  windows?: number
  newPrices?: number
  ignoredColumns?: string[]
}

async function importCsv(text: string): Promise<{ status: number; body: ImportBody }> {
  const form = new FormData()
  form.set('file', new File([text], 'research.csv', { type: 'text/csv' }))
  const response = await sharedImport(
    new Request('https://ebd.example/api/research/shared-csv', { method: 'POST', body: form }),
  )
  return { status: response.status, body: (await response.json()) as ImportBody }
}

async function exportCsv(query = ''): Promise<{ status: number; text: string; disposition: string | null }> {
  const response = await sharedExport(new Request(`https://ebd.example/api/research/shared-csv${query}`))
  return {
    status: response.status,
    text: await response.text(),
    disposition: response.headers.get('content-disposition'),
  }
}

async function facts(mpns: string[]) {
  const response = await marketFacts(
    new Request('https://ebd.example/api/integrations/market-facts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ mpns }),
    }),
  )
  return ((await response.json()) as MarketFactsEnvelopeV1).facts
}

type SnapshotDbRow = {
  period: string
  sold_qty: number | null
  price: string | null
  shipping: string | null
  sell_through_pct: string | null
  source: string
  price_basis: string
  research_session_id: number | null
  captured_at: Date
}

async function snapshotsFor(mpn: string): Promise<SnapshotDbRow[]> {
  return rows<SnapshotDbRow>(`
    select m.period, m.sold_qty, m.price, m.shipping, m.sell_through_pct, m.source,
           m.price_basis, m.research_session_id, m.captured_at
    from market_snapshots m join parts p on p.id = m.part_id
    where p.mpn = '${mpn}'
    order by m.id
  `)
}

type PartDbRow = {
  mpn: string
  mpn_key: string
  description: string
  inventory_qty: number
  cost_basis: string | null
  ship_cost: string | null
  target_margin_pct: string | null
  new_price: string | null
  notes: string | null
}

async function partRow(mpnKey: string): Promise<PartDbRow | undefined> {
  const [row] = await rows<PartDbRow>(`
    select mpn, mpn_key, description, inventory_qty, cost_basis, ship_cost,
           target_margin_pct, new_price, notes
    from parts where mpn_key = '${mpnKey}'
  `)
  return row
}

// ─── Contract parsing (no database) ──────────────────────────────────────────

describe('shared research CSV contract', () => {
  it('uses the canonical Parts Engine header order', () => {
    expect([...SHARED_RESEARCH_CSV_HEADERS]).toEqual([
      'mpn',
      'description',
      'notes',
      'New Price',
      '7 Day sales',
      '7 Day Avg Price',
      '30 Day sales',
      '30 Day Avg Price',
      '90 Day sales',
      '90 Day Avg Price',
      '90 Day Sell Through %',
    ])
  })

  it('maps canonical columns to New Price, notes and the 7d/30d/90d windows', () => {
    const parsed = parseSharedResearchCsv(
      csv(HEADER, 'W10-123,Pump,checked sold comps,149.99,3,95.5,12,92,30,90.25,41.5'),
    )
    expect(parsed).toEqual({
      ok: true,
      ignoredColumns: [],
      rows: [
        {
          line: 2,
          mpnKey: 'W10123',
          mpnDisplay: 'W10-123',
          description: 'Pump',
          notes: 'checked sold comps',
          newPrice: 149.99,
          windows: [
            { period: '7d', totalSold: 3, avgSoldPrice: 95.5, sellThroughPct: null },
            { period: '30d', totalSold: 12, avgSoldPrice: 92, sellThroughPct: null },
            { period: '90d', totalSold: 30, avgSoldPrice: 90.25, sellThroughPct: 41.5 },
          ],
        },
      ],
    })
  })

  it('accepts case, space, underscore, hyphen and whitespace header variants', () => {
    const row = 'W10-123,Pump,note,149.99,3,95.5,12,92,30,90.25,41.5'
    const canonical = parseSharedResearchCsv(csv(HEADER, row))
    const variants = [
      ' MPN ,Description,NOTES,new_price,7-day-sales,7_DAY_AVG_PRICE, 30 day sales ,30-Day Avg Price,90_day_sales,90 DAY AVG PRICE,90_day_sell_through_%',
      'mpn,description,notes,newprice,7daysales,7dayavgprice,30daysales,30dayavgprice,90daysales,90dayavgprice,90 Day Sell Through Pct',
      '\tMpn\t,description,notes,New-Price,7 Day Sales,7 Day Avg Price,30 Day Sales,30 Day Avg Price,90 Day Sales,90 Day Avg Price,90 day sell-through percent',
    ]
    for (const header of variants) {
      expect(parseSharedResearchCsv(csv(header, row))).toEqual(canonical)
    }
  })

  it('reads columns by name in any order and ignores columns outside the contract', () => {
    const parsed = parseSharedResearchCsv(
      csv('90 Day Sell Through %,Active Listings,mpn,90 Day sales', '25,40,W10-123,10'),
    )
    expect(parsed).toMatchObject({
      ok: true,
      ignoredColumns: ['Active Listings'],
      rows: [{ mpnKey: 'W10123', windows: [{ period: '90d', totalSold: 10, avgSoldPrice: null, sellThroughPct: 25 }] }],
    })
  })

  it('keeps blank cells and missing columns unknown, and never derives sell-through', () => {
    const parsed = parseSharedResearchCsv(
      csv(
        'mpn,90 Day sales,90 Day Avg Price,Active Listings',
        'A-1,,,',
        'B-2,6,,30',
        'C-3,6,80,30',
      ),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const [a, b, c] = parsed.rows
    expect(a).toMatchObject({ description: '', notes: null, newPrice: null, windows: [] })
    expect(b?.windows).toEqual([{ period: '90d', totalSold: 6, avgSoldPrice: null, sellThroughPct: null }])
    // Sold 6 with 30 active listings would be a 16.67% sell-through if derived. It is not.
    expect(c?.windows).toEqual([{ period: '90d', totalSold: 6, avgSoldPrice: 80, sellThroughPct: null }])
  })

  it('accepts dollar signs, digit grouping, percent signs and whole-valued decimals', () => {
    const parsed = parseSharedResearchCsv(
      csv(HEADER, 'A-1,,," $1,234.50",7.0,$95,"1,200",.5,30,90,45 %'),
    )
    expect(parsed).toMatchObject({
      ok: true,
      rows: [
        {
          newPrice: 1234.5,
          windows: [
            { period: '7d', totalSold: 7, avgSoldPrice: 95 },
            { period: '30d', totalSold: 1200, avgSoldPrice: 0.5 },
            { period: '90d', totalSold: 30, avgSoldPrice: 90, sellThroughPct: 45 },
          ],
        },
      ],
    })
  })

  it('rejects malformed populated numbers and fails the whole file', () => {
    const bad: [string, string][] = [
      ['7 Day sales', '-1'],
      ['7 Day sales', '2.5'],
      ['30 Day sales', 'ten'],
      ['30 Day Avg Price', 'abc'],
      ['90 Day Avg Price', '1e3'],
      ['90 Day Avg Price', '12,34'],
      ['New Price', '-5'],
      ['New Price', '0x10'],
      ['90 Day Sell Through %', '-5%'],
      ['90 Day Sell Through %', 'n/a'],
      ['90 Day Avg Price', '1000001'],
    ]
    for (const [column, value] of bad) {
      const parsed = parseSharedResearchCsv(
        csv(`mpn,${column}`, 'GOOD-1,', `BAD-1,"${value}"`),
      )
      expect(parsed, `${column} = ${value}`).toMatchObject({ ok: false, kind: 'rows' })
      if (parsed.ok) continue
      expect(parsed.errors).toHaveLength(1)
      expect(parsed.errors[0]).toContain('Line 3')
      expect(parsed.errors[0]).toContain(column)
    }
  })

  it('rejects rows without a usable MPN and duplicate D1 keys', () => {
    const parsed = parseSharedResearchCsv(
      csv('mpn,description', ',No MPN', '--/--,Punctuation only', 'W10-123,First', 'w10 123,Same key'),
    )
    expect(parsed).toMatchObject({ ok: false, kind: 'rows' })
    if (parsed.ok) return
    expect(parsed.errors).toEqual([
      'Line 2: no MPN.',
      'Line 3: MPN "--/--" has no letters or digits.',
      'Lines 4, 5: the same MPN (key W10123) appears more than once. Keep one row per MPN.',
    ])
  })

  it('rejects files with no mpn column, two columns for one field, or too many rows', () => {
    expect(parseSharedResearchCsv(csv('part,90 Day sales', 'A-1,4'))).toMatchObject({ ok: false, kind: 'file' })
    expect(parseSharedResearchCsv(csv('mpn,New Price,new_price', 'A-1,1,2'))).toMatchObject({
      ok: false,
      kind: 'file',
      error: 'Columns "New Price" and "new_price" are both "New Price". Keep one.',
    })
    expect(parseSharedResearchCsv(csv(HEADER))).toMatchObject({ ok: false, kind: 'file' })

    const lines = Array.from({ length: SHARED_RESEARCH_MAX_ROWS + 1 }, (_, i) => `MPN-${i}`)
    expect(parseSharedResearchCsv(csv('mpn', ...lines))).toMatchObject({ ok: false, kind: 'file' })
  })
})

// ─── Import / export through the route (PGlite) ──────────────────────────────

describe('POST /api/research/shared-csv', () => {
  it('imports 7d/30d/90d values into one auditable manual session per row, without calling eBay', async () => {
    await createPart({ mpn: 'W11204517', description: 'Control board', inventoryQty: 2 })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'))

    const { status, body } = await importCsv(
      csv(
        HEADER,
        'W11204517,Ignored for existing parts,checked sold comps,,3,95.50,12,92,30,90.25,41.5',
        'dc47-00019a,Heating element,,,,,,,5,60,',
      ),
    )

    expect(isAutomatedEbayResearchEnabled()).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(status).toBe(200)
    expect(body).toMatchObject({ rows: 2, registered: 1, existing: 1, sessions: 2, windows: 4, newPrices: 0 })

    const sessions = await rows<{ part_mpn: string; source: string; notes: string | null; researched_at: Date }>(`
      select p.mpn as part_mpn, s.source, s.notes, s.researched_at
      from market_research_sessions s join parts p on p.id = s.part_id order by s.id
    `)
    expect(sessions).toEqual([
      {
        part_mpn: 'W11204517',
        source: 'ebay_product_research_manual',
        notes: 'checked sold comps',
        researched_at: new Date('2026-10-01T12:00:00Z'),
      },
      {
        part_mpn: 'dc47-00019a',
        source: 'ebay_product_research_manual',
        notes: null,
        researched_at: new Date('2026-10-01T12:00:00Z'),
      },
    ])

    const windows = await snapshotsFor('W11204517')
    expect(windows).toMatchObject([
      { period: '7d', sold_qty: 3, price: '95.50', shipping: null, sell_through_pct: null, source: 'manual', price_basis: 'sold' },
      { period: '30d', sold_qty: 12, price: '92.00', shipping: null, sell_through_pct: null, source: 'manual', price_basis: 'sold' },
      { period: '90d', sold_qty: 30, price: '90.25', shipping: null, sell_through_pct: '41.50', source: 'manual', price_basis: 'sold' },
    ])
    expect(windows.every((row) => row.research_session_id != null)).toBe(true)
    expect(windows.every((row) => row.captured_at.getTime() === Date.parse('2026-10-01T12:00:00Z'))).toBe(true)

    // Existing catalogue identity is untouched; the new MPN starts at inventory 0.
    expect(await partRow('W11204517')).toMatchObject({ description: 'Control board', inventory_qty: 2 })
    expect(await partRow('DC4700019A')).toMatchObject({
      mpn: 'dc47-00019a',
      description: 'Heating element',
      inventory_qty: 0,
      cost_basis: null,
      new_price: null,
    })
  })

  it('keeps blanks null and stores 90-day sell-through only when supplied', async () => {
    await importCsv(csv(HEADER, 'P-1,Pump,,,,,4,,9,88,'))

    expect((await snapshotsFor('P-1')).map((row) => [row.period, row.sold_qty, row.price, row.sell_through_pct])).toEqual([
      ['30d', 4, null, null],
      ['90d', 9, '88.00', null],
    ])
    const [fact] = await facts(['P-1'])
    expect(fact?.sold90).toMatchObject({ soldQty: 9, avgSoldPrice: 88, avgBuyerShipping: null, sellThroughPct: null })
  })

  it('preserves New Price in its own field, never as cost basis, inventory or a sold price', async () => {
    await createPart({
      mpn: 'NP-1',
      description: 'Valve',
      inventoryQty: 3,
      costBasis: 12.5,
      shipCost: 4,
      targetMarginPct: 30,
    })
    const exportBefore = await (await fullExport()).text()

    const priceOnly = await importCsv(csv(HEADER, 'NP-1,Valve,,149.99,,,,,,,'))
    expect(priceOnly.body).toMatchObject({ sessions: 0, newPrices: 1 })
    expect(await partRow('NP1')).toMatchObject({
      new_price: '149.99',
      cost_basis: '12.50',
      ship_cost: '4.00',
      target_margin_pct: '30.00',
      inventory_qty: 3,
    })
    expect(await count('market_snapshots')).toBe(0)
    expect(await count('active_market_snapshots')).toBe(0)
    // Decision math and the full export do not read New Price.
    expect(await (await fullExport()).text()).toBe(exportBefore)

    await importCsv(csv(HEADER, 'NP-1,Valve,,,,,,,2,60,'))
    expect((await partRow('NP1'))?.new_price).toBe('149.99')
    expect((await snapshotsFor('NP-1')).map((row) => row.price)).toEqual(['60.00'])
    const [fact] = await facts(['NP-1'])
    expect(fact?.sold90?.avgSoldPrice).toBe(60)
  })

  it('keeps notes as text: Parts Engine donor counts never become inventory, New Price or market facts', async () => {
    await createPart({ mpn: 'W10-555', description: 'Pump', inventoryQty: 2 })
    const donorNote = 'Parts Engine: 7 donor machine(s) across 3 model(s); family pump; new $45.00'

    const contextOnly = await importCsv(
      csv(HEADER, `W10-555,Pump,"${donorNote}",,,,,,,,`, `W10-777,Motor,"${donorNote}",,,,,,,,`),
    )
    // Rows with no research values register MPNs but create no research session.
    expect(contextOnly.body).toMatchObject({ registered: 1, existing: 1, sessions: 0, windows: 0, newPrices: 0 })
    expect(await count('market_research_sessions')).toBe(0)
    expect(await count('market_snapshots')).toBe(0)
    expect(await partRow('W10555')).toMatchObject({ inventory_qty: 2, new_price: null, notes: null })
    expect(await partRow('W10777')).toMatchObject({ inventory_qty: 0, new_price: null, notes: null })

    await importCsv(csv(HEADER, `W10-555,Pump,"${donorNote}",,,,,,4,50,`))
    expect(await rows(`select notes from market_research_sessions`)).toEqual([{ notes: donorNote }])
    expect(await partRow('W10555')).toMatchObject({ inventory_qty: 2, new_price: null })
    const [fact] = await facts(['W10-555'])
    expect(fact?.sold90).toMatchObject({ soldQty: 4, avgSoldPrice: 50 })
  })

  it('a corrected re-import adds a newer session, leaves the earlier one intact, and market-facts serves it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'))
    await importCsv(csv(HEADER, 'W10-123,Pump,first pass,,,,,,5,80,40'))
    const firstWindows = await snapshotsFor('W10-123')

    vi.setSystemTime(new Date('2026-10-02T09:30:00Z'))
    const corrected = await importCsv(csv(HEADER, 'W10-123,Pump,corrected,,,,,,6,82.5,37.5'))
    expect(corrected.body).toMatchObject({ registered: 0, existing: 1, sessions: 1 })

    const sessions = await rows<{ id: number; notes: string; researched_at: Date }>(
      `select id, notes, researched_at from market_research_sessions order by id`,
    )
    expect(sessions.map((session) => [session.notes, session.researched_at.toISOString()])).toEqual([
      ['first pass', '2026-10-01T12:00:00.000Z'],
      ['corrected', '2026-10-02T09:30:00.000Z'],
    ])

    const allWindows = await snapshotsFor('W10-123')
    expect(allWindows).toHaveLength(2)
    expect(allWindows[0]).toEqual(firstWindows[0])
    expect(allWindows[1]).toMatchObject({ sold_qty: 6, price: '82.50', sell_through_pct: '37.50', research_session_id: sessions[1]?.id })

    const [fact] = await facts(['W10123'])
    expect(fact).toMatchObject({
      status: 'found',
      sold90: {
        soldQty: 6,
        avgSoldPrice: 82.5,
        sellThroughPct: 37.5,
        source: 'manual',
        priceBasis: 'sold',
        capturedAt: '2026-10-02T09:30:00.000Z',
      },
    })
  })

  it('rejects a file with any invalid row and writes nothing', async () => {
    const { status, body } = await importCsv(
      csv(HEADER, 'OK-1,Pump,,,,,,,4,50,', 'BAD-1,Motor,,,,,,,-4,50,'),
    )
    expect(status).toBe(422)
    expect(body.errorCount).toBe(1)
    expect(body.errors?.[0]).toContain('Line 3')
    for (const table of ['parts', 'market_research_sessions', 'market_snapshots']) {
      expect(await count(table)).toBe(0)
    }
  })

  it('requires a signed-in session', async () => {
    auth.signedIn = false
    expect((await importCsv(csv(HEADER, 'OK-1,Pump,,,,,,,4,50,'))).status).toBe(401)
    expect((await exportCsv()).status).toBe(401)
    expect(await count('parts')).toBe(0)
  })
})

describe('GET /api/research/shared-csv', () => {
  it('exports canonical headers with the latest manual values, blanks for unknown, and re-imports cleanly', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'))
    await importCsv(
      csv(
        HEADER,
        'A-1,"Pump, drain",older note,,1,10,,,,,',
        'B-2,Never researched,,,,,,,,,',
      ),
    )
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'))
    await importCsv(csv(HEADER, 'A-1,"Pump, drain",latest note,149.99,3,95.5,12,92,30,90.25,41.5'))

    // Automated rows and unknown-basis legacy rows are not manual sold research.
    const legacy = await createPart({ mpn: 'C-3', description: 'Legacy only' })
    await testDb.insert(marketSnapshots).values([
      { partId: legacy.id, period: '90d', price: '70.00', soldQty: 9, source: 'manual', priceBasis: 'unknown' },
      { partId: legacy.id, period: '90d', price: '75.00', soldQty: 11, source: 'ebay_insights', priceBasis: 'sold' },
    ])

    const first = await exportCsv()
    expect(first.status).toBe(200)
    expect(first.disposition).toContain('research-all-')
    expect(first.text.split('\r\n')[0]).toBe(HEADER)
    expect(parseCsv(first.text).slice(1)).toEqual([
      ['A-1', 'Pump, drain', 'latest note', '149.99', '3', '95.50', '12', '92.00', '30', '90.25', '41.50'],
      ['B-2', 'Never researched', '', '', '', '', '', '', '', '', ''],
      ['C-3', 'Legacy only', '', '', '', '', '', '', '', '', ''],
    ])

    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'))
    const reimport = await importCsv(first.text)
    expect(reimport.status).toBe(200)
    expect(reimport.body).toMatchObject({ rows: 3, registered: 0, existing: 3, sessions: 1, windows: 3, newPrices: 1 })

    const sessions = await rows<{ mpn: string; researched_at: Date }>(`
      select p.mpn, s.researched_at from market_research_sessions s
      join parts p on p.id = s.part_id order by s.id
    `)
    expect(sessions.map((session) => [session.mpn, session.researched_at.toISOString()])).toEqual([
      ['A-1', '2026-10-01T12:00:00.000Z'],
      ['A-1', '2026-10-03T12:00:00.000Z'],
      ['A-1', '2026-10-05T12:00:00.000Z'],
    ])
    expect((await exportCsv()).text).toBe(first.text)
  })

  it('scope=due exports the Research Queue default: in stock, never researched or stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'))
    const stale = await createPart({ mpn: 'STALE-1', description: 'Stale', inventoryQty: 1 })
    const current = await createPart({ mpn: 'CURRENT-1', description: 'Current', inventoryQty: 5 })
    await createPart({ mpn: 'NEVER-1', description: 'Never', inventoryQty: 2 })
    await createPart({ mpn: 'NEVER-2', description: 'Never, more stock', inventoryQty: 9 })
    await createPart({ mpn: 'EMPTY-1', description: 'No stock', inventoryQty: 0 })
    await saveMarketResearchSession({
      partId: stale.id,
      researchedAt: new Date('2026-08-01T00:00:00Z'),
      windows: [{ period: '90d', avgSoldPrice: 40, avgShipping: null, totalSold: 2 }],
    })
    await saveMarketResearchSession({
      partId: current.id,
      researchedAt: new Date('2026-10-09T00:00:00Z'),
      windows: [{ period: '90d', avgSoldPrice: 50, avgShipping: null, totalSold: 3 }],
    })

    const due = await exportCsv('?scope=due')
    expect(due.disposition).toContain('research-queue-')
    expect(parseCsv(due.text).slice(1).map((row) => [row[0], row[8], row[9]])).toEqual([
      ['NEVER-2', '', ''],
      ['NEVER-1', '', ''],
      ['STALE-1', '2', '40.00'],
    ])
  })

  it('leaves the full diagnostic export in place', async () => {
    await importCsv(csv(HEADER, 'A-1,Pump,,149.99,,,,,30,90,41.5'))
    const response = await fullExport()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('ebaydecisions-')
    const [header, row] = parseCsv(await response.text())
    expect(header?.slice(0, 10)).toEqual([
      'mpn',
      'description',
      'category',
      'inventory_qty',
      'cost_basis',
      'ship_cost',
      'target_margin_pct',
      'source_url',
      'notes',
      'active',
    ])
    expect(header).toContain('90d_sold_qty')
    expect(row?.[header!.indexOf('90d_sold_qty')]).toBe('30')
    expect(row?.[header!.indexOf('cost_basis')]).toBe('')
  })
})
