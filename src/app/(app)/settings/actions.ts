'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { updateSettings } from '@/db/queries'
import { requireSession } from '@/lib/session'

export type ActionResult = { ok: true } | { ok: false; error: string }

const schema = z
  .object({
    feePct: z.coerce
      .number()
      .min(0, 'Fee percent cannot be negative.')
      .max(99, 'A fee of 99% or more leaves nothing to sell for.'),
    feeFixed: z.coerce.number().min(0, 'The fixed fee cannot be negative.'),
    defaultShipCost: z.coerce.number().min(0, 'Ship cost cannot be negative.'),
    targetMarginPct: z.coerce
      .number()
      .min(0, 'Target margin cannot be negative.')
      .max(99, 'A target margin of 100% or more is not reachable.'),
    minMarginPct: z.coerce
      .number()
      .min(0, 'The margin floor cannot be negative.')
      .max(99, 'A margin floor of 100% or more is not reachable.'),
  })
  .refine((value) => value.minMarginPct <= value.targetMarginPct, {
    message: 'The margin floor has to be at or below the target margin.',
    path: ['minMarginPct'],
  })

export async function saveSettings(formData: FormData): Promise<ActionResult> {
  await requireSession()

  const parsed = schema.safeParse({
    feePct: formData.get('feePct'),
    feeFixed: formData.get('feeFixed'),
    defaultShipCost: formData.get('defaultShipCost'),
    targetMarginPct: formData.get('targetMarginPct'),
    minMarginPct: formData.get('minMarginPct'),
  })

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the values and retry.' }
  }

  try {
    await updateSettings(parsed.data)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save settings.' }
  }

  // Every recommendation is a function of these numbers.
  revalidatePath('/settings')
  revalidatePath('/decisions')
  revalidatePath('/inventory')
  return { ok: true }
}
