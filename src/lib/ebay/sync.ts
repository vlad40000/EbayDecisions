import 'server-only'

import {
  finishSyncRun,
  insertActiveSnapshots,
  insertSoldSnapshots,
  listParts,
  startSyncRun,
  type SyncActiveSnapshot,
  type SyncSoldSnapshot,
} from '@/db/queries'

import type { Period } from '../types'
import { AUTOMATED_EBAY_RESEARCH_DISABLED, isAutomatedEbayResearchEnabled } from './automation-gate'
import { fetchActiveMarket } from './browse'
import { EbayError, getEbayConfig, isEbayConfigured, type EbayAdapterName } from './client'
import { fetchSoldWindows, type SoldWindowsResult } from './insights'

export type SyncResult = {
  runId: number | null
  status: 'success' | 'partial' | 'failed' | 'skipped'
  adapter: EbayAdapterName | null
  partsProcessed: number
  partsFailed: number
  snapshotsWritten: number
  soldSnapshotsWritten: number
  activeSnapshotsWritten: number
  message: string
  failures: { mpn: string; error: string }[]
}

const REQUEST_SPACING_MS = 250
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type ResolvedAdapter = {
  adapter: EbayAdapterName
  note: string
  firstSoldResult?: SoldWindowsResult
}

/** Probe actual scope access instead of guessing from configuration. */
async function resolveAdapter(sampleMpn: string): Promise<ResolvedAdapter> {
  const config = getEbayConfig()
  if (config.adapter === 'browse') return { adapter: 'browse', note: 'Browse (configured)' }
  if (config.adapter === 'insights') return { adapter: 'insights', note: 'Insights (configured)' }

  try {
    const firstSoldResult = await fetchSoldWindows(sampleMpn, config)
    return { adapter: 'insights', note: 'Insights (sold comps)', firstSoldResult }
  } catch (error) {
    const reason = error instanceof EbayError ? `HTTP ${error.status ?? '?'}` : 'error'
    return {
      adapter: 'browse',
      note: `Browse (Insights unavailable: ${reason}; active listings only)`,
    }
  }
}

export async function runSync(trigger: 'cron' | 'manual'): Promise<SyncResult> {
  const empty: Omit<SyncResult, 'status' | 'message'> = {
    runId: null,
    adapter: null,
    partsProcessed: 0,
    partsFailed: 0,
    snapshotsWritten: 0,
    soldSnapshotsWritten: 0,
    activeSnapshotsWritten: 0,
    failures: [],
  }

  // Manual-only mode: skip before reading parts, opening a sync run, or
  // contacting eBay.
  if (!isAutomatedEbayResearchEnabled()) {
    return { ...empty, status: 'skipped', message: AUTOMATED_EBAY_RESEARCH_DISABLED }
  }

  if (!isEbayConfigured()) {
    return {
      ...empty,
      status: 'skipped',
      message: 'eBay credentials are not set. Manual market entry remains available.',
    }
  }

  const config = getEbayConfig()
  const allParts = await listParts()
  if (allParts.length === 0) {
    return { ...empty, status: 'skipped', message: 'No active parts to sync.' }
  }

  const batch = allParts.slice(0, config.syncLimit)
  const runId = await startSyncRun(trigger)

  let resolved: ResolvedAdapter
  try {
    resolved = await resolveAdapter(batch[0]?.mpn ?? '')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finishSyncRun(runId, { status: 'failed', error: message })
    return { ...empty, runId, status: 'failed', message: `Could not reach eBay: ${message}` }
  }

  const soldSnapshots: SyncSoldSnapshot[] = []
  const activeSnapshots: SyncActiveSnapshot[] = []
  const failures: { mpn: string; error: string }[] = []
  const notes = new Set<string>()
  let processed = 0

  for (let index = 0; index < batch.length; index += 1) {
    const part = batch[index]!
    try {
      if (resolved.adapter === 'insights') {
        const result = index === 0 && resolved.firstSoldResult
          ? resolved.firstSoldResult
          : await fetchSoldWindows(part.mpn, config)

        if (!result.exactMpnVerified) {
          notes.add('Insights did not expose titles for every returned sale, so sold MPN qualification relied on eBay keyword search plus USED condition filtering.')
        }
        if (result.truncated) {
          notes.add('At least one Insights result exceeded one response page; sold counts for truncated samples were left unknown rather than undercounted.')
        }

        for (const [period, aggregate] of Object.entries(result.windows)) {
          if (!aggregate) continue
          soldSnapshots.push({
            partId: part.id,
            period: period as Period,
            price: aggregate.avgSoldPrice,
            shipping: aggregate.avgShipping,
            soldQty: aggregate.totalSold,
            source: 'ebay_insights',
            sampleSize: aggregate.sampleSize,
          })
        }
      } else {
        const active = await fetchActiveMarket(part.mpn, config)
        if (active.truncated) {
          notes.add('At least one Browse result was truncated; its active-listing count was left unknown rather than undercounted.')
        }
        activeSnapshots.push({
          partId: part.id,
          askingPrice: active.askingPrice,
          askingShipping: active.askingShipping,
          activeQty: active.activeQty,
          sampleSize: active.sampleSize,
          broadMatchCount: active.broadMatchCount,
          mpnRejectedCount: active.mpnRejectedCount,
          conditionRejectedCount: active.conditionRejectedCount,
          truncated: active.truncated,
        })
      }
      processed += 1
    } catch (error) {
      failures.push({
        mpn: part.mpn,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    if (index < batch.length - 1) await sleep(REQUEST_SPACING_MS)
  }

  let soldWritten = 0
  let activeWritten = 0
  try {
    // Only one adapter runs per sync, so normally only one of these performs a
    // database statement. Empty batches are no-ops.
    soldWritten = await insertSoldSnapshots(soldSnapshots)
    activeWritten = await insertActiveSnapshots(activeSnapshots)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finishSyncRun(runId, {
      status: 'failed',
      adapter: resolved.adapter,
      partsProcessed: processed,
      partsFailed: failures.length,
      error: `Fetched market data but the write failed: ${message}`,
    })
    return {
      runId,
      status: 'failed',
      adapter: resolved.adapter,
      partsProcessed: processed,
      partsFailed: failures.length,
      snapshotsWritten: 0,
      soldSnapshotsWritten: 0,
      activeSnapshotsWritten: 0,
      message: `Fetched ${processed} parts but could not save: ${message}`,
      failures,
    }
  }

  const written = soldWritten + activeWritten
  const status = failures.length === 0 ? 'success' : processed > 0 ? 'partial' : 'failed'
  await finishSyncRun(runId, {
    status,
    adapter: resolved.adapter,
    partsProcessed: processed,
    partsFailed: failures.length,
    snapshotsWritten: written,
    soldSnapshotsWritten: soldWritten,
    activeSnapshotsWritten: activeWritten,
    error:
      failures.length > 0
        ? failures.slice(0, 10).map((failure) => `${failure.mpn}: ${failure.error}`).join('; ')
        : null,
  })

  const skipped = allParts.length - batch.length
  const messageParts = [
    `${resolved.note}: ${processed} of ${batch.length} parts, ${written} observations written.`,
  ]
  if (failures.length > 0) messageParts.push(`${failures.length} failed.`)
  if (skipped > 0) messageParts.push(`${skipped} skipped by EBAY_SYNC_LIMIT.`)
  for (const note of notes) messageParts.push(note)

  return {
    runId,
    status,
    adapter: resolved.adapter,
    partsProcessed: processed,
    partsFailed: failures.length,
    snapshotsWritten: written,
    soldSnapshotsWritten: soldWritten,
    activeSnapshotsWritten: activeWritten,
    message: messageParts.join(' '),
    failures,
  }
}
