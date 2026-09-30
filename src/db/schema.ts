import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const periodEnum = pgEnum('period', ['1yr', '6m', '90d', '30d', '7d'])

export const snapshotSourceEnum = pgEnum('snapshot_source', [
  'manual',
  'ebay_browse',
  'ebay_insights',
])

export const priceBasisEnum = pgEnum('price_basis', ['unknown', 'sold', 'asking'])

export const syncStatusEnum = pgEnum('sync_status', [
  'running',
  'success',
  'partial',
  'failed',
])

export const parts = pgTable(
  'parts',
  {
    id: serial('id').primaryKey(),
    mpn: text('mpn').notNull(),
    description: text('description').notNull(),
    category: text('category'),
    inventoryQty: integer('inventory_qty').notNull().default(0),
    costBasis: numeric('cost_basis', { precision: 10, scale: 2 }),
    shipCost: numeric('ship_cost', { precision: 10, scale: 2 }),
    targetMarginPct: numeric('target_margin_pct', { precision: 5, scale: 2 }),
    sourceUrl: text('source_url'),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('parts_mpn_unique').on(t.mpn),
    index('parts_active_idx').on(t.active),
    index('parts_description_idx').on(t.description),
    index('parts_category_idx').on(t.category),
    check('parts_inventory_qty_nonneg', sql`${t.inventoryQty} >= 0`),
    check(
      'parts_cost_basis_sane',
      sql`${t.costBasis} IS NULL OR (${t.costBasis} >= 0 AND ${t.costBasis} <= 1000000)`,
    ),
    check(
      'parts_ship_cost_sane',
      sql`${t.shipCost} IS NULL OR (${t.shipCost} >= 0 AND ${t.shipCost} <= 1000000)`,
    ),
    check(
      'parts_target_margin_sane',
      sql`${t.targetMarginPct} IS NULL OR (${t.targetMarginPct} >= 0 AND ${t.targetMarginPct} < 100)`,
    ),
  ],
)

export const marketResearchSessions = pgTable(
  'market_research_sessions',
  {
    id: serial('id').primaryKey(),
    partId: integer('part_id')
      .notNull()
      .references(() => parts.id, { onDelete: 'cascade' }),
    researchedAt: timestamp('researched_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').notNull().default('ebay_product_research_manual'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('research_sessions_part_researched_idx').on(
      t.partId,
      t.researchedAt.desc(),
      t.id.desc(),
    ),
    index('research_sessions_researched_idx').on(t.researchedAt.desc()),
  ],
)

/**
 * Append-only sold/market aggregates for the five lookback windows.
 *
 * `soldQty` always means units sold in that window. It is never reused for the
 * number of currently active listings. `priceBasis` makes a manual price's
 * meaning explicit instead of silently treating every manual number as a comp.
 *
 * `legacyQty` preserves pre-migration ambiguous quantities for audit only. New
 * code never reads or writes it.
 */
export const marketSnapshots = pgTable(
  'market_snapshots',
  {
    id: serial('id').primaryKey(),
    partId: integer('part_id')
      .notNull()
      .references(() => parts.id, { onDelete: 'cascade' }),
    researchSessionId: integer('research_session_id').references(() => marketResearchSessions.id, {
      onDelete: 'set null',
    }),
    period: periodEnum('period').notNull(),
    price: numeric('price', { precision: 10, scale: 2 }),
    shipping: numeric('shipping', { precision: 10, scale: 2 }),
    legacyQty: integer('legacy_qty'),
    soldQty: integer('sold_qty'),
    soldPriceMin: numeric('sold_price_min', { precision: 10, scale: 2 }),
    soldPriceMax: numeric('sold_price_max', { precision: 10, scale: 2 }),
    totalSellers: integer('total_sellers'),
    sellThroughPct: numeric('sell_through_pct', { precision: 8, scale: 2 }),
    freeShippingPct: numeric('free_shipping_pct', { precision: 5, scale: 2 }),
    source: snapshotSourceEnum('source').notNull().default('manual'),
    priceBasis: priceBasisEnum('price_basis').notNull().default('unknown'),
    sampleSize: integer('sample_size'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('snapshots_part_period_captured_idx').on(t.partId, t.period, t.capturedAt.desc()),
    index('snapshots_research_session_period_idx').on(t.researchSessionId, t.period),
    check(
      'snapshots_price_sane',
      sql`${t.price} IS NULL OR (${t.price} >= 0 AND ${t.price} <= 1000000)`,
    ),
    check(
      'snapshots_shipping_sane',
      sql`${t.shipping} IS NULL OR (${t.shipping} >= 0 AND ${t.shipping} <= 1000000)`,
    ),
    check('snapshots_legacy_qty_nonneg', sql`${t.legacyQty} IS NULL OR ${t.legacyQty} >= 0`),
    check('snapshots_sold_qty_nonneg', sql`${t.soldQty} IS NULL OR ${t.soldQty} >= 0`),
    check(
      'snapshots_sold_price_min_sane',
      sql`${t.soldPriceMin} IS NULL OR (${t.soldPriceMin} >= 0 AND ${t.soldPriceMin} <= 1000000)`,
    ),
    check(
      'snapshots_sold_price_max_sane',
      sql`${t.soldPriceMax} IS NULL OR (${t.soldPriceMax} >= 0 AND ${t.soldPriceMax} <= 1000000)`,
    ),
    check(
      'snapshots_sold_price_range_sane',
      sql`${t.soldPriceMin} IS NULL OR ${t.soldPriceMax} IS NULL OR ${t.soldPriceMin} <= ${t.soldPriceMax}`,
    ),
    check('snapshots_total_sellers_nonneg', sql`${t.totalSellers} IS NULL OR ${t.totalSellers} >= 0`),
    check('snapshots_sell_through_nonneg', sql`${t.sellThroughPct} IS NULL OR ${t.sellThroughPct} >= 0`),
    check(
      'snapshots_free_shipping_pct_sane',
      sql`${t.freeShippingPct} IS NULL OR (${t.freeShippingPct} >= 0 AND ${t.freeShippingPct} <= 100)`,
    ),
  ],
)

/**
 * Point-in-time active competition. Asking prices and active listing count are
 * current-state observations, not 7d/30d/90d aggregates, so they have their own
 * stream and their trend is computed across capture dates.
 */
export const activeMarketSnapshots = pgTable(
  'active_market_snapshots',
  {
    id: serial('id').primaryKey(),
    partId: integer('part_id')
      .notNull()
      .references(() => parts.id, { onDelete: 'cascade' }),
    askingPrice: numeric('asking_price', { precision: 10, scale: 2 }),
    askingShipping: numeric('asking_shipping', { precision: 10, scale: 2 }),
    activeQty: integer('active_qty'),
    source: snapshotSourceEnum('source').notNull().default('manual'),
    sampleSize: integer('sample_size'),
    broadMatchCount: integer('broad_match_count'),
    mpnRejectedCount: integer('mpn_rejected_count'),
    conditionRejectedCount: integer('condition_rejected_count'),
    truncated: boolean('truncated').notNull().default(false),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('active_snapshots_part_captured_idx').on(t.partId, t.capturedAt.desc()),
    check(
      'active_snapshots_price_sane',
      sql`${t.askingPrice} IS NULL OR (${t.askingPrice} >= 0 AND ${t.askingPrice} <= 1000000)`,
    ),
    check(
      'active_snapshots_shipping_sane',
      sql`${t.askingShipping} IS NULL OR (${t.askingShipping} >= 0 AND ${t.askingShipping} <= 1000000)`,
    ),
    check('active_snapshots_qty_nonneg', sql`${t.activeQty} IS NULL OR ${t.activeQty} >= 0`),
    check('active_snapshots_sample_nonneg', sql`${t.sampleSize} IS NULL OR ${t.sampleSize} >= 0`),
  ],
)

export const settings = pgTable(
  'settings',
  {
    id: integer('id').primaryKey().default(1),
    feePct: numeric('fee_pct', { precision: 5, scale: 2 }).notNull().default('13.25'),
    feeFixed: numeric('fee_fixed', { precision: 10, scale: 2 }).notNull().default('0.30'),
    defaultShipCost: numeric('default_ship_cost', { precision: 10, scale: 2 })
      .notNull()
      .default('12.00'),
    targetMarginPct: numeric('target_margin_pct', { precision: 5, scale: 2 })
      .notNull()
      .default('35.00'),
    minMarginPct: numeric('min_margin_pct', { precision: 5, scale: 2 })
      .notNull()
      .default('15.00'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('settings_single_row', sql`${t.id} = 1`),
    check('settings_fee_pct_sane', sql`${t.feePct} >= 0 AND ${t.feePct} < 100`),
    check('settings_fee_fixed_sane', sql`${t.feeFixed} >= 0 AND ${t.feeFixed} <= 1000`),
    check(
      'settings_ship_cost_sane',
      sql`${t.defaultShipCost} >= 0 AND ${t.defaultShipCost} <= 1000000`,
    ),
    check(
      'settings_target_margin_sane',
      sql`${t.targetMarginPct} >= 0 AND ${t.targetMarginPct} < 100`,
    ),
    check('settings_min_margin_sane', sql`${t.minMarginPct} >= 0 AND ${t.minMarginPct} < 100`),
    check('settings_floor_below_target', sql`${t.minMarginPct} <= ${t.targetMarginPct}`),
  ],
)

export const ebaySyncRuns = pgTable(
  'ebay_sync_runs',
  {
    id: serial('id').primaryKey(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: syncStatusEnum('status').notNull().default('running'),
    adapter: text('adapter'),
    trigger: text('trigger').notNull().default('manual'),
    partsProcessed: integer('parts_processed').notNull().default(0),
    partsFailed: integer('parts_failed').notNull().default(0),
    snapshotsWritten: integer('snapshots_written').notNull().default(0),
    soldSnapshotsWritten: integer('sold_snapshots_written').notNull().default(0),
    activeSnapshotsWritten: integer('active_snapshots_written').notNull().default(0),
    error: text('error'),
  },
  (t) => [index('sync_runs_started_idx').on(t.startedAt.desc())],
)

export type PartRow = typeof parts.$inferSelect
export type NewPartRow = typeof parts.$inferInsert
export type ResearchSessionRow = typeof marketResearchSessions.$inferSelect
export type NewResearchSessionRow = typeof marketResearchSessions.$inferInsert
export type SnapshotRow = typeof marketSnapshots.$inferSelect
export type NewSnapshotRow = typeof marketSnapshots.$inferInsert
export type ActiveSnapshotRow = typeof activeMarketSnapshots.$inferSelect
export type NewActiveSnapshotRow = typeof activeMarketSnapshots.$inferInsert
export type SettingsRow = typeof settings.$inferSelect
export type SyncRunRow = typeof ebaySyncRuns.$inferSelect
