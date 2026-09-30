'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import {
  saveManualMarket,
  saveMarketResearchSession,
  type ManualActivePatch,
  type ManualWindowPatch,
} from '@/db/queries'
import { requireSession } from '@/lib/session'
import { PERIODS } from '@/lib/types'

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

const windowSchema = z.object({
  period: z.enum(PERIODS),
  price: optionalAmount.optional(),
  shipping: optionalAmount.optional(),
  soldQty: optionalAmount.optional(),
  priceBasis: z.enum(['unknown', 'sold', 'asking']).optional(),
})

const activeSchema = z
  .object({
    askingPrice: optionalAmount.optional(),
    askingShipping: optionalAmount.optional(),
    activeQty: optionalAmount.optional(),
    source: z.enum(['manual', 'ebay_browse']).optional(),
    sampleSize: z.number().int().nonnegative().nullable().optional(),
    broadMatchCount: z.number().int().nonnegative().nullable().optional(),
    mpnRejectedCount: z.number().int().nonnegative().nullable().optional(),
    conditionRejectedCount: z.number().int().nonnegative().nullable().optional(),
    truncated: z.boolean().optional(),
  })
  .optional()

const schema = z
  .object({
    partId: z.coerce.number().int().positive(),
    windows: z.array(windowSchema).max(PERIODS.length).default([]),
    active: activeSchema,
  })
  .refine((value) => value.windows.length > 0 || value.active != null, {
    message: 'Nothing changed for this MPN.',
  })
  .refine((value) => new Set(value.windows.map((window) => window.period)).size === value.windows.length, {
    message: 'A lookback window can only be saved once per request.',
  })

export type WindowInput = {
  period: string
  price?: string
  shipping?: string
  soldQty?: string
  priceBasis?: string
}

export type ActiveInput = {
  askingPrice?: string
  askingShipping?: string
  activeQty?: string
  source?: 'manual' | 'ebay_browse'
  sampleSize?: number | null
  broadMatchCount?: number | null
  mpnRejectedCount?: number | null
  conditionRejectedCount?: number | null
  truncated?: boolean
}

export type SaveResult =
  | { ok: true; written: number }
  | { ok: false; error: string }

export async function saveMarketPart(input: {
  partId: number
  windows: WindowInput[]
  active?: ActiveInput
}): Promise<SaveResult> {
  await requireSession()

  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'That value is not valid.' }
  }

  const windows: ManualWindowPatch[] = parsed.data.windows.map((window) => ({
    period: window.period,
    ...(window.price !== undefined ? { price: window.price } : {}),
    ...(window.shipping !== undefined ? { shipping: window.shipping } : {}),
    ...(window.soldQty !== undefined
      ? { soldQty: window.soldQty == null ? null : Math.round(window.soldQty) }
      : {}),
    ...(window.priceBasis !== undefined ? { priceBasis: window.priceBasis } : {}),
  }))

  const active: ManualActivePatch | undefined = parsed.data.active
    ? {
        ...(parsed.data.active.askingPrice !== undefined
          ? { askingPrice: parsed.data.active.askingPrice }
          : {}),
        ...(parsed.data.active.askingShipping !== undefined
          ? { askingShipping: parsed.data.active.askingShipping }
          : {}),
        ...(parsed.data.active.activeQty !== undefined
          ? {
              activeQty:
                parsed.data.active.activeQty == null
                  ? null
                  : Math.round(parsed.data.active.activeQty),
            }
          : {}),
        source: parsed.data.active.source ?? 'manual',
        ...(parsed.data.active.source === 'ebay_browse'
          ? {
              sampleSize: parsed.data.active.sampleSize ?? null,
              broadMatchCount: parsed.data.active.broadMatchCount ?? null,
              mpnRejectedCount: parsed.data.active.mpnRejectedCount ?? null,
              conditionRejectedCount: parsed.data.active.conditionRejectedCount ?? null,
              truncated: parsed.data.active.truncated ?? false,
            }
          : {}),
      }
    : undefined

  try {
    const written = await saveManualMarket({ partId: parsed.data.partId, windows, active })
    revalidatePath('/tracker')
    revalidatePath('/decisions')
    revalidatePath('/inventory')
    return { ok: true, written }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save.' }
  }
}


const researchNumber = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : Number(value)))
  .refine((value) => value === null || (Number.isFinite(value) && value >= 0), {
    message: 'Enter a number of 0 or more, or leave it blank.',
  })
  .refine((value) => value === null || value <= MAX_AMOUNT, {
    message: `That value is over ${MAX_AMOUNT.toLocaleString()} — check for a typo.`,
  })

const researchInteger = researchNumber.refine(
  (value) => value === null || Number.isInteger(value),
  { message: 'Enter a whole number, or leave it blank.' },
)

const freeShippingPct = researchNumber.refine(
  (value) => value === null || value <= 100,
  { message: 'Free shipping must be between 0 and 100%.' },
)

const researchWindowSchema = z
  .object({
    period: z.enum(PERIODS),
    avgSoldPrice: researchNumber,
    avgShipping: researchNumber,
    totalSold: researchInteger,
    soldPriceMin: researchNumber,
    soldPriceMax: researchNumber,
    totalSellers: researchInteger,
    sellThroughPct: researchNumber,
    freeShippingPct,
  })
  .refine(
    (value) =>
      value.soldPriceMin == null ||
      value.soldPriceMax == null ||
      value.soldPriceMin <= value.soldPriceMax,
    { message: 'Range low cannot be greater than range high.' },
  )

const researchSchema = z
  .object({
    partId: z.coerce.number().int().positive(),
    windows: z.array(researchWindowSchema).length(PERIODS.length),
  })
  .refine(
    (value) =>
      new Set(value.windows.map((window) => window.period)).size === PERIODS.length &&
      PERIODS.every((period) => value.windows.some((window) => window.period === period)),
    { message: 'SAVE RESEARCH must include each of the five lookback windows once.' },
  )

export type ResearchWindowFormInput = {
  period: string
  avgSoldPrice: string
  avgShipping: string
  totalSold: string
  soldPriceMin: string
  soldPriceMax: string
  totalSellers: string
  sellThroughPct: string
  freeShippingPct: string
}

export type SaveResearchResult =
  | { ok: true; written: number; researchedAt: string }
  | { ok: false; error: string }

export async function saveResearch(input: {
  partId: number
  windows: ResearchWindowFormInput[]
}): Promise<SaveResearchResult> {
  await requireSession()

  const parsed = researchSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'That research entry is not valid.' }
  }

  const researchedAt = new Date()

  try {
    const written = await saveMarketResearchSession({
      partId: parsed.data.partId,
      researchedAt,
      windows: parsed.data.windows.map((window) => ({
        period: window.period,
        avgSoldPrice: window.avgSoldPrice,
        avgShipping: window.avgShipping,
        totalSold: window.totalSold,
        soldPriceMin: window.soldPriceMin,
        soldPriceMax: window.soldPriceMax,
        totalSellers: window.totalSellers,
        sellThroughPct: window.sellThroughPct,
        freeShippingPct: window.freeShippingPct,
      })),
    })

    revalidatePath('/tracker')
    revalidatePath('/opportunities')
    revalidatePath('/research')
    revalidatePath('/inventory')

    return { ok: true, written, researchedAt: researchedAt.toISOString() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save research.' }
  }
}
