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
  listMarketOpportunities,
  listParts,
  listPartsWithMarketForMpns,
  listResearchQueue,
  listPartsWithMarket,
  loadTrendSummaries,
  researchSessionHistory,
  saveManualMarket,
  saveMarketResearchSession,
  snapshotHistory,
  updatePart,
  updateSettings,
  upsertPartByMpn,
} from '@/db/queries'
import { activeMarketSnapshots, marketResearchSessions, marketSnapshots } from '@/db/schema'

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
      'market_research_sessions',
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
    await applySql(files[3]!)

    const sold = await client.query<{ source: string; sold_qty: number | null; legacy_qty: number | null; price_basis: string; research_session_id: number | null }>(
      `select source, sold_qty, legacy_qty, price_basis, research_session_id from market_snapshots order by period`,
    )
    expect(sold.rows.some((row) => row.source === 'ebay_insights' && row.sold_qty === 8 && row.price_basis === 'sold')).toBe(true)
    expect(sold.rows.some((row) => row.source === 'ebay_browse')).toBe(false)
    expect(sold.rows.some((row) => row.source === 'manual' && row.sold_qty == null && row.legacy_qty === 99)).toBe(true)
    expect(sold.rows.every((row) => row.research_session_id == null)).toBe(true)

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

describe('Market Opportunities query', () => {
  it('paginates the catalogue in Postgres instead of returning the whole set', async () => {
    await testDb.insert(schema.parts).values(
      Array.from({ length: 55 }, (_, index) => ({
        mpn: `PART-${String(index + 1).padStart(3, '0')}`,
        description: 'Control Board',
        inventoryQty: 1,
      })),
    )

    const result = await listMarketOpportunities({
      page: 2,
      pageSize: 20,
      sort: 'mpn',
      direction: 'asc',
    })

    expect(result.total).toBe(55)
    expect(result.rows).toHaveLength(20)
    expect(result.rows[0]?.mpn).toBe('PART-021')
    expect(result.rows[19]?.mpn).toBe('PART-040')
  })

  it('searches exact MPNs at the database layer', async () => {
    await testDb.insert(schema.parts).values([
      { mpn: 'W10830046', description: 'Refrigerator Door Gasket', inventoryQty: 1 },
      { mpn: 'W10634026', description: 'Washer Control Board', inventoryQty: 1 },
    ])

    const result = await listMarketOpportunities({ query: 'W10830046' })
    expect(result.total).toBe(1)
    expect(result.rows.map((row) => row.mpn)).toEqual(['W10830046'])
  })

  it('filters by inventory, 30d sold activity, 30d average sold price, and research freshness', async () => {
    const strong = await createPart({
      mpn: 'STRONG-1',
      description: 'Board',
      inventoryQty: 3,
    })
    const weak = await createPart({
      mpn: 'WEAK-1',
      description: 'Board',
      inventoryQty: 2,
    })
    await createPart({
      mpn: 'EMPTY-1',
      description: 'Board',
      inventoryQty: 0,
    })

    await saveMarketResearchSession({
      partId: strong.id,
      researchedAt: new Date(),
      windows: [{ period: '30d', avgSoldPrice: 75, avgShipping: 12, totalSold: 18 }],
    })
    await saveMarketResearchSession({
      partId: weak.id,
      researchedAt: new Date(),
      windows: [{ period: '30d', avgSoldPrice: 25, avgShipping: 10, totalSold: 2 }],
    })

    const result = await listMarketOpportunities({
      inStock: true,
      research: 'current',
      staleDays: 30,
      minInventory: 1,
      min30dSold: 5,
      minAvgSold: 40,
    })

    expect(result.total).toBe(1)
    expect(result.rows[0]?.mpn).toBe('STRONG-1')
    expect(result.rows[0]?.sold30d).toBe(18)
    expect(result.rows[0]?.avgSoldPrice).toBe(75)
    expect(result.rows[0]?.lastResearchedAt).not.toBeNull()
  })

  it('keeps never-researched parts visibly queryable', async () => {
    await createPart({ mpn: 'NEVER-1', description: 'Board', inventoryQty: 1 })
    const researched = await createPart({ mpn: 'DONE-1', description: 'Board', inventoryQty: 1 })
    await saveMarketResearchSession({
      partId: researched.id,
      windows: [{ period: '30d', avgSoldPrice: 50, avgShipping: 10, totalSold: 6 }],
    })

    const result = await listMarketOpportunities({ research: 'never' })
    expect(result.rows.map((row) => row.mpn)).toEqual(['NEVER-1'])
    expect(result.rows[0]?.lastResearchedAt).toBeNull()
  })
})

describe('Research Queue query', () => {
  it('defaults to due work and orders never researched before stale', async () => {
    await createPart({ mpn: 'NEVER-Q', description: 'Never', inventoryQty: 2 })
    const stale = await createPart({ mpn: 'STALE-Q', description: 'Stale', inventoryQty: 1 })
    const current = await createPart({ mpn: 'CURRENT-Q', description: 'Current', inventoryQty: 1 })

    await saveMarketResearchSession({
      partId: stale.id,
      researchedAt: new Date(Date.now() - 45 * 86_400_000),
      windows: [{ period: '30d', avgSoldPrice: 60, avgShipping: 12, totalSold: 8 }],
    })
    await saveMarketResearchSession({
      partId: current.id,
      researchedAt: new Date(Date.now() - 5 * 86_400_000),
      windows: [{ period: '30d', avgSoldPrice: 70, avgShipping: 10, totalSold: 10 }],
    })

    const result = await listResearchQueue({ staleDays: 30 })
    expect(result.rows.map((row) => row.mpn)).toEqual(['NEVER-Q', 'STALE-Q'])
    expect(result.rows[0]?.researchState).toBe('never')
    expect(result.rows[1]?.researchState).toBe('stale')
    expect(result.rows[1]?.sold30d).toBe(8)
    expect(result.rows[1]?.avgSoldPrice).toBe(60)
  })

  it('can show current rows and stays paginated', async () => {
    for (let index = 0; index < 23; index += 1) {
      const part = await createPart({
        mpn: `CUR-${String(index + 1).padStart(2, '0')}`,
        description: 'Board',
        inventoryQty: 1,
      })
      await saveMarketResearchSession({
        partId: part.id,
        researchedAt: new Date(),
        windows: [{ period: '30d', avgSoldPrice: 40 + index, avgShipping: 9, totalSold: index }],
      })
    }

    const result = await listResearchQueue({ state: 'current', page: 2, pageSize: 10 })
    expect(result.total).toBe(23)
    expect(result.rows).toHaveLength(10)
    expect(result.page).toBe(2)
  })

  it('can include zero-inventory parts only when explicitly requested', async () => {
    await createPart({ mpn: 'ZERO-Q', description: 'Board', inventoryQty: 0 })
    expect((await listResearchQueue({ state: 'never' })).total).toBe(0)
    expect((await listResearchQueue({ state: 'never', inStock: false })).total).toBe(1)
  })

  it('loads only an explicit MPN working set for Tracker', async () => {
    await createPart({ mpn: 'SET-A', description: 'A', inventoryQty: 1 })
    await createPart({ mpn: 'SET-B', description: 'B', inventoryQty: 1 })
    await createPart({ mpn: 'SET-C', description: 'C', inventoryQty: 1 })

    const rows = await listPartsWithMarketForMpns(['SET-C', 'SET-A'])
    expect(rows.map((row) => row.mpn)).toEqual(['SET-A', 'SET-C'])
  })
})

describe('Product Research sessions', () => {
  it('groups the five lookback windows under one dated session and preserves optional metrics', async () => {
    const part = await createPart({ mpn: 'R1', description: 'Board' })
    const written = await saveMarketResearchSession({
      partId: part.id,
      researchedAt: new Date('2026-09-30T15:00:00Z'),
      windows: [
        { period: '7d', avgSoldPrice: 65, avgShipping: 9, totalSold: 8, soldPriceMin: 50, soldPriceMax: 80, totalSellers: 5, sellThroughPct: 160, freeShippingPct: 25 },
        { period: '30d', avgSoldPrice: 60, avgShipping: 10, totalSold: 20 },
        { period: '90d', avgSoldPrice: 58, avgShipping: 11, totalSold: 50 },
        { period: '6m', avgSoldPrice: 57, avgShipping: 12, totalSold: 90 },
        { period: '1yr', avgSoldPrice: 55, avgShipping: 12, totalSold: 180 },
      ],
    })

    expect(written).toBe(5)
    const sessions = await researchSessionHistory(part.id)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.researchedAt).toBe('2026-09-30T15:00:00.000Z')
    expect(sessions[0]?.periods['7d']?.soldQty).toBe(8)
    expect(sessions[0]?.periods['7d']?.soldPriceMin).toBe(50)
    expect(sessions[0]?.periods['7d']?.totalSellers).toBe(5)
    expect(sessions[0]?.periods['7d']?.sellThroughPct).toBe(160)
    expect(sessions[0]?.periods['30d']?.soldPriceMin).toBeNull()

    const rawSessions = await testDb.select().from(marketResearchSessions)
    const rawSnapshots = await testDb.select().from(marketSnapshots)
    expect(rawSessions).toHaveLength(1)
    expect(rawSnapshots).toHaveLength(5)
    expect(rawSnapshots.every((row) => row.researchSessionId === rawSessions[0]?.id)).toBe(true)
  })

  it('appends later research without overwriting the earlier session', async () => {
    const part = await createPart({ mpn: 'R2', description: 'Board' })
    await saveMarketResearchSession({
      partId: part.id,
      researchedAt: new Date('2026-09-01T12:00:00Z'),
      windows: [{ period: '30d', avgSoldPrice: 50, avgShipping: 10, totalSold: 10 }],
    })
    await saveMarketResearchSession({
      partId: part.id,
      researchedAt: new Date('2026-09-30T12:00:00Z'),
      windows: [{ period: '30d', avgSoldPrice: 60, avgShipping: 11, totalSold: 18 }],
    })

    const sessions = await researchSessionHistory(part.id)
    expect(sessions).toHaveLength(2)
    expect(sessions[0]?.periods['30d']?.price).toBe(60)
    expect(sessions[1]?.periods['30d']?.price).toBe(50)
    expect(await snapshotHistory(part.id)).toHaveLength(2)
  })

  it('keeps legacy/sync snapshots ungrouped and rejects duplicate windows before writing', async () => {
    const part = await createPart({ mpn: 'R3', description: 'Board' })
    await insertSoldSnapshots([
      { partId: part.id, period: '7d', price: 10, shipping: 1, soldQty: 2, source: 'ebay_insights', sampleSize: 2 },
    ])
    expect((await snapshotHistory(part.id))[0]?.researchSessionId).toBeNull()

    await expect(
      saveMarketResearchSession({
        partId: part.id,
        windows: [
          { period: '30d', avgSoldPrice: 20, avgShipping: 2, totalSold: 3 },
          { period: '30d', avgSoldPrice: 21, avgShipping: 2, totalSold: 4 },
        ],
      }),
    ).rejects.toThrow('duplicate lookback windows')

    expect(await testDb.select().from(marketResearchSessions)).toHaveLength(0)
    expect(await snapshotHistory(part.id)).toHaveLength(1)
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
