'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { getPartByMpn, insertActiveSnapshots, saveMarketResearchSession } from '@/db/queries'
import { fetchActiveMarket } from '@/lib/ebay/browse'
import { requireSession } from '@/lib/session'
import { PERIODS } from '@/lib/types'

const MAX_AMOUNT = 1_000_000


const activeCaptureSchema = z.object({
  partId: z.coerce.number().int().positive(),
  mpn: z.string().trim().min(1).max(64),
})

export type CaptureActiveResult =
  | { ok: true; capturedAt: string }
  | { ok: false; error: string }

export async function captureActiveResearch(input: {
  partId: number
  mpn: string
}): Promise<CaptureActiveResult> {
  await requireSession()

  const parsed = activeCaptureSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'That MPN is not valid.' }
  }

  const part = await getPartByMpn(parsed.data.mpn)
  if (!part || part.id !== parsed.data.partId) {
    return { ok: false, error: 'The MPN no longer matches this inventory row.' }
  }

  try {
    const active = await fetchActiveMarket(parsed.data.mpn)
    await insertActiveSnapshots([
      {
        partId: part.id,
        askingPrice: active.askingPrice,
        askingShipping: active.askingShipping,
        activeQty: active.activeQty,
        sampleSize: active.sampleSize,
        broadMatchCount: active.broadMatchCount,
        mpnRejectedCount: active.mpnRejectedCount,
        conditionRejectedCount: active.conditionRejectedCount,
        truncated: active.truncated,
      },
    ])

    revalidatePath('/tracker')
    revalidatePath('/opportunities')
    revalidatePath('/research')
    revalidatePath(`/inventory/${encodeURIComponent(part.mpn)}`)

    return { ok: true, capturedAt: new Date().toISOString() }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not capture active eBay research.',
    }
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
    source: z
      .enum(['ebay_product_research_manual', 'ebay_insights_reviewed'])
      .default('ebay_product_research_manual'),
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

export type ResearchSaveSource = 'ebay_product_research_manual' | 'ebay_insights_reviewed'

export async function saveResearch(input: {
  partId: number
  source?: ResearchSaveSource
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
      source: parsed.data.source,
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
