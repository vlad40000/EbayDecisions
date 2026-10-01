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
