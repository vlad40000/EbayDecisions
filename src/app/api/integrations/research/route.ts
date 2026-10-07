import { NextResponse } from 'next/server'

import { AUTOMATED_EBAY_RESEARCH_DISABLED, isAutomatedEbayResearchEnabled } from '@/lib/ebay/automation-gate'
import { isEbayConfigured } from '@/lib/ebay/client'
import { researchExactMpns } from '@/lib/ebay/exact-mpn-research'
import { checkIntegrationAuth } from '@/lib/integration-auth'
import { parseTargetedResearchRequest, type TargetedResearchEnvelopeV1 } from '@/lib/targeted-research'

const NO_STORE = { 'Cache-Control': 'no-store' }

/** Up to 20 parts, each with a Browse and an Insights call, spaced out. */
export const maxDuration = 300

/**
 * Explicit exact-MPN research for Parts Engine.
 *
 * Authenticated by INTEGRATION_API_KEY, not the browser session. Researches
 * only already-registered parts through the official eBay APIs and reports a
 * per-MPN outcome; read the saved facts from /api/integrations/market-facts.
 * Errors carry this app's own wording only — never eBay bodies or keys.
 *
 * Manual-only by default: unless EBAY_AUTOMATED_RESEARCH_ENABLED is exactly
 * "true", a valid request answers 503 before any part lookup or eBay call.
 */
export async function POST(request: Request) {
  const auth = checkIntegrationAuth(request.headers.get('authorization'))
  if (auth === 'unconfigured') {
    return NextResponse.json(
      { error: 'The integration API is not configured.' },
      { status: 503, headers: NO_STORE },
    )
  }
  if (auth === 'unauthorized') {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401, headers: NO_STORE })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400, headers: NO_STORE })
  }

  const parsed = parseTargetedResearchRequest(body)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE })
  }

  if (!isAutomatedEbayResearchEnabled()) {
    return NextResponse.json(
      { error: AUTOMATED_EBAY_RESEARCH_DISABLED },
      { status: 503, headers: NO_STORE },
    )
  }

  if (!isEbayConfigured()) {
    return NextResponse.json(
      { error: 'eBay API credentials are not configured.' },
      { status: 503, headers: NO_STORE },
    )
  }

  let results: TargetedResearchEnvelopeV1['results']
  try {
    results = await researchExactMpns(parsed.keys)
  } catch {
    return NextResponse.json({ error: 'Research failed.' }, { status: 500, headers: NO_STORE })
  }

  const envelope: TargetedResearchEnvelopeV1 = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    results,
  }
  return NextResponse.json(envelope, { headers: NO_STORE })
}
