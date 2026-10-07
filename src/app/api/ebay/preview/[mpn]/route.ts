import { NextResponse } from 'next/server'

import { AUTOMATED_EBAY_RESEARCH_DISABLED, isAutomatedEbayResearchEnabled } from '@/lib/ebay/automation-gate'
import { fetchActiveMarket } from '@/lib/ebay/browse'
import { hasValidSession } from '@/lib/session'

/**
 * User-triggered preview: calls eBay but deliberately writes nothing to Neon.
 * Answers 503 without calling eBay in manual-only mode.
 */
export async function GET(_request: Request, props: { params: Promise<{ mpn: string }> }) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }

  if (!isAutomatedEbayResearchEnabled()) {
    return NextResponse.json({ error: AUTOMATED_EBAY_RESEARCH_DISABLED }, { status: 503 })
  }

  const { mpn: raw } = await props.params
  const mpn = decodeURIComponent(raw)
  try {
    return NextResponse.json(await fetchActiveMarket(mpn))
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not preview eBay.' },
      { status: 502 },
    )
  }
}
