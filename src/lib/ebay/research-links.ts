import { PERIOD_DAYS, type Period } from '../types'

export function normalizeResearchMpn(mpn: string): string {
  return mpn.trim()
}

function ebaySearchUrl(mpn: string, sold: boolean): string {
  const query = normalizeResearchMpn(mpn)
  const url = new URL('https://www.ebay.com/sch/i.html')
  url.searchParams.set('_nkw', query)
  if (sold) {
    url.searchParams.set('LH_Sold', '1')
    url.searchParams.set('LH_Complete', '1')
  }
  return url.toString()
}

/**
 * eBay research searches are intentionally MPN-only.
 * Do not append brand, model, description, category, compatibility, or machine context.
 */
export function buildEbayActiveResearchUrl(mpn: string): string {
  return ebaySearchUrl(mpn, false)
}

/**
 * Completed/Sold eBay research using the exact same MPN-only query.
 */
export function buildEbaySoldResearchUrl(mpn: string): string {
  return ebaySearchUrl(mpn, true)
}

const DAY_MS = 86_400_000

/**
 * Seller Hub Product Research deep link for one MPN and one exact lookback window.
 *
 * Search authority remains the supplied MPN only. categoryId=0 intentionally
 * avoids category narrowing; no brand/model/description/condition filters are added.
 */
export function buildEbayProductResearchUrl(
  mpn: string,
  period: Period,
  nowMs: number,
  timeZone = 'America/New_York',
): string {
  const days = PERIOD_DAYS[period]
  const endDate = nowMs
  const startDate = endDate - days * DAY_MS

  const url = new URL('https://www.ebay.com/sh/research')
  url.searchParams.set('marketplace', 'EBAY-US')
  url.searchParams.set('keywords', normalizeResearchMpn(mpn))
  url.searchParams.set('dayRange', String(days))
  url.searchParams.set('endDate', String(endDate))
  url.searchParams.set('startDate', String(startDate))
  url.searchParams.set('categoryId', '0')
  url.searchParams.set('offset', '0')
  url.searchParams.set('limit', '50')
  url.searchParams.set('tabName', 'SOLD')
  url.searchParams.set('tz', timeZone)
  return url.toString()
}
