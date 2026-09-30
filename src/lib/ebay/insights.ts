/**
 * Marketplace Insights adapter — real sold comps.
 *
 * Two limits that shape the design:
 *
 * 1. eBay restricts the `buy.marketplace.insights` scope. Your app has to be
 *    approved for it; until then the token request fails and the sync falls back
 *    to Browse. That is a permissions state, not a bug.
 * 2. Insights covers the last 90 days. The 6-month and 1-year windows cannot be
 *    backfilled from the API at all — they accumulate from this app's own
 *    snapshot history as it keeps running. Nothing here fabricates them.
 *
 * One request pulls the full 90 days, then sales are bucketed locally into the
 * 7/30/90-day windows. Three windows from one call, all cut from the same data.
 */
import { median } from '../stats'
import type { Period } from '../types'

import { daysAgo, ebayGet, getEbayConfig, isoUtc, type EbayConfig } from './client'

type ItemSale = {
  itemId?: string
  lastSoldPrice?: { value?: string; currency?: string }
  lastSoldDate?: string
  shippingOptions?: { shippingCost?: { value?: string } }[]
}

type InsightsResponse = {
  total?: number
  itemSales?: ItemSale[]
}

export type WindowAggregate = {
  price: number | null
  shipping: number | null
  /** Units sold in the window. */
  qty: number | null
  sampleSize: number
}

/** Windows Insights can actually answer for. */
export const INSIGHTS_PERIODS: Period[] = ['90d', '30d', '7d']

const WINDOW_DAYS: Record<'90d' | '30d' | '7d', number> = { '90d': 90, '30d': 30, '7d': 7 }

const PAGE_LIMIT = 200
const MAX_LOOKBACK_DAYS = 90

export async function fetchSoldWindows(
  mpn: string,
  config: EbayConfig = getEbayConfig(),
  now = new Date(),
): Promise<Partial<Record<Period, WindowAggregate>>> {
  const start = daysAgo(MAX_LOOKBACK_DAYS, now)

  const response = await ebayGet<InsightsResponse>(
    '/buy/marketplace_insights/v1_beta/item_sales/search',
    {
      q: mpn,
      limit: String(PAGE_LIMIT),
      filter: `lastSoldDate:[${isoUtc(start)}..${isoUtc(now)}]`,
    },
    config.insightsScope,
    config,
  )

  const sales = (response.itemSales ?? [])
    .map((sale) => {
      const price = Number(sale.lastSoldPrice?.value)
      const soldAt = sale.lastSoldDate ? new Date(sale.lastSoldDate).getTime() : Number.NaN
      const option = sale.shippingOptions?.[0]
      const shipping = option ? Number(option.shippingCost?.value ?? '0') : null
      return {
        price: Number.isFinite(price) && price > 0 ? price : null,
        soldAt,
        shipping: shipping != null && Number.isFinite(shipping) ? shipping : null,
      }
    })
    .filter((sale) => sale.price != null && Number.isFinite(sale.soldAt))

  const result: Partial<Record<Period, WindowAggregate>> = {}

  for (const period of INSIGHTS_PERIODS) {
    const cutoff = daysAgo(WINDOW_DAYS[period as '90d' | '30d' | '7d'], now).getTime()
    const inWindow = sales.filter((sale) => sale.soldAt >= cutoff)

    if (inWindow.length === 0) {
      // A window with no sales is a real, useful signal — nothing moved. Record
      // it as zero units rather than leaving the window blank, so "no demand"
      // reads differently from "never looked".
      result[period] = { price: null, shipping: null, qty: 0, sampleSize: 0 }
      continue
    }

    result[period] = {
      price: median(inWindow.map((sale) => sale.price as number)),
      shipping: median(
        inWindow.map((sale) => sale.shipping).filter((s): s is number => s != null),
      ),
      qty: inWindow.length,
      sampleSize: inWindow.length,
    }
  }

  return result
}
