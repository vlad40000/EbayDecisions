import type { Period } from '../types'

export type SoldSample = {
  price: number
  soldAt: number
  shipping: number | null
}

export type SoldWindowAggregate = {
  avgSoldPrice: number | null
  avgShipping: number | null
  totalSold: number | null
  soldPriceMin: number | null
  soldPriceMax: number | null
  freeShippingPct: number | null
  sampleSize: number
}

export const INSIGHTS_PERIODS = ['90d', '30d', '7d'] as const satisfies readonly Period[]

const WINDOW_DAYS: Record<(typeof INSIGHTS_PERIODS)[number], number> = {
  '90d': 90,
  '30d': 30,
  '7d': 7,
}

const DAY_MS = 86_400_000

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function aggregateSoldSamples(
  sales: readonly SoldSample[],
  now: Date,
  truncated: boolean,
): Partial<Record<Period, SoldWindowAggregate>> {
  const windows: Partial<Record<Period, SoldWindowAggregate>> = {}

  for (const period of INSIGHTS_PERIODS) {
    const cutoff = now.getTime() - WINDOW_DAYS[period] * DAY_MS
    const inWindow = sales.filter((sale) => sale.soldAt >= cutoff)
    const prices = inWindow.map((sale) => sale.price)
    const shipping = inWindow
      .map((sale) => sale.shipping)
      .filter((value): value is number => value != null && Number.isFinite(value))

    windows[period] = {
      avgSoldPrice: average(prices),
      avgShipping: average(shipping),
      totalSold: truncated ? null : inWindow.length,
      soldPriceMin: prices.length === 0 ? null : Math.min(...prices),
      soldPriceMax: prices.length === 0 ? null : Math.max(...prices),
      freeShippingPct:
        shipping.length === 0
          ? null
          : (shipping.filter((value) => value === 0).length / shipping.length) * 100,
      sampleSize: inWindow.length,
    }
  }

  return windows
}
