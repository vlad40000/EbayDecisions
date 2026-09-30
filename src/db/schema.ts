import {
  boolean,
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

/**
 * Lookback windows tracked per part. Ordered oldest -> newest everywhere in the
 * app so regressions and charts read left-to-right as time moving forward.
 */
export const periodEnum = pgEnum('period', ['1yr', '6m', '90d', '30d', '7d'])

/**
 * Where a market number came from. This matters a great deal: a Browse API
 * number is an *asking* price on an active listing, while an Insights number is
 * a real *sold* comp. Mixing them silently would corrupt pricing decisions, so
 * the source is stored on every row and surfaced in the UI.
 */
export const snapshotSourceEnum = pgEnum('snapshot_source', [
  'manual',
  'ebay_browse',
  'ebay_insights',
])

export const syncStatusEnum = pgEnum('sync_status', ['running', 'success', 'partial', 'failed'])

export const parts = pgTable(
  'parts',
  {
    id: serial('id').primaryKey(),
    mpn: text('mpn').notNull(),
    description: text('description').notNull(),
    /** Overrides the description-derived category when set. */
    category: text('category'),
    inventoryQty: integer('inventory_qty').notNull().default(0),
    /**
     * What this unit cost you. NULL means unknown (margin cannot be computed).
     * 0 is a legitimate, meaningful value: a part pulled off a scrapped machine
     * has no marginal cost. The decision engine treats NULL and 0 differently.
     */
    costBasis: numeric('cost_basis', { precision: 10, scale: 2 }),
    /** Your actual cost to ship this part. Falls back to the global default. */
    shipCost: numeric('ship_cost', { precision: 10, scale: 2 }),
    /** Per-part target margin override, in percent. Falls back to global. */
    targetMarginPct: numeric('target_margin_pct', { precision: 5, scale: 2 }),
    sourceUrl: text('source_url'),
    notes: text('notes'),
    /** Inactive parts are hidden from the board and skipped by sync. */
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('parts_mpn_unique').on(t.mpn), index('parts_active_idx').on(t.active)],
)

/**
 * Append-only market observations.
 *
 * Each row is one reading of one window for one part. Nothing is ever
 * overwritten by a sync, so you keep a real history of how the 30-day comp
 * moved week to week — which is what the trend math and the charts read.
 *
 * "Current" values are the newest row per (part, period), via DISTINCT ON.
 * Rapid manual typing is coalesced in the write path (see queries.ts) so a
 * single editing session produces one row per field set, not one per keystroke.
 */
export const marketSnapshots = pgTable(
  'market_snapshots',
  {
    id: serial('id').primaryKey(),
    partId: integer('part_id')
      .notNull()
      .references(() => parts.id, { onDelete: 'cascade' }),
    period: periodEnum('period').notNull(),
    /** Item price, excluding shipping. */
    price: numeric('price', { precision: 10, scale: 2 }),
    /** Shipping the buyer pays, as observed in comps. */
    shipping: numeric('shipping', { precision: 10, scale: 2 }),
    /** Units observed: sold count for Insights, active listing count for Browse. */
    qty: integer('qty'),
    source: snapshotSourceEnum('source').notNull().default('manual'),
    /** How many comps the aggregate was computed from. NULL for manual entry. */
    sampleSize: integer('sample_size'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Drives the DISTINCT ON latest-per-period read path.
    index('snapshots_part_period_captured_idx').on(t.partId, t.period, t.capturedAt.desc()),
  ],
)

/**
 * Single-row settings table (id is always 1). Holds the fee and margin
 * assumptions the decision engine runs on, so they are auditable and editable
 * without a redeploy.
 */
export const settings = pgTable('settings', {
  id: integer('id').primaryKey().default(1),
  /** eBay final value fee, percent of the total order including shipping. */
  feePct: numeric('fee_pct', { precision: 5, scale: 2 }).notNull().default('13.25'),
  /** Fixed per-order fee in dollars. */
  feeFixed: numeric('fee_fixed', { precision: 10, scale: 2 }).notNull().default('0.30'),
  /** Used when a part has no shipCost of its own. */
  defaultShipCost: numeric('default_ship_cost', { precision: 10, scale: 2 })
    .notNull()
    .default('12.00'),
  /** Margin you want, percent of net proceeds. At/above this, list it. */
  targetMarginPct: numeric('target_margin_pct', { precision: 5, scale: 2 })
    .notNull()
    .default('35.00'),
  /** Margin floor. Below this, the part is a problem. */
  minMarginPct: numeric('min_margin_pct', { precision: 5, scale: 2 }).notNull().default('15.00'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const ebaySyncRuns = pgTable(
  'ebay_sync_runs',
  {
    id: serial('id').primaryKey(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: syncStatusEnum('status').notNull().default('running'),
    /** 'browse' | 'insights' — which adapter actually ran. */
    adapter: text('adapter'),
    /** 'cron' | 'manual' */
    trigger: text('trigger').notNull().default('manual'),
    partsProcessed: integer('parts_processed').notNull().default(0),
    partsFailed: integer('parts_failed').notNull().default(0),
    snapshotsWritten: integer('snapshots_written').notNull().default(0),
    error: text('error'),
  },
  (t) => [index('sync_runs_started_idx').on(t.startedAt.desc())],
)

export type PartRow = typeof parts.$inferSelect
export type NewPartRow = typeof parts.$inferInsert
export type SnapshotRow = typeof marketSnapshots.$inferSelect
export type NewSnapshotRow = typeof marketSnapshots.$inferInsert
export type SettingsRow = typeof settings.$inferSelect
export type SyncRunRow = typeof ebaySyncRuns.$inferSelect
