'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { saveSettings } from '@/app/(app)/settings/actions'
import type { EconomicSettings } from '@/lib/types'

import { Panel } from './ui'

export function SettingsForm({ settings }: { settings: EconomicSettings }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [status, setStatus] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  async function submit(formData: FormData) {
    setStatus(null)
    const result = await saveSettings(formData)
    setStatus(result.ok ? { tone: 'good', text: 'Saved.' } : { tone: 'bad', text: result.error })
    if (result.ok) startTransition(() => router.refresh())
  }

  return (
    <Panel title="Fee and margin assumptions">
      <p className="text-ink-dim mb-4 max-w-prose text-xs">
        Every recommendation on the board is computed from these five numbers, so they live in the
        database rather than in the code — change one and the whole board re-reads. The defaults
        reflect a typical eBay final-value fee; check yours against a recent payout statement, since
        the rate varies by category and store subscription.
      </p>

      <form action={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <NumberField
            name="feePct"
            label="eBay fee"
            suffix="%"
            step={0.01}
            defaultValue={settings.feePct}
            help="Final value fee, as a percent of the whole order — item plus the shipping the buyer pays."
          />
          <NumberField
            name="feeFixed"
            label="Fixed fee per order"
            prefix="$"
            step={0.01}
            defaultValue={settings.feeFixed}
            help="The flat per-order charge eBay adds on top of the percentage."
          />
          <NumberField
            name="defaultShipCost"
            label="Default ship cost"
            prefix="$"
            step={0.01}
            defaultValue={settings.defaultShipCost}
            help="What it costs you to ship, used for any part without its own figure."
          />
          <NumberField
            name="targetMarginPct"
            label="Target margin"
            suffix="%"
            step={1}
            defaultValue={settings.targetMarginPct}
            help="At or above this, a part is worth listing. Percent of net proceeds."
          />
          <NumberField
            name="minMarginPct"
            label="Margin floor"
            suffix="%"
            step={1}
            defaultValue={settings.minMarginPct}
            help="Below this, a part is a problem — dump it or hold for a better market."
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="border-good/40 bg-good/12 text-good hover:bg-good/20 rounded border px-3 py-1.5 text-xs transition-colors disabled:opacity-40"
          >
            {pending ? 'Saving…' : 'Save settings'}
          </button>
          {status && (
            <span className={`text-xs ${status.tone === 'good' ? 'text-good' : 'text-bad'}`}>
              {status.text}
            </span>
          )}
        </div>
      </form>
    </Panel>
  )
}

function NumberField({
  name,
  label,
  defaultValue,
  step,
  prefix,
  suffix,
  help,
}: {
  name: string
  label: string
  defaultValue: number
  step: number
  prefix?: string
  suffix?: string
  help: string
}) {
  return (
    <label className="block">
      <span className="text-ink-faint mb-1 block text-xs tracking-widest uppercase">{label}</span>
      <span className="flex items-center gap-1">
        {prefix && <span className="text-ink-faint font-mono text-xs">{prefix}</span>}
        <input
          name={name}
          type="number"
          min={0}
          step={step}
          required
          defaultValue={defaultValue}
          className="field w-24 px-2 py-1.5 text-right font-mono text-xs outline-none focus:border-[var(--color-good)]"
        />
        {suffix && <span className="text-ink-faint font-mono text-xs">{suffix}</span>}
      </span>
      <span className="text-ink-faint mt-1 block max-w-64 text-[11px] leading-snug">{help}</span>
    </label>
  )
}
