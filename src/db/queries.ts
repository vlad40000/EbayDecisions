import 'server-only'

import { and, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { categoryOf } from '@/lib/categories'
import { toDbNumeric, toNumber } from '@/lib/format'
import type { MarketFactsV1 } from '@/lib/market-facts'
import { toMpnKey } from '@/lib/mpn'
import { timeTrend } from '@/lib/stats'
import {
  PERIOD_DAYS,
  type ActiveMarketObservation,
  type EconomicSettings,
  type MarketResearchSession,
  type Part,
  type PartWithMarket,
  type Period,
  type PeriodObservation,
  type PriceBasis,
  type SnapshotSource,
  type TrendSummary,
} from '@/lib/types'

import { db } from './index'
import {
  activeMarketSnapshots,
  ebaySyncRuns,
  marketResearchSessions,
  marketSnapshots,
  parts,
  settings,
  type ActiveSnapshotRow,
  type SnapshotRow,
} from './schema'

// ─── Mapping ──────────────────────────────────────────────────────────────────

function mapPart(row: Omit<typeof parts.$inferSelect, 'mpnKey'>): Part {
  return {
    id: row.id,
    mpn: row.mpn,
    description: row.description,
    category: categoryOf(row.description, row.category),
    inventoryQty: row.inventoryQty,
    costBasis: toNumber(row.costBasis),
    shipCost: toNumber(row.shipCost),
    targetMarginPct: toNumber(row.targetMarginPct),
    sourceUrl: row.sourceUrl,
    notes: row.notes,
    active: row.active,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function mapObservation(row: {
  price: string | null
  shipping: string | null
  soldQty: number | null
  soldPriceMin: string | null
  soldPriceMax: string | null
  totalSellers: number | null
  sellThroughPct: string | null
  freeShippingPct: string | null
  researchSessionId: number | null
  source: SnapshotSource
  priceBasis: PriceBasis
  sampleSize: number | null
  capturedAt: Date
}): PeriodObservation {
  return {
    price: toNumber(row.price),
    shipping: toNumber(row.shipping),
    soldQty: row.soldQty,
    soldPriceMin: toNumber(row.soldPriceMin),
    soldPriceMax: toNumber(row.soldPriceMax),
    totalSellers: row.totalSellers,
    sellThroughPct: toNumber(row.sellThroughPct),
    freeShippingPct: toNumber(row.freeShippingPct),
    researchSessionId: row.researchSessionId,
    source: row.source,
    priceBasis: row.priceBasis,
    sampleSize: row.sampleSize,
    capturedAt: row.capturedAt.toISOString(),
  }
}

function mapActiveObservation(row: {
  askingPrice: string | null
  askingShipping: string | null
  activeQty: number | null
  source: SnapshotSource
  sampleSize: number | null
  broadMatchCount: number | null
  mpnRejectedCount: number | null
  conditionRejectedCount: number | null
  truncated: boolean
  capturedAt: Date
}): ActiveMarketObservation {
  return {
    askingPrice: toNumber(row.askingPrice),
    askingShipping: toNumber(row.askingShipping),
    activeQty: row.activeQty,
    source: row.source === 'ebay_browse' ? 'ebay_browse' : 'manual',
    sampleSize: row.sampleSize,
    broadMatchCount: row.broadMatchCount,
    mpnRejectedCount: row.mpnRejectedCount,
    conditionRejectedCount: row.conditionRejectedCount,
    truncated: row.truncated,
    capturedAt: row.capturedAt.toISOString(),
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const SETTINGS_DEFAULTS: EconomicSettings = {
  feePct: 13.25,
  feeFixed: 0.3,
  defaultShipCost: 12,
  targetMarginPct: 35,
  minMarginPct: 15,
}

export async function getSettings(): Promise<EconomicSettings> {
  const rows = await db.select().from(settings).where(eq(settings.id, 1)).limit(1)
  const row = rows[0]
  if (!row) {
    await db.insert(settings).values({ id: 1 }).onConflictDoNothing()
    return SETTINGS_DEFAULTS
  }

  return {
    feePct: toNumber(row.feePct) ?? SETTINGS_DEFAULTS.feePct,
    feeFixed: toNumber(row.feeFixed) ?? SETTINGS_DEFAULTS.feeFixed,
    defaultShipCost: toNumber(row.defaultShipCost) ?? SETTINGS_DEFAULTS.defaultShipCost,
    targetMarginPct: toNumber(row.targetMarginPct) ?? SETTINGS_DEFAULTS.targetMarginPct,
    minMarginPct: toNumber(row.minMarginPct) ?? SETTINGS_DEFAULTS.minMarginPct,
  }
}

export async function updateSettings(next: Partial<EconomicSettings>): Promise<void> {
  const patch = {
    ...(next.feePct != null ? { feePct: toDbNumeric(next.feePct) ?? '13.25' } : {}),
    ...(next.feeFixed != null ? { feeFixed: toDbNumeric(next.feeFixed) ?? '0.30' } : {}),
    ...(next.defaultShipCost != null
      ? { defaultShipCost: toDbNumeric(next.defaultShipCost) ?? '12.00' }
      : {}),
    ...(next.targetMarginPct != null
      ? { targetMarginPct: toDbNumeric(next.targetMarginPct) ?? '35.00' }
      : {}),
    ...(next.minMarginPct != null
      ? { minMarginPct: toDbNumeric(next.minMarginPct) ?? '15.00' }
      : {}),
    updatedAt: new Date(),
  }

  await db
    .insert(settings)
    .values({ id: 1, ...patch })
    .onConflictDoUpdate({ target: settings.id, set: patch })
}

// ─── Parts ────────────────────────────────────────────────────────────────────

export async function listParts(options: { includeInactive?: boolean } = {}): Promise<Part[]> {
  const rows = options.includeInactive
    ? await db.select().from(parts).orderBy(parts.mpn)
    : await db.select().from(parts).where(eq(parts.active, true)).orderBy(parts.mpn)
  return rows.map(mapPart)
}

export type InventoryPageResult = {
  rows: Part[]
  total: number
  page: number
  pageSize: number
  pages: number
}

export async function listInventoryParts(
  options: {
    query?: string
    includeInactive?: boolean
    page?: number
    pageSize?: number
  } = {},
): Promise<InventoryPageResult> {
  const page = Math.max(1, Math.trunc(options.page ?? 1))
  const pageSize = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 50)))
  const query = options.query?.trim() ?? ''

  const conditions = []
  if (!options.includeInactive) conditions.push(eq(parts.active, true))
  if (query) {
    const search = or(ilike(parts.mpn, `%${query}%`), ilike(parts.description, `%${query}%`))
    if (search) conditions.push(search)
  }

  const rows = await db
    .select({
      totalCount: sql<number>`count(*) over()::int`,
      id: parts.id,
      mpn: parts.mpn,
      description: parts.description,
      category: parts.category,
      inventoryQty: parts.inventoryQty,
      costBasis: parts.costBasis,
      shipCost: parts.shipCost,
      targetMarginPct: parts.targetMarginPct,
      sourceUrl: parts.sourceUrl,
      notes: parts.notes,
      active: parts.active,
      createdAt: parts.createdAt,
      updatedAt: parts.updatedAt,
    })
    .from(parts)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(parts.mpn)
    .limit(pageSize)
    .offset((page - 1) * pageSize)

  const total = Number(rows[0]?.totalCount ?? 0)

  return {
    rows: rows.map(mapPart),
    total,
    page,
    pageSize,
    pages: total === 0 ? 0 : Math.ceil(total / pageSize),
  }
}

/** Looks a part up by D1 key, so any case/punctuation spelling finds it. */
export async function getPartByMpn(mpn: string): Promise<Part | null> {
  const key = toMpnKey(mpn)
  if (!key) return null
  const rows = await db.select().from(parts).where(eq(parts.mpnKey, key)).limit(1)
  return rows[0] ? mapPart(rows[0]) : null
}

/** D1 key for a submitted MPN; rejects spellings with no letters or digits. */
function requireMpnKey(mpn: string): string {
  const key = toMpnKey(mpn)
  if (!key) throw new Error(`MPN "${mpn.trim()}" has no letters or digits.`)
  return key
}

export type PartInput = {
  mpn: string
  description: string
  category?: string | null
  inventoryQty?: number
  costBasis?: number | null
  shipCost?: number | null
  targetMarginPct?: number | null
  sourceUrl?: string | null
  notes?: string | null
  active?: boolean
}

export async function createPart(input: PartInput): Promise<Part> {
  const rows = await db
    .insert(parts)
    .values({
      mpn: input.mpn.trim(),
      mpnKey: requireMpnKey(input.mpn),
      description: input.description.trim(),
      category: input.category ?? null,
      inventoryQty: input.inventoryQty ?? 0,
      costBasis: toDbNumeric(input.costBasis),
      shipCost: toDbNumeric(input.shipCost),
      targetMarginPct: toDbNumeric(input.targetMarginPct),
      sourceUrl: input.sourceUrl ?? null,
      notes: input.notes ?? null,
      active: input.active ?? true,
    })
    .returning()
  if (!rows[0]) throw new Error('Insert returned no row')
  return mapPart(rows[0])
}

export async function updatePart(id: number, input: Partial<PartInput>): Promise<void> {
  await db
    .update(parts)
    .set({
      ...(input.mpn !== undefined ? { mpn: input.mpn.trim(), mpnKey: requireMpnKey(input.mpn) } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.inventoryQty !== undefined ? { inventoryQty: input.inventoryQty } : {}),
      ...(input.costBasis !== undefined ? { costBasis: toDbNumeric(input.costBasis) } : {}),
      ...(input.shipCost !== undefined ? { shipCost: toDbNumeric(input.shipCost) } : {}),
      ...(input.targetMarginPct !== undefined
        ? { targetMarginPct: toDbNumeric(input.targetMarginPct) }
        : {}),
      ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: new Date(),
    })
    .where(eq(parts.id, id))
}

export async function deletePart(id: number): Promise<void> {
  await db.delete(parts).where(eq(parts.id, id))
}

/**
 * Identity is the D1 key: re-importing `dc47 00019a` updates the part stored
 * as `DC47-00019A` instead of creating a second one. The stored display MPN
 * is kept as-is; only the other supplied fields are updated.
 */
export async function upsertPartByMpn(input: PartInput): Promise<'inserted' | 'updated'> {
  const existing = await db
    .select({ id: parts.id })
    .from(parts)
    .where(eq(parts.mpnKey, requireMpnKey(input.mpn)))
    .limit(1)
  if (existing[0]) {
    const fields: Partial<PartInput> = { ...input }
    delete fields.mpn
    await updatePart(existing[0].id, fields)
    return 'updated'
  }
  await createPart(input)
  return 'inserted'
}

// ─── Market opportunities ────────────────────────────────────────────────────

export type MarketOpportunityResearchState = 'all' | 'never' | 'stale' | 'current'
export type MarketOpportunitySort =
  | 'mpn'
  | 'inventory'
  | '7d'
  | '30d'
  | '90d'
  | '6m'
  | '1yr'
  | 'avg-sold'
  | 'avg-ship'
  | 'updated'

export type MarketOpportunityRow = {
  partId: number
  mpn: string
  description: string
  inventoryQty: number
  sold7d: number | null
  sold30d: number | null
  sold90d: number | null
  sold6m: number | null
  sold1yr: number | null
  avgSoldPrice: number | null
  avgShipping: number | null
  lastResearchedAt: string | null
}

export type MarketOpportunityPage = {
  rows: MarketOpportunityRow[]
  total: number
  page: number
  pageSize: number
  pages: number
}

export type MarketOpportunityOptions = {
  query?: string
  inStock?: boolean
  research?: MarketOpportunityResearchState
  staleDays?: number
  min30dSold?: number | null
  minAvgSold?: number | null
  minInventory?: number | null
  sort?: MarketOpportunitySort
  direction?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

const opportunity7d = alias(marketSnapshots, 'opportunity_7d')
const opportunity30d = alias(marketSnapshots, 'opportunity_30d')
const opportunity90d = alias(marketSnapshots, 'opportunity_90d')
const opportunity6m = alias(marketSnapshots, 'opportunity_6m')
const opportunity1yr = alias(marketSnapshots, 'opportunity_1yr')

/**
 * One server-side query for the Opportunities surface.
 *
 * Pagination, search, filters, sorting, latest research-session lookup, the five
 * sold windows, and total result count all stay in Postgres. No catalogue-wide
 * result set is returned to the browser.
 */
export async function listMarketOpportunities(
  options: MarketOpportunityOptions = {},
): Promise<MarketOpportunityPage> {
  const page = Math.max(1, Math.trunc(options.page ?? 1))
  const pageSize = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 50)))
  const staleDays = Math.min(3650, Math.max(1, Math.trunc(options.staleDays ?? 30)))
  const research = options.research ?? 'all'
  const sort = options.sort ?? 'updated'
  const direction = options.direction ?? 'desc'
  const query = options.query?.trim() ?? ''

  const latestSession = db
    .selectDistinctOn([marketResearchSessions.partId], {
      id: marketResearchSessions.id,
      partId: marketResearchSessions.partId,
      researchedAt: marketResearchSessions.researchedAt,
    })
    .from(marketResearchSessions)
    .orderBy(
      marketResearchSessions.partId,
      desc(marketResearchSessions.researchedAt),
      desc(marketResearchSessions.id),
    )
    .as('latest_research_session')

  const conditions = [eq(parts.active, true)]

  if (query) {
    const search = or(ilike(parts.mpn, `%${query}%`), ilike(parts.description, `%${query}%`))
    if (search) conditions.push(search)
  }
  if (options.inStock) conditions.push(gt(parts.inventoryQty, 0))
  if (options.minInventory != null) {
    conditions.push(gte(parts.inventoryQty, Math.max(0, Math.trunc(options.minInventory))))
  }
  if (options.min30dSold != null) {
    conditions.push(gte(opportunity30d.soldQty, Math.max(0, Math.trunc(options.min30dSold))))
  }
  if (options.minAvgSold != null) {
    conditions.push(gte(opportunity30d.price, toDbNumeric(Math.max(0, options.minAvgSold)) ?? '0.00'))
  }

  const staleCutoff = new Date(Date.now() - staleDays * 86_400_000)
  if (research === 'never') conditions.push(isNull(latestSession.id))
  if (research === 'stale') {
    conditions.push(isNotNull(latestSession.id), lt(latestSession.researchedAt, staleCutoff))
  }
  if (research === 'current') {
    conditions.push(isNotNull(latestSession.id), gte(latestSession.researchedAt, staleCutoff))
  }

  const sortExpression = {
    mpn: parts.mpn,
    inventory: parts.inventoryQty,
    '7d': opportunity7d.soldQty,
    '30d': opportunity30d.soldQty,
    '90d': opportunity90d.soldQty,
    '6m': opportunity6m.soldQty,
    '1yr': opportunity1yr.soldQty,
    'avg-sold': opportunity30d.price,
    'avg-ship': opportunity30d.shipping,
    updated: latestSession.researchedAt,
  }[sort]

  const directionSql = direction === 'asc' ? sql.raw('asc') : sql.raw('desc')
  const orderClause = sql`${sortExpression} ${directionSql} nulls last`

  const rows = await db
    .select({
      totalCount: sql<number>`count(*) over()::int`,
      partId: parts.id,
      mpn: parts.mpn,
      description: parts.description,
      inventoryQty: parts.inventoryQty,
      sold7d: opportunity7d.soldQty,
      sold30d: opportunity30d.soldQty,
      sold90d: opportunity90d.soldQty,
      sold6m: opportunity6m.soldQty,
      sold1yr: opportunity1yr.soldQty,
      avgSoldPrice: opportunity30d.price,
      avgShipping: opportunity30d.shipping,
      lastResearchedAt: latestSession.researchedAt,
    })
    .from(parts)
    .leftJoin(latestSession, eq(latestSession.partId, parts.id))
    .leftJoin(
      opportunity7d,
      and(eq(opportunity7d.researchSessionId, latestSession.id), eq(opportunity7d.period, '7d')),
    )
    .leftJoin(
      opportunity30d,
      and(eq(opportunity30d.researchSessionId, latestSession.id), eq(opportunity30d.period, '30d')),
    )
    .leftJoin(
      opportunity90d,
      and(eq(opportunity90d.researchSessionId, latestSession.id), eq(opportunity90d.period, '90d')),
    )
    .leftJoin(
      opportunity6m,
      and(eq(opportunity6m.researchSessionId, latestSession.id), eq(opportunity6m.period, '6m')),
    )
    .leftJoin(
      opportunity1yr,
      and(eq(opportunity1yr.researchSessionId, latestSession.id), eq(opportunity1yr.period, '1yr')),
    )
    .where(and(...conditions))
    .orderBy(orderClause, parts.mpn)
    .limit(pageSize)
    .offset((page - 1) * pageSize)

  const total = Number(rows[0]?.totalCount ?? 0)

  return {
    rows: rows.map((row) => ({
      partId: row.partId,
      mpn: row.mpn,
      description: row.description,
      inventoryQty: row.inventoryQty,
      sold7d: row.sold7d,
      sold30d: row.sold30d,
      sold90d: row.sold90d,
      sold6m: row.sold6m,
      sold1yr: row.sold1yr,
      avgSoldPrice: toNumber(row.avgSoldPrice),
      avgShipping: toNumber(row.avgShipping),
      lastResearchedAt: row.lastResearchedAt?.toISOString() ?? null,
    })),
    total,
    page,
    pageSize,
    pages: total === 0 ? 0 : Math.ceil(total / pageSize),
  }
}

// ─── Research queue ──────────────────────────────────────────────────────────

export type ResearchQueueState = 'due' | 'all' | 'never' | 'stale' | 'current'

export type ResearchQueueRow = {
  partId: number
  mpn: string
  description: string
  inventoryQty: number
  lastResearchedAt: string | null
  ageDays: number | null
  sold30d: number | null
  avgSoldPrice: number | null
  researchState: 'never' | 'stale' | 'current'
}

export type ResearchQueuePage = {
  rows: ResearchQueueRow[]
  total: number
  page: number
  pageSize: number
  pages: number
}

export async function listResearchQueue(
  options: {
    query?: string
    state?: ResearchQueueState
    staleDays?: number
    inStock?: boolean
    page?: number
    pageSize?: number
  } = {},
): Promise<ResearchQueuePage> {
  const page = Math.max(1, Math.trunc(options.page ?? 1))
  const pageSize = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 50)))
  const staleDays = Math.min(3650, Math.max(1, Math.trunc(options.staleDays ?? 30)))
  const state = options.state ?? 'due'
  const query = options.query?.trim() ?? ''
  const staleCutoff = new Date(Date.now() - staleDays * 86_400_000)

  const latestSession = db
    .selectDistinctOn([marketResearchSessions.partId], {
      id: marketResearchSessions.id,
      partId: marketResearchSessions.partId,
      researchedAt: marketResearchSessions.researchedAt,
    })
    .from(marketResearchSessions)
    .orderBy(
      marketResearchSessions.partId,
      desc(marketResearchSessions.researchedAt),
      desc(marketResearchSessions.id),
    )
    .as('queue_latest_research_session')

  const queue30d = alias(marketSnapshots, 'queue_30d')
  const conditions = [eq(parts.active, true)]

  if (options.inStock !== false) conditions.push(gt(parts.inventoryQty, 0))
  if (query) {
    const search = or(ilike(parts.mpn, `%${query}%`), ilike(parts.description, `%${query}%`))
    if (search) conditions.push(search)
  }

  if (state === 'due') {
    const due = or(isNull(latestSession.id), lt(latestSession.researchedAt, staleCutoff))
    if (due) conditions.push(due)
  }
  if (state === 'never') conditions.push(isNull(latestSession.id))
  if (state === 'stale') {
    conditions.push(isNotNull(latestSession.id), lt(latestSession.researchedAt, staleCutoff))
  }
  if (state === 'current') {
    conditions.push(isNotNull(latestSession.id), gte(latestSession.researchedAt, staleCutoff))
  }

  const priority = sql<number>`
    CASE
      WHEN ${latestSession.id} IS NULL THEN 0
      WHEN ${latestSession.researchedAt} < ${staleCutoff} THEN 1
      ELSE 2
    END
  `

  const rows = await db
    .select({
      totalCount: sql<number>`count(*) over()::int`,
      partId: parts.id,
      mpn: parts.mpn,
      description: parts.description,
      inventoryQty: parts.inventoryQty,
      lastResearchedAt: latestSession.researchedAt,
      sold30d: queue30d.soldQty,
      avgSoldPrice: queue30d.price,
      priority,
    })
    .from(parts)
    .leftJoin(latestSession, eq(latestSession.partId, parts.id))
    .leftJoin(
      queue30d,
      and(eq(queue30d.researchSessionId, latestSession.id), eq(queue30d.period, '30d')),
    )
    .where(and(...conditions))
    .orderBy(priority, latestSession.researchedAt, desc(parts.inventoryQty), parts.mpn)
    .limit(pageSize)
    .offset((page - 1) * pageSize)

  const total = Number(rows[0]?.totalCount ?? 0)

  return {
    rows: rows.map((row) => {
      const researchedAt = row.lastResearchedAt
      const ageDays =
        researchedAt == null
          ? null
          : Math.max(0, Math.floor((Date.now() - researchedAt.getTime()) / 86_400_000))
      const researchState =
        researchedAt == null ? 'never' : researchedAt < staleCutoff ? 'stale' : 'current'

      return {
        partId: row.partId,
        mpn: row.mpn,
        description: row.description,
        inventoryQty: row.inventoryQty,
        lastResearchedAt: researchedAt?.toISOString() ?? null,
        ageDays,
        sold30d: row.sold30d,
        avgSoldPrice: toNumber(row.avgSoldPrice),
        researchState,
      }
    }),
    total,
    page,
    pageSize,
    pages: total === 0 ? 0 : Math.ceil(total / pageSize),
  }
}

// ─── Sold Research tracker ───────────────────────────────────────────────────

export type TrackerResearchRow = {
  partId: number
  mpn: string
  description: string
  inventoryQty: number
  lastResearchedAt: string | null
  periods: Partial<Record<Period, PeriodObservation>>
  activeMarket: ActiveMarketObservation | null
}

export type TrackerResearchPage = {
  rows: TrackerResearchRow[]
  total: number
  page: number
  pageSize: number
  pages: number
}

export async function listTrackerResearchParts(
  options: {
    query?: string
    mpns?: string[]
    page?: number
    pageSize?: number
  } = {},
): Promise<TrackerResearchPage> {
  const page = Math.max(1, Math.trunc(options.page ?? 1))
  const pageSize = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 50)))
  const query = options.query?.trim() ?? ''
  const selectedKeys = [...new Set((options.mpns ?? []).map(toMpnKey).filter(Boolean))].slice(0, 20)

  const latestSession = db
    .selectDistinctOn([marketResearchSessions.partId], {
      id: marketResearchSessions.id,
      partId: marketResearchSessions.partId,
      researchedAt: marketResearchSessions.researchedAt,
    })
    .from(marketResearchSessions)
    .orderBy(
      marketResearchSessions.partId,
      desc(marketResearchSessions.researchedAt),
      desc(marketResearchSessions.id),
    )
    .as('tracker_latest_research_session')

  const conditions = [eq(parts.active, true)]
  if (selectedKeys.length > 0) conditions.push(inArray(parts.mpnKey, selectedKeys))
  if (query) {
    const search = or(ilike(parts.mpn, `%${query}%`), ilike(parts.description, `%${query}%`))
    if (search) conditions.push(search)
  }

  const pageRows = await db
    .select({
      totalCount: sql<number>`count(*) over()::int`,
      partId: parts.id,
      mpn: parts.mpn,
      description: parts.description,
      inventoryQty: parts.inventoryQty,
      researchSessionId: latestSession.id,
      lastResearchedAt: latestSession.researchedAt,
    })
    .from(parts)
    .leftJoin(latestSession, eq(latestSession.partId, parts.id))
    .where(and(...conditions))
    .orderBy(parts.mpn)
    .limit(pageSize)
    .offset((page - 1) * pageSize)

  const sessionIds = pageRows
    .map((row) => row.researchSessionId)
    .filter((id): id is number => id != null)

  const periodRows =
    sessionIds.length === 0
      ? []
      : await db
          .select({
            researchSessionId: marketSnapshots.researchSessionId,
            period: marketSnapshots.period,
            price: marketSnapshots.price,
            shipping: marketSnapshots.shipping,
            soldQty: marketSnapshots.soldQty,
            soldPriceMin: marketSnapshots.soldPriceMin,
            soldPriceMax: marketSnapshots.soldPriceMax,
            totalSellers: marketSnapshots.totalSellers,
            sellThroughPct: marketSnapshots.sellThroughPct,
            freeShippingPct: marketSnapshots.freeShippingPct,
            source: marketSnapshots.source,
            priceBasis: marketSnapshots.priceBasis,
            sampleSize: marketSnapshots.sampleSize,
            capturedAt: marketSnapshots.capturedAt,
          })
          .from(marketSnapshots)
          .where(inArray(marketSnapshots.researchSessionId, sessionIds))
          .orderBy(marketSnapshots.researchSessionId, marketSnapshots.period)

  const activeByPart = await latestActiveSnapshots(pageRows.map((row) => row.partId))

  const periodsBySession = new Map<number, Partial<Record<Period, PeriodObservation>>>()
  for (const row of periodRows) {
    if (row.researchSessionId == null) continue
    const periods = periodsBySession.get(row.researchSessionId) ?? {}
    periods[row.period as Period] = mapObservation(row)
    periodsBySession.set(row.researchSessionId, periods)
  }

  const total = Number(pageRows[0]?.totalCount ?? 0)
  return {
    rows: pageRows.map((row) => ({
      partId: row.partId,
      mpn: row.mpn,
      description: row.description,
      inventoryQty: row.inventoryQty,
      lastResearchedAt: row.lastResearchedAt?.toISOString() ?? null,
      periods:
        row.researchSessionId == null ? {} : periodsBySession.get(row.researchSessionId) ?? {},
      activeMarket: activeByPart.get(row.partId) ?? null,
    })),
    total,
    page,
    pageSize,
    pages: total === 0 ? 0 : Math.ceil(total / pageSize),
  }
}

// ─── Current market reads ─────────────────────────────────────────────────────

export async function latestSnapshots(
  partIds: number[],
): Promise<Map<number, Partial<Record<Period, PeriodObservation>>>> {
  const byPart = new Map<number, Partial<Record<Period, PeriodObservation>>>()
  if (partIds.length === 0) return byPart

  const rows = await db
    .selectDistinctOn([marketSnapshots.partId, marketSnapshots.period], {
      partId: marketSnapshots.partId,
      period: marketSnapshots.period,
      price: marketSnapshots.price,
      shipping: marketSnapshots.shipping,
      soldQty: marketSnapshots.soldQty,
      soldPriceMin: marketSnapshots.soldPriceMin,
      soldPriceMax: marketSnapshots.soldPriceMax,
      totalSellers: marketSnapshots.totalSellers,
      sellThroughPct: marketSnapshots.sellThroughPct,
      freeShippingPct: marketSnapshots.freeShippingPct,
      researchSessionId: marketSnapshots.researchSessionId,
      source: marketSnapshots.source,
      priceBasis: marketSnapshots.priceBasis,
      sampleSize: marketSnapshots.sampleSize,
      capturedAt: marketSnapshots.capturedAt,
    })
    .from(marketSnapshots)
    .where(inArray(marketSnapshots.partId, partIds))
    .orderBy(
      marketSnapshots.partId,
      marketSnapshots.period,
      desc(marketSnapshots.capturedAt),
      desc(marketSnapshots.id),
    )

  for (const row of rows) {
    const existing = byPart.get(row.partId) ?? {}
    existing[row.period as Period] = mapObservation(row)
    byPart.set(row.partId, existing)
  }
  return byPart
}

export async function latestActiveSnapshots(
  partIds: number[],
): Promise<Map<number, ActiveMarketObservation>> {
  const byPart = new Map<number, ActiveMarketObservation>()
  if (partIds.length === 0) return byPart

  const rows = await db
    .selectDistinctOn([activeMarketSnapshots.partId], {
      partId: activeMarketSnapshots.partId,
      askingPrice: activeMarketSnapshots.askingPrice,
      askingShipping: activeMarketSnapshots.askingShipping,
      activeQty: activeMarketSnapshots.activeQty,
      source: activeMarketSnapshots.source,
      sampleSize: activeMarketSnapshots.sampleSize,
      broadMatchCount: activeMarketSnapshots.broadMatchCount,
      mpnRejectedCount: activeMarketSnapshots.mpnRejectedCount,
      conditionRejectedCount: activeMarketSnapshots.conditionRejectedCount,
      truncated: activeMarketSnapshots.truncated,
      capturedAt: activeMarketSnapshots.capturedAt,
    })
    .from(activeMarketSnapshots)
    .where(inArray(activeMarketSnapshots.partId, partIds))
    .orderBy(activeMarketSnapshots.partId, desc(activeMarketSnapshots.capturedAt), desc(activeMarketSnapshots.id))

  for (const row of rows) byPart.set(row.partId, mapActiveObservation(row))
  return byPart
}

export async function listPartsWithMarket(
  options: { includeInactive?: boolean } = {},
): Promise<PartWithMarket[]> {
  const rows = await listParts(options)
  const ids = rows.map((part) => part.id)
  const [snapshots, active] = await Promise.all([latestSnapshots(ids), latestActiveSnapshots(ids)])
  return rows.map((part) => ({
    ...part,
    periods: snapshots.get(part.id) ?? {},
    activeMarket: active.get(part.id) ?? null,
  }))
}

export async function listPartsWithMarketForMpns(mpns: string[]): Promise<PartWithMarket[]> {
  const keys = [...new Set(mpns.map(toMpnKey).filter(Boolean))].slice(0, 20)
  if (keys.length === 0) return []

  const partRows = await db
    .select()
    .from(parts)
    .where(and(eq(parts.active, true), inArray(parts.mpnKey, keys)))
    .orderBy(parts.mpn)

  const mapped = partRows.map(mapPart)
  const ids = mapped.map((part) => part.id)
  const [snapshots, active] = await Promise.all([latestSnapshots(ids), latestActiveSnapshots(ids)])

  return mapped.map((part) => ({
    ...part,
    periods: snapshots.get(part.id) ?? {},
    activeMarket: active.get(part.id) ?? null,
  }))
}

export async function getPartWithMarket(mpn: string): Promise<PartWithMarket | null> {
  const part = await getPartByMpn(mpn)
  if (!part) return null
  const [snapshots, active] = await Promise.all([latestSnapshots([part.id]), latestActiveSnapshots([part.id])])
  return {
    ...part,
    periods: snapshots.get(part.id) ?? {},
    activeMarket: active.get(part.id) ?? null,
  }
}

export async function snapshotHistory(partId: number, limit = 500): Promise<SnapshotRow[]> {
  return db
    .select()
    .from(marketSnapshots)
    .where(eq(marketSnapshots.partId, partId))
    .orderBy(desc(marketSnapshots.capturedAt), desc(marketSnapshots.id))
    .limit(limit)
}

export async function activeSnapshotHistory(partId: number, limit = 500): Promise<ActiveSnapshotRow[]> {
  return db
    .select()
    .from(activeMarketSnapshots)
    .where(eq(activeMarketSnapshots.partId, partId))
    .orderBy(desc(activeMarketSnapshots.capturedAt), desc(activeMarketSnapshots.id))
    .limit(limit)
}

// ─── Integration market facts (read-only) ─────────────────────────────────────

/**
 * Market facts for Parts Engine, one record per requested D1 key, in request
 * order. Reads only: exact-key lookups on `parts_mpn_key_unique`, then the
 * newest 90d sold row and newest active row for just those parts. Nothing is
 * inserted, updated, or registered, and no catalogue-wide scan is made.
 */
export async function getMarketFactsByMpnKeys(keys: string[]): Promise<MarketFactsV1[]> {
  if (keys.length === 0) return []

  const partRows = await db
    .select({ id: parts.id, mpn: parts.mpn, mpnKey: parts.mpnKey })
    .from(parts)
    .where(inArray(parts.mpnKey, keys))
  const ids = partRows.map((row) => row.id)

  const [soldRows, active] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : db
          .selectDistinctOn([marketSnapshots.partId], {
            partId: marketSnapshots.partId,
            price: marketSnapshots.price,
            shipping: marketSnapshots.shipping,
            soldQty: marketSnapshots.soldQty,
            sellThroughPct: marketSnapshots.sellThroughPct,
            source: marketSnapshots.source,
            priceBasis: marketSnapshots.priceBasis,
            capturedAt: marketSnapshots.capturedAt,
          })
          .from(marketSnapshots)
          .where(and(inArray(marketSnapshots.partId, ids), eq(marketSnapshots.period, '90d')))
          .orderBy(marketSnapshots.partId, desc(marketSnapshots.capturedAt), desc(marketSnapshots.id)),
    latestActiveSnapshots(ids),
  ])

  const partByKey = new Map(partRows.map((row) => [row.mpnKey, row]))
  const soldByPart = new Map(soldRows.map((row) => [row.partId, row]))

  return keys.map((mpnKey): MarketFactsV1 => {
    const part = partByKey.get(mpnKey)
    if (!part) return { mpnKey, mpnDisplay: null, status: 'unregistered', sold90: null, active: null }

    const sold = soldByPart.get(part.id)
    const current = active.get(part.id)
    return {
      mpnKey,
      mpnDisplay: part.mpn,
      status: 'found',
      sold90: sold
        ? {
            soldQty: sold.soldQty,
            avgSoldPrice: toNumber(sold.price),
            avgBuyerShipping: toNumber(sold.shipping),
            sellThroughPct: toNumber(sold.sellThroughPct),
            source: sold.source,
            priceBasis: sold.priceBasis,
            capturedAt: sold.capturedAt.toISOString(),
          }
        : null,
      active: current
        ? {
            activeQty: current.activeQty,
            askingPrice: current.askingPrice,
            askingShipping: current.askingShipping,
            source: current.source,
            sampleSize: current.sampleSize,
            truncated: current.truncated,
            capturedAt: current.capturedAt,
          }
        : null,
    }
  })
}

// ─── Product Research sessions ────────────────────────────────────────────────

export type ResearchWindowInput = {
  period: Period
  avgSoldPrice: number | null
  avgShipping: number | null
  totalSold: number | null
  soldPriceMin?: number | null
  soldPriceMax?: number | null
  totalSellers?: number | null
  sellThroughPct?: number | null
  freeShippingPct?: number | null
}

/**
 * Saves one eBay Product Research event atomically.
 *
 * The parent session and every supplied lookback window are inserted by one
 * Postgres statement. Legacy/manual rows that predate this model remain
 * ungrouped with a null research_session_id.
 */
export async function saveMarketResearchSession(input: {
  partId: number
  researchedAt?: Date
  source?: string
  notes?: string | null
  windows: ResearchWindowInput[]
}): Promise<number> {
  if (input.windows.length === 0) {
    throw new Error('A research session must contain at least one lookback window')
  }

  const periods = input.windows.map((window) => window.period)
  if (new Set(periods).size !== periods.length) {
    throw new Error('A research session cannot contain duplicate lookback windows')
  }

  const researchedAt = input.researchedAt ?? new Date()
  const source = input.source?.trim() || 'ebay_product_research_manual'
  const notes = input.notes?.trim() || null

  await db.execute(sql`
    WITH inserted_session AS (
      INSERT INTO ${marketResearchSessions}
        (part_id, researched_at, source, notes, created_at)
      VALUES
        (${input.partId}, ${researchedAt}, ${source}, ${notes}, now())
      RETURNING id, researched_at
    ),
    window_input(
      period, price, shipping, sold_qty, sold_price_min, sold_price_max,
      total_sellers, sell_through_pct, free_shipping_pct
    ) AS (
      VALUES ${sql.join(
        input.windows.map(
          (window) => sql`(
            ${window.period}::period,
            ${toDbNumeric(window.avgSoldPrice)}::numeric(10,2),
            ${toDbNumeric(window.avgShipping)}::numeric(10,2),
            ${window.totalSold}::integer,
            ${toDbNumeric(window.soldPriceMin)}::numeric(10,2),
            ${toDbNumeric(window.soldPriceMax)}::numeric(10,2),
            ${window.totalSellers ?? null}::integer,
            ${toDbNumeric(window.sellThroughPct)}::numeric(8,2),
            ${toDbNumeric(window.freeShippingPct)}::numeric(5,2)
          )`,
        ),
        sql`, `,
      )}
    ),
    inserted_windows AS (
      INSERT INTO ${marketSnapshots}
        (part_id, research_session_id, period, price, shipping, sold_qty,
         sold_price_min, sold_price_max, total_sellers, sell_through_pct,
         free_shipping_pct, source, price_basis, sample_size, captured_at)
      SELECT
        ${input.partId}, s.id, w.period, w.price, w.shipping, w.sold_qty,
        w.sold_price_min, w.sold_price_max, w.total_sellers, w.sell_through_pct,
        w.free_shipping_pct, 'manual'::snapshot_source, 'sold'::price_basis,
        NULL, s.researched_at
      FROM inserted_session s
      CROSS JOIN window_input w
      RETURNING 1
    )
    SELECT count(*)::int AS written FROM inserted_windows
  `)

  return input.windows.length
}

export async function researchSessionHistory(
  partId: number,
  limit = 100,
): Promise<MarketResearchSession[]> {
  const sessions = await db
    .select()
    .from(marketResearchSessions)
    .where(eq(marketResearchSessions.partId, partId))
    .orderBy(desc(marketResearchSessions.researchedAt), desc(marketResearchSessions.id))
    .limit(limit)

  if (sessions.length === 0) return []

  const ids = sessions.map((session) => session.id)
  const windows = await db
    .select({
      researchSessionId: marketSnapshots.researchSessionId,
      period: marketSnapshots.period,
      price: marketSnapshots.price,
      shipping: marketSnapshots.shipping,
      soldQty: marketSnapshots.soldQty,
      soldPriceMin: marketSnapshots.soldPriceMin,
      soldPriceMax: marketSnapshots.soldPriceMax,
      totalSellers: marketSnapshots.totalSellers,
      sellThroughPct: marketSnapshots.sellThroughPct,
      freeShippingPct: marketSnapshots.freeShippingPct,
      source: marketSnapshots.source,
      priceBasis: marketSnapshots.priceBasis,
      sampleSize: marketSnapshots.sampleSize,
      capturedAt: marketSnapshots.capturedAt,
    })
    .from(marketSnapshots)
    .where(inArray(marketSnapshots.researchSessionId, ids))
    .orderBy(desc(marketSnapshots.capturedAt), marketSnapshots.period)

  const bySession = new Map<number, Partial<Record<Period, PeriodObservation>>>()
  for (const window of windows) {
    if (window.researchSessionId == null) continue
    const periods = bySession.get(window.researchSessionId) ?? {}
    periods[window.period as Period] = mapObservation(window)
    bySession.set(window.researchSessionId, periods)
  }

  return sessions.map((session) => ({
    id: session.id,
    partId: session.partId,
    researchedAt: session.researchedAt.toISOString(),
    source: session.source,
    notes: session.notes,
    createdAt: session.createdAt.toISOString(),
    periods: bySession.get(session.id) ?? {},
  }))
}

// ─── Explicit manual save ─────────────────────────────────────────────────────

export type ManualWindowPatch = {
  period: Period
  price?: number | null
  shipping?: number | null
  soldQty?: number | null
  priceBasis?: PriceBasis
}

export type ManualActivePatch = {
  askingPrice?: number | null
  askingShipping?: number | null
  activeQty?: number | null
  source?: 'manual' | 'ebay_browse'
  sampleSize?: number | null
  broadMatchCount?: number | null
  mpnRejectedCount?: number | null
  conditionRejectedCount?: number | null
  truncated?: boolean
}

/**
 * Persists one part's explicit Save action in one Postgres statement.
 *
 * Only touched fields are supplied by the browser. The CTE reads the live latest
 * rows and carries untouched fields forward, so a sync that landed after the
 * screen loaded cannot be overwritten by stale browser state. Every save
 * appends; same-day corrections remain auditable, while trend calculation later
 * collapses a UTC day to its latest observation.
 */
export async function saveManualMarket(input: {
  partId: number
  windows: ManualWindowPatch[]
  active?: ManualActivePatch
}): Promise<number> {
  const { partId, windows, active } = input
  if (windows.length === 0 && !active) return 0

  const windowCtes =
    windows.length > 0
      ? sql`
        window_input(period, has_price, price, has_shipping, shipping, has_sold_qty, sold_qty, has_basis, price_basis) AS (
          VALUES ${sql.join(
            windows.map((patch) => sql`(
              ${patch.period}::period,
              ${patch.price !== undefined}::boolean,
              ${toDbNumeric(patch.price)}::numeric(10,2),
              ${patch.shipping !== undefined}::boolean,
              ${toDbNumeric(patch.shipping)}::numeric(10,2),
              ${patch.soldQty !== undefined}::boolean,
              ${patch.soldQty ?? null}::integer,
              ${patch.priceBasis !== undefined}::boolean,
              ${patch.priceBasis ?? null}::price_basis
            )`),
            sql`, `,
          )}
        ),
        current_window AS (
          SELECT DISTINCT ON (m.period)
            m.period, m.price, m.shipping, m.sold_qty, m.price_basis
          FROM ${marketSnapshots} m
          JOIN window_input i ON i.period = m.period
          WHERE m.part_id = ${partId}
          ORDER BY m.period, m.captured_at DESC, m.id DESC
        ),
        inserted_windows AS (
          INSERT INTO ${marketSnapshots}
            (part_id, period, price, shipping, sold_qty, source, price_basis, sample_size, captured_at)
          SELECT
            ${partId}, i.period,
            CASE WHEN i.has_price THEN i.price ELSE c.price END,
            CASE WHEN i.has_shipping THEN i.shipping ELSE c.shipping END,
            CASE WHEN i.has_sold_qty THEN i.sold_qty ELSE c.sold_qty END,
            'manual'::snapshot_source,
            CASE WHEN i.has_basis THEN i.price_basis ELSE COALESCE(c.price_basis, 'unknown'::price_basis) END,
            NULL, now()
          FROM window_input i
          LEFT JOIN current_window c ON c.period = i.period
          RETURNING 1
        )`
      : sql`inserted_windows AS (SELECT 1 WHERE false)`

  const activeCtes = active
    ? sql`
      active_current AS (
        SELECT asking_price, asking_shipping, active_qty
        FROM ${activeMarketSnapshots}
        WHERE part_id = ${partId}
        ORDER BY captured_at DESC, id DESC
        LIMIT 1
      ),
      inserted_active AS (
        INSERT INTO ${activeMarketSnapshots}
          (part_id, asking_price, asking_shipping, active_qty, source, sample_size,
           broad_match_count, mpn_rejected_count, condition_rejected_count, truncated, captured_at)
        SELECT
          ${partId},
          CASE WHEN ${active.askingPrice !== undefined}::boolean THEN ${toDbNumeric(active.askingPrice)}::numeric(10,2) ELSE c.asking_price END,
          CASE WHEN ${active.askingShipping !== undefined}::boolean THEN ${toDbNumeric(active.askingShipping)}::numeric(10,2) ELSE c.asking_shipping END,
          CASE WHEN ${active.activeQty !== undefined}::boolean THEN ${active.activeQty ?? null}::integer ELSE c.active_qty END,
          ${(active.source ?? 'manual')}::snapshot_source,
          ${active.source === 'ebay_browse' ? (active.sampleSize ?? null) : null}::integer,
          ${active.source === 'ebay_browse' ? (active.broadMatchCount ?? null) : null}::integer,
          ${active.source === 'ebay_browse' ? (active.mpnRejectedCount ?? null) : null}::integer,
          ${active.source === 'ebay_browse' ? (active.conditionRejectedCount ?? null) : null}::integer,
          ${active.source === 'ebay_browse' ? (active.truncated ?? false) : false}::boolean, now()
        FROM (SELECT 1) seed
        LEFT JOIN active_current c ON true
        RETURNING 1
      )`
    : sql`inserted_active AS (SELECT 1 WHERE false)`

  await db.execute(sql`
    WITH ${windowCtes}, ${activeCtes}
    SELECT
      (SELECT count(*)::int FROM inserted_windows) +
      (SELECT count(*)::int FROM inserted_active) AS written
  `)

  // The statement either succeeds atomically or throws; its write cardinality is
  // deterministic from the validated patches and does not depend on driver-specific
  // execute() result shapes (Neon HTTP vs PGlite in tests).
  return windows.length + (active ? 1 : 0)
}

// ─── Sync writes ──────────────────────────────────────────────────────────────

export type SyncSoldSnapshot = {
  partId: number
  period: Period
  price: number | null
  shipping: number | null
  soldQty: number | null
  source: 'ebay_insights'
  sampleSize: number | null
}

export async function insertSoldSnapshots(rows: SyncSoldSnapshot[]): Promise<number> {
  if (rows.length === 0) return 0
  await db.insert(marketSnapshots).values(
    rows.map((row) => ({
      partId: row.partId,
      period: row.period,
      price: toDbNumeric(row.price),
      shipping: toDbNumeric(row.shipping),
      soldQty: row.soldQty,
      source: row.source,
      priceBasis: 'sold' as const,
      sampleSize: row.sampleSize,
    })),
  )
  return rows.length
}

export type SyncActiveSnapshot = {
  partId: number
  askingPrice: number | null
  askingShipping: number | null
  activeQty: number | null
  sampleSize: number | null
  broadMatchCount: number | null
  mpnRejectedCount: number | null
  conditionRejectedCount: number | null
  truncated: boolean
}

export async function insertActiveSnapshots(rows: SyncActiveSnapshot[]): Promise<number> {
  if (rows.length === 0) return 0
  await db.insert(activeMarketSnapshots).values(
    rows.map((row) => ({
      ...row,
      source: 'ebay_browse' as const,
      askingPrice: toDbNumeric(row.askingPrice),
      askingShipping: toDbNumeric(row.askingShipping),
    })),
  )
  return rows.length
}

// ─── Historical trend summaries ──────────────────────────────────────────────

const HISTORY_PERIOD_PREFERENCE: Period[] = ['30d', '7d', '90d']
const HISTORY_LOOKBACK_DAYS = 365

function pickHistoricalTrend(
  rows: { period: Period; capturedAt: Date; value: number | null }[],
): { trend: ReturnType<typeof timeTrend>; period: Period | null } {
  let fallback: { trend: ReturnType<typeof timeTrend>; period: Period | null } = {
    trend: timeTrend([]),
    period: null,
  }

  for (const period of HISTORY_PERIOD_PREFERENCE) {
    const trend = timeTrend(
      rows.filter((row) => row.period === period).map((row) => ({ at: row.capturedAt, value: row.value })),
    )
    if (trend.qualified) return { trend, period }
    if (trend.points > fallback.trend.points) fallback = { trend, period }
  }
  return fallback
}

export async function loadTrendSummaries(partIds: number[]): Promise<Map<number, TrendSummary>> {
  const summaries = new Map<number, TrendSummary>()
  if (partIds.length === 0) return summaries

  const cutoff = new Date(Date.now() - HISTORY_LOOKBACK_DAYS * 86_400_000)
  const [soldRows, activeRows] = await Promise.all([
    db
      .select({
        partId: marketSnapshots.partId,
        period: marketSnapshots.period,
        price: marketSnapshots.price,
        shipping: marketSnapshots.shipping,
        soldQty: marketSnapshots.soldQty,
        priceBasis: marketSnapshots.priceBasis,
        capturedAt: marketSnapshots.capturedAt,
      })
      .from(marketSnapshots)
      .where(
        and(
          inArray(marketSnapshots.partId, partIds),
          inArray(marketSnapshots.period, HISTORY_PERIOD_PREFERENCE),
          gte(marketSnapshots.capturedAt, cutoff),
        ),
      )
      .orderBy(marketSnapshots.partId, marketSnapshots.capturedAt),
    db
      .select({
        partId: activeMarketSnapshots.partId,
        activeQty: activeMarketSnapshots.activeQty,
        capturedAt: activeMarketSnapshots.capturedAt,
      })
      .from(activeMarketSnapshots)
      .where(
        and(
          inArray(activeMarketSnapshots.partId, partIds),
          gte(activeMarketSnapshots.capturedAt, cutoff),
        ),
      )
      .orderBy(activeMarketSnapshots.partId, activeMarketSnapshots.capturedAt),
  ])

  for (const partId of partIds) {
    const partSold = soldRows.filter((row) => row.partId === partId)

    const priceRows = partSold
      .filter((row) => row.priceBasis === 'sold')
      .map((row) => ({
        period: row.period,
        capturedAt: row.capturedAt,
        value:
          toNumber(row.price) == null
            ? null
            : (toNumber(row.price) as number) + (toNumber(row.shipping) ?? 0),
      }))
    const market = pickHistoricalTrend(priceRows)

    const demandRows = partSold.map((row) => ({
      period: row.period,
      capturedAt: row.capturedAt,
      value: row.soldQty == null ? null : row.soldQty / PERIOD_DAYS[row.period],
    }))
    const demand = pickHistoricalTrend(demandRows)

    const supply = timeTrend(
      activeRows
        .filter((row) => row.partId === partId)
        .map((row) => ({ at: row.capturedAt, value: row.activeQty })),
    )

    summaries.set(partId, {
      marketPctPer30d: market.trend.pctPer30d,
      marketPoints: market.trend.points,
      marketSpanDays: market.trend.spanDays,
      marketPeriod: market.period,
      demandPctPer30d: demand.trend.pctPer30d,
      demandPoints: demand.trend.points,
      demandSpanDays: demand.trend.spanDays,
      demandPeriod: demand.period,
      supplyPctPer30d: supply.pctPer30d,
      supplyPoints: supply.points,
      supplySpanDays: supply.spanDays,
    })
  }

  return summaries
}

// ─── Sync runs ────────────────────────────────────────────────────────────────

export async function startSyncRun(trigger: 'cron' | 'manual'): Promise<number> {
  const rows = await db.insert(ebaySyncRuns).values({ trigger }).returning({ id: ebaySyncRuns.id })
  if (!rows[0]) throw new Error('Could not open a sync run')
  return rows[0].id
}

export async function finishSyncRun(
  id: number,
  result: {
    status: 'success' | 'partial' | 'failed'
    adapter?: string | null
    partsProcessed?: number
    partsFailed?: number
    snapshotsWritten?: number
    soldSnapshotsWritten?: number
    activeSnapshotsWritten?: number
    error?: string | null
  },
): Promise<void> {
  await db
    .update(ebaySyncRuns)
    .set({
      status: result.status,
      adapter: result.adapter ?? null,
      partsProcessed: result.partsProcessed ?? 0,
      partsFailed: result.partsFailed ?? 0,
      snapshotsWritten: result.snapshotsWritten ?? 0,
      soldSnapshotsWritten: result.soldSnapshotsWritten ?? 0,
      activeSnapshotsWritten: result.activeSnapshotsWritten ?? 0,
      error: result.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(ebaySyncRuns.id, id))
}

export async function recentSyncRuns(limit = 10) {
  return db.select().from(ebaySyncRuns).orderBy(desc(ebaySyncRuns.startedAt)).limit(limit)
}

export async function databaseReachable(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`)
    return true
  } catch {
    return false
  }
}
