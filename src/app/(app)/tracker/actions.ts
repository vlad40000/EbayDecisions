'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { saveManualSnapshots, type WindowPatch } from '@/db/queries'
import { requireSession } from '@/lib/session'
import { PERIODS } from '@/lib/types'

/** Blank clears the field; anything else must be a sane, non-negative number. */
const MAX_AMOUNT = 1_000_000

const optionalAmount = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : Number(value)))
  .refine((value) => value === null || (Number.isFinite(value) && value >= 0), {
    message: 'Enter a number of 0 or more, or leave it blank.',
  })
  .refine((value) => value === null || value <= MAX_AMOUNT, {
    message: `That is over ${MAX_AMOUNT.toLocaleString()} — check for a typo.`,
  })

/**
 * One window's edits. Every field is optional: only what was actually typed is
 * sent, so a value that changed in the database while you were editing is
 * carried forward rather than clobbered with a stale copy from the browser.
 */
const windowSchema = z.object({
  period: z.enum(PERIODS),
  price: optionalAmount.optional(),
  shipping: optionalAmount.optional(),
  qty: optionalAmount.optional(),
})

const schema = z.object({
  partId: z.coerce.number().int().positive(),
  windows: z.array(windowSchema).min(1).max(PERIODS.length),
})

export type SaveResult = { ok: true } | { ok: false; error: string }

export type WindowInput = {
  period: string
  price?: string
  shipping?: string
  qty?: string
}

/**
 * Saves every edited window of one part in a single call.
 *
 * The grid batches by part rather than firing per field: typing across five
 * windows was up to fifteen round-trips, and this is two or three. Neon bills
 * for the time its compute is awake, so a chatty write path costs real money
 * for no benefit.
 */
export async function saveMarketWindows(input: {
  partId: number
  windows: WindowInput[]
}): Promise<SaveResult> {
  await requireSession()

  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'That value is not valid.',
    }
  }

  const patches: WindowPatch[] = parsed.data.windows.map((window) => ({
    period: window.period,
    ...(window.price !== undefined ? { price: window.price } : {}),
    ...(window.shipping !== undefined ? { shipping: window.shipping } : {}),
    // Market quantity is a count of listings or sales, so it is a whole number.
    ...(window.qty !== undefined
      ? { qty: window.qty == null ? null : Math.round(window.qty) }
      : {}),
  }))

  try {
    await saveManualSnapshots(parsed.data.partId, patches)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save.' }
  }

  // The board reads these numbers, so refresh it too.
  revalidatePath('/tracker')
  revalidatePath('/decisions')
  return { ok: true }
}
