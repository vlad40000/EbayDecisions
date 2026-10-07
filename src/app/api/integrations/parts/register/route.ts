import { NextResponse } from 'next/server'

import { registerPartsByMpnKey } from '@/db/queries'
import { checkIntegrationAuth } from '@/lib/integration-auth'
import { parsePartRegistrationRequest, type PartRegistrationEnvelopeV1 } from '@/lib/part-registration'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * Explicit exact-MPN registration for Parts Engine.
 *
 * Authenticated by INTEGRATION_API_KEY, not the browser session. Inserts only
 * D1 keys that do not exist yet (inventory 0, blank economics) and reports
 * existing keys without touching them. No eBay calls.
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

  const parsed = parsePartRegistrationRequest(body)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE })
  }

  let results: PartRegistrationEnvelopeV1['results']
  try {
    results = await registerPartsByMpnKey(parsed.entries)
  } catch {
    return NextResponse.json({ error: 'Registration failed.' }, { status: 500, headers: NO_STORE })
  }

  const envelope: PartRegistrationEnvelopeV1 = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    results,
  }
  return NextResponse.json(envelope, { headers: NO_STORE })
}
