'use client'

import { useEffect, useRef, useState } from 'react'

type SaveResult = { ok: true } | { ok: false; error: string }

const DEBOUNCE_MS = 700
const SAVED_FLASH_MS = 1600

/**
 * A number input that saves itself a beat after you stop typing, and
 * immediately on Enter or blur.
 *
 * The draft lives in local state while you are editing, so a server round-trip
 * can never yank the value out from under the cursor. Clearing the draft on a
 * successful save is what hands control back to `storedValue`, which is how the
 * cell picks up a fresh sync without ever discarding an in-progress edit.
 */
export function InlineNumber({
  storedValue,
  onSave,
  step = 0.01,
  decimals = 2,
  prefix,
  suffix,
  placeholder = '—',
  label,
  width = 'w-20',
  allowBlank = true,
}: {
  storedValue: number | null
  onSave: (value: string) => Promise<SaveResult>
  step?: number
  decimals?: number
  prefix?: string
  suffix?: string
  placeholder?: string
  label: string
  width?: string
  allowBlank?: boolean
}) {
  const format = (value: number | null) =>
    value == null ? '' : decimals === 0 ? String(Math.round(value)) : value.toFixed(decimals)

  const [draft, setDraft] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  async function commit(value: string) {
    setState('saving')
    const result = await onSave(value)
    if (result.ok) {
      setState('saved')
      setError(null)
      setDraft(null)
      setTimeout(() => setState((prev) => (prev === 'saved' ? 'idle' : prev)), SAVED_FLASH_MS)
    } else {
      setState('error')
      setError(result.error)
    }
  }

  function schedule(value: string) {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void commit(value)
    }, DEBOUNCE_MS)
  }

  function flush(value: string) {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = null
    void commit(value)
  }

  const value = draft ?? format(storedValue)

  const borderClass =
    state === 'error'
      ? 'border-[var(--color-bad)]'
      : state === 'saved'
        ? 'border-[var(--color-good)]'
        : ''

  return (
    <span className="inline-flex flex-col items-end">
      <span className="inline-flex items-center gap-0.5">
        {prefix && <span className="text-ink-faint font-mono text-xs">{prefix}</span>}
        <input
          type="number"
          min={0}
          step={step}
          inputMode="decimal"
          required={!allowBlank}
          value={value}
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={state === 'error'}
          onChange={(event) => {
            setDraft(event.target.value)
            schedule(event.target.value)
          }}
          onBlur={(event) => flush(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              flush(event.currentTarget.value)
            }
          }}
          className={`field ${width} px-2 py-1 text-right font-mono text-xs outline-none focus:border-[var(--color-good)] ${borderClass}`}
        />
        {suffix && <span className="text-ink-faint font-mono text-xs">{suffix}</span>}
      </span>
      {state === 'error' && error && (
        <span className="text-bad mt-0.5 max-w-40 text-right text-[10px]">{error}</span>
      )}
    </span>
  )
}
