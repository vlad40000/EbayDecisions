import { NextResponse } from 'next/server'

import { EbayError, isEbayConfigured } from '@/lib/ebay/client'
import { fetchSoldWindows } from '@/lib/ebay/insights'
import { hasValidSession } from '@/lib/session'

export const maxDuration = 60

export async function GET(_request: Request, props: { params: Promise<{ mpn: string }> }) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }

  if (!isEbayConfigured()) {
    return NextResponse.json(
      {
        error:
          'eBay credentials are not configured. Continue with manual Product Research, or add approved eBay Buy API credentials.',
      },
      { status: 503 },
    )
  }

  const { mpn: raw } = await props.params
  const mpn = decodeURIComponent(raw).trim()
  if (!mpn || mpn.length > 64) {
    return NextResponse.json({ error: 'A valid MPN is required.' }, { status: 400 })
  }

  try {
    const result = await fetchSoldWindows(mpn)
    return NextResponse.json(
      {
        source: 'ebay_marketplace_insights',
        ...result,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    const message =
      error instanceof EbayError
        ? `${error.message} Marketplace Insights is restricted by eBay; if your key lacks that scope, use manual Product Research.`
        : error instanceof Error
          ? error.message
          : 'Could not fetch eBay SOLD research.'

    return NextResponse.json({ error: message }, { status: 502 })
  }
}
