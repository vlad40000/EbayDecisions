import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { setDatabaseForTests } from '@/db/index'
import * as schema from '@/db/schema'
import {
  activeSnapshotHistory,
  createPart,
  deletePart,
  getPartWithMarket,
  getSettings,
  insertActiveSnapshots,
  insertSoldSnapshots,
  latestActiveSnapshots,
  latestSnapshots,
  listParts,
  listPartsWithMarket,
  loadTrendSummaries,
  saveManualMarket,
  snapshotHistory,
  updatePart,
  updateSettings,
  upsertPartByMpn,
} from '@/db/queries'
import { activeMarketSnapshots, marketSnapshots } from '@/db/schema'

const client = new PGlite()
const testDb = drizzle({ client, schema })
setDatabaseForTests(testDb)

function migrationFiles(): string[] {
  const dir = path.resolve(import.meta.dirname, '../drizzle')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(path.join(dir, name), 'utf8'))
}

async function applySql(sql: string) {
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (trimmed) await client.exec(trimmed)
  }
}

async function resetSchema() {
  await client.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  for (const sql of migrationFiles()) await applySql(sql)
}

beforeEach(resetSchema)
afterAll(async () => client.close())

describe('migrations', () => {
  it('apply cleanly and create the separated active-market table', async () => {
    const result = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema='public' order by table_name`,
    )
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'active_market_snapshots',
      'ebay_sync_runs',
      'market_snapshots',
      'parts',
      'settings',
    ])
  })

  it('migrates legacy Insights qty to sold_qty and Browse qty to active supply', async () => {
    const files = migrationFiles()
    await client.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    await applySql(files[0]!)
    await applySql(files[1]!)
    await client.exec(`insert into parts (mpn, description) values ('LEGACY-1','Board')`)
    const part = await client.query<{ id: number }>(`select id from parts where mpn='LEGACY-1'`)
    const id = part.rows[0]!.id
    await client.exec(`
      insert into market_snapshots (part_id, period, price, shipping, qty, source, sample_size)
      values
        (${id}, '30d', 100, 10, 8, 'ebay_insights', 8),
        (${id}, '7d', 90, 9, 14, 'ebay_browse', 14),
        (${id}, '1yr', 80, 8, 99, 'manual', null)
    `)
    await applySql(files[2]!)

    const sold = await client.query<{ source: string; sold_qty: number | null; legacy_qty: number | null; price_basis: string }>(
      `select source, sold_qty, legacy_qty, price_basis from market_snapshots order by period`,
    )
    expect(sold.rows.some((row) => row.source === 'ebay_insights' && row.sold_qty === 8 && row.price_basis === 'sold')).toBe(true)
    expect(sold.rows.some((row) => row.source === 'ebay_browse')).toBe(false)
    expect(sold.rows.some((row) => row.source === 'manual' && row.sold_qty == null && row.legacy_qty === 99)).toBe(true)

    const active = await client.query<{ active_qty: number | null; source: string }>(
      `select active_qty, source from active_market_snapshots`,
    )
    expect(active.rows).toEqual([{ active_qty: 14, source: 'ebay_browse' }])
  })
})

describe('settings and parts', () => {
  it('materializes settings defaults and enforces floor <= target', async () => {
    const settings = await getSettings()
    expect(settings.feePct).toBeCloseTo(13.25, 2)
    await expect(client.exec(`update settings set min_margin_pct=50,target_margin_pct=20 where id=1`)).rejects.toThrow()
  })

  it('updates only supplied settings', async () => {
    await getSettings()
    await updateSettings({ feePct: 12.9 })
    const after = await getSettings()
    expect(after.feePct).toBeCloseTo(12.9, 2)
    expect(after.targetMarginPct).toBeCloseTo(35, 2)
  })

  it('keeps zero cost basis distinct from missing cost basis', async () => {
    await createPart({ mpn: 'FREE-1', description: 'Salvaged board', costBasis: 0 })
    await createPart({ mpn: 'UNKNOWN-1', description: 'Unpriced board' })
    const parts = await listParts()
    expect(parts.find((part) => part.mpn === 'FREE-1')?.costBasis).toBe(0)
    expect(parts.find((part) => part.mpn === 'UNKNOWN-1')?.costBasis).toBeNull()
  })

  it('supports CRUD, inactive filtering, and MPN upsert', async () => {
    const first = await createPart({ mpn: 'P1', description: 'Board' })
    await updatePart(first.id, { active: false })
    expect(await listParts()).toHaveLength(0)
    expect(await listParts({ includeInactive: true })).toHaveLength(1)
    expect(await upsertPartByMpn({ mpn: 'P1', description: 'Updated Board', active: true })).toBe('updated')
    expect((await listParts())[0]?.description).toBe('Updated Board')
    await deletePart(first.id)
    expect(await listParts({ includeInactive: true })).toHaveLength(0)
  })
})

describe('separate sold and active market streams', () => {
  it('returns newest sold observation per window while preserving history', async () => {
    const part = await createPart({ mpn: 'S1', description: 'Board' })
    await insertSoldSnapshots([
      { partId: part.id, period: '7d', price: 100, shipping: 10, soldQty: 3, source: 'ebay_insights', sampleSize: 3 },
    ])
    await insertSoldSnapshots([
      { partId: part.id, period: '7d', price: 120, shipping: 12, soldQty: 5, source: 'ebay_insights', sampleSize: 5 },
    ])
    const latest = (await latestSnapshots([part.id])).get(part.id)?.['7d']
    expect(latest?.price).toBe(120)
    expect(latest?.soldQty).toBe(5)
    expect(latest?.priceBasis).toBe('sold')
    expect(await snapshotHistory(part.id)).toHaveLength(2)
  })

  it('stores active competition independently from sold demand', async () => {
    const part = await createPart({ mpn: 'A1', description: 'Board' })
    await insertSoldSnapshots([
      { partId: part.id, period: '30d', price: 100, shipping: 10, soldQty: 20, source: 'ebay_insights', sampleSize: 20 },
    ])
    await insertActiveSnapshots([
      { partId: part.id, askingPrice: 120, askingShipping: 12, activeQty: 7, sampleSize: 7, broadMatchCount: 10, mpnRejectedCount: 3, conditionRejectedCount: 0, truncated: false },
    ])
    const loaded = await getPartWithMarket('A1')
    expect(loaded?.periods['30d']?.soldQty).toBe(20)
    expect(loaded?.activeMarket?.activeQty).toBe(7)
    expect(loaded?.activeMarket?.askingPrice).toBe(120)
  })

  it('cascades both history streams when a part is deleted', async () => {
    const part = await createPart({ mpn: 'D1', description: 'Board' })
    await insertSoldSnapshots([{ partId: part.id, period: '7d', price: 10, shipping: 1, soldQty: 1, source: 'ebay_insights', sampleSize: 1 }])
    await insertActiveSnapshots([{ partId: part.id, askingPrice: 12, askingShipping: 1, activeQty: 2, sampleSize: 2, broadMatchCount: 2, mpnRejectedCount: 0, conditionRejectedCount: 0, truncated: false }])
    await deletePart(part.id)
    expect(await testDb.select().from(marketSnapshots)).toHaveLength(0)
    expect(await testDb.select().from(activeMarketSnapshots)).toHaveLength(0)
  })
})

describe('explicit Save MPN', () => {
  it('writes all touched windows and point-in-time active fields in one save boundary', async () => {
    const part = await createPart({ mpn: 'M1', description: 'Board' })
    const written = await saveManualMarket({
      partId: part.id,
      windows: [
        { period: '30d', price: 100, shipping: 10, soldQty: 20, priceBasis: 'sold' },
        { period: '7d', price: 105, soldQty: 8, priceBasis: 'sold' },
      ],
      active: { askingPrice: 120, askingShipping: 12, activeQty: 9 },
    })
    expect(written).toBe(3)
    expect(await snapshotHistory(part.id)).toHaveLength(2)
    expect(await activeSnapshotHistory(part.id)).toHaveLength(1)
  })

  it('preserves eBay preview provenance only when the preview is explicitly saved', async () => {
    const part = await createPart({ mpn: 'M-PREVIEW', description: 'Board' })
    await saveManualMarket({
      partId: part.id,
      windows: [],
      active: {
        askingPrice: 119,
        askingShipping: 11,
        activeQty: 7,
        source: 'ebay_browse',
        sampleSize: 9,
        broadMatchCount: 12,
        mpnRejectedCount: 3,
        conditionRejectedCount: 0,
        truncated: false,
      },
    })
    const history = await activeSnapshotHistory(part.id)
    expect(history).toHaveLength(1)
    expect(history[0]?.source).toBe('ebay_browse')
    expect(history[0]?.sampleSize).toBe(9)
    expect(history[0]?.mpnRejectedCount).toBe(3)
  })

  it('carries forward untouched live fields instead of overwriting them with stale browser state', async () => {
    const part = await createPart({ mpn: 'M2', description: 'Board' })
    await insertSoldSnapshots([{ partId: part.id, period: '7d', price: 100, shipping: 14, soldQty: 6, source: 'ebay_insights', sampleSize: 8 }])
    await saveManualMarket({ partId: part.id, windows: [{ period: '7d', price: 88 } ] })
    const latest = (await latestSnapshots([part.id])).get(part.id)?.['7d']
    expect(latest?.price).toBe(88)
    expect(latest?.shipping).toBe(14)
    expect(latest?.soldQty).toBe(6)
    expect(await snapshotHistory(part.id)).toHaveLength(2)
  })

  it('can explicitly clear a touched field with null', async () => {
    const part = await createPart({ mpn: 'M3', description: 'Board' })
    await saveManualMarket({ partId: part.id, windows: [{ period: '7d', price: 100, shipping: 10 }] })
    await saveManualMarket({ partId: part.id, windows: [{ period: '7d', shipping: null }] })
    const latest = (await latestSnapshots([part.id])).get(part.id)?.['7d']
    expect(latest?.price).toBe(100)
    expect(latest?.shipping).toBeNull()
  })

  it('does not write when there are no touched fields', async () => {
    const part = await createPart({ mpn: 'M4', description: 'Board' })
    expect(await saveManualMarket({ partId: part.id, windows: [] })).toBe(0)
    expect(await snapshotHistory(part.id)).toHaveLength(0)
  })
})

describe('historical summaries', () => {
  it('requires three distinct dates over at least 14 days and collapses same-day corrections', async () => {
    const part = await createPart({ mpn: 'H1', description: 'Board' })
    await testDb.insert(marketSnapshots).values([
      { partId: part.id, period: '30d', price: '120.00', shipping: '0.00', soldQty: 20, source: 'ebay_insights', priceBasis: 'sold', capturedAt: new Date('2026-09-01T08:00:00Z') },
      { partId: part.id, period: '30d', price: '118.00', shipping: '0.00', soldQty: 21, source: 'manual', priceBasis: 'sold', capturedAt: new Date('2026-09-01T16:00:00Z') },
      { partId: part.id, period: '30d', price: '110.00', shipping: '0.00', soldQty: 22, source: 'ebay_insights', priceBasis: 'sold', capturedAt: new Date('2026-09-15T12:00:00Z') },
      { partId: part.id, period: '30d', price: '100.00', shipping: '0.00', soldQty: 24, source: 'ebay_insights', priceBasis: 'sold', capturedAt: new Date('2026-09-29T12:00:00Z') },
    ])
    const summary = (await loadTrendSummaries([part.id])).get(part.id)!
    expect(summary.marketPoints).toBe(3)
    expect(summary.marketSpanDays).toBeGreaterThanOrEqual(28)
    expect(summary.marketPctPer30d).toBeLessThan(0)
    expect(summary.marketPeriod).toBe('30d')
  })

  it('computes demand history from sold units per day', async () => {
    const part = await createPart({ mpn: 'H2', description: 'Board' })
    await testDb.insert(marketSnapshots).values([
      { partId: part.id, period: '30d', soldQty: 9, source: 'ebay_insights', priceBasis: 'sold', capturedAt: new Date('2026-09-01T12:00:00Z') },
      { partId: part.id, period: '30d', soldQty: 15, source: 'ebay_insights', priceBasis: 'sold', capturedAt: new Date('2026-09-15T12:00:00Z') },
      { partId: part.id, period: '30d', soldQty: 24, source: 'ebay_insights', priceBasis: 'sold', capturedAt: new Date('2026-09-29T12:00:00Z') },
    ])
    const summary = (await loadTrendSummaries([part.id])).get(part.id)!
    expect(summary.demandPoints).toBe(3)
    expect(summary.demandPctPer30d).toBeGreaterThan(0)
  })

  it('derives supply only from point-in-time active snapshots', async () => {
    const part = await createPart({ mpn: 'H3', description: 'Board' })
    await testDb.insert(activeMarketSnapshots).values([
      { partId: part.id, activeQty: 8, source: 'ebay_browse', capturedAt: new Date('2026-09-01T12:00:00Z') },
      { partId: part.id, activeQty: 12, source: 'ebay_browse', capturedAt: new Date('2026-09-15T12:00:00Z') },
      { partId: part.id, activeQty: 18, source: 'ebay_browse', capturedAt: new Date('2026-09-29T12:00:00Z') },
    ])
    const summary = (await loadTrendSummaries([part.id])).get(part.id)!
    expect(summary.supplyPoints).toBe(3)
    expect(summary.supplyPctPer30d).toBeGreaterThan(0)
    expect(summary.demandPoints).toBe(0)
  })
})

describe('constraints', () => {
  it('rejects negative sold and active quantities', async () => {
    const part = await createPart({ mpn: 'X1', description: 'Board' })
    await expect(client.exec(`insert into market_snapshots (part_id,period,sold_qty) values (${part.id},'7d',-1)`)).rejects.toThrow()
    await expect(client.exec(`insert into active_market_snapshots (part_id,active_qty) values (${part.id},-1)`)).rejects.toThrow()
  })

  it('attaches both latest market streams to list results', async () => {
    const part = await createPart({ mpn: 'L1', description: 'Board' })
    await insertSoldSnapshots([{ partId: part.id, period: '7d', price: 50, shipping: 5, soldQty: 4, source: 'ebay_insights', sampleSize: 4 }])
    await insertActiveSnapshots([{ partId: part.id, askingPrice: 60, askingShipping: 6, activeQty: 9, sampleSize: 9, broadMatchCount: 12, mpnRejectedCount: 3, conditionRejectedCount: 0, truncated: false }])
    const listed = await listPartsWithMarket()
    expect(listed[0]?.periods['7d']?.soldQty).toBe(4)
    expect(listed[0]?.activeMarket?.activeQty).toBe(9)
    expect((await latestActiveSnapshots([part.id])).get(part.id)?.activeQty).toBe(9)
  })
})
