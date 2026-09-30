import { NextResponse } from 'next/server'

import { runSync } from '@/lib/ebay/sync'
import { hasValidSession } from '@/lib/session'

/** A sync walks every active part, so give it room. */
export const maxDuration = 300

export async function POST() {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }

  try {
    const result = await runSync('manual')
    return NextResponse.json(result, { status: result.status === 'failed' ? 502 : 200 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ status: 'failed', message }, { status: 500 })
  }
}
