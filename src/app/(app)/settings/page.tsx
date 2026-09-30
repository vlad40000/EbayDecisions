import { ImportExport } from '@/components/import-export'
import { SettingsForm } from '@/components/settings-form'
import { Chip, DatabaseError, Notice, PageHeader, Panel } from '@/components/ui'
import { getSettings, recentSyncRuns } from '@/db/queries'
import { getEbayConfig, isEbayConfigured } from '@/lib/ebay/client'
import { relativeTime } from '@/lib/format'
import { requireSession } from '@/lib/session'
import type { EconomicSettings } from '@/lib/types'

export const metadata = { title: 'Settings — EbayDecisions' }
export const dynamic = 'force-dynamic'

const FALLBACK: EconomicSettings = {
  feePct: 13.25,
  feeFixed: 0.3,
  defaultShipCost: 12,
  targetMarginPct: 35,
  minMarginPct: 15,
}

export default async function SettingsPage() {
  await requireSession()

  let settings = FALLBACK
  let runs: Awaited<ReturnType<typeof recentSyncRuns>> = []
  let error: string | null = null

  try {
    ;[settings, runs] = await Promise.all([getSettings(), recentSyncRuns(8)])
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  const ebayReady = isEbayConfigured()
  let ebayDetail: { env: string; marketplace: string; adapter: string; limit: number } | null = null
  if (ebayReady) {
    try {
      const config = getEbayConfig()
      ebayDetail = {
        env: config.host.includes('sandbox') ? 'sandbox' : 'production',
        marketplace: config.marketplaceId,
        adapter: config.adapter,
        limit: config.syncLimit,
      }
    } catch {
      ebayDetail = null
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        subtitle="Data connections, import/export, and retained listing-economics assumptions."
      />

      {error && <DatabaseError error={error} />}

      <SettingsForm settings={settings} />

      <Panel title="eBay connection">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={ebayReady ? 'good' : 'dim'}>
            {ebayReady ? 'Credentials set' : 'Not configured'}
          </Chip>
          {ebayDetail && (
            <>
              <Chip tone={ebayDetail.env === 'sandbox' ? 'warn' : 'dim'}>{ebayDetail.env}</Chip>
              <Chip>{ebayDetail.marketplace}</Chip>
              <Chip>adapter: {ebayDetail.adapter}</Chip>
              <Chip>limit: {ebayDetail.limit}/run</Chip>
            </>
          )}
        </div>

        {!ebayReady && (
          <div className="mt-3">
            <Notice tone="info">
              Manual Product Research remains the first-class workflow. eBay credentials can support
              user-initiated adapter work later, but this app does not schedule a catalogue-wide research sweep.
            </Notice>
          </div>
        )}

        <div className="text-ink-dim mt-4 max-w-prose space-y-2 text-xs">
          <p>
            <strong className="text-ink font-medium">Sold comps vs asking prices.</strong> Real sold
            data comes from eBay&apos;s Marketplace Insights API, which is a restricted scope your
            app has to be approved for, and which reaches back 90 days. Without that approval the
            sync falls back to the Browse API, which only sees active listings — asking prices, not
            comps. Sold observations and active asking-price snapshots are stored in separate streams, so sold demand can never be mistaken for competing supply. Every stored reading records its provenance.
          </p>
          <p>
            <strong className="text-ink font-medium">Automation boundary.</strong> Any future adapter
            should operate on an MPN or deliberately selected working set, preserve provenance, and present
            SOLD research for review before it becomes a dated research session.
          </p>
        </div>
      </Panel>

      <Panel title="Recent syncs">
        {runs.length === 0 ? (
          <p className="text-ink-dim text-sm">No sync has run yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm" style={{ minWidth: 620 }}>
              <thead>
                <tr className="border-line border-b">
                  {['When', 'Trigger', 'Adapter', 'Parts', 'Sold / active', 'Status'].map((header) => (
                    <th
                      key={header}
                      scope="col"
                      className="text-ink-faint pb-2 pr-3 text-left text-xs font-medium tracking-widest uppercase"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-line/50 border-b last:border-0 align-top">
                    <td className="text-ink-dim py-2 pr-3 font-mono text-xs whitespace-nowrap">
                      {relativeTime(run.startedAt.toISOString())}
                    </td>
                    <td className="text-ink-dim py-2 pr-3 font-mono text-xs">{run.trigger}</td>
                    <td className="text-ink-dim py-2 pr-3 font-mono text-xs">
                      {run.adapter ?? '—'}
                    </td>
                    <td className="text-ink py-2 pr-3 font-mono text-xs">
                      {run.partsProcessed}
                      {run.partsFailed > 0 && (
                        <span className="text-bad"> (+{run.partsFailed} failed)</span>
                      )}
                    </td>
                    <td className="text-ink py-2 pr-3 font-mono text-xs">
                      {run.soldSnapshotsWritten} / {run.activeSnapshotsWritten}
                    </td>
                    <td className="py-2">
                      <Chip
                        tone={
                          run.status === 'success'
                            ? 'good'
                            : run.status === 'partial'
                              ? 'warn'
                              : run.status === 'failed'
                                ? 'bad'
                                : 'dim'
                        }
                      >
                        {run.status}
                      </Chip>
                      {run.error && (
                        <p className="text-ink-faint mt-1 max-w-md text-[11px] break-words">
                          {run.error}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <ImportExport />
    </div>
  )
}
