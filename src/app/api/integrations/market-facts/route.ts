import { NextResponse } from 'next/server'

import { getMarketFactsByMpnKeys } from '@/db/queries'
import { checkIntegrationAuth } from '@/lib/integration-auth'
import { parseMarketFactsRequest, type MarketFactsEnvelopeV1 } from '@/lib/market-facts'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * Zero-write exact-MPN market facts for Parts Engine.
 *
 * Authenticated by INTEGRATION_API_KEY, not the browser session, and excluded
 * from the session redirect in proxy.ts. Reads stored facts only: no eBay
 * calls, no research sessions or snapshots, no part registration.
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

  const parsed = parseMarketFactsRequest(body)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE })
  }

  const envelope: MarketFactsEnvelopeV1 = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    facts: await getMarketFactsByMpnKeys(parsed.keys),
  }
  return NextResponse.json(envelope, { headers: NO_STORE })
}
