import { z } from 'zod'

import { toMpnKey } from './mpn'
import { firstIssueMessage } from './part-registration'

/**
 * Targeted research contract v1, served to Parts Engine by
 * POST /api/integrations/research.
 *
 * One explicit call researches a deliberate working set of already-registered
 * exact MPNs through the official eBay APIs. Active competition (Browse) and
 * sold demand (Marketplace Insights) are separate streams with separate
 * outcomes; one can be saved while the other is unavailable.
 *
 * The response reports what happened, not the facts themselves — read those
 * from POST /api/integrations/market-facts afterwards.
 *
 * Sold outcomes:
 * - `saved`: Insights answered and every returned sale was title-checked
 *   against the exact MPN (`exactMpnVerified`), so the windows were saved.
 * - `unverified`: Insights answered but exact-MPN verification was not
 *   possible (a sale without a title, or no sales returned). Nothing saved.
 * - `unavailable`: these credentials have no Marketplace Insights access.
 * - `failed`: the call or the write failed. Nothing saved.
 *
 * Active outcomes are `saved`, `unavailable`, or `failed` on the same terms.
 */
export type ResearchSoldOutcome = 'saved' | 'unavailable' | 'unverified' | 'failed'
export type ResearchActiveOutcome = 'saved' | 'unavailable' | 'failed'
export type ResearchOverall = 'success' | 'partial' | 'failed'

export type TargetedResearchResultV1 = {
  mpnKey: string
  mpnDisplay: string | null
  registration: 'registered' | 'unregistered'
  /** null when the MPN is unregistered and nothing was attempted. */
  sold: ResearchSoldOutcome | null
  active: ResearchActiveOutcome | null
  /** success = both streams saved, partial = one saved, failed = none saved. */
  overall: ResearchOverall
  /** Fixed explanations written by this app; never eBay bodies or credentials. */
  notes: string[]
}

export type TargetedResearchEnvelopeV1 = {
  schemaVersion: 1
  generatedAt: string
  results: TargetedResearchResultV1[]
}

/** Same cap as a Research Queue working set. */
export const RESEARCH_MAX_MPNS = 20

const requestSchema = z.strictObject({
  mpns: z
    .array(z.string().max(200))
    .min(1, 'At least one MPN is required.')
    .max(RESEARCH_MAX_MPNS, `At most ${RESEARCH_MAX_MPNS} MPNs per research request.`),
})

/**
 * Validates a research body and reduces it to D1 keys, first-seen order kept.
 * Equivalent spellings collapse to one key and research runs once per key.
 */
export function parseTargetedResearchRequest(
  body: unknown,
): { ok: true; keys: string[] } | { ok: false; error: string } {
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) return { ok: false, error: firstIssueMessage(parsed.error) }

  const keys = [...new Set(parsed.data.mpns.map(toMpnKey).filter(Boolean))]
  if (keys.length === 0) {
    return { ok: false, error: 'At least one MPN with letters or digits is required.' }
  }
  return { ok: true, keys }
}

export function overallOutcome(
  sold: ResearchSoldOutcome | null,
  active: ResearchActiveOutcome | null,
): ResearchOverall {
  const saved = (sold === 'saved' ? 1 : 0) + (active === 'saved' ? 1 : 0)
  return saved === 2 ? 'success' : saved === 1 ? 'partial' : 'failed'
}
