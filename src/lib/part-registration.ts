import { z } from 'zod'

import { toMpnKey } from './mpn'

/**
 * Part registration contract v1, served to Parts Engine by
 * POST /api/integrations/parts/register.
 *
 * Registration only makes an MPN identity known here so it can be researched.
 * It never overwrites an existing part, never calls eBay, and carries no Parts
 * Engine data: donor counts are not physical inventory, so a new provider row
 * always starts with inventory 0 and blank economics.
 */
export type PartRegistrationResultV1 = {
  mpnKey: string
  /** The stored display MPN — the existing spelling when status is `existing`. */
  mpnDisplay: string
  status: 'inserted' | 'existing'
}

export type PartRegistrationEnvelopeV1 = {
  schemaVersion: 1
  generatedAt: string
  results: PartRegistrationResultV1[]
}

export type PartRegistrationEntry = {
  mpnKey: string
  mpnDisplay: string
  description: string
}

export const REGISTRATION_MAX_PARTS = 100

/*
 * Strict objects: a field this contract does not define (inventoryQty,
 * donorCount, costBasis, machine IDs …) is rejected rather than silently
 * dropped, so a caller can never believe it copied Parts Engine data here.
 */
const requestSchema = z.strictObject({
  parts: z
    .array(
      z.strictObject({
        mpn: z.string().max(200),
        description: z.string().max(500).nullish(),
      }),
    )
    .max(REGISTRATION_MAX_PARTS, `At most ${REGISTRATION_MAX_PARTS} parts per request.`),
})

export function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid request body.'
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
}

/**
 * Validates a registration body and reduces it to one entry per D1 key.
 *
 * Equivalent spellings collapse to the first-seen entry (its display MPN and
 * description win), and spellings with no letters or digits are dropped before
 * anything reaches the database.
 */
export function parsePartRegistrationRequest(
  body: unknown,
): { ok: true; entries: PartRegistrationEntry[] } | { ok: false; error: string } {
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) return { ok: false, error: firstIssueMessage(parsed.error) }

  const entries = new Map<string, PartRegistrationEntry>()
  for (const part of parsed.data.parts) {
    const mpnKey = toMpnKey(part.mpn)
    if (!mpnKey || entries.has(mpnKey)) continue
    entries.set(mpnKey, {
      mpnKey,
      mpnDisplay: part.mpn.trim(),
      description: part.description?.trim() ?? '',
    })
  }
  return { ok: true, entries: [...entries.values()] }
}
