'use client'

import {
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

/**
 * Chart palette.
 *
 * These are the first three slots of the validated categorical set, stepped for
 * a dark surface — checked with the data-viz validator against this app's
 * #0e1018 surface on both the adjacent and all-pairs lists (worst CVD ΔE 9.4,
 * worst normal-vision ΔE 20.9, all above 3:1 contrast).
 *
 * They are deliberately NOT the app's green/red/amber: those are status tokens
 * meaning good, bad and warning. Reusing a status hue as "series 2" makes a
 * shipping-cost bar look like a verdict.
 */
const SERIES = {
  primary: '#3987e5',
  secondary: '#d95926',
  tertiary: '#199e70',
} as const

const SURFACE = '#0e1018'
const GRID = '#1c2030'
const AXIS_TEXT = '#545d72'

/**
 * Y-axis domain for line charts: pad 8% below and above the observed range and
 * round outward, so the movement fills the plot instead of hugging a zero
 * baseline that no data point is near.
 */
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

/**
 * Values and labels wear text tokens; the small colored square carries series
 * identity. Colored text would put series hue on type, which reads as status.
 */
function ChartTooltip({
  active,
  payload,
  label,
  moneyKeys,
}: {
  active?: boolean
  payload?: TooltipEntry[]
  label?: string | number
  moneyKeys?: string[]
}) {
  if (!active || !payload?.length) return null

  const visible = payload.filter((entry) => entry.value != null)
  if (visible.length === 0) return null

  return (
    <div className="border-line bg-surface min-w-40 rounded border p-2.5 shadow-lg">
      <div className="text-ink-dim mb-1.5 font-mono text-xs">{label}</div>
      <dl className="space-y-1">
        {visible.map((entry) => {
          const isMoney = !moneyKeys || moneyKeys.includes(String(entry.dataKey ?? entry.name))
          return (
            <div key={String(entry.dataKey ?? entry.name)} className="flex items-center gap-2">
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
                    : String(entry.value)
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
  totalCost: number | null
  trend: number | null
  price: number | null
  shipping: number | null
  qty: number | null
}

export function TotalCostChart({ data }: { data: PeriodPoint[] }) {
  const hasTrend = data.some((point) => point.trend != null)

  return (
    <ResponsiveContainer width="100%" height={210}>
      <LineChart data={data} margin={{ top: 8, right: 24, left: -12, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis dataKey="period" tick={axisTick} axisLine={false} tickLine={false} />
        <YAxis
          tick={axisTick}
          axisLine={false}
          tickLine={false}
          tickFormatter={(value: number) => `$${value}`}
          width={52}
          /* Fitted to the data, not anchored at zero. Position encodes value on
             a line chart, so a forced zero baseline squashes a real 28% move
             into a flat line. Bars keep their zero baseline, where length is
             the encoding. */
          domain={FITTED_DOMAIN}
        />
        <Tooltip content={<ChartTooltip />} cursor={{ stroke: GRID, strokeWidth: 1 }} />
        {hasTrend && <Legend wrapperStyle={legendStyle} iconSize={8} />}
        <Line
          type="monotone"
          dataKey="totalCost"
          name="Total cost"
          stroke={SERIES.primary}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          // 2px ring in the surface colour keeps the dot legible where it
          // crosses the trend line, and enlarges the hover target.
          dot={{ fill: SERIES.primary, r: 4, stroke: SURFACE, strokeWidth: 2 }}
          activeDot={{ fill: SERIES.primary, r: 5, stroke: SURFACE, strokeWidth: 2 }}
          connectNulls={false}
        />
        {hasTrend && (
          <Line
            type="linear"
            dataKey="trend"
            name="Fitted trend"
            stroke={AXIS_TEXT}
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
            connectNulls
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  )
}

export function PriceShippingChart({ data }: { data: PeriodPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={210}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
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
          content={<ChartTooltip />}
          cursor={{ fill: 'rgba(255,255,255,0.03)' }}
        />
        <Legend wrapperStyle={legendStyle} iconSize={8} />
        {/* The 2px stroke in the surface colour is the surface gap between
            stacked segments — the separator is the surface showing through,
            not a border drawn around the mark. */}
        <Bar
          dataKey="price"
          name="Item price"
          stackId="order"
          fill={SERIES.primary}
          stroke={SURFACE}
          strokeWidth={2}
          maxBarSize={24}
        />
        <Bar
          dataKey="shipping"
          name="Shipping"
          stackId="order"
          fill={SERIES.secondary}
          stroke={SURFACE}
          strokeWidth={2}
          radius={[4, 4, 0, 0]}
          maxBarSize={24}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function QuantityChart({ data }: { data: PeriodPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={210}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis dataKey="period" tick={axisTick} axisLine={false} tickLine={false} />
        <YAxis allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} width={52} />
        <Tooltip
          content={<ChartTooltip moneyKeys={[]} />}
          cursor={{ fill: 'rgba(255,255,255,0.03)' }}
        />
        <Bar
          dataKey="qty"
          name="Units"
          fill={SERIES.tertiary}
          radius={[4, 4, 0, 0]}
          maxBarSize={24}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

export type HistoryPoint = {
  /** Calendar date the reading was taken. */
  at: string
  [period: string]: string | number | null
}

/**
 * How each window's comp has moved over calendar time.
 *
 * This is what the append-only snapshot table buys you, and what the
 * spreadsheet could not show: not just "the 30-day comp is $104" but "the
 * 30-day comp has slid from $118 to $104 over six weeks."
 */
export function HistoryChart({
  data,
  periods,
}: {
  data: HistoryPoint[]
  periods: string[]
}) {
  const colors = [SERIES.primary, SERIES.secondary, SERIES.tertiary]

  return (
    <ResponsiveContainer width="100%" height={230}>
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
        <Tooltip content={<ChartTooltip />} cursor={{ stroke: GRID, strokeWidth: 1 }} />
        {periods.length > 1 && <Legend wrapperStyle={legendStyle} iconSize={8} />}
        {periods.map((period, index) => (
          <Line
            key={period}
            type="monotone"
            dataKey={period}
            name={`${period} comp`}
            stroke={colors[index % colors.length]}
            strokeWidth={2}
            strokeLinecap="round"
            dot={{
              fill: colors[index % colors.length],
              r: 3.5,
              stroke: SURFACE,
              strokeWidth: 2,
            }}
            activeDot={{ r: 5, stroke: SURFACE, strokeWidth: 2 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
