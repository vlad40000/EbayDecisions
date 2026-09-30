/**
 * Sync orchestrator.
 *
 * Picks an adapter, walks the active parts, writes snapshots, and records the run
 * so a failure at 3am is visible at 8am instead of silent.
 *
 * Adapter selection, when EBAY_ADAPTER is "auto": try Insights (real sold comps)
 * and fall back to Browse (active listings) if the Insights scope has not been
 * granted. The fallback is reported in the run row, so you can always tell which
 * kind of data a given night produced.
 */
import {
  finishSyncRun,
  insertSnapshots,
  listParts,
  startSyncRun,
  type SyncSnapshot,
} from '@/db/queries'

import type { Period } from '../types'
import { BROWSE_TARGET_PERIOD, fetchActiveMarket } from './browse'
import { EbayError, getEbayConfig, isEbayConfigured, type EbayAdapterName } from './client'
import { fetchSoldWindows } from './insights'

export type SyncResult = {
  runId: number | null
  status: 'success' | 'partial' | 'failed' | 'skipped'
  adapter: EbayAdapterName | null
  partsProcessed: number
  partsFailed: number
  snapshotsWritten: number
  message: string
  failures: { mpn: string; error: string }[]
}

/** Courtesy pause between parts so a 100-part run does not look like a flood. */
const REQUEST_SPACING_MS = 250

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Decides which adapter to run by actually trying the preferred one.
 *
 * Probing beats guessing: whether the Insights scope is granted is a fact about
 * eBay's records, not something readable from config.
 */
async function resolveAdapter(sampleMpn: string): Promise<{
  adapter: EbayAdapterName
  note: string
}> {
  const config = getEbayConfig()

  if (config.adapter === 'browse') return { adapter: 'browse', note: 'Browse (configured)' }
  if (config.adapter === 'insights') return { adapter: 'insights', note: 'Insights (configured)' }

  try {
    await fetchSoldWindows(sampleMpn, config)
    return { adapter: 'insights', note: 'Insights (sold comps)' }
  } catch (error) {
    const reason = error instanceof EbayError ? `HTTP ${error.status ?? '?'}` : 'error'
    return {
      adapter: 'browse',
      note: `Browse (Insights unavailable: ${reason} — active listings only)`,
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
    failures: [],
  }

  if (!isEbayConfigured()) {
    return {
      ...empty,
      status: 'skipped',
      message:
        'eBay credentials are not set, so there is nothing to sync. Add EBAY_CLIENT_ID and EBAY_CLIENT_SECRET, or keep entering market data in the Tracker.',
    }
  }

  const config = getEbayConfig()
  const allParts = await listParts()

  if (allParts.length === 0) {
    return { ...empty, status: 'skipped', message: 'No active parts to sync. Run `pnpm db:seed` first.' }
  }

  const batch = allParts.slice(0, config.syncLimit)
  const runId = await startSyncRun(trigger)

  let adapter: EbayAdapterName
  let adapterNote: string
  try {
    const resolved = await resolveAdapter(batch[0]?.mpn ?? '')
    adapter = resolved.adapter
    adapterNote = resolved.note
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finishSyncRun(runId, { status: 'failed', error: message })
    return { ...empty, runId, status: 'failed', message: `Could not reach eBay: ${message}` }
  }

  const snapshots: SyncSnapshot[] = []
  const failures: { mpn: string; error: string }[] = []
  let processed = 0

  for (const part of batch) {
    try {
      if (adapter === 'insights') {
        const windows = await fetchSoldWindows(part.mpn, config)
        for (const [period, aggregate] of Object.entries(windows)) {
          if (!aggregate) continue
          snapshots.push({
            partId: part.id,
            period: period as Period,
            price: aggregate.price,
            shipping: aggregate.shipping,
            qty: aggregate.qty,
            source: 'ebay_insights',
            sampleSize: aggregate.sampleSize,
          })
        }
      } else {
        const active = await fetchActiveMarket(part.mpn, config)
        snapshots.push({
          partId: part.id,
          period: BROWSE_TARGET_PERIOD,
          price: active.price,
          shipping: active.shipping,
          qty: active.activeCount,
          source: 'ebay_browse',
          sampleSize: active.sampleSize,
        })
      }
      processed += 1
    } catch (error) {
      failures.push({
        mpn: part.mpn,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    await sleep(REQUEST_SPACING_MS)
  }

  let written = 0
  try {
    written = await insertSnapshots(snapshots)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finishSyncRun(runId, {
      status: 'failed',
      adapter,
      partsProcessed: processed,
      partsFailed: failures.length,
      error: `Fetched market data but the write failed: ${message}`,
    })
    return {
      runId,
      status: 'failed',
      adapter,
      partsProcessed: processed,
      partsFailed: failures.length,
      snapshotsWritten: 0,
      message: `Fetched ${processed} parts but could not save: ${message}`,
      failures,
    }
  }

  const status = failures.length === 0 ? 'success' : processed > 0 ? 'partial' : 'failed'

  await finishSyncRun(runId, {
    status,
    adapter,
    partsProcessed: processed,
    partsFailed: failures.length,
    snapshotsWritten: written,
    error:
      failures.length > 0
        ? failures
            .slice(0, 10)
            .map((f) => `${f.mpn}: ${f.error}`)
            .join('; ')
        : null,
  })

  const skipped = allParts.length - batch.length
  const parts: string[] = [
    `${adapterNote}: ${processed} of ${batch.length} parts, ${written} snapshots written.`,
  ]
  if (failures.length > 0) parts.push(`${failures.length} failed.`)
  if (skipped > 0) parts.push(`${skipped} parts skipped by EBAY_SYNC_LIMIT.`)
  if (adapter === 'browse') {
    parts.push('These are active-listing asking prices, not sold comps.')
  }

  return {
    runId,
    status,
    adapter,
    partsProcessed: processed,
    partsFailed: failures.length,
    snapshotsWritten: written,
    message: parts.join(' '),
    failures,
  }
}
