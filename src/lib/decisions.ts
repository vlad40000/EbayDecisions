import { linearTrend, type Trend } from './stats'
import {
  PERIODS,
  SOURCE_IS_SOLD,
  type EconomicSettings,
  type Period,
  type PartWithMarket,
} from './types'

export type Action = 'LIST_NOW' | 'LIST' | 'HOLD' | 'WATCH' | 'DUMP' | 'NEEDS_DATA'

/** Sort order for the board: the things you should act on first come first. */
export const ACTION_PRIORITY: Record<Action, number> = {
  LIST_NOW: 0,
  DUMP: 1,
  LIST: 2,
  WATCH: 3,
  HOLD: 4,
  NEEDS_DATA: 5,
}

export const ACTION_LABELS: Record<Action, string> = {
  LIST_NOW: 'List now',
  LIST: 'List',
  HOLD: 'Hold',
  WATCH: 'Watch',
  DUMP: 'Dump',
  NEEDS_DATA: 'Needs data',
}

/** Per-unit economics at one window's observed market. */
export type Economics = {
  /** Item price the comps show. */
  price: number
  /** Shipping the buyer pays, per the comps. */
  shipping: number
  /** Total the buyer pays — this is what eBay charges fees on. */
  grossOrder: number
  /** eBay final value fee plus the fixed per-order fee. */
  fees: number
  /** What it costs you to ship it. */
  shipCost: number
  /** What lands in your pocket before cost of goods. */
  netProceeds: number
  /** netProceeds minus cost basis. NULL when cost basis is unknown. */
  marginDollars: number | null
  /** Margin as a percent of net proceeds. NULL when cost basis is unknown. */
  marginPct: number | null
  /** Return on cost. NULL when cost basis is unknown or zero. */
  roiPct: number | null
}

export type Decision = {
  action: Action
  /** One sentence, with the numbers that drove it. */
  reason: string
  /** Supporting observations, most important first. */
  notes: string[]
  economics: Economics | null
  costTrend: Trend
  supplyTrend: Trend
  /** Target used, after any per-part override. */
  targetMarginPct: number
  /** What to list at to hit the target margin. NULL without a cost basis. */
  suggestedListPrice: number | null
  /** marginDollars times units on hand — how much is actually at stake. */
  potentialDollars: number | null
  /** True when the read rests on asking prices rather than sold comps. */
  askingPricesOnly: boolean
  /** True when fewer than 3 windows have data. */
  thinData: boolean
}

/**
 * Per-unit economics for a listing at the given price and shipping.
 *
 * eBay's final value fee applies to the whole order — item plus the shipping the
 * buyer pays — which is why `grossOrder` and not `price` is the fee base. A
 * model that fees only the item price systematically overstates margin.
 */
export function computeEconomics(args: {
  price: number
  shipping: number
  costBasis: number | null
  shipCost: number | null
  settings: EconomicSettings
}): Economics {
  const { price, shipping, costBasis, settings } = args
  const shipCost = args.shipCost ?? settings.defaultShipCost

  const grossOrder = price + shipping
  const fees = grossOrder * (settings.feePct / 100) + settings.feeFixed
  const netProceeds = grossOrder - fees - shipCost

  // costBasis of 0 is real and common — a part pulled off a scrapped machine.
  // Only null means "unknown", and only null blocks the margin math.
  const marginDollars = costBasis == null ? null : netProceeds - costBasis
  const marginPct =
    marginDollars == null || netProceeds <= 0 ? null : (marginDollars / netProceeds) * 100
  const roiPct =
    marginDollars == null || costBasis == null || costBasis <= 0
      ? null
      : (marginDollars / costBasis) * 100

  return {
    price,
    shipping,
    grossOrder,
    fees,
    shipCost,
    netProceeds,
    marginDollars,
    marginPct,
    roiPct,
  }
}

/**
 * The item price that hits `targetMarginPct` on net proceeds, given the shipping
 * you intend to charge.
 *
 * Solving netProceeds = cost / (1 - m) for price:
 *   netProceeds = (price + shipping)(1 - f) - feeFixed - shipCost
 *   price = [cost/(1 - m) + feeFixed + shipCost] / (1 - f) - shipping
 */
export function suggestedListPrice(args: {
  costBasis: number | null
  shipping: number
  shipCost: number | null
  targetMarginPct: number
  settings: EconomicSettings
}): number | null {
  const { costBasis, shipping, targetMarginPct, settings } = args
  if (costBasis == null) return null

  const m = targetMarginPct / 100
  const f = settings.feePct / 100
  if (m >= 1 || f >= 1) return null

  const shipCost = args.shipCost ?? settings.defaultShipCost
  const requiredNet = costBasis / (1 - m)
  const price = (requiredNet + settings.feeFixed + shipCost) / (1 - f) - shipping

  return price > 0 ? price : null
}

function totalCost(observation: { price: number | null; shipping: number | null }): number | null {
  if (observation.price == null) return null
  return observation.price + (observation.shipping ?? 0)
}

/**
 * Turns a part's market history into a recommendation.
 *
 * Rules are evaluated in order and the first match wins, so the ordering encodes
 * the priority: losing money outranks a thin margin, which outranks a healthy
 * one. Every branch states the numbers behind it, because a recommendation you
 * cannot audit is a recommendation you should not follow.
 */
export function decide(part: PartWithMarket, settings: EconomicSettings): Decision {
  const target = part.targetMarginPct ?? settings.targetMarginPct
  const min = settings.minMarginPct

  const costSeries = PERIODS.map((p) => {
    const observation = part.periods[p]
    return observation ? totalCost(observation) : null
  })
  const qtySeries = PERIODS.map((p) => part.periods[p]?.qty ?? null)

  const costTrend = linearTrend(costSeries)
  const supplyTrend = linearTrend(qtySeries)

  const windowsWithData = costSeries.filter((v) => v != null).length
  const thinData = windowsWithData > 0 && windowsWithData < 3

  // The most recent window with a price is what we price against today.
  let current: { period: Period; price: number; shipping: number } | null = null
  for (let i = PERIODS.length - 1; i >= 0; i -= 1) {
    const period = PERIODS[i] as Period
    const observation = part.periods[period]
    if (observation?.price != null) {
      current = { period, price: observation.price, shipping: observation.shipping ?? 0 }
      break
    }
  }

  const sourcesSeen = PERIODS.map((p) => part.periods[p]?.source).filter(
    (s): s is NonNullable<typeof s> => s != null,
  )
  const askingPricesOnly = sourcesSeen.length > 0 && sourcesSeen.every((s) => !SOURCE_IS_SOLD[s])

  const base = {
    costTrend,
    supplyTrend,
    targetMarginPct: target,
    askingPricesOnly,
    thinData,
  }

  if (!current) {
    return {
      ...base,
      action: 'NEEDS_DATA',
      reason: 'No market data yet — run a sync or enter comps in the Tracker.',
      notes: [],
      economics: null,
      suggestedListPrice: null,
      potentialDollars: null,
    }
  }

  const economics = computeEconomics({
    price: current.price,
    shipping: current.shipping,
    costBasis: part.costBasis,
    shipCost: part.shipCost,
    settings,
  })

  const suggested = suggestedListPrice({
    costBasis: part.costBasis,
    shipping: current.shipping,
    shipCost: part.shipCost,
    targetMarginPct: target,
    settings,
  })

  const notes: string[] = []
  if (thinData) {
    notes.push(`Only ${windowsWithData} of 5 windows have data — trend read is weak.`)
  }
  if (askingPricesOnly) {
    notes.push('Based on active-listing asking prices, not sold comps.')
  }
  if (part.shipCost == null) {
    notes.push(`Using the default $${settings.defaultShipCost.toFixed(2)} ship cost.`)
  }
  if (supplyTrend.direction === 'rising' && supplyTrend.strong) {
    notes.push(`Competing supply up ${Math.abs(supplyTrend.pctPerPeriod ?? 0).toFixed(1)}%/window.`)
  }
  if (supplyTrend.direction === 'falling' && supplyTrend.strong) {
    notes.push(
      `Competing supply down ${Math.abs(supplyTrend.pctPerPeriod ?? 0).toFixed(1)}%/window.`,
    )
  }

  const { marginDollars, marginPct } = economics
  const potentialDollars = marginDollars == null ? null : marginDollars * part.inventoryQty
  const result = { ...base, economics, notes, suggestedListPrice: suggested, potentialDollars }

  if (part.costBasis == null) {
    return {
      ...result,
      action: 'NEEDS_DATA',
      reason: `Market is $${economics.grossOrder.toFixed(2)} but there is no cost basis, so margin is unknown.`,
    }
  }

  const trendPct = Math.abs(costTrend.pctPerPeriod ?? 0).toFixed(1)
  const marginText = marginPct == null ? 'n/a' : `${marginPct.toFixed(1)}%`
  const netText = `$${economics.netProceeds.toFixed(2)} net`

  // 1. Losing money outright.
  if (marginDollars != null && marginDollars < 0) {
    return {
      ...result,
      action: 'DUMP',
      reason: `Underwater: ${netText} against a $${part.costBasis.toFixed(2)} cost basis loses $${Math.abs(marginDollars).toFixed(2)} per unit.`,
    }
  }

  // 2. Below the floor.
  if (marginPct != null && marginPct < min) {
    if (costTrend.direction === 'falling') {
      return {
        ...result,
        action: 'DUMP',
        reason: `Margin ${marginText} is under the ${min.toFixed(0)}% floor and the market is falling ${trendPct}%/window — it gets worse from here.`,
      }
    }
    if (costTrend.direction === 'rising') {
      return {
        ...result,
        action: 'HOLD',
        reason: `Margin ${marginText} is under the ${min.toFixed(0)}% floor, but the market is rising ${trendPct}%/window — worth waiting.`,
      }
    }
    return {
      ...result,
      action: 'WATCH',
      reason: `Margin ${marginText} is under the ${min.toFixed(0)}% floor and the market is flat.`,
    }
  }

  // 3. At or above target.
  if (marginPct != null && marginPct >= target) {
    if (costTrend.direction === 'falling') {
      return {
        ...result,
        action: 'LIST_NOW',
        reason: `Margin ${marginText} beats the ${target.toFixed(0)}% target and the market is falling ${trendPct}%/window — list before it erodes.`,
      }
    }
    if (supplyTrend.direction === 'rising' && supplyTrend.strong) {
      return {
        ...result,
        action: 'LIST_NOW',
        reason: `Margin ${marginText} is healthy and competing supply is climbing — list ahead of the crowd.`,
      }
    }
    if (costTrend.direction === 'rising' && costTrend.strong) {
      return {
        ...result,
        action: 'HOLD',
        reason: `Margin ${marginText} is already above target and the market is climbing ${trendPct}%/window — holding earns more.`,
      }
    }
    return {
      ...result,
      action: 'LIST',
      reason: `Margin ${marginText} meets the ${target.toFixed(0)}% target in a stable market.`,
    }
  }

  // 4. Between the floor and the target.
  if (costTrend.direction === 'rising') {
    return {
      ...result,
      action: 'HOLD',
      reason: `Margin ${marginText} sits between the ${min.toFixed(0)}% floor and the ${target.toFixed(0)}% target, and the market is rising ${trendPct}%/window.`,
    }
  }
  if (costTrend.direction === 'falling') {
    return {
      ...result,
      action: 'LIST',
      reason: `Margin ${marginText} is workable but the market is falling ${trendPct}%/window — take it now rather than chasing the target.`,
    }
  }
  return {
    ...result,
    action: 'WATCH',
    reason: `Margin ${marginText} is below the ${target.toFixed(0)}% target in a flat market.`,
  }
}

/** Board ordering: action priority first, then dollars actually at stake. */
export function compareDecisions(
  a: { decision: Decision },
  b: { decision: Decision },
): number {
  const byAction = ACTION_PRIORITY[a.decision.action] - ACTION_PRIORITY[b.decision.action]
  if (byAction !== 0) return byAction
  const aDollars = Math.abs(a.decision.potentialDollars ?? 0)
  const bDollars = Math.abs(b.decision.potentialDollars ?? 0)
  return bDollars - aDollars
}
