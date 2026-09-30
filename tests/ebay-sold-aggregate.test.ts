import { describe, expect, it } from 'vitest'

import { aggregateSoldSamples, type SoldSample } from '@/lib/ebay/sold-aggregate'

const now = new Date('2026-09-30T12:00:00.000Z')
const day = 86_400_000

function sample(daysAgo: number, price: number, shipping: number | null): SoldSample {
  return {
    price,
    shipping,
    soldAt: now.getTime() - daysAgo * day,
  }
}

describe('assisted SOLD research aggregation', () => {
  it('uses arithmetic averages for the Product Research fields', () => {
    const result = aggregateSoldSamples(
      [
        sample(2, 10, 0),
        sample(4, 20, 5),
        sample(6, 100, 10),
        sample(20, 50, 5),
        sample(80, 30, 0),
      ],
      now,
      false,
    )

    expect(result['7d']?.avgSoldPrice).toBeCloseTo(43.3333, 4)
    expect(result['7d']?.avgShipping).toBeCloseTo(5, 4)
    expect(result['7d']?.totalSold).toBe(3)
    expect(result['7d']?.soldPriceMin).toBe(10)
    expect(result['7d']?.soldPriceMax).toBe(100)
    expect(result['7d']?.freeShippingPct).toBeCloseTo(33.3333, 4)

    expect(result['30d']?.avgSoldPrice).toBeCloseTo(45, 4)
    expect(result['30d']?.totalSold).toBe(4)
    expect(result['90d']?.totalSold).toBe(5)
  })

  it('withholds sold totals when the eBay result set is truncated but keeps price samples', () => {
    const result = aggregateSoldSamples(
      [sample(2, 75, 12), sample(5, 85, 0)],
      now,
      true,
    )

    expect(result['7d']?.avgSoldPrice).toBe(80)
    expect(result['7d']?.totalSold).toBeNull()
    expect(result['7d']?.sampleSize).toBe(2)
  })

  it('returns explicit zero sold for a complete empty window', () => {
    const result = aggregateSoldSamples([sample(20, 50, 5)], now, false)

    expect(result['7d']).toEqual({
      avgSoldPrice: null,
      avgShipping: null,
      totalSold: 0,
      soldPriceMin: null,
      soldPriceMax: null,
      freeShippingPct: null,
      sampleSize: 0,
    })
  })
})
