import { describe, expect, it } from 'vitest'

import { computeEconomics, decide, suggestedListPrice } from '@/lib/decisions'
import { median, spacedWindowTrend, timeTrend } from '@/lib/stats'
import type {
  EconomicSettings,
  PartWithMarket,
  Period,
  PeriodObservation,
  TrendSummary,
} from '@/lib/types'

const SETTINGS: EconomicSettings = {
  feePct: 13.25,
  feeFixed: 0.3,
  defaultShipCost: 12,
  targetMarginPct: 35,
  minMarginPct: 15,
}

function observation(
  price: number | null,
  shipping = 0,
  soldQty: number | null = null,
  priceBasis: PeriodObservation['priceBasis'] = 'sold',
): PeriodObservation {
  return {
    price,
    shipping,
    soldQty,
    source: priceBasis === 'sold' ? 'ebay_insights' : 'manual',
    priceBasis,
    sampleSize: 5,
    capturedAt: '2026-09-30T12:00:00.000Z',
  }
}

function part(overrides: Partial<PartWithMarket> = {}): PartWithMarket {
  return {
    id: 1,
    mpn: 'W11170706',
    description: 'Washer Control Board',
    category: 'Control Boards',
    inventoryQty: 2,
    costBasis: 40,
    shipCost: null,
    targetMarginPct: null,
    sourceUrl: null,
    notes: null,
    active: true,
    updatedAt: '2026-09-30T12:00:00.000Z',
    periods: {},
    activeMarket: null,
    ...overrides,
  }
}

function flatMarket(price: number, shipping = 15, soldQty = 10): PartWithMarket['periods'] {
  const periods: PartWithMarket['periods'] = {}
  for (const key of ['1yr', '6m', '90d', '30d', '7d'] as Period[]) {
    periods[key] = observation(price, shipping, soldQty)
  }
  return periods
}

function summary(overrides: Partial<TrendSummary> = {}): TrendSummary {
  return {
    marketPctPer30d: null,
    marketPoints: 0,
    marketSpanDays: 0,
    marketPeriod: null,
    demandPctPer30d: null,
    demandPoints: 0,
    demandSpanDays: 0,
    demandPeriod: null,
    supplyPctPer30d: null,
    supplyPoints: 0,
    supplySpanDays: 0,
    ...overrides,
  }
}

describe('economics', () => {
  it('charges the percentage fee on item plus buyer shipping', () => {
    const result = computeEconomics({ price: 100, shipping: 15, costBasis: 40, shipCost: 12, settings: SETTINGS })
    expect(result.grossOrder).toBe(115)
    expect(result.fees).toBeCloseTo(15.5375, 6)
    expect(result.netProceeds).toBeCloseTo(87.4625, 6)
    expect(result.marginDollars).toBeCloseTo(47.4625, 6)
  })

  it('keeps zero cost basis distinct from unknown cost basis', () => {
    const free = computeEconomics({ price: 100, shipping: 0, costBasis: 0, shipCost: 12, settings: SETTINGS })
    const unknown = computeEconomics({ price: 100, shipping: 0, costBasis: null, shipCost: 12, settings: SETTINGS })
    expect(free.marginPct).toBeCloseTo(100, 9)
    expect(free.roiPct).toBeNull()
    expect(unknown.marginDollars).toBeNull()
    expect(unknown.marginPct).toBeNull()
  })

  it('uses default actual ship cost when a part has no override', () => {
    const result = computeEconomics({ price: 80, shipping: 10, costBasis: 20, shipCost: null, settings: SETTINGS })
    expect(result.shipCost).toBe(12)
  })
})

describe('suggestedListPrice', () => {
  it('round-trips through the fee model to the requested margin', () => {
    const price = suggestedListPrice({ costBasis: 40, shipping: 15, shipCost: 12, targetMarginPct: 35, settings: SETTINGS })
    expect(price).not.toBeNull()
    const result = computeEconomics({ price: price as number, shipping: 15, costBasis: 40, shipCost: 12, settings: SETTINGS })
    expect(result.marginPct).toBeCloseTo(35, 6)
  })

  it('returns null without a cost basis', () => {
    expect(suggestedListPrice({ costBasis: null, shipping: 0, shipCost: 12, targetMarginPct: 35, settings: SETTINGS })).toBeNull()
  })
})

describe('calendar trend qualification', () => {
  it('requires at least three distinct dates', () => {
    const trend = timeTrend([
      { at: '2026-09-01T10:00:00Z', value: 120 },
      { at: '2026-09-20T10:00:00Z', value: 100 },
    ])
    expect(trend.qualified).toBe(false)
    expect(trend.direction).toBe('unknown')
  })

  it('requires at least 14 days of span', () => {
    const trend = timeTrend([
      { at: '2026-09-01T10:00:00Z', value: 120 },
      { at: '2026-09-04T10:00:00Z', value: 110 },
      { at: '2026-09-08T10:00:00Z', value: 100 },
    ])
    expect(trend.points).toBe(3)
    expect(trend.qualified).toBe(false)
  })

  it('collapses same-day corrections to the latest observation', () => {
    const trend = timeTrend([
      { at: '2026-09-01T08:00:00Z', value: 120 },
      { at: '2026-09-01T12:00:00Z', value: 118 },
      { at: '2026-09-15T12:00:00Z', value: 110 },
      { at: '2026-09-29T12:00:00Z', value: 100 },
    ])
    expect(trend.points).toBe(3)
    expect(trend.spanDays).toBeCloseTo(28, 3)
    expect(trend.qualified).toBe(true)
    expect(trend.direction).toBe('falling')
    expect(Math.abs(trend.pctPer30d ?? 0)).toBeLessThan(100)
  })

  it('uses real day spacing for the current-window curve', () => {
    const trend = spacedWindowTrend([
      { daysAgo: 365, value: 140 },
      { daysAgo: 182, value: 130 },
      { daysAgo: 90, value: 118 },
      { daysAgo: 30, value: 104 },
      { daysAgo: 7, value: 96 },
    ])
    expect(trend.direction).toBe('falling')
    expect(trend.pctPer30d).not.toBeNull()
    expect(trend.spanDays).toBe(358)
  })

  it('computes a median without mutating the source array', () => {
    const values = [3, 1, 2]
    expect(median(values)).toBe(2)
    expect(values).toEqual([3, 1, 2])
  })
})

describe('decision semantics', () => {
  it('does not allow a window curve alone to force timing action', () => {
    const periods: PartWithMarket['periods'] = {
      '1yr': observation(140, 0, 100),
      '6m': observation(130, 0, 70),
      '90d': observation(118, 0, 45),
      '30d': observation(104, 0, 20),
      '7d': observation(96, 0, 8),
    }
    const result = decide(part({ costBasis: 10, periods }), SETTINGS)
    expect(result.marketTrend.basis).toBe('window-curve')
    expect(result.action).toBe('LIST')
  })

  it('normalizes fallback sold demand to units per day', () => {
    const periods: PartWithMarket['periods'] = {
      '1yr': observation(100, 10, 100),
      '30d': observation(100, 10, 20),
      '7d': observation(100, 10, 8),
    }
    const result = decide(part({ periods }), SETTINGS)
    expect(result.demandTrend.basis).toBe('window-velocity')
    expect(result.demandTrend.direction).toBe('rising')
  })

  it('never treats sold volume as competing supply', () => {
    const periods: PartWithMarket['periods'] = {
      '1yr': observation(100, 10, 10),
      '90d': observation(100, 10, 20),
      '30d': observation(100, 10, 30),
      '7d': observation(100, 10, 40),
    }
    const result = decide(part({ periods }), SETTINGS)
    expect(result.supplyTrend.direction).toBe('unknown')
    expect(result.supplyTrend.basis).toBe('insufficient')
  })

  it('allows qualified falling sold-price history to produce LIST_NOW at healthy margin', () => {
    const result = decide(
      part({ costBasis: 10, periods: flatMarket(100) }),
      SETTINGS,
      summary({ marketPctPer30d: -8, marketPoints: 4, marketSpanDays: 45, marketPeriod: '30d' }),
    )
    expect(result.marketTrend.basis).toBe('history')
    expect(result.action).toBe('LIST_NOW')
  })

  it('allows qualified rising active supply to produce LIST_NOW without conflating demand', () => {
    const result = decide(
      part({ costBasis: 10, periods: flatMarket(100) }),
      SETTINGS,
      summary({ supplyPctPer30d: 12, supplyPoints: 4, supplySpanDays: 28 }),
    )
    expect(result.supplyTrend.basis).toBe('history')
    expect(result.supplyTrend.direction).toBe('rising')
    expect(result.action).toBe('LIST_NOW')
  })

  it('does not act on history that is too short', () => {
    const result = decide(
      part({ costBasis: 60, periods: flatMarket(70, 0) }),
      SETTINGS,
      summary({ marketPctPer30d: -50, marketPoints: 3, marketSpanDays: 2, marketPeriod: '30d' }),
    )
    expect(result.marketTrend.basis).toBe('window-curve')
    expect(result.action).toBe('WATCH')
  })

  it('labels active-only economics as asking price provenance', () => {
    const result = decide(
      part({
        periods: {},
        activeMarket: {
          askingPrice: 100,
          askingShipping: 15,
          activeQty: 12,
          source: 'ebay_browse',
          sampleSize: 20,
          broadMatchCount: 30,
          mpnRejectedCount: 10,
          conditionRejectedCount: 0,
          truncated: false,
          capturedAt: '2026-09-30T12:00:00Z',
        },
      }),
      SETTINGS,
    )
    expect(result.provenance).toBe('asking')
    expect(result.currentMarketKind).toBe('active')
    expect(result.notes.some((note) => note.includes('asking prices'))).toBe(true)
  })

  it('needs data when there is no market price', () => {
    expect(decide(part({ periods: {}, activeMarket: null }), SETTINGS).action).toBe('NEEDS_DATA')
  })
})
