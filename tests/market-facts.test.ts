import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST } from '@/app/api/integrations/market-facts/route'
import { setDatabaseForTests } from '@/db/index'
import * as schema from '@/db/schema'
import {
  createPart,
  getPartByMpn,
  listParts,
  listTrackerResearchParts,
  saveMarketResearchSession,
  updatePart,
  upsertPartByMpn,
} from '@/db/queries'
import { activeMarketSnapshots, marketSnapshots } from '@/db/schema'
import type { MarketFactsEnvelopeV1 } from '@/lib/market-facts'

const client = new PGlite()
const testDb = drizzle({ client, schema })
setDatabaseForTests(testDb)

const KEY = 'integration-test-key-0123456789'

function migrationFiles(): string[] {
  const dir = path.resolve(import.meta.dirname, '../drizzle')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(path.join(dir, name), 'utf8'))
}

function statements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean)
}

async function applySql(sql: string) {
  for (const statement of statements(sql)) await client.exec(statement)
}

/** Applies one migration in a transaction, as the migrator does. */
async function applyMigrationAtomically(sql: string) {
  await client.exec('BEGIN')
  try {
    for (const statement of statements(sql)) await client.exec(statement)
    await client.exec('COMMIT')
  } catch (error) {
    await client.exec('ROLLBACK')
    throw error
  }
}

async function migrateThrough(lastIndex: number) {
  await client.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  for (const sql of migrationFiles().slice(0, lastIndex + 1)) await applySql(sql)
}

const MPN_KEY_MIGRATION = 4

beforeEach(async () => {
  await migrateThrough(migrationFiles().length - 1)
  process.env.INTEGRATION_API_KEY = KEY
})
afterEach(() => {
  delete process.env.INTEGRATION_API_KEY
  vi.restoreAllMocks()
})
afterAll(async () => client.close())

function call(body: unknown, authorization: string | null = `Bearer ${KEY}`) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authorization != null) headers.authorization = authorization
  return POST(
    new Request('https://ebd.example/api/integrations/market-facts', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

async function facts(mpns: string[]) {
  const response = await call({ mpns })
  expect(response.status).toBe(200)
  return (await response.json()) as MarketFactsEnvelopeV1
}

async function dumpState(): Promise<string> {
  const tables = ['parts', 'market_research_sessions', 'market_snapshots', 'active_market_snapshots', 'settings', 'ebay_sync_runs']
  const out: Record<string, unknown> = {}
  for (const table of tables) {
    out[table] = (await client.query(`select * from ${table} order by 1`)).rows
  }
  return JSON.stringify(out)
}

describe('0004 parts.mpn_key migration', () => {
  it('refuses existing raw MPNs that collapse to one D1 key, and changes nothing', async () => {
    await migrateThrough(MPN_KEY_MIGRATION - 1)
    await client.exec(`
      insert into parts (mpn, description) values
        ('DC47-00019A', 'Thermal fuse'),
        ('dc47 00019a', 'Thermal fuse duplicate'),
        ('W10830046', 'Gasket')
    `)

    await expect(applyMigrationAtomically(migrationFiles()[MPN_KEY_MIGRATION]!)).rejects.toThrow(
      "existing MPNs collapse to the same D1 key and must be resolved by hand: DC4700019A <- id 1 'DC47-00019A', id 2 'dc47 00019a'",
    )

    const rows = await client.query<{ id: number; mpn: string }>(`select id, mpn from parts order by id`)
    expect(rows.rows).toEqual([
      { id: 1, mpn: 'DC47-00019A' },
      { id: 2, mpn: 'dc47 00019a' },
      { id: 3, mpn: 'W10830046' },
    ])
    const column = await client.query(
      `select 1 from information_schema.columns where table_name='parts' and column_name='mpn_key'`,
    )
    expect(column.rows).toHaveLength(0)
  })

  it('refuses existing MPNs that have no letters or digits', async () => {
    await migrateThrough(MPN_KEY_MIGRATION - 1)
    await client.exec(`insert into parts (mpn, description) values ('--', 'Junk row')`)
    await expect(applyMigrationAtomically(migrationFiles()[MPN_KEY_MIGRATION]!)).rejects.toThrow(
      "no A-Z/0-9 characters: id 1 '--'",
    )
  })

  it('backfills a clean catalogue and then enforces one non-blank key per part', async () => {
    await migrateThrough(MPN_KEY_MIGRATION - 1)
    await client.exec(`
      insert into parts (mpn, description) values
        ('dc47-00019a', 'Thermal fuse'),
        (' W10830046 ', 'Gasket'),
        ('DC47-00019B', 'Superseding fuse')
    `)
    await applyMigrationAtomically(migrationFiles()[MPN_KEY_MIGRATION]!)

    const rows = await client.query<{ mpn: string; mpn_key: string }>(`select mpn, mpn_key from parts order by id`)
    expect(rows.rows).toEqual([
      { mpn: 'dc47-00019a', mpn_key: 'DC4700019A' },
      { mpn: ' W10830046 ', mpn_key: 'W10830046' },
      { mpn: 'DC47-00019B', mpn_key: 'DC4700019B' },
    ])

    await expect(
      client.exec(`insert into parts (mpn, mpn_key, description) values ('DC47/00019A', 'DC4700019A', 'x')`),
    ).rejects.toThrow(/parts_mpn_key_unique/)
    await expect(
      client.exec(`insert into parts (mpn, mpn_key, description) values ('--', '', 'x')`),
    ).rejects.toThrow(/parts_mpn_key_nonblank/)
    await expect(client.exec(`insert into parts (mpn, description) values ('NEW-1', 'x')`)).rejects.toThrow(
      /null value in column "mpn_key"/,
    )
  })
})

describe('part identity uses the D1 key', () => {
  it('re-import of a spelling variant updates the same part and keeps its display MPN', async () => {
    expect(await upsertPartByMpn({ mpn: 'DC47-00019A', description: 'Thermal fuse', inventoryQty: 1 })).toBe('inserted')
    expect(await upsertPartByMpn({ mpn: 'dc47 00019a', description: 'Thermal fuse (updated)', inventoryQty: 4 })).toBe(
      'updated',
    )

    const all = await listParts({ includeInactive: true })
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ mpn: 'DC47-00019A', description: 'Thermal fuse (updated)', inventoryQty: 4 })

    const stored = await client.query<{ mpn_key: string }>(`select mpn_key from parts`)
    expect(stored.rows).toEqual([{ mpn_key: 'DC4700019A' }])
  })

  it('keeps superseding MPNs as separate parts', async () => {
    await upsertPartByMpn({ mpn: 'DC47-00019A', description: 'Fuse' })
    expect(await upsertPartByMpn({ mpn: 'DC47-00019B', description: 'Superseding fuse' })).toBe('inserted')
    expect(await listParts()).toHaveLength(2)
  })

  it('finds a part by any spelling and blocks a second identity for the same key', async () => {
    const part = await createPart({ mpn: 'DC47-00019A', description: 'Fuse' })
    expect((await getPartByMpn('dc47/00019a'))?.id).toBe(part.id)
    expect(await getPartByMpn('---')).toBeNull()
    await expect(createPart({ mpn: 'dc47 00019a', description: 'Dup' })).rejects.toThrow()
    await expect(createPart({ mpn: '---', description: 'Junk' })).rejects.toThrow('has no letters or digits')
  })

  it('keeps mpn_key in step when the display MPN is edited', async () => {
    const part = await createPart({ mpn: 'OLD-1', description: 'Board' })
    await updatePart(part.id, { mpn: 'new-2' })
    expect((await getPartByMpn('NEW2'))?.mpn).toBe('new-2')
    expect(await getPartByMpn('OLD-1')).toBeNull()
  })

  it('matches Tracker working sets by key', async () => {
    await createPart({ mpn: 'DC47-00019A', description: 'Fuse', inventoryQty: 1 })
    const result = await listTrackerResearchParts({ mpns: ['dc47 00019a'] })
    expect(result.rows.map((row) => row.mpn)).toEqual(['DC47-00019A'])
  })
})

describe('POST /api/integrations/market-facts', () => {
  it('rejects a missing or wrong API key with 401', async () => {
    expect((await call({ mpns: ['W1'] }, null)).status).toBe(401)
    expect((await call({ mpns: ['W1'] }, 'Bearer nope')).status).toBe(401)
    expect((await call({ mpns: ['W1'] }, `Basic ${KEY}`)).status).toBe(401)
  })

  it('answers 503, not data, when INTEGRATION_API_KEY is not configured', async () => {
    await createPart({ mpn: 'W1', description: 'Board' })
    delete process.env.INTEGRATION_API_KEY
    const response = await call({ mpns: ['W1'] })
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).not.toContain('W1')
  })

  it('rejects malformed and oversized requests with 400', async () => {
    expect((await call('not json')).status).toBe(400)
    expect((await call({ mpn: 'W1' })).status).toBe(400)
    expect((await call({ mpns: Array.from({ length: 101 }, (_, i) => `P${i}`) })).status).toBe(400)
  })

  it('returns the v1 envelope with only the requested MPNs, in request order', async () => {
    await createPart({ mpn: 'A-1', description: 'A' })
    await createPart({ mpn: 'B-2', description: 'B' })
    await createPart({ mpn: 'C-3', description: 'C' })

    const body = await facts(['c3', 'A-1'])
    expect(body.schemaVersion).toBe(1)
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false)
    expect(body.facts.map((fact) => [fact.mpnKey, fact.mpnDisplay, fact.status])).toEqual([
      ['C3', 'C-3', 'found'],
      ['A1', 'A-1', 'found'],
    ])
  })

  it('dedupes equivalent spellings and drops blank keys', async () => {
    await createPart({ mpn: 'DC47-00019A', description: 'Fuse' })
    const body = await facts(['DC47-00019A', 'dc47 00019a', 'DC47/00019A', '---', ''])
    expect(body.facts).toHaveLength(1)
    expect(body.facts[0]).toMatchObject({ mpnKey: 'DC4700019A', mpnDisplay: 'DC47-00019A', status: 'found' })
  })

  it('reports unknown MPNs as unregistered without registering them', async () => {
    const body = await facts(['W11567368'])
    expect(body.facts).toEqual([
      { mpnKey: 'W11567368', mpnDisplay: null, status: 'unregistered', sold90: null, active: null },
    ])
    expect(await listParts({ includeInactive: true })).toHaveLength(0)
  })

  it('reports a known MPN with no saved facts as found with null streams', async () => {
    await createPart({ mpn: 'W1', description: 'Board', active: false })
    const body = await facts(['W1'])
    expect(body.facts).toEqual([{ mpnKey: 'W1', mpnDisplay: 'W1', status: 'found', sold90: null, active: null }])
  })

  it('takes sold90 only from the newest 90d snapshot', async () => {
    const part = await createPart({ mpn: 'S-90', description: 'Board' })
    await testDb.insert(marketSnapshots).values([
      { partId: part.id, period: '90d', price: '50.00', shipping: '5.00', soldQty: 3, sellThroughPct: '20.00', source: 'manual', priceBasis: 'sold', capturedAt: new Date('2026-01-01T00:00:00Z') },
      { partId: part.id, period: '90d', price: '60.00', shipping: '9.50', soldQty: 7, sellThroughPct: '41.25', source: 'ebay_insights', priceBasis: 'sold', capturedAt: new Date('2026-03-01T00:00:00Z') },
      { partId: part.id, period: '30d', price: '999.00', shipping: '99.00', soldQty: 99, sellThroughPct: '99.00', source: 'manual', priceBasis: 'sold', capturedAt: new Date('2026-04-01T00:00:00Z') },
      { partId: part.id, period: '1yr', price: '1.00', shipping: '1.00', soldQty: 500, source: 'manual', priceBasis: 'sold', capturedAt: new Date('2026-05-01T00:00:00Z') },
    ])

    const [fact] = (await facts(['S90'])).facts
    expect(fact?.sold90).toEqual({
      soldQty: 7,
      avgSoldPrice: 60,
      avgBuyerShipping: 9.5,
      sellThroughPct: 41.25,
      source: 'ebay_insights',
      priceBasis: 'sold',
      capturedAt: '2026-03-01T00:00:00.000Z',
    })
    expect(fact?.active).toBeNull()
  })

  it('takes active only from the newest active snapshot', async () => {
    const part = await createPart({ mpn: 'ACT-1', description: 'Board' })
    await testDb.insert(activeMarketSnapshots).values([
      { partId: part.id, activeQty: 10, askingPrice: '80.00', askingShipping: '0.00', source: 'manual', sampleSize: 10, truncated: false, capturedAt: new Date('2026-01-01T00:00:00Z') },
      { partId: part.id, activeQty: 40, askingPrice: '75.00', askingShipping: '12.00', source: 'ebay_browse', sampleSize: 25, truncated: true, capturedAt: new Date('2026-02-01T00:00:00Z') },
    ])

    const [fact] = (await facts(['ACT1'])).facts
    expect(fact?.active).toEqual({
      activeQty: 40,
      askingPrice: 75,
      askingShipping: 12,
      source: 'ebay_browse',
      sampleSize: 25,
      truncated: true,
      capturedAt: '2026-02-01T00:00:00.000Z',
    })
    expect(fact?.sold90).toBeNull()
  })

  it('returns sell-through exactly as stored, null when absent, and never derives it', async () => {
    const part = await createPart({ mpn: 'QTY-1', description: 'Board' })
    await saveMarketResearchSession({
      partId: part.id,
      researchedAt: new Date('2026-03-01T00:00:00Z'),
      windows: [{ period: '90d', avgSoldPrice: 45, avgShipping: null, totalSold: 5 }],
    })
    await testDb.insert(activeMarketSnapshots).values({
      partId: part.id, activeQty: 40, askingPrice: '70.00', askingShipping: null, source: 'ebay_browse', truncated: false,
    })

    const [fact] = (await facts(['QTY-1'])).facts
    // soldQty is 90d sold units and activeQty is active listings; neither
    // feeds the other, and 5/40 is not turned into a sell-through figure.
    expect(fact?.sold90?.soldQty).toBe(5)
    expect(fact?.active?.activeQty).toBe(40)
    expect(fact?.sold90?.sellThroughPct).toBeNull()
    expect(fact?.sold90?.avgBuyerShipping).toBeNull()
    expect(fact?.sold90?.avgSoldPrice).toBe(45)
    expect(fact?.active?.askingPrice).toBe(70)
    expect(fact?.active?.askingShipping).toBeNull()

    await saveMarketResearchSession({
      partId: part.id,
      researchedAt: new Date('2026-04-01T00:00:00Z'),
      windows: [{ period: '90d', avgSoldPrice: 46, avgShipping: 0, totalSold: 0, sellThroughPct: 312.5 }],
    })
    const [later] = (await facts(['QTY-1'])).facts
    expect(later?.sold90).toMatchObject({ soldQty: 0, avgBuyerShipping: 0, sellThroughPct: 312.5 })
  })

  it('is zero-write: no part, session, snapshot, or settings changes and no eBay calls', async () => {
    const part = await createPart({ mpn: 'ZW-1', description: 'Board' })
    await saveMarketResearchSession({
      partId: part.id,
      windows: [{ period: '90d', avgSoldPrice: 10, avgShipping: 1, totalSold: 2, sellThroughPct: 15 }],
    })
    await testDb.insert(activeMarketSnapshots).values({ partId: part.id, activeQty: 3, source: 'manual', truncated: false })

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const before = await dumpState()

    const response = await call({ mpns: ['ZW-1', 'zw1', 'UNKNOWN-9', 'W11567368'] })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')

    expect(await dumpState()).toBe(before)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
