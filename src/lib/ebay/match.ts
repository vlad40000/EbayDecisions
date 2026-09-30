/** Normalize an appliance MPN without erasing meaningful letters/numbers. */
export function normalizeMpn(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Conservative title qualifier for keyword-search results.
 *
 * Accepts an exact alphanumeric token or up to three punctuation-separated
 * tokens that join to the requested MPN. Rejects substring matches such as
 * W112045170 for W11204517.
 */
export function titleMatchesMpn(title: string, mpn: string): boolean {
  const wanted = normalizeMpn(mpn)
  if (!wanted) return false

  const tokens = title
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map(normalizeMpn)

  if (tokens.includes(wanted)) return true

  for (let start = 0; start < tokens.length; start += 1) {
    let joined = ''
    for (let end = start; end < Math.min(tokens.length, start + 3); end += 1) {
      joined += tokens[end]
      if (joined === wanted) return true
      if (joined.length >= wanted.length) break
    }
  }
  return false
}
