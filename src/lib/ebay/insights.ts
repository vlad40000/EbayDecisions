/** Marketplace Insights adapter — completed sales, where access is granted. */
import type { Period } from '../types'
import { daysAgo, ebayGet, getEbayConfig, isoUtc, type EbayConfig } from './client'
import { titleMatchesMpn } from './match'
import {
  aggregateSoldSamples,
  type SoldSample,
  type SoldWindowAggregate,
} from './sold-aggregate'

type ItemSale = {
  itemId?: string
  title?: string
  lastSoldPrice?: { value?: string; currency?: string }
  lastSoldDate?: string
  shippingOptions?: { shippingCost?: { value?: string } }[]
}

type InsightsResponse = {
  total?: number
  itemSales?: ItemSale[]
}

export type WindowAggregate = SoldWindowAggregate

export type SoldWindowsResult = {
  windows: Partial<Record<Period, WindowAggregate>>
  /** True only when every returned sale exposed a title and exact-MPN filtering was possible. */
  exactMpnVerified: boolean
  mpnRejectedCount: number
  truncated: boolean
}

const PAGE_LIMIT = 200
const MAX_LOOKBACK_DAYS = 90

export async function fetchSoldWindows(
  mpn: string,
  config: EbayConfig = getEbayConfig(),
  now = new Date(),
): Promise<SoldWindowsResult> {
  const start = daysAgo(MAX_LOOKBACK_DAYS, now)
  const response = await ebayGet<InsightsResponse>(
    '/buy/marketplace_insights/v1_beta/item_sales/search',
    {
      q: mpn,
      limit: String(PAGE_LIMIT),
      filter: `lastSoldDate:[${isoUtc(start)}..${isoUtc(now)}],conditions:{USED}`,
    },
    config.insightsScope,
    config,
  )

  const raw = response.itemSales ?? []
  const titled = raw.filter((sale) => typeof sale.title === 'string' && sale.title.length > 0)
  const exactMpnVerified = raw.length > 0 && titled.length === raw.length
  const qualifiedRaw = exactMpnVerified
    ? raw.filter((sale) => titleMatchesMpn(sale.title ?? '', mpn))
    : raw
  const mpnRejectedCount = exactMpnVerified ? raw.length - qualifiedRaw.length : 0
  const truncated = typeof response.total === 'number' && response.total > raw.length

  const sales = qualifiedRaw
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
    .filter(
      (sale): sale is SoldSample =>
        sale.price != null && Number.isFinite(sale.price) && Number.isFinite(sale.soldAt),
    )

  return {
    windows: aggregateSoldSamples(sales, now, truncated),
    exactMpnVerified,
    mpnRejectedCount,
    truncated,
  }
}
