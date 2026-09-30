import { describe, expect, it } from 'vitest'

import { computeEconomics, decide, suggestedListPrice } from '@/lib/decisions'
import { linearTrend, median, trendValueAt } from '@/lib/stats'
import type { EconomicSettings, PartWithMarket, Period, PeriodObservation } from '@/lib/types'

const SETTINGS: EconomicSettings = {
  feePct: 13.25,
  feeFixed: 0.3,
  defaultShipCost: 12,
  targetMarginPct: 35,
  minMarginPct: 15,
}

function observation(
  price: number | null,
  shipping: number | null = 0,
  qty: number | null = null,
  source: PeriodObservation['source'] = 'ebay_insights',
): PeriodObservation {
  return { price, shipping, qty, source, sampleSize: 5, capturedAt: new Date().toISOString() }
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
    updatedAt: new Date().toISOString(),
    periods: {},
    ...overrides,
  }
}

/** Fills every window with the same figure, so trend is flat by construction. */
function flatMarket(price: number, shipping = 15, qty = 3): PartWithMarket['periods'] {
  const periods: PartWithMarket['periods'] = {}
  for (const key of ['1yr', '6m', '90d', '30d', '7d'] as Period[]) {
    periods[key] = observation(price, shipping, qty)
  }
  return periods
}

function rampMarket(prices: [number, number, number, number, number], shipping = 15) {
  const keys: Period[] = ['1yr', '6m', '90d', '30d', '7d']
  const periods: PartWithMarket['periods'] = {}
  keys.forEach((key, index) => {
    periods[key] = observation(prices[index] as number, shipping, 3)
  })
  return periods
}

describe('computeEconomics', () => {
  it('charges the fee on the whole order, not just the item price', () => {
    const economics = computeEconomics({
      price: 100,
      shipping: 15,
      costBasis: 40,
      shipCost: 12,
      settings: SETTINGS,
    })

    expect(economics.grossOrder).toBe(115)
    // 115 * 0.1325 + 0.30
    expect(economics.fees).toBeCloseTo(15.5375, 6)
    // 115 - 15.5375 - 12
    expect(economics.netProceeds).toBeCloseTo(87.4625, 6)
    expect(economics.marginDollars).toBeCloseTo(47.4625, 6)
    expect(economics.marginPct).toBeCloseTo(54.2663, 3)
    expect(economics.roiPct).toBeCloseTo(118.65625, 4)
  })

  it('falls back to the default ship cost when the part has none', () => {
    const withDefault = computeEconomics({
      price: 100,
      shipping: 0,
      costBasis: 10,
      shipCost: null,
      settings: SETTINGS,
    })
    const explicit = computeEconomics({
      price: 100,
      shipping: 0,
      costBasis: 10,
      shipCost: 12,
      settings: SETTINGS,
    })

    expect(withDefault.shipCost).toBe(12)
    expect(withDefault.netProceeds).toBeCloseTo(explicit.netProceeds, 9)
  })

  it('treats a zero cost basis as free, not as unknown', () => {
    const free = computeEconomics({
      price: 100,
      shipping: 0,
      costBasis: 0,
      shipCost: 12,
      settings: SETTINGS,
    })

    // A part pulled off a scrapped machine: all of the net is margin.
    expect(free.marginDollars).toBeCloseTo(free.netProceeds, 9)
    expect(free.marginPct).toBeCloseTo(100, 9)
    // ROI on a zero cost is undefined, not infinite.
    expect(free.roiPct).toBeNull()
  })

  it('reports unknown margin when the cost basis is missing', () => {
    const unknown = computeEconomics({
      price: 100,
      shipping: 0,
      costBasis: null,
      shipCost: 12,
      settings: SETTINGS,
    })

    expect(unknown.netProceeds).toBeGreaterThan(0)
    expect(unknown.marginDollars).toBeNull()
    expect(unknown.marginPct).toBeNull()
    expect(unknown.roiPct).toBeNull()
  })

  it('reports a negative margin when the market is below cost', () => {
    const underwater = computeEconomics({
      price: 30,
      shipping: 10,
      costBasis: 45,
      shipCost: 12,
      settings: SETTINGS,
    })

    expect(underwater.marginDollars).toBeLessThan(0)
  })
})

describe('suggestedListPrice', () => {
  it('produces a price that actually hits the target margin', () => {
    const price = suggestedListPrice({
      costBasis: 40,
      shipping: 15,
      shipCost: 12,
      targetMarginPct: 35,
      settings: SETTINGS,
    })

    expect(price).not.toBeNull()
    expect(price as number).toBeCloseTo(70.1164, 3)

    // Round-trip: feeding it back through the economics must yield 35%.
    const economics = computeEconomics({
      price: price as number,
      shipping: 15,
      costBasis: 40,
      shipCost: 12,
      settings: SETTINGS,
    })
    expect(economics.marginPct).toBeCloseTo(35, 6)
  })

  it('round-trips at other targets too', () => {
    for (const target of [10, 25, 50, 70]) {
      const price = suggestedListPrice({
        costBasis: 62.5,
        shipping: 9.99,
        shipCost: 14.25,
        targetMarginPct: target,
        settings: SETTINGS,
      })
      const economics = computeEconomics({
        price: price as number,
        shipping: 9.99,
        costBasis: 62.5,
        shipCost: 14.25,
        settings: SETTINGS,
      })
      expect(economics.marginPct).toBeCloseTo(target, 6)
    }
  })

  it('has no answer without a cost basis, or at an impossible target', () => {
    expect(
      suggestedListPrice({
        costBasis: null,
        shipping: 0,
        shipCost: 12,
        targetMarginPct: 35,
        settings: SETTINGS,
      }),
    ).toBeNull()

    expect(
      suggestedListPrice({
        costBasis: 40,
        shipping: 0,
        shipCost: 12,
        targetMarginPct: 100,
        settings: SETTINGS,
      }),
    ).toBeNull()
  })
})

describe('linearTrend', () => {
  it('reads a steady climb as rising', () => {
    const trend = linearTrend([100, 105, 110, 115, 120])
    expect(trend.slope).toBeCloseTo(5, 9)
    expect(trend.direction).toBe('rising')
    // 5 / 110 * 100
    expect(trend.pctPerPeriod).toBeCloseTo(4.5455, 3)
    expect(trend.strong).toBe(false)
    expect(trend.points).toBe(5)
  })

  it('flags a steep move as strong', () => {
    const trend = linearTrend([100, 90, 80, 70, 60])
    expect(trend.direction).toBe('falling')
    expect(trend.strong).toBe(true)
  })

  it('treats a small wobble as flat', () => {
    const trend = linearTrend([100, 100.5, 100, 100.4, 100.2])
    expect(trend.direction).toBe('flat')
  })

  it('keeps original spacing when windows are missing', () => {
    // Points sit at x=0 and x=4, so the slope is 5 per window — not 20, which is
    // what collapsing them to adjacent indices would give.
    const trend = linearTrend([100, null, null, null, 120])
    expect(trend.slope).toBeCloseTo(5, 9)
    expect(trend.points).toBe(2)
  })

  it('cannot read a trend from fewer than two points', () => {
    expect(linearTrend([null, null, null, null, 120]).direction).toBe('unknown')
    expect(linearTrend([]).direction).toBe('unknown')
    expect(linearTrend([null, null]).points).toBe(0)
  })

  it('fits a line through the observed points', () => {
    const series = [100, 105, 110, 115, 120]
    const trend = linearTrend(series)
    expect(trendValueAt(series, trend, 0)).toBeCloseTo(100, 6)
    expect(trendValueAt(series, trend, 4)).toBeCloseTo(120, 6)
  })
})

describe('median', () => {
  it('averages the middle pair on an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
  it('takes the middle of an odd count regardless of input order', () => {
    expect(median([9, 1, 5])).toBe(5)
  })
  it('has no answer for an empty set', () => {
    expect(median([])).toBeNull()
  })
})

describe('decide', () => {
  it('asks for data when there are no comps', () => {
    const decision = decide(part({ periods: {} }), SETTINGS)
    expect(decision.action).toBe('NEEDS_DATA')
    expect(decision.economics).toBeNull()
  })

  it('asks for a cost basis when comps exist but cost does not', () => {
    const decision = decide(part({ costBasis: null, periods: flatMarket(100) }), SETTINGS)
    expect(decision.action).toBe('NEEDS_DATA')
    expect(decision.reason).toContain('no cost basis')
    // The market side is still computed and shown.
    expect(decision.economics?.grossOrder).toBe(115)
  })

  it('says dump when the part loses money', () => {
    const decision = decide(part({ costBasis: 200, periods: flatMarket(100) }), SETTINGS)
    expect(decision.action).toBe('DUMP')
    expect(decision.reason).toContain('Underwater')
    expect(decision.potentialDollars).toBeLessThan(0)
  })

  it('says dump when margin is under the floor and the market is falling', () => {
    // Net at price 100 / ship 15 is 87.46; a cost of 80 leaves ~8.5% margin.
    const decision = decide(
      part({ costBasis: 80, periods: rampMarket([140, 130, 120, 110, 100]) }),
      SETTINGS,
    )
    expect(decision.action).toBe('DUMP')
    expect(decision.costTrend.direction).toBe('falling')
  })

  it('says hold when margin is under the floor but the market is climbing', () => {
    const decision = decide(
      part({ costBasis: 80, periods: rampMarket([60, 70, 80, 90, 100]) }),
      SETTINGS,
    )
    expect(decision.action).toBe('HOLD')
    expect(decision.costTrend.direction).toBe('rising')
  })

  it('says list now when a healthy margin meets a falling market', () => {
    const decision = decide(
      part({ costBasis: 20, periods: rampMarket([140, 130, 120, 110, 100]) }),
      SETTINGS,
    )
    expect(decision.action).toBe('LIST_NOW')
    expect(decision.reason).toContain('before it erodes')
  })

  it('says list when a healthy margin meets a flat market', () => {
    const decision = decide(part({ costBasis: 20, periods: flatMarket(100) }), SETTINGS)
    expect(decision.action).toBe('LIST')
    expect(decision.economics?.marginPct).toBeGreaterThanOrEqual(SETTINGS.targetMarginPct)
  })

  it('says hold when the margin is already good and the market is climbing hard', () => {
    const decision = decide(
      part({ costBasis: 20, periods: rampMarket([60, 70, 80, 90, 100]) }),
      SETTINGS,
    )
    expect(decision.action).toBe('HOLD')
    expect(decision.costTrend.strong).toBe(true)
  })

  it('prices against the most recent window that has data', () => {
    const decision = decide(
      part({
        costBasis: 20,
        periods: { '1yr': observation(200, 15), '30d': observation(100, 15) },
      }),
      SETTINGS,
    )
    expect(decision.economics?.price).toBe(100)
  })

  it('honours a per-part target margin over the global one', () => {
    const base = part({ costBasis: 55, periods: flatMarket(100) })
    // Margin at cost 55 is about 37%: above the global 35% target.
    expect(decide(base, SETTINGS).action).toBe('LIST')
    // Raising this part's own target to 60% puts it between floor and target.
    const stricter = decide({ ...base, targetMarginPct: 60 }, SETTINGS)
    expect(stricter.targetMarginPct).toBe(60)
    expect(stricter.action).toBe('WATCH')
  })

  it('flags a read built only on active-listing asking prices', () => {
    const periods: PartWithMarket['periods'] = {
      '7d': observation(100, 15, 4, 'ebay_browse'),
    }
    const decision = decide(part({ costBasis: 20, periods }), SETTINGS)
    expect(decision.askingPricesOnly).toBe(true)
    expect(decision.notes.join(' ')).toContain('asking prices')
  })

  it('does not flag asking prices when a sold comp is present', () => {
    const periods: PartWithMarket['periods'] = {
      '30d': observation(100, 15, 4, 'ebay_insights'),
      '7d': observation(100, 15, 4, 'ebay_browse'),
    }
    expect(decide(part({ costBasis: 20, periods }), SETTINGS).askingPricesOnly).toBe(false)
  })

  it('warns when too few windows have data to trust the trend', () => {
    const periods: PartWithMarket['periods'] = { '7d': observation(100, 15, 2) }
    const decision = decide(part({ costBasis: 20, periods }), SETTINGS)
    expect(decision.thinData).toBe(true)
    expect(decision.notes.join(' ')).toContain('1 of 5 windows')
  })

  it('does not warn about thin data once three windows are filled', () => {
    const periods: PartWithMarket['periods'] = {
      '90d': observation(100, 15, 2),
      '30d': observation(100, 15, 2),
      '7d': observation(100, 15, 2),
    }
    expect(decide(part({ costBasis: 20, periods }), SETTINGS).thinData).toBe(false)
  })

  it('scales what is at stake by the units on hand', () => {
    const one = decide(part({ costBasis: 20, inventoryQty: 1, periods: flatMarket(100) }), SETTINGS)
    const four = decide(
      part({ costBasis: 20, inventoryQty: 4, periods: flatMarket(100) }),
      SETTINGS,
    )
    expect(four.potentialDollars).toBeCloseTo((one.potentialDollars as number) * 4, 6)
  })

  it('pushes to list when competing supply is climbing fast', () => {
    const keys: Period[] = ['1yr', '6m', '90d', '30d', '7d']
    const supply = [1, 3, 6, 10, 15]
    const periods: PartWithMarket['periods'] = {}
    keys.forEach((key, index) => {
      periods[key] = observation(100, 15, supply[index] as number)
    })

    const decision = decide(part({ costBasis: 20, periods }), SETTINGS)
    expect(decision.supplyTrend.direction).toBe('rising')
    expect(decision.action).toBe('LIST_NOW')
    expect(decision.reason).toContain('supply')
  })
})
