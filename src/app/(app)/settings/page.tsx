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

  const cronConfigured = Boolean(process.env.CRON_SECRET)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        subtitle="The assumptions behind every recommendation, plus data in and out."
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
          <Chip tone={cronConfigured ? 'good' : 'warn'}>
            {cronConfigured ? 'Cron secret set' : 'No cron secret'}
          </Chip>
        </div>

        {!ebayReady && (
          <div className="mt-3">
            <Notice tone="info">
              Without eBay credentials the app works exactly as the spreadsheet did — you type the
              comps and it does the maths. Set{' '}
              <code className="font-mono">EBAY_CLIENT_ID</code> and{' '}
              <code className="font-mono">EBAY_CLIENT_SECRET</code> to add syncing.
            </Notice>
          </div>
        )}

        <div className="text-ink-dim mt-4 max-w-prose space-y-2 text-xs">
          <p>
            <strong className="text-ink font-medium">Sold comps vs asking prices.</strong> Real sold
            data comes from eBay&apos;s Marketplace Insights API, which is a restricted scope your
            app has to be approved for, and which reaches back 90 days. Without that approval the
            sync falls back to the Browse API, which only sees active listings — asking prices, not
            comps. Every stored reading records which one it came from, and the board flags any part
            whose read rests on asking prices alone.
          </p>
          <p>
            <strong className="text-ink font-medium">The 6-month and 1-year windows.</strong> No
            eBay API will backfill those. They fill in by hand, or they accumulate as this app keeps
            taking readings — which is why nothing here ever invents them.
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
                  {['When', 'Trigger', 'Adapter', 'Parts', 'Snapshots', 'Status'].map((header) => (
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
                      {run.snapshotsWritten}
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
