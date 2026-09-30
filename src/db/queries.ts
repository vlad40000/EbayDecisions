import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import { categoryOf } from '@/lib/categories'
import { toDbNumeric, toNumber } from '@/lib/format'
import type {
  EconomicSettings,
  Part,
  PartWithMarket,
  Period,
  PeriodObservation,
  SnapshotSource,
} from '@/lib/types'

import { db } from './index'
import {
  ebaySyncRuns,
  marketSnapshots,
  parts,
  settings,
  type PartRow,
  type SnapshotRow,
} from './schema'

/**
 * A manual edit within this window updates the row it is editing instead of
 * appending a new one, so typing into three fields of one window produces one
 * snapshot rather than three near-identical ones. Longer gaps append, which is
 * what preserves the history the trend math reads.
 */
const MANUAL_COALESCE_MINUTES = 10

// ─── Mapping ──────────────────────────────────────────────────────────────────

function mapPart(row: PartRow): Part {
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
  qty: number | null
  source: SnapshotSource
  sampleSize: number | null
  capturedAt: Date
}): PeriodObservation {
  return {
    price: toNumber(row.price),
    shipping: toNumber(row.shipping),
    qty: row.qty,
    source: row.source,
    sampleSize: row.sampleSize,
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

/** Reads the single settings row, creating it with defaults on first call. */
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

export async function getPartByMpn(mpn: string): Promise<Part | null> {
  const rows = await db.select().from(parts).where(eq(parts.mpn, mpn)).limit(1)
  const row = rows[0]
  return row ? mapPart(row) : null
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

  const row = rows[0]
  if (!row) throw new Error('Insert returned no row')
  return mapPart(row)
}

export async function updatePart(id: number, input: Partial<PartInput>): Promise<void> {
  await db
    .update(parts)
    .set({
      ...(input.mpn !== undefined ? { mpn: input.mpn.trim() } : {}),
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

/** Upsert by MPN. Used by the seed script and the CSV importer. */
export async function upsertPartByMpn(input: PartInput): Promise<'inserted' | 'updated'> {
  const existing = await db
    .select({ id: parts.id })
    .from(parts)
    .where(eq(parts.mpn, input.mpn.trim()))
    .limit(1)

  const found = existing[0]
  if (found) {
    await updatePart(found.id, input)
    return 'updated'
  }
  await createPart(input)
  return 'inserted'
}

// ─── Snapshots ────────────────────────────────────────────────────────────────

/**
 * Newest observation per (part, period) for the given parts.
 *
 * `DISTINCT ON` is the Postgres-native way to do a latest-per-group read in one
 * pass, and it uses the (part_id, period, captured_at DESC) index directly.
 */
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
      qty: marketSnapshots.qty,
      source: marketSnapshots.source,
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
    existing[row.period] = mapObservation(row)
    byPart.set(row.partId, existing)
  }

  return byPart
}

export async function listPartsWithMarket(
  options: { includeInactive?: boolean } = {},
): Promise<PartWithMarket[]> {
  const rows = await listParts(options)
  const snapshots = await latestSnapshots(rows.map((p) => p.id))
  return rows.map((part) => ({ ...part, periods: snapshots.get(part.id) ?? {} }))
}

export async function getPartWithMarket(mpn: string): Promise<PartWithMarket | null> {
  const part = await getPartByMpn(mpn)
  if (!part) return null
  const snapshots = await latestSnapshots([part.id])
  return { ...part, periods: snapshots.get(part.id) ?? {} }
}

/** Full snapshot history for one part, newest first. Powers the history chart. */
export async function snapshotHistory(partId: number, limit = 500): Promise<SnapshotRow[]> {
  return db
    .select()
    .from(marketSnapshots)
    .where(eq(marketSnapshots.partId, partId))
    .orderBy(desc(marketSnapshots.capturedAt))
    .limit(limit)
}

export type ManualSnapshotPatch = {
  price?: number | null
  shipping?: number | null
  qty?: number | null
}

/**
 * Records a manual edit to one window.
 *
 * Two behaviours worth knowing:
 *
 * 1. A recent manual row for the same window is updated in place
 *    (MANUAL_COALESCE_MINUTES), so an editing session leaves one row.
 * 2. When a new row is appended, the untouched fields are carried forward from
 *    whatever the current values are — otherwise typing a price would silently
 *    blank the shipping figure sitting next to it. The new row is marked
 *    `manual` because a person set it.
 */
export async function saveManualSnapshot(
  partId: number,
  period: Period,
  patch: ManualSnapshotPatch,
): Promise<void> {
  const latest = await db
    .select()
    .from(marketSnapshots)
    .where(and(eq(marketSnapshots.partId, partId), eq(marketSnapshots.period, period)))
    .orderBy(desc(marketSnapshots.capturedAt), desc(marketSnapshots.id))
    .limit(1)

  const current = latest[0]
  const cutoff = Date.now() - MANUAL_COALESCE_MINUTES * 60 * 1000

  const merged = {
    price:
      patch.price !== undefined ? toDbNumeric(patch.price) : (current?.price ?? null),
    shipping:
      patch.shipping !== undefined ? toDbNumeric(patch.shipping) : (current?.shipping ?? null),
    qty: patch.qty !== undefined ? patch.qty : (current?.qty ?? null),
  }

  if (current && current.source === 'manual' && current.capturedAt.getTime() >= cutoff) {
    await db
      .update(marketSnapshots)
      .set({ ...merged, capturedAt: new Date() })
      .where(eq(marketSnapshots.id, current.id))
    return
  }

  await db.insert(marketSnapshots).values({
    partId,
    period,
    ...merged,
    source: 'manual',
    sampleSize: null,
  })
}

export type SyncSnapshot = {
  partId: number
  period: Period
  price: number | null
  shipping: number | null
  qty: number | null
  source: SnapshotSource
  sampleSize: number | null
}

/** Batch-appends snapshots produced by a sync run. */
export async function insertSnapshots(rows: SyncSnapshot[]): Promise<number> {
  if (rows.length === 0) return 0
  await db.insert(marketSnapshots).values(
    rows.map((row) => ({
      partId: row.partId,
      period: row.period,
      price: toDbNumeric(row.price),
      shipping: toDbNumeric(row.shipping),
      qty: row.qty,
      source: row.source,
      sampleSize: row.sampleSize,
    })),
  )
  return rows.length
}

// ─── Sync runs ────────────────────────────────────────────────────────────────

export async function startSyncRun(trigger: 'cron' | 'manual'): Promise<number> {
  const rows = await db.insert(ebaySyncRuns).values({ trigger }).returning({ id: ebaySyncRuns.id })
  const row = rows[0]
  if (!row) throw new Error('Could not open a sync run')
  return row.id
}

export async function finishSyncRun(
  id: number,
  result: {
    status: 'success' | 'partial' | 'failed'
    adapter?: string | null
    partsProcessed?: number
    partsFailed?: number
    snapshotsWritten?: number
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
      error: result.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(ebaySyncRuns.id, id))
}

export async function recentSyncRuns(limit = 10) {
  return db.select().from(ebaySyncRuns).orderBy(desc(ebaySyncRuns.startedAt)).limit(limit)
}

/** Cheap connectivity probe used by the settings page. */
export async function databaseReachable(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`)
    return true
  } catch {
    return false
  }
}
