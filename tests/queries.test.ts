/**
 * Integration tests for the query layer, against a real Postgres.
 *
 * PGlite is Postgres compiled to WebAssembly, running in-process — so the
 * `DISTINCT ON` read path, the enum columns, the cascade delete and the
 * snapshot-coalescing logic are executed by an actual Postgres planner rather
 * than asserted about in the abstract. The schema comes from the same generated
 * migration that will run against Neon, which means these tests also prove the
 * migration applies cleanly.
 */
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { setDatabaseForTests } from '@/db/index'
import * as schema from '@/db/schema'
import {
  createPart,
  deletePart,
  getPartWithMarket,
  getSettings,
  insertSnapshots,
  latestSnapshots,
  listParts,
  listPartsWithMarket,
  saveManualSnapshot,
  snapshotHistory,
  updatePart,
  updateSettings,
  upsertPartByMpn,
} from '@/db/queries'
import { marketSnapshots } from '@/db/schema'

const client = new PGlite()
const testDb = drizzle({ client, schema })

setDatabaseForTests(testDb)

function migrationSql(): string {
  const dir = path.resolve(import.meta.dirname, '../drizzle')
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  return files.map((name) => readFileSync(path.join(dir, name), 'utf8')).join('\n')
}

async function resetSchema() {
  await client.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  for (const statement of migrationSql().split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (trimmed) await client.exec(trimmed)
  }
}

beforeEach(async () => {
  await resetSchema()
})

afterAll(async () => {
  await client.close()
})

describe('the generated migration', () => {
  it('applies cleanly and creates every table', async () => {
    const result = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    )
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'ebay_sync_runs',
      'market_snapshots',
      'parts',
      'settings',
    ])
  })

  it('creates the index the latest-per-window read depends on', async () => {
    const result = await client.query<{ indexname: string }>(
      `select indexname from pg_indexes where tablename = 'market_snapshots'`,
    )
    expect(result.rows.map((row) => row.indexname)).toContain(
      'snapshots_part_period_captured_idx',
    )
  })
})

describe('settings', () => {
  it('materialises the row with defaults on first read', async () => {
    const settings = await getSettings()
    expect(settings.feePct).toBeCloseTo(13.25, 2)
    expect(settings.targetMarginPct).toBeCloseTo(35, 2)

    const rows = await client.query<{ count: string }>('select count(*) from settings')
    expect(Number(rows.rows[0]?.count)).toBe(1)
  })

  it('updates only the fields it is given', async () => {
    await getSettings()
    await updateSettings({ feePct: 12.9 })
    const after = await getSettings()

    expect(after.feePct).toBeCloseTo(12.9, 2)
    // Untouched fields keep their values.
    expect(after.targetMarginPct).toBeCloseTo(35, 2)
    expect(after.defaultShipCost).toBeCloseTo(12, 2)
  })

  it('stays a single row no matter how often it is written', async () => {
    await updateSettings({ feePct: 11 })
    await updateSettings({ feePct: 12 })
    await updateSettings({ minMarginPct: 20 })

    const rows = await client.query<{ count: string }>('select count(*) from settings')
    expect(Number(rows.rows[0]?.count)).toBe(1)

    const settings = await getSettings()
    expect(settings.feePct).toBeCloseTo(12, 2)
    expect(settings.minMarginPct).toBeCloseTo(20, 2)
  })
})

describe('parts', () => {
  it('round-trips money columns as numbers, not strings', async () => {
    const created = await createPart({
      mpn: 'W11170706',
      description: 'Washer Control Board',
      inventoryQty: 2,
      costBasis: 41.5,
      shipCost: 13.25,
    })

    expect(created.costBasis).toBe(41.5)
    expect(created.shipCost).toBe(13.25)
    expect(typeof created.costBasis).toBe('number')
  })

  it('keeps a zero cost basis distinct from a missing one', async () => {
    await createPart({ mpn: 'FREE-1', description: 'Salvaged board', costBasis: 0 })
    await createPart({ mpn: 'UNKNOWN-1', description: 'Unpriced board' })

    const parts = await listParts()
    const free = parts.find((part) => part.mpn === 'FREE-1')
    const unknown = parts.find((part) => part.mpn === 'UNKNOWN-1')

    expect(free?.costBasis).toBe(0)
    expect(unknown?.costBasis).toBeNull()
  })

  it('derives a category from the description and lets a stored one win', async () => {
    await createPart({ mpn: 'G-1', description: 'Freezer Door Gasket' })
    await createPart({ mpn: 'G-2', description: 'Freezer Door Gasket', category: 'Other' })

    const parts = await listParts()
    expect(parts.find((part) => part.mpn === 'G-1')?.category).toBe('Door Gaskets')
    expect(parts.find((part) => part.mpn === 'G-2')?.category).toBe('Other')
  })

  it('upserts on MPN instead of duplicating', async () => {
    expect(await upsertPartByMpn({ mpn: 'W1', description: 'First' })).toBe('inserted')
    expect(await upsertPartByMpn({ mpn: 'W1', description: 'Second', costBasis: 20 })).toBe(
      'updated',
    )

    const parts = await listParts()
    expect(parts).toHaveLength(1)
    expect(parts[0]?.description).toBe('Second')
    expect(parts[0]?.costBasis).toBe(20)
  })

  it('hides inactive parts unless asked for them', async () => {
    const part = await createPart({ mpn: 'A1', description: 'Active' })
    await createPart({ mpn: 'A2', description: 'Also active' })
    await updatePart(part.id, { active: false })

    expect(await listParts()).toHaveLength(1)
    expect(await listParts({ includeInactive: true })).toHaveLength(2)
  })

  it('cascades a delete to that part history', async () => {
    const part = await createPart({ mpn: 'D1', description: 'Doomed' })
    await insertSnapshots([
      { partId: part.id, period: '7d', price: 10, shipping: 1, qty: 1, source: 'manual', sampleSize: null },
    ])
    expect(await snapshotHistory(part.id)).toHaveLength(1)

    await deletePart(part.id)

    const remaining = await testDb.select().from(marketSnapshots)
    expect(remaining).toHaveLength(0)
  })
})

describe('latestSnapshots', () => {
  it('returns the newest reading per window, not the first', async () => {
    const part = await createPart({ mpn: 'L1', description: 'Board' })

    await insertSnapshots([
      { partId: part.id, period: '7d', price: 100, shipping: 10, qty: 3, source: 'manual', sampleSize: null },
    ])
    // A later reading for the same window must win.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await insertSnapshots([
      { partId: part.id, period: '7d', price: 120, shipping: 12, qty: 5, source: 'ebay_insights', sampleSize: 9 },
    ])

    const map = await latestSnapshots([part.id])
    const latest = map.get(part.id)?.['7d']

    expect(latest?.price).toBe(120)
    expect(latest?.source).toBe('ebay_insights')
    expect(latest?.sampleSize).toBe(9)

    // Both readings are still on file — nothing was overwritten.
    expect(await snapshotHistory(part.id)).toHaveLength(2)
  })

  it('keeps each window independent', async () => {
    const part = await createPart({ mpn: 'L2', description: 'Board' })
    await insertSnapshots([
      { partId: part.id, period: '1yr', price: 80, shipping: 10, qty: 2, source: 'manual', sampleSize: null },
      { partId: part.id, period: '30d', price: 95, shipping: 11, qty: 3, source: 'manual', sampleSize: null },
      { partId: part.id, period: '7d', price: 100, shipping: 12, qty: 4, source: 'manual', sampleSize: null },
    ])

    const periods = (await latestSnapshots([part.id])).get(part.id)
    expect(periods?.['1yr']?.price).toBe(80)
    expect(periods?.['30d']?.price).toBe(95)
    expect(periods?.['7d']?.price).toBe(100)
    expect(periods?.['6m']).toBeUndefined()
    expect(periods?.['90d']).toBeUndefined()
  })

  it('separates readings by part', async () => {
    const a = await createPart({ mpn: 'P-A', description: 'A' })
    const b = await createPart({ mpn: 'P-B', description: 'B' })

    await insertSnapshots([
      { partId: a.id, period: '7d', price: 10, shipping: 1, qty: 1, source: 'manual', sampleSize: null },
      { partId: b.id, period: '7d', price: 20, shipping: 2, qty: 2, source: 'manual', sampleSize: null },
    ])

    const map = await latestSnapshots([a.id, b.id])
    expect(map.get(a.id)?.['7d']?.price).toBe(10)
    expect(map.get(b.id)?.['7d']?.price).toBe(20)
  })

  it('answers an empty part list without querying', async () => {
    expect((await latestSnapshots([])).size).toBe(0)
  })
})

describe('saveManualSnapshot', () => {
  it('creates a row on first edit', async () => {
    const part = await createPart({ mpn: 'M1', description: 'Board' })
    await saveManualSnapshot(part.id, '30d', { price: 99.5 })

    const history = await snapshotHistory(part.id)
    expect(history).toHaveLength(1)
    expect(history[0]?.price).toBe('99.50')
    expect(history[0]?.source).toBe('manual')
  })

  it('coalesces a burst of edits into one row', async () => {
    const part = await createPart({ mpn: 'M2', description: 'Board' })

    // Typing price, then shipping, then qty into the same window.
    await saveManualSnapshot(part.id, '30d', { price: 99.5 })
    await saveManualSnapshot(part.id, '30d', { shipping: 12 })
    await saveManualSnapshot(part.id, '30d', { qty: 4 })

    const history = await snapshotHistory(part.id)
    expect(history).toHaveLength(1)

    const periods = (await latestSnapshots([part.id])).get(part.id)
    expect(periods?.['30d']?.price).toBe(99.5)
    expect(periods?.['30d']?.shipping).toBe(12)
    expect(periods?.['30d']?.qty).toBe(4)
  })

  it('carries forward untouched fields when appending after a sync', async () => {
    const part = await createPart({ mpn: 'M3', description: 'Board' })

    await insertSnapshots([
      { partId: part.id, period: '7d', price: 100, shipping: 14, qty: 6, source: 'ebay_insights', sampleSize: 8 },
    ])

    // Correcting only the price must not blank the shipping beside it.
    await saveManualSnapshot(part.id, '7d', { price: 88 })

    const periods = (await latestSnapshots([part.id])).get(part.id)
    expect(periods?.['7d']?.price).toBe(88)
    expect(periods?.['7d']?.shipping).toBe(14)
    expect(periods?.['7d']?.qty).toBe(6)
    // A person set it, so the row is manual, and the eBay reading survives.
    expect(periods?.['7d']?.source).toBe('manual')
    expect(await snapshotHistory(part.id)).toHaveLength(2)
  })

  it('appends rather than coalescing once the edit window has passed', async () => {
    const part = await createPart({ mpn: 'M4', description: 'Board' })
    await saveManualSnapshot(part.id, '7d', { price: 100 })

    // Backdate the row past the coalescing window.
    await client.exec(
      `update market_snapshots set captured_at = now() - interval '2 hours' where part_id = ${part.id}`,
    )

    await saveManualSnapshot(part.id, '7d', { price: 110 })

    const history = await snapshotHistory(part.id)
    expect(history).toHaveLength(2)
    expect((await latestSnapshots([part.id])).get(part.id)?.['7d']?.price).toBe(110)
  })

  it('clears a field when given null', async () => {
    const part = await createPart({ mpn: 'M5', description: 'Board' })
    await saveManualSnapshot(part.id, '7d', { price: 100, shipping: 10 })
    await saveManualSnapshot(part.id, '7d', { shipping: null })

    const periods = (await latestSnapshots([part.id])).get(part.id)
    expect(periods?.['7d']?.price).toBe(100)
    expect(periods?.['7d']?.shipping).toBeNull()
  })
})

describe('listPartsWithMarket', () => {
  it('attaches each part readings and leaves bare parts empty', async () => {
    const withData = await createPart({ mpn: 'W-1', description: 'Board', costBasis: 30 })
    await createPart({ mpn: 'W-2', description: 'Gasket' })

    await insertSnapshots([
      { partId: withData.id, period: '7d', price: 100, shipping: 12, qty: 3, source: 'ebay_insights', sampleSize: 4 },
    ])

    const parts = await listPartsWithMarket()
    expect(parts).toHaveLength(2)

    const first = parts.find((part) => part.mpn === 'W-1')
    const second = parts.find((part) => part.mpn === 'W-2')

    expect(first?.periods['7d']?.price).toBe(100)
    expect(Object.keys(second?.periods ?? {})).toHaveLength(0)
  })

  it('finds one part with its market by MPN', async () => {
    const part = await createPart({ mpn: 'W11122852', description: 'Oven Display Board' })
    await insertSnapshots([
      { partId: part.id, period: '90d', price: 75.25, shipping: 9.99, qty: 2, source: 'manual', sampleSize: null },
    ])

    const loaded = await getPartWithMarket('W11122852')
    expect(loaded?.periods['90d']?.price).toBe(75.25)
    expect(loaded?.periods['90d']?.shipping).toBe(9.99)

    expect(await getPartWithMarket('NOPE')).toBeNull()
  })
})
