'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState, useTransition } from 'react'

import { Panel } from './ui'

type ImportResponse = {
  message?: string
  error?: string
  errors?: string[]
  errorCount?: number
}

const SHARED_RESEARCH_COLUMNS =
  'mpn, description, notes, New Price, 7 Day sales, 7 Day Avg Price, 30 Day sales, 30 Day Avg Price, 90 Day sales, 90 Day Avg Price, 90 Day Sell Through %'

function CsvUploadForm({ endpoint, label }: { endpoint: string; label: string }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResponse | null>(null)
  const [failed, setFailed] = useState(false)

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const file = inputRef.current?.files?.[0]
    if (!file) return

    setBusy(true)
    setResult(null)
    setFailed(false)

    try {
      const body = new FormData()
      body.set('file', file)
      const response = await fetch(endpoint, { method: 'POST', body })
      const json = (await response.json()) as ImportResponse
      setFailed(!response.ok)
      setResult(json)
      if (response.ok) {
        if (inputRef.current) inputRef.current.value = ''
        startTransition(() => router.refresh())
      }
    } catch (error) {
      setFailed(true)
      setResult({ error: error instanceof Error ? error.message : 'Upload failed.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <form onSubmit={upload} className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          aria-label={label}
          className="text-ink-dim file:border-line file:bg-surface-2 file:text-ink-dim hover:file:text-ink max-w-64 text-xs file:mr-2 file:rounded file:border file:px-2 file:py-1 file:text-xs"
        />
        <button
          type="submit"
          disabled={busy}
          className="border-good/40 bg-good/12 text-good hover:bg-good/20 rounded border px-3 py-1.5 text-xs transition-colors disabled:opacity-40"
        >
          {busy ? 'Importing…' : 'Import'}
        </button>
      </form>

      {result && (
        <div className="mt-3 text-xs">
          <p className={failed ? 'text-bad' : 'text-good'}>
            {result.error ?? result.message ?? 'Done.'}
          </p>
          {result.errors && result.errors.length > 0 && (
            <ul className="text-ink-dim mt-1.5 space-y-0.5">
              {result.errors.map((line) => (
                <li key={line}>· {line}</li>
              ))}
              {result.errorCount != null && result.errorCount > result.errors.length && (
                <li>· …and {result.errorCount - result.errors.length} more.</li>
              )}
            </ul>
          )}
        </div>
      )}
    </>
  )
}

export function ImportExport() {
  return (
    <>
      <Panel title="Shared research CSV">
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="text-ink mb-1 text-sm font-medium">Import manual research</h3>
            <p className="text-ink-dim mb-3 max-w-prose text-xs">
              The same file format Parts Engine downloads and uploads. Each row with research values
              becomes a new dated manual research session; nothing earlier is edited. Blank cells stay
              unknown, sell-through is saved only when supplied, and unknown MPNs are added with
              inventory 0. Notes are kept as text and never change inventory. If any row has a
              problem, nothing is imported. No eBay request is made.
            </p>
            <CsvUploadForm endpoint="/api/research/shared-csv" label="Shared research CSV to import" />
          </div>

          <div>
            <h3 className="text-ink mb-1 text-sm font-medium">Download research CSV</h3>
            <p className="text-ink-dim mb-3 max-w-prose text-xs">
              Latest manual 7/30/90-day research and New Price per MPN, unknown values blank. Columns:{' '}
              <code className="font-mono">{SHARED_RESEARCH_COLUMNS}</code>.
            </p>
            <div className="flex flex-wrap gap-2">
              <a
                href="/api/research/shared-csv?scope=due"
                className="border-line bg-surface text-ink-dim hover:text-ink inline-block rounded border px-3 py-1.5 text-xs transition-colors"
              >
                Research queue (due, in stock)
              </a>
              <a
                href="/api/research/shared-csv"
                className="border-line bg-surface text-ink-dim hover:text-ink inline-block rounded border px-3 py-1.5 text-xs transition-colors"
              >
                All active parts
              </a>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Import and export">
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="text-ink mb-1 text-sm font-medium">Import a CSV</h3>
            <p className="text-ink-dim mb-3 max-w-prose text-xs">
              Rows are matched on MPN, so re-importing a corrected file updates rather than
              duplicates. Only the columns your file contains are touched — a CSV of just{' '}
              <code className="font-mono">mpn,cost_basis</code> fills in costs and leaves everything
              else alone.
            </p>

            <CsvUploadForm endpoint="/api/parts/import" label="CSV file to import" />

            <details className="mt-3">
              <summary className="text-ink-faint hover:text-ink-dim cursor-pointer text-xs transition-colors">
                Recognised column names
              </summary>
              <dl className="text-ink-dim mt-2 space-y-1 text-[11px]">
                {[
                  ['mpn', 'mpn, part_number, part, sku — required'],
                  ['description', 'description, desc, name'],
                  ['inventory_qty', 'inventory_qty, qty, quantity, on_hand'],
                  ['cost_basis', 'cost_basis, cost, my_cost, paid'],
                  ['ship_cost', 'ship_cost, shipping_cost, my_shipping'],
                  ['target_margin_pct', 'target_margin_pct, target_margin, target'],
                  ['source_url', 'source_url, url, link, source'],
                  ['notes', 'notes, note, comment'],
                ].map(([field, aliases]) => (
                  <div key={field} className="flex gap-2">
                    <dt className="text-ink-faint w-32 shrink-0 font-mono">{field}</dt>
                    <dd>{aliases}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-ink-faint mt-2 text-[11px]">
                Case, spaces and underscores are ignored when matching headers. Dollar signs in
                amounts are stripped.
              </p>
            </details>
          </div>

          <div>
            <h3 className="text-ink mb-1 text-sm font-medium">Export everything</h3>
            <p className="text-ink-dim mb-3 max-w-prose text-xs">
              One row per part: the catalogue, the latest reading for all five windows with its
              source, and the computed margin, suggested list price and recommendation. Round-trips
              back through the importer.
            </p>
            <a
              href="/api/parts/export"
              className="border-line bg-surface text-ink-dim hover:text-ink inline-block rounded border px-3 py-1.5 text-xs transition-colors"
            >
              Download CSV
            </a>
          </div>
        </div>
      </Panel>
    </>
  )
}
