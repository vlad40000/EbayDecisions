/** Marketplace Insights adapter — completed sales, where access is granted. */
import { median } from '../stats'
import type { Period } from '../types'
import { daysAgo, ebayGet, getEbayConfig, isoUtc, type EbayConfig } from './client'
import { titleMatchesMpn } from './match'

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

export type WindowAggregate = {
  price: number | null
  shipping: number | null
  soldQty: number | null
  sampleSize: number
}

export type SoldWindowsResult = {
  windows: Partial<Record<Period, WindowAggregate>>
  /** True only when every returned sale exposed a title and passed exact-MPN filtering. */
  exactMpnVerified: boolean
  mpnRejectedCount: number
  truncated: boolean
}

export const INSIGHTS_PERIODS: Period[] = ['90d', '30d', '7d']
const WINDOW_DAYS: Record<'90d' | '30d' | '7d', number> = { '90d': 90, '30d': 30, '7d': 7 }
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
    .filter((sale) => sale.price != null && Number.isFinite(sale.soldAt))

  const windows: Partial<Record<Period, WindowAggregate>> = {}
  for (const period of INSIGHTS_PERIODS) {
    const cutoff = daysAgo(WINDOW_DAYS[period as '90d' | '30d' | '7d'], now).getTime()
    const inWindow = sales.filter((sale) => sale.soldAt >= cutoff)

    if (inWindow.length === 0) {
      windows[period] = {
        price: null,
        shipping: null,
        soldQty: truncated ? null : 0,
        sampleSize: 0,
      }
      continue
    }

    windows[period] = {
      price: median(inWindow.map((sale) => sale.price as number)),
      shipping: median(
        inWindow.map((sale) => sale.shipping).filter((value): value is number => value != null),
      ),
      // If eBay reports more matching sales than the response page contains,
      // the true sold count is unknown. Do not write a known-under-count.
      soldQty: truncated ? null : inWindow.length,
      sampleSize: inWindow.length,
    }
  }

  return { windows, exactMpnVerified, mpnRejectedCount, truncated }
}
