'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { createPart, deletePart, getPartByMpn, updatePart } from '@/db/queries'
import { requireSession } from '@/lib/session'

export type ActionResult = { ok: true } | { ok: false; error: string }

/** Blank clears the field. Anything else must be a sane, non-negative amount. */
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

const partFieldsSchema = z
  .object({
    partId: z.coerce.number().int().positive(),
    inventoryQty: optionalAmount
      .refine((value) => value !== null, {
        message: 'Quantity is required — use 0 for none on hand.',
      })
      .optional(),
    costBasis: optionalAmount.optional(),
    shipCost: optionalAmount.optional(),
    targetMarginPct: optionalAmount
      .refine((value) => value === null || value < 100, {
        message: 'A target margin of 100% or more is not reachable.',
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.inventoryQty !== undefined ||
      value.costBasis !== undefined ||
      value.shipCost !== undefined ||
      value.targetMarginPct !== undefined,
    { message: 'Nothing changed for this part.' },
  )

export type PartFieldsInput = {
  partId: number
  inventoryQty?: string
  costBasis?: string
  shipCost?: string
  targetMarginPct?: string
}

/** Explicit per-row inventory save. One button press becomes one UPDATE. */
export async function savePartFields(input: PartFieldsInput): Promise<ActionResult> {
  await requireSession()
  const parsed = partFieldsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'That value is not valid.' }
  }

  const { partId, ...values } = parsed.data
  try {
    await updatePart(partId, {
      ...(values.inventoryQty !== undefined
        ? { inventoryQty: Math.round(values.inventoryQty ?? 0) }
        : {}),
      ...(values.costBasis !== undefined ? { costBasis: values.costBasis } : {}),
      ...(values.shipCost !== undefined ? { shipCost: values.shipCost } : {}),
      ...(values.targetMarginPct !== undefined ? { targetMarginPct: values.targetMarginPct } : {}),
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save.' }
  }

  revalidatePath('/inventory')
  revalidatePath('/decisions')
  return { ok: true }
}

const newPartSchema = z.object({
  mpn: z.string().trim().min(1, 'MPN is required.').max(64, 'That MPN is too long.'),
  description: z.string().trim().min(1, 'Description is required.').max(200),
  inventoryQty: z.coerce.number().int().min(0).default(0),
  costBasis: optionalAmount,
  sourceUrl: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .refine((value) => value === null || /^https?:\/\//i.test(value), {
      message: 'A source URL must start with http:// or https://.',
    }),
})

export async function addPart(formData: FormData): Promise<ActionResult> {
  await requireSession()

  const parsed = newPartSchema.safeParse({
    mpn: formData.get('mpn') ?? '',
    description: formData.get('description') ?? '',
    inventoryQty: formData.get('inventoryQty') ?? '0',
    costBasis: formData.get('costBasis') ?? '',
    sourceUrl: formData.get('sourceUrl') ?? '',
  })

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  }

  const existing = await getPartByMpn(parsed.data.mpn)
  if (existing) {
    return { ok: false, error: `${parsed.data.mpn} is already in the catalogue.` }
  }

  try {
    await createPart(parsed.data)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not add the part.' }
  }

  revalidatePath('/inventory')
  revalidatePath('/decisions')
  revalidatePath('/tracker')
  return { ok: true }
}

export async function setPartActive(partId: number, active: boolean): Promise<ActionResult> {
  await requireSession()
  try {
    await updatePart(partId, { active })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not update.' }
  }
  revalidatePath('/inventory')
  revalidatePath('/decisions')
  revalidatePath('/tracker')
  return { ok: true }
}

/** Hard delete, cascading to that part's snapshot history. */
export async function removePart(partId: number): Promise<ActionResult> {
  await requireSession()
  try {
    await deletePart(partId)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not delete.' }
  }
  revalidatePath('/inventory')
  revalidatePath('/decisions')
  revalidatePath('/tracker')
  return { ok: true }
}

const detailSchema = z.object({
  partId: z.coerce.number().int().positive(),
  description: z.string().trim().min(1, 'Description is required.').max(200),
  category: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value)),
  notes: z
    .string()
    .trim()
    .max(2000)
    .transform((value) => (value === '' ? null : value)),
  sourceUrl: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .refine((value) => value === null || /^https?:\/\//i.test(value), {
      message: 'A source URL must start with http:// or https://.',
    }),
})

export async function savePartDetail(formData: FormData): Promise<ActionResult> {
  await requireSession()

  const parsed = detailSchema.safeParse({
    partId: formData.get('partId') ?? '',
    description: formData.get('description') ?? '',
    category: formData.get('category') ?? '',
    notes: formData.get('notes') ?? '',
    sourceUrl: formData.get('sourceUrl') ?? '',
  })

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  }

  const { partId, ...fields } = parsed.data

  try {
    await updatePart(partId, fields)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save.' }
  }

  revalidatePath('/inventory')
  revalidatePath('/decisions')
  return { ok: true }
}
