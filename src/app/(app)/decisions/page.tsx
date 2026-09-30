import { DecisionBoard, type BoardRow } from '@/components/decision-board'
import { SyncButton } from '@/components/sync-button'
import { DatabaseError, Notice, PageHeader, StatCard } from '@/components/ui'
import { getSettings, listPartsWithMarket, loadTrendSummaries, recentSyncRuns } from '@/db/queries'
import { decide, type Action } from '@/lib/decisions'
import { isEbayConfigured } from '@/lib/ebay/client'
import { money, relativeTime } from '@/lib/format'
import { requireSession } from '@/lib/session'

export const metadata = { title: 'Decisions — EbayDecisions' }

// Pricing decisions must reflect the latest sync, never a cached page.
export const dynamic = 'force-dynamic'

type Loaded = {
  rows: BoardRow[]
  totals: {
    units: number
    upside: number
    exposure: number
    needsData: number
    actionCounts: Map<Action, number>
  }
  lastSync: { at: string; status: string; adapter: string | null } | null
  error: string | null
}

async function load(): Promise<Loaded> {
  const empty: Loaded = {
    rows: [],
    totals: { units: 0, upside: 0, exposure: 0, needsData: 0, actionCounts: new Map() },
    lastSync: null,
    error: null,
  }

  try {
    const [settings, parts, runs] = await Promise.all([
      getSettings(),
      listPartsWithMarket(),
      recentSyncRuns(1),
    ])
    const trendSummaries = await loadTrendSummaries(parts.map((part) => part.id))

    const actionCounts = new Map<Action, number>()
    let units = 0
    let upside = 0
    let exposure = 0
    let needsData = 0

    const rows: BoardRow[] = parts.map((part) => {
      const decision = decide(part, settings, trendSummaries.get(part.id))
      actionCounts.set(decision.action, (actionCounts.get(decision.action) ?? 0) + 1)
      units += part.inventoryQty

      const potential = decision.potentialDollars
      if (potential != null) {
        if (potential >= 0) upside += potential
        else exposure += potential
      }
      if (decision.action === 'NEEDS_DATA') needsData += 1

      return {
        mpn: part.mpn,
        description: part.description,
        category: part.category,
        inventoryQty: part.inventoryQty,
        costBasis: part.costBasis,
        marketPrice: decision.economics?.price ?? null,
        marketShipping: decision.economics?.shipping ?? null,
        netProceeds: decision.economics?.netProceeds ?? null,
        marginDollars: decision.economics?.marginDollars ?? null,
        marginPct: decision.economics?.marginPct ?? null,
        potentialDollars: potential,
        suggestedListPrice: decision.suggestedListPrice,
        marketTrendDirection: decision.marketTrend.direction,
        marketTrendPct: decision.marketTrend.pctPer30d,
        marketTrendBasis: decision.marketTrend.basis,
        demandTrendDirection: decision.demandTrend.direction,
        demandTrendPct: decision.demandTrend.pctPer30d,
        supplyTrendDirection: decision.supplyTrend.direction,
        supplyTrendPct: decision.supplyTrend.pctPer30d,
        action: decision.action,
        reason: decision.reason,
        notes: decision.notes,
        provenance: decision.provenance,
      }
    })

    const run = runs[0]

    return {
      rows,
      totals: { units, upside, exposure, needsData, actionCounts },
      lastSync: run
        ? { at: run.startedAt.toISOString(), status: run.status, adapter: run.adapter }
        : null,
      error: null,
    }
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) }
  }
}

export default async function DecisionsPage() {
  await requireSession()
  const { rows, totals, lastSync, error } = await load()
  const ebayReady = isEbayConfigured()

  const listNow = totals.actionCounts.get('LIST_NOW') ?? 0
  const dump = totals.actionCounts.get('DUMP') ?? 0

  return (
    <div>
      <PageHeader
        title="Decisions"
        subtitle={
          [
            `${rows.length} MPNs`,
            lastSync
              ? `last sync ${relativeTime(lastSync.at)} · ${lastSync.status}${lastSync.adapter ? ` · ${lastSync.adapter}` : ''}`
              : 'no sync has run yet',
          ].join(' · ')
        }
        action={<SyncButton enabled={ebayReady} />}
      />

      {error ? (
        <DatabaseError error={error} />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="List now"
              value={String(listNow)}
              sub={listNow > 0 ? 'Act on these first' : 'Nothing urgent'}
              tone={listNow > 0 ? 'good' : 'neutral'}
            />
            <StatCard
              label="Upside on hand"
              value={money(totals.upside)}
              sub={`${totals.units} units`}
              tone="good"
              hint="Sum of positive margin times units held, at the latest observed market."
            />
            <StatCard
              label="Underwater"
              value={money(totals.exposure)}
              sub={dump > 0 ? `${dump} to dump` : 'None'}
              tone={totals.exposure < 0 ? 'bad' : 'neutral'}
              hint="Parts that lose money at the current market, summed across units held."
            />
            <StatCard
              label="Needs data"
              value={String(totals.needsData)}
              sub={totals.needsData > 0 ? 'Missing cost or comps' : 'All parts priced'}
              tone={totals.needsData > 0 ? 'warn' : 'neutral'}
            />
          </div>

          {!ebayReady && (
            <div className="mb-4">
              <Notice tone="info">
                eBay credentials are not set, so market data comes only from what you enter in the
                Tracker. Add <code className="font-mono">EBAY_CLIENT_ID</code> and{' '}
                <code className="font-mono">EBAY_CLIENT_SECRET</code> to turn on syncing.
              </Notice>
            </div>
          )}

          <DecisionBoard rows={rows} />
        </>
      )}
    </div>
  )
}
