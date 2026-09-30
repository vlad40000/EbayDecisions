/**
 * Browse API adapter — the *active listings* view.
 *
 * What this gives you: what other sellers are currently asking, and how many are
 * competing with you right now. That second number is genuinely useful; the
 * first is not a comp. An unsold listing at $200 is evidence of one seller's
 * hope, not of what the part fetches.
 *
 * So every row this adapter writes is stamped `ebay_browse`, the UI labels it
 * "Active listings", and the decision engine flags any part whose entire read
 * rests on asking prices. Use Insights for real sold comps when eBay grants your
 * app that scope.
 */
import { median } from '../stats'
import type { Period } from '../types'

import { ebayGet, getEbayConfig, type EbayConfig } from './client'

type BrowseItemSummary = {
  itemId?: string
  price?: { value?: string; currency?: string }
  shippingOptions?: { shippingCost?: { value?: string } }[]
  condition?: string
}

type BrowseResponse = {
  total?: number
  itemSummaries?: BrowseItemSummary[]
}

export type BrowseResult = {
  /** Median asking price across active listings. */
  price: number | null
  /** Median shipping charged. Free shipping counts as 0, not as missing. */
  shipping: number | null
  /** How many active listings matched — your competition. */
  activeCount: number | null
  sampleSize: number
}

const PAGE_LIMIT = 100

/** Browse only describes right now, so it fills the shortest window. */
export const BROWSE_TARGET_PERIOD: Period = '7d'

export async function fetchActiveMarket(
  mpn: string,
  config: EbayConfig = getEbayConfig(),
): Promise<BrowseResult> {
  const response = await ebayGet<BrowseResponse>(
    '/buy/browse/v1/item_summary/search',
    { q: mpn, limit: String(PAGE_LIMIT) },
    config.browseScope,
    config,
  )

  const summaries = response.itemSummaries ?? []

  const prices: number[] = []
  const shippingCosts: number[] = []

  for (const item of summaries) {
    const price = Number(item.price?.value)
    if (Number.isFinite(price) && price > 0) prices.push(price)

    // Absent shippingOptions means eBay did not say; absent cost within a
    // present option means free. Only the latter is a real zero.
    const option = item.shippingOptions?.[0]
    if (option) {
      const shipping = Number(option.shippingCost?.value ?? '0')
      if (Number.isFinite(shipping)) shippingCosts.push(shipping)
    }
  }

  return {
    price: median(prices),
    shipping: median(shippingCosts),
    activeCount: typeof response.total === 'number' ? response.total : null,
    sampleSize: prices.length,
  }
}
