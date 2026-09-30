/** Lookback windows, ordered oldest -> newest. Order is load-bearing: the
 *  trend regression and every chart read this array left to right as time. */
export const PERIODS = ['1yr', '6m', '90d', '30d', '7d'] as const
export type Period = (typeof PERIODS)[number]

export const PERIOD_LABELS: Record<Period, string> = {
  '1yr': '1 Year',
  '6m': '6 Months',
  '90d': '90 Days',
  '30d': '30 Days',
  '7d': '7 Days',
}

/** Approximate days each window spans. Used to size eBay date filters. */
export const PERIOD_DAYS: Record<Period, number> = {
  '1yr': 365,
  '6m': 182,
  '90d': 90,
  '30d': 30,
  '7d': 7,
}

export type SnapshotSource = 'manual' | 'ebay_browse' | 'ebay_insights'

export const SOURCE_LABELS: Record<SnapshotSource, string> = {
  manual: 'Manual',
  ebay_browse: 'Active listings',
  ebay_insights: 'Sold comps',
}

/**
 * Whether a source reflects completed sales. Asking prices on active listings
 * are not comps — an unsold listing at $200 tells you nothing about what the
 * part fetches. The UI flags decisions built on asking prices.
 */
export const SOURCE_IS_SOLD: Record<SnapshotSource, boolean> = {
  manual: true,
  ebay_browse: false,
  ebay_insights: true,
}

export type PeriodObservation = {
  price: number | null
  shipping: number | null
  qty: number | null
  source: SnapshotSource
  sampleSize: number | null
  capturedAt: string
}

export type Part = {
  id: number
  mpn: string
  description: string
  category: string
  inventoryQty: number
  costBasis: number | null
  shipCost: number | null
  targetMarginPct: number | null
  sourceUrl: string | null
  notes: string | null
  active: boolean
  updatedAt: string
}

export type EconomicSettings = {
  feePct: number
  feeFixed: number
  defaultShipCost: number
  targetMarginPct: number
  minMarginPct: number
}

export type PartWithMarket = Part & {
  /** Newest observation per window. Missing windows are simply absent. */
  periods: Partial<Record<Period, PeriodObservation>>
}
