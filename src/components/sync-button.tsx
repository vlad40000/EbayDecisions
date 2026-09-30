'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

export function SyncButton({ enabled }: { enabled: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  async function run() {
    setRunning(true)
    setMessage(null)
    setFailed(false)
    try {
      const response = await fetch('/api/ebay/sync', { method: 'POST' })
      const body = (await response.json()) as { message?: string; status?: string }
      setFailed(!response.ok || body.status === 'failed')
      setMessage(body.message ?? (response.ok ? 'Sync finished.' : 'Sync failed.'))
      startTransition(() => router.refresh())
    } catch (error) {
      setFailed(true)
      setMessage(error instanceof Error ? error.message : 'Sync request failed.')
    } finally {
      setRunning(false)
    }
  }

  const busy = running || pending

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={run}
        disabled={!enabled || busy}
        title={
          enabled
            ? 'Pull fresh market data from eBay for every active part.'
            : 'Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET to enable syncing.'
        }
        className="border-good/40 bg-good/12 text-good hover:bg-good/20 rounded border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? 'Syncing…' : 'Sync from eBay'}
      </button>
      {message && (
        <p
          role="status"
          className={`max-w-md text-right text-xs ${failed ? 'text-bad' : 'text-ink-dim'}`}
        >
          {message}
        </p>
      )}
    </div>
  )
}
