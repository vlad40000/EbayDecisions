import 'server-only'

/**
 * Manual-only gate for every server-side eBay API call.
 *
 * Automated research — the official Browse and Marketplace Insights adapters
 * behind Tracker Capture Active, POST /api/integrations/research,
 * GET /api/ebay/preview/[mpn], GET /api/ebay/research/[mpn], and the manual
 * and cron syncs — runs only when EBAY_AUTOMATED_RESEARCH_ENABLED is exactly
 * "true". Unset, empty, "false", "TRUE", "1", or anything else is manual-only:
 * each of those entry points returns before contacting eBay or writing a
 * snapshot, and the eBay client refuses to request a token or call an API as
 * the backstop for any caller that does not check first.
 *
 * Manual-only leaves the MPN-only eBay links, SAVE RESEARCH, part
 * registration, and stored market-facts reads untouched; none of them call
 * the eBay APIs. The adapter code stays in place, dormant until the flag is set.
 */

export const AUTOMATED_EBAY_RESEARCH_DISABLED =
  'Automated eBay research is disabled (manual-only mode). Use the MPN-only eBay links and SAVE RESEARCH.'

export function isAutomatedEbayResearchEnabled(): boolean {
  return process.env.EBAY_AUTOMATED_RESEARCH_ENABLED === 'true'
}

export class AutomatedEbayResearchDisabledError extends Error {
  constructor() {
    super(AUTOMATED_EBAY_RESEARCH_DISABLED)
    this.name = 'AutomatedEbayResearchDisabledError'
  }
}

/** Throws before any eBay request is attempted while automated research is off. */
export function assertAutomatedEbayResearchEnabled(): void {
  if (!isAutomatedEbayResearchEnabled()) throw new AutomatedEbayResearchDisabledError()
}
