'use client'

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { money } from '@/lib/format'

const SERIES = {
  price: '#3b82f6',
  shipping: '#8b92a8',
  quantity: '#f59e0b',
  history: '#22c55e',
} as const

const SURFACE = '#0e1018'
const GRID = '#1c2030'
const AXIS_TEXT = '#545d72'

const FITTED_DOMAIN: [(min: number) => number, (max: number) => number] = [
  (min: number) => {
    const padded = min - Math.max((min || 1) * 0.08, 1)
    return Math.max(0, Math.floor(padded / 5) * 5)
  },
  (max: number) => Math.ceil((max + Math.max(max * 0.08, 1)) / 5) * 5,
]

const axisTick = { fill: AXIS_TEXT, fontSize: 10, fontFamily: 'DM Mono, monospace' }
const legendStyle = { fontSize: 10, fontFamily: 'DM Mono, monospace', color: AXIS_TEXT }

type TooltipEntry = { name?: string; value?: number | string; color?: string; dataKey?: string }

function ChartTooltip({
  active,
  payload,
  label,
  moneyKeys,
  suffixes,
}: {
  active?: boolean
  payload?: TooltipEntry[]
  label?: string | number
  moneyKeys?: string[]
  suffixes?: Record<string, string>
}) {
  if (!active || !payload?.length) return null
  const visible = payload.filter((entry) => entry.value != null)
  if (visible.length === 0) return null

  return (
    <div className="border-line bg-surface min-w-40 rounded border p-2.5 shadow-lg">
      <div className="text-ink-dim mb-1.5 font-mono text-xs">{label}</div>
      <dl className="space-y-1">
        {visible.map((entry) => {
          const key = String(entry.dataKey ?? entry.name)
          const isMoney = !moneyKeys || moneyKeys.includes(key)
          const suffix = suffixes?.[key] ?? ''
          return (
            <div key={key} className="flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block size-2 shrink-0 rounded-sm"
                style={{ background: entry.color }}
              />
              <dt className="text-ink-dim font-mono text-xs">{entry.name}</dt>
              <dd className="text-ink ml-auto font-mono text-xs">
                {typeof entry.value === 'number'
                  ? isMoney
                    ? money(entry.value)
                    : `${Number.isInteger(entry.value) ? entry.value : entry.value.toFixed(2)}${suffix}`
                  : String(entry.value)}
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}

export type PeriodPoint = {
  period: string
  daysAgo: number
  avgSoldPrice?: number | null
  avgShipping?: number | null
  delivered?: number | null
  soldQty: number | null
  soldPerDay?: number | null
  // Legacy aliases retained so older hidden surfaces compile during transition.
  totalCost?: number | null
  trend?: number | null
  price?: number | null
  shipping?: number | null
}

function normalizePeriodData(data: PeriodPoint[]) {
  return data.map((point) => ({
    ...point,
    avgSoldPrice: point.avgSoldPrice ?? point.price ?? null,
    avgShipping: point.avgShipping ?? point.shipping ?? null,
    delivered:
      point.delivered ??
      (point.avgSoldPrice ?? point.price) == null
        ? point.totalCost ?? null
        : (point.avgSoldPrice ?? point.price ?? 0) + (point.avgShipping ?? point.shipping ?? 0),
  }))
}

export function AverageSoldPriceChart({ data }: { data: PeriodPoint[] }) {
  const ordered = [...normalizePeriodData(data)].sort((a, b) => b.daysAgo - a.daysAgo)

  return (
    <ResponsiveContainer width="100%" height={230}>
      <AreaChart data={ordered} margin={{ top: 8, right: 24, left: -12, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis dataKey="period" tick={axisTick} axisLine={false} tickLine={false} />
        <YAxis
          tick={axisTick}
          axisLine={false}
          tickLine={false}
          tickFormatter={(value: number) => `$${value}`}
          width={52}
          domain={FITTED_DOMAIN}
        />
        <Tooltip
          content={<ChartTooltip moneyKeys={['avgSoldPrice']} />}
          cursor={{ stroke: GRID, strokeWidth: 1 }}
        />
        <Area
          type="monotone"
          dataKey="avgSoldPrice"
          name="Avg sold price"
          stroke={SERIES.price}
          fill={SERIES.price}
          fillOpacity={0.12}
          strokeWidth={2}
          connectNulls={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/** @deprecated Use AverageSoldPriceChart. */
export function WindowCurveChart({ data }: { data: PeriodPoint[] }) {
  return <AverageSoldPriceChart data={data} />
}

export function PriceShippingChart({ data }: { data: PeriodPoint[] }) {
  const normalized = normalizePeriodData(data)

  return (
    <ResponsiveContainer width="100%" height={230}>
      <BarChart data={normalized} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis dataKey="period" tick={axisTick} axisLine={false} tickLine={false} />
        <YAxis
          tick={axisTick}
          axisLine={false}
          tickLine={false}
          tickFormatter={(value: number) => `$${value}`}
          width={52}
        />
        <Tooltip
          content={<ChartTooltip moneyKeys={['avgSoldPrice', 'avgShipping']} />}
          cursor={{ fill: 'rgba(255,255,255,0.03)' }}
        />
        <Legend wrapperStyle={legendStyle} iconSize={8} />
        <Bar
          dataKey="avgSoldPrice"
          name="Avg sold price"
          stackId="order"
          fill={SERIES.price}
          stroke={SURFACE}
          strokeWidth={2}
          maxBarSize={24}
        />
        <Bar
          dataKey="avgShipping"
          name="Avg shipping"
          stackId="order"
          fill={SERIES.shipping}
          stroke={SURFACE}
          strokeWidth={2}
          radius={[4, 4, 0, 0]}
          maxBarSize={24}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function UnitsSoldChart({ data }: { data: PeriodPoint[] }) {
  const ordered = [...data].sort((a, b) => b.daysAgo - a.daysAgo)

  return (
    <ResponsiveContainer width="100%" height={230}>
      <BarChart data={ordered} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis dataKey="period" tick={axisTick} axisLine={false} tickLine={false} />
        <YAxis allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} width={52} />
        <Tooltip
          content={<ChartTooltip moneyKeys={[]} />}
          cursor={{ fill: 'rgba(255,255,255,0.03)' }}
        />
        <Bar
          dataKey="soldQty"
          name="Units sold"
          fill={SERIES.quantity}
          radius={[4, 4, 0, 0]}
          maxBarSize={26}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Legacy diagnostic chart retained outside the primary dashboard. */
export function SoldVelocityChart({ data }: { data: PeriodPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={230}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis dataKey="period" tick={axisTick} axisLine={false} tickLine={false} />
        <YAxis tick={axisTick} axisLine={false} tickLine={false} width={52} />
        <Tooltip
          content={<ChartTooltip moneyKeys={[]} suffixes={{ soldPerDay: '/day' }} />}
          cursor={{ fill: 'rgba(255,255,255,0.03)' }}
        />
        <Bar
          dataKey="soldPerDay"
          name="Sold velocity"
          fill={SERIES.history}
          radius={[4, 4, 0, 0]}
          maxBarSize={24}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

export type HistoryPoint = { at: string; value: number | null }

export function SoldHistoryChart({
  data,
  label = '30d avg sold price',
}: {
  data: HistoryPoint[]
  label?: string
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 24, left: -12, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis dataKey="at" tick={axisTick} axisLine={false} tickLine={false} />
        <YAxis
          tick={axisTick}
          axisLine={false}
          tickLine={false}
          tickFormatter={(value: number) => `$${value}`}
          width={52}
          domain={FITTED_DOMAIN}
        />
        <Tooltip
          content={<ChartTooltip moneyKeys={['value']} />}
          cursor={{ stroke: GRID, strokeWidth: 1 }}
        />
        <Line
          type="monotone"
          dataKey="value"
          name={label}
          stroke={SERIES.price}
          strokeWidth={2}
          dot={{ fill: SERIES.price, r: 3.5, stroke: SURFACE, strokeWidth: 2 }}
          activeDot={{ r: 5, stroke: SURFACE, strokeWidth: 2 }}
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

export function SoldUnitsHistoryChart({ data }: { data: HistoryPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis dataKey="at" tick={axisTick} axisLine={false} tickLine={false} />
        <YAxis allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} width={52} />
        <Tooltip
          content={<ChartTooltip moneyKeys={[]} />}
          cursor={{ fill: 'rgba(255,255,255,0.03)' }}
        />
        <Bar
          dataKey="value"
          name="30d units sold"
          fill={SERIES.quantity}
          radius={[4, 4, 0, 0]}
          maxBarSize={28}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Retained for legacy/secondary surfaces; active competition is not primary dashboard data. */
export function ActiveSupplyHistoryChart({ data }: { data: HistoryPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis dataKey="at" tick={axisTick} axisLine={false} tickLine={false} />
        <YAxis allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} width={52} />
        <Tooltip
          content={<ChartTooltip moneyKeys={[]} />}
          cursor={{ fill: 'rgba(255,255,255,0.03)' }}
        />
        <Bar
          dataKey="value"
          name="Active listings"
          fill={SERIES.shipping}
          radius={[4, 4, 0, 0]}
          maxBarSize={28}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}
