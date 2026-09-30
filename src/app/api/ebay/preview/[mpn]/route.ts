import { NextResponse } from 'next/server'

import { fetchActiveMarket } from '@/lib/ebay/browse'
import { hasValidSession } from '@/lib/session'

/** User-triggered preview: calls eBay but deliberately writes nothing to Neon. */
export async function GET(_request: Request, props: { params: Promise<{ mpn: string }> }) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
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
