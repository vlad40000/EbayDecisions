'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { saveManualSnapshot } from '@/db/queries'
import { requireSession } from '@/lib/session'
import { PERIODS } from '@/lib/types'

/** Blank clears the field; anything else must be a non-negative number. */
const optionalAmount = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : Number(value)))
  .refine((value) => value === null || (Number.isFinite(value) && value >= 0), {
    message: 'Enter a number of 0 or more, or leave it blank.',
  })

const schema = z.object({
  partId: z.coerce.number().int().positive(),
  period: z.enum(PERIODS),
  field: z.enum(['price', 'shipping', 'qty']),
  value: optionalAmount,
})

export type SaveResult = { ok: true } | { ok: false; error: string }

export async function saveMarketField(input: {
  partId: number
  period: string
  field: string
  value: string
}): Promise<SaveResult> {
  await requireSession()

  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'That value is not valid.' }
  }

  const { partId, period, field, value } = parsed.data

  try {
    await saveManualSnapshot(partId, period, {
      [field]: field === 'qty' && value != null ? Math.round(value) : value,
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save.' }
  }

  // The board reads these numbers, so refresh it too.
  revalidatePath('/tracker')
  revalidatePath('/decisions')
  return { ok: true }
}
