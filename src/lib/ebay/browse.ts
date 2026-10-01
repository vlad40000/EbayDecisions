/** Active-listing adapter. Never presented as sold comps. */
import { median } from '../stats'
import { ebayGet, getEbayConfig, type EbayConfig } from './client'
import { titleMatchesMpn } from './match'

type BrowseItemSummary = {
  itemId?: string
  title?: string
  price?: { value?: string; currency?: string }
  shippingOptions?: { shippingCost?: { value?: string } }[]
}

type BrowseResponse = {
  total?: number
  itemSummaries?: BrowseItemSummary[]
}

export type BrowseResult = {
  askingPrice: number | null
  askingShipping: number | null
  /** Exact active count only when the broad result set fit in the inspected page. */
  activeQty: number | null
  sampleSize: number
  broadMatchCount: number | null
  mpnRejectedCount: number
  conditionRejectedCount: number
  truncated: boolean
}

const PAGE_LIMIT = 200

/** The research population is defined by the supplied MPN only. */
export function buildActiveSearchParams(mpn: string): Record<string, string> {
  return {
    q: mpn.trim(),
    limit: String(PAGE_LIMIT),
  }
}

export async function fetchActiveMarket(
  mpn: string,
  config: EbayConfig = getEbayConfig(),
): Promise<BrowseResult> {
  const response = await ebayGet<BrowseResponse>(
    '/buy/browse/v1/item_summary/search',
    buildActiveSearchParams(mpn),
    config.browseScope,
    config,
  )

  const returned = response.itemSummaries ?? []
  const exactMpn = returned.filter((item) => item.title && titleMatchesMpn(item.title, mpn))
  const qualified = exactMpn

  const prices: number[] = []
  const shippingCosts: number[] = []
  for (const item of qualified) {
    const price = Number(item.price?.value)
    if (Number.isFinite(price) && price > 0) prices.push(price)

    const option = item.shippingOptions?.[0]
    if (option) {
      const shipping = Number(option.shippingCost?.value ?? '0')
      if (Number.isFinite(shipping) && shipping >= 0) shippingCosts.push(shipping)
    }
  }

  const broadMatchCount = typeof response.total === 'number' ? response.total : null
  const truncated = broadMatchCount != null && broadMatchCount > returned.length

  return {
    askingPrice: median(prices),
    askingShipping: median(shippingCosts),
    // If the broad search is truncated, counting exact matches in only the first
    // page would silently understate competition. Preserve price sample, but do
    // not claim an exact active count.
    activeQty: truncated ? null : qualified.length,
    sampleSize: prices.length,
    broadMatchCount,
    mpnRejectedCount: returned.length - exactMpn.length,
    conditionRejectedCount: 0,
    truncated,
  }
}
