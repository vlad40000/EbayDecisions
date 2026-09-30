import Link from 'next/link'
import type { ReactNode } from 'react'

import { ACTION_LABELS, type Action } from '@/lib/decisions'
import { SOURCE_LABELS, type SnapshotSource } from '@/lib/types'

export function Panel({
  title,
  action,
  children,
  className = '',
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`bg-surface border-line rounded border ${className}`}>
      {(title || action) && (
        <header className="border-line flex items-center justify-between gap-3 border-b px-4 py-2.5">
          {title && (
            <h2 className="text-ink-faint text-xs font-medium tracking-widest uppercase">
              {title}
            </h2>
          )}
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function StatCard({
  label,
  value,
  sub,
  tone = 'neutral',
  hint,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'info'
  hint?: string
}) {
  const subTone = {
    neutral: 'text-ink-faint',
    good: 'text-good',
    bad: 'text-bad',
    warn: 'text-warn',
    info: 'text-info',
  }[tone]

  return (
    <div className="bg-surface border-line rounded border p-4" title={hint}>
      <div className="text-ink-faint mb-1 text-xs tracking-widest uppercase">{label}</div>
      <div className="text-ink font-mono text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className={`mt-1 font-mono text-xs ${subTone}`}>{sub}</div>}
    </div>
  )
}

export function Chip({
  children,
  tone = 'dim',
  title,
}: {
  children: ReactNode
  tone?: 'dim' | 'good' | 'bad' | 'warn' | 'info' | 'hold'
  title?: string
}) {
  const styles = {
    dim: 'bg-white/[0.04] text-ink-faint border-line',
    good: 'bg-good/12 text-good border-good/25',
    bad: 'bg-bad/12 text-bad border-bad/25',
    warn: 'bg-warn/12 text-warn border-warn/25',
    info: 'bg-info/12 text-info border-info/25',
    hold: 'bg-hold/12 text-hold border-hold/25',
  }[tone]

  return (
    <span
      title={title}
      className={`inline-block rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wider whitespace-nowrap uppercase ${styles}`}
    >
      {children}
    </span>
  )
}

const ACTION_TONE: Record<Action, 'good' | 'bad' | 'warn' | 'info' | 'hold' | 'dim'> = {
  LIST_NOW: 'good',
  LIST: 'info',
  HOLD: 'hold',
  WATCH: 'warn',
  DUMP: 'bad',
  NEEDS_DATA: 'dim',
}

export function ActionBadge({ action, title }: { action: Action; title?: string }) {
  return (
    <Chip tone={ACTION_TONE[action]} title={title}>
      {ACTION_LABELS[action]}
    </Chip>
  )
}

/**
 * Names the kind of data behind a number. Active-listing asking prices and sold
 * comps are not interchangeable, so the distinction is always on screen.
 */
export function SourceBadge({ source }: { source: SnapshotSource }) {
  const tone = source === 'ebay_browse' ? 'warn' : source === 'ebay_insights' ? 'good' : 'dim'
  return (
    <Chip
      tone={tone}
      title={
        source === 'ebay_browse'
          ? 'Median asking price across active listings — not a sold comp.'
          : source === 'ebay_insights'
            ? 'Median of completed sales from eBay Marketplace Insights.'
            : 'Entered by hand.'
      }
    >
      {SOURCE_LABELS[source]}
    </Chip>
  )
}

export function TrendGlyph({
  direction,
  pctPerPeriod,
  /** Rising costs are good news when you are the seller. */
  invert = false,
}: {
  direction: 'rising' | 'falling' | 'flat' | 'unknown'
  pctPerPeriod: number | null
  invert?: boolean
}) {
  if (direction === 'unknown') return <span className="text-ink-ghost font-mono text-xs">—</span>

  const glyph = direction === 'rising' ? '▴' : direction === 'falling' ? '▾' : '•'
  const positive = invert ? direction === 'falling' : direction === 'rising'
  const tone =
    direction === 'flat' ? 'text-ink-faint' : positive ? 'text-good' : 'text-bad'

  return (
    <span className={`font-mono text-xs ${tone}`}>
      {glyph} {pctPerPeriod == null ? '' : `${Math.abs(pctPerPeriod).toFixed(1)}%`}
    </span>
  )
}

export function EmptyState({
  title,
  body,
  cta,
}: {
  title: string
  body: string
  cta?: { href: string; label: string }
}) {
  return (
    <div className="border-line bg-surface rounded border border-dashed px-6 py-10 text-center">
      <p className="text-ink mb-1 text-sm font-medium">{title}</p>
      <p className="text-ink-dim mx-auto max-w-prose text-sm">{body}</p>
      {cta && (
        <Link
          href={cta.href}
          className="border-good/40 bg-good/10 text-good hover:bg-good/20 mt-4 inline-block rounded border px-3 py-1.5 text-xs transition-colors"
        >
          {cta.label}
        </Link>
      )}
    </div>
  )
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'bad' | 'good'
  children: ReactNode
}) {
  const styles = {
    info: 'border-info/30 bg-info/8 text-info',
    warn: 'border-warn/30 bg-warn/8 text-warn',
    bad: 'border-bad/30 bg-bad/8 text-bad',
    good: 'border-good/30 bg-good/8 text-good',
  }[tone]

  return <div className={`rounded border px-3 py-2 text-xs ${styles}`}>{children}</div>
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-ink text-lg font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-ink-dim mt-0.5 text-sm">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}
