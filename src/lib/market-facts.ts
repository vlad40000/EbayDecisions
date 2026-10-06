import { z } from 'zod'

import { toMpnKey } from './mpn'

/**
 * Market facts contract v1, served to Parts Engine by
 * POST /api/integrations/market-facts.
 *
 * Sold demand and active competition are separate streams and are never
 * combined: `soldQty` is 90-day sold units, `activeQty` is current active
 * listings, and `sellThroughPct` is only ever the stored exact-MPN Product
 * Research value. Missing data stays null — it is never turned into zero.
 */
export type MarketFactsV1 = {
  mpnKey: string
  mpnDisplay: string | null
  status: 'found' | 'unregistered'

  sold90: null | {
    soldQty: number | null
    avgSoldPrice: number | null
    avgBuyerShipping: number | null
    sellThroughPct: number | null
    source: 'manual' | 'ebay_insights' | 'ebay_browse'
    priceBasis: 'unknown' | 'sold' | 'asking'
    capturedAt: string
  }

  active: null | {
    activeQty: number | null
    askingPrice: number | null
    askingShipping: number | null
    source: 'manual' | 'ebay_browse'
    sampleSize: number | null
    truncated: boolean
    capturedAt: string
  }
}

export type MarketFactsEnvelopeV1 = {
  schemaVersion: 1
  generatedAt: string
  facts: MarketFactsV1[]
}

export const MARKET_FACTS_MAX_MPNS = 100

const requestSchema = z.object({
  mpns: z
    .array(z.string().max(200))
    .max(MARKET_FACTS_MAX_MPNS, `At most ${MARKET_FACTS_MAX_MPNS} MPNs per request.`),
})

/**
 * Validates a request body and reduces it to the D1 keys to look up.
 *
 * Every spelling goes through `toMpnKey`; equivalent spellings collapse to one
 * key (first-seen order kept), and spellings with no letters or digits are
 * dropped before anything reaches the database.
 */
export function parseMarketFactsRequest(
  body: unknown,
): { ok: true; keys: string[] } | { ok: false; error: string } {
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }
  }
  const keys = [...new Set(parsed.data.mpns.map(toMpnKey).filter(Boolean))]
  return { ok: true, keys }
}
