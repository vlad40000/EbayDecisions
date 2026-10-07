import 'server-only'

import {
  findPartsByMpnKeys,
  insertActiveSnapshots,
  insertSoldSnapshots,
  type PartIdentity,
  type SyncSoldSnapshot,
} from '@/db/queries'

import {
  overallOutcome,
  type ResearchActiveOutcome,
  type ResearchSoldOutcome,
  type TargetedResearchResultV1,
} from '../targeted-research'
import type { Period } from '../types'
import { assertAutomatedEbayResearchEnabled } from './automation-gate'
import { fetchActiveMarket, type BrowseResult } from './browse'
import { EbayError, getAccessToken, getEbayConfig, type EbayConfig } from './client'
import { fetchSoldWindows, type SoldWindowsResult } from './insights'

/**
 * Explicit exact-MPN research for the integration API.
 *
 * Unlike `runSync`, which walks the active catalogue and picks one adapter for
 * the whole run, this researches only the requested, already-registered parts
 * and runs both official adapters for each one: Browse for active competition
 * and Marketplace Insights for sold demand. Each stream succeeds or fails on
 * its own, and each part's rows are written before the next part is fetched,
 * so one failure never erases or blocks another part's facts.
 *
 * Writes go through the existing append-only snapshot writers. Nothing here
 * registers parts, touches inventory, opens a research session, or computes
 * sell-through.
 */

const REQUEST_SPACING_MS = 250
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type StreamAccess = 'ready' | 'unavailable' | 'failed'
type Access = { active: StreamAccess; sold: StreamAccess }

/*
 * A token grant refused with 400/401/403 (eBay answers `invalid_scope` for a
 * scope the app is not approved for) and a data call refused with 401/403 are
 * access facts, not per-MPN failures. Rate limits and 5xx stay `failed`.
 */
const TOKEN_DENIED = new Set([400, 401, 403])
const REQUEST_DENIED = new Set([401, 403])

function hasStatus(error: unknown, statuses: Set<number>): boolean {
  return error instanceof EbayError && error.status != null && statuses.has(error.status)
}

async function probeAccess(scope: string, config: EbayConfig): Promise<StreamAccess> {
  try {
    await getAccessToken(scope, config)
    return 'ready'
  } catch (error) {
    return hasStatus(error, TOKEN_DENIED) ? 'unavailable' : 'failed'
  }
}

/** Our own words plus the HTTP status only — never eBay's message or body. */
function failureNote(stream: 'Active' | 'Sold', error: unknown): string {
  return error instanceof EbayError && error.status != null
    ? `${stream}: eBay answered HTTP ${error.status}; nothing saved.`
    : `${stream}: the eBay request failed; nothing saved.`
}

const NOTES = {
  activeUnavailable: 'Active: these eBay credentials have no Browse access; nothing saved.',
  activeTokenFailed: 'Active: could not get an eBay Browse token; nothing saved.',
  activeWriteFailed: 'Active: fetched but could not be saved.',
  activeTruncated:
    'Active: more listings than one page; active count left unknown, asking-price sample kept.',
  soldUnavailable:
    'Sold: these eBay credentials have no Marketplace Insights access; nothing saved.',
  soldTokenFailed: 'Sold: could not get an eBay Marketplace Insights token; nothing saved.',
  soldWriteFailed: 'Sold: fetched but could not be saved.',
  soldUnverified:
    'Sold: exact-MPN verification was not possible (a returned sale had no title, or none were returned); nothing saved.',
  soldTruncated:
    'Sold: more sales than one page; sold quantities left unknown, sampled sold prices kept.',
  unregistered: 'Not registered. Register the MPN first; research never registers parts.',
} as const

type StreamResult<T> = { outcome: T; notes: string[] }

async function researchActive(
  part: PartIdentity,
  config: EbayConfig,
  access: Access,
): Promise<StreamResult<ResearchActiveOutcome>> {
  if (access.active === 'unavailable') return { outcome: 'unavailable', notes: [NOTES.activeUnavailable] }
  if (access.active === 'failed') return { outcome: 'failed', notes: [NOTES.activeTokenFailed] }

  let result: BrowseResult
  try {
    result = await fetchActiveMarket(part.mpn, config)
  } catch (error) {
    if (hasStatus(error, REQUEST_DENIED)) {
      access.active = 'unavailable'
      return { outcome: 'unavailable', notes: [NOTES.activeUnavailable] }
    }
    return { outcome: 'failed', notes: [failureNote('Active', error)] }
  }

  try {
    // A truncated result already carries activeQty = null from the adapter.
    await insertActiveSnapshots([
      {
        partId: part.id,
        askingPrice: result.askingPrice,
        askingShipping: result.askingShipping,
        activeQty: result.activeQty,
        sampleSize: result.sampleSize,
        broadMatchCount: result.broadMatchCount,
        mpnRejectedCount: result.mpnRejectedCount,
        conditionRejectedCount: result.conditionRejectedCount,
        truncated: result.truncated,
      },
    ])
  } catch {
    return { outcome: 'failed', notes: [NOTES.activeWriteFailed] }
  }
  return { outcome: 'saved', notes: result.truncated ? [NOTES.activeTruncated] : [] }
}

async function researchSold(
  part: PartIdentity,
  config: EbayConfig,
  access: Access,
): Promise<StreamResult<ResearchSoldOutcome>> {
  if (access.sold === 'unavailable') return { outcome: 'unavailable', notes: [NOTES.soldUnavailable] }
  if (access.sold === 'failed') return { outcome: 'failed', notes: [NOTES.soldTokenFailed] }

  let result: SoldWindowsResult
  try {
    result = await fetchSoldWindows(part.mpn, config)
  } catch (error) {
    if (hasStatus(error, REQUEST_DENIED)) {
      access.sold = 'unavailable'
      return { outcome: 'unavailable', notes: [NOTES.soldUnavailable] }
    }
    return { outcome: 'failed', notes: [failureNote('Sold', error)] }
  }

  // MPN-only rule: sold observations are saved only when every returned sale
  // was title-checked against the exact MPN.
  if (result.exactMpnVerified !== true) return { outcome: 'unverified', notes: [NOTES.soldUnverified] }

  // Truncated windows already carry totalSold = null from the adapter. There
  // is no sell-through field to write: it is never derived from sold/active.
  const rows: SyncSoldSnapshot[] = []
  for (const [period, aggregate] of Object.entries(result.windows)) {
    if (!aggregate) continue
    rows.push({
      partId: part.id,
      period: period as Period,
      price: aggregate.avgSoldPrice,
      shipping: aggregate.avgShipping,
      soldQty: aggregate.totalSold,
      source: 'ebay_insights',
      sampleSize: aggregate.sampleSize,
    })
  }

  try {
    await insertSoldSnapshots(rows)
  } catch {
    return { outcome: 'failed', notes: [NOTES.soldWriteFailed] }
  }
  return { outcome: 'saved', notes: result.truncated ? [NOTES.soldTruncated] : [] }
}

/**
 * Researches each D1 key once, in request order. Keys with no registered part
 * come back `unregistered` and are never created. eBay is only contacted once
 * a registered part is reached.
 *
 * Throws AutomatedEbayResearchDisabledError before any lookup in manual-only
 * mode; the route answers 503 before calling this.
 */
export async function researchExactMpns(keys: string[]): Promise<TargetedResearchResultV1[]> {
  assertAutomatedEbayResearchEnabled()

  const partByKey = new Map((await findPartsByMpnKeys(keys)).map((part) => [part.mpnKey, part]))

  let config: EbayConfig | null = null
  let access: Access | null = null
  let researched = 0
  const results: TargetedResearchResultV1[] = []

  for (const mpnKey of keys) {
    const part = partByKey.get(mpnKey)
    if (!part) {
      results.push({
        mpnKey,
        mpnDisplay: null,
        registration: 'unregistered',
        sold: null,
        active: null,
        overall: 'failed',
        notes: [NOTES.unregistered],
      })
      continue
    }

    if (researched++ > 0) await sleep(REQUEST_SPACING_MS)
    config ??= getEbayConfig()
    access ??= {
      active: await probeAccess(config.browseScope, config),
      sold: await probeAccess(config.insightsScope, config),
    }

    const active = await researchActive(part, config, access)
    const sold = await researchSold(part, config, access)
    results.push({
      mpnKey,
      mpnDisplay: part.mpn,
      registration: 'registered',
      sold: sold.outcome,
      active: active.outcome,
      overall: overallOutcome(sold.outcome, active.outcome),
      notes: [...active.notes, ...sold.notes],
    })
  }

  return results
}
