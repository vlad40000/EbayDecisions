import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'

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
 * Scheduled sync is opt-in. Vercel may still invoke this route from vercel.json,
 * but with EBAY_CRON_ENABLED unset/false it returns before touching Neon.
 */
export async function GET(request: NextRequest) {
  if (process.env.EBAY_CRON_ENABLED !== 'true') {
    return NextResponse.json({ status: 'skipped', message: 'Scheduled eBay sync is disabled.' })
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
