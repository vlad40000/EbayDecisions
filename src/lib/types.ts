/** Lookback windows for sold-market aggregates, oldest -> newest. */
export const PERIODS = ['1yr', '6m', '90d', '30d', '7d'] as const
export type Period = (typeof PERIODS)[number]

export const PERIOD_LABELS: Record<Period, string> = {
  '1yr': '1 Year',
  '6m': '6 Months',
  '90d': '90 Days',
  '30d': '30 Days',
  '7d': '7 Days',
}

/** Approximate span represented by each sold-data aggregate. */
export const PERIOD_DAYS: Record<Period, number> = {
  '1yr': 365,
  '6m': 182,
  '90d': 90,
  '30d': 30,
  '7d': 7,
}

export type SnapshotSource = 'manual' | 'ebay_browse' | 'ebay_insights'
export type PriceBasis = 'unknown' | 'sold' | 'asking'

export const SOURCE_LABELS: Record<SnapshotSource, string> = {
  manual: 'Manual',
  ebay_browse: 'eBay active listings',
  ebay_insights: 'eBay sold comps',
}

export const PRICE_BASIS_LABELS: Record<PriceBasis, string> = {
  unknown: 'Unknown basis',
  sold: 'Sold comps',
  asking: 'Asking prices',
}

export type PeriodObservation = {
  price: number | null
  shipping: number | null
  /** Units sold inside this lookback window. Never active-listing count. */
  soldQty: number | null
  soldPriceMin?: number | null
  soldPriceMax?: number | null
  totalSellers?: number | null
  sellThroughPct?: number | null
  freeShippingPct?: number | null
  researchSessionId?: number | null
  source: SnapshotSource
  priceBasis: PriceBasis
  sampleSize: number | null
  capturedAt: string
}

/** Active competition is a point-in-time observation, not a lookback window. */
export type ActiveMarketObservation = {
  askingPrice: number | null
  askingShipping: number | null
  activeQty: number | null
  source: 'manual' | 'ebay_browse'
  sampleSize: number | null
  broadMatchCount: number | null
  mpnRejectedCount: number | null
  conditionRejectedCount: number | null
  truncated: boolean
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
  /** Newest sold/market observation per lookback window. */
  periods: Partial<Record<Period, PeriodObservation>>
  /** Newest point-in-time active competition observation. */
  activeMarket: ActiveMarketObservation | null
}

export type MarketResearchSession = {
  id: number
  partId: number
  researchedAt: string
  source: string
  notes: string | null
  createdAt: string
  periods: Partial<Record<Period, PeriodObservation>>
}

export type TrendBasis = 'history' | 'window-curve' | 'window-velocity' | 'insufficient'

export type TrendSummary = {
  marketPctPer30d: number | null
  marketPoints: number
  marketSpanDays: number
  marketPeriod: Period | null
  demandPctPer30d: number | null
  demandPoints: number
  demandSpanDays: number
  demandPeriod: Period | null
  supplyPctPer30d: number | null
  supplyPoints: number
  supplySpanDays: number
}
