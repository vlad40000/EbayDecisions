import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'

import { AUTOMATED_EBAY_RESEARCH_DISABLED, isAutomatedEbayResearchEnabled } from '@/lib/ebay/automation-gate'
import { runSync } from '@/lib/ebay/sync'

export const maxDuration = 300

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

/**
 * Scheduled sync is opt-in twice over. Vercel may still invoke this route from
 * vercel.json, but unless EBAY_CRON_ENABLED and EBAY_AUTOMATED_RESEARCH_ENABLED
 * are both "true" it returns before touching Neon or eBay.
 */
export async function GET(request: NextRequest) {
  if (process.env.EBAY_CRON_ENABLED !== 'true') {
    return NextResponse.json({ status: 'skipped', message: 'Scheduled eBay sync is disabled.' })
  }

  if (!isAutomatedEbayResearchEnabled()) {
    return NextResponse.json({ status: 'skipped', message: AUTOMATED_EBAY_RESEARCH_DISABLED })
  }

  const expected = process.env.CRON_SECRET
  if (!expected) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not set, so scheduled sync is disabled.' },
      { status: 503 },
    )
  }

  const header = request.headers.get('authorization') ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!provided || !tokenMatches(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  try {
    const result = await runSync('cron')
    return NextResponse.json(result, { status: result.status === 'failed' ? 502 : 200 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ status: 'failed', message }, { status: 500 })
  }
}
