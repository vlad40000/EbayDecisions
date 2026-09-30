export const CATEGORIES = [
  'Control Boards',
  'Door Gaskets',
  'Display / UI',
  'Motors',
  'Heating Elements',
  'Cooling & Other',
  'Other',
] as const

export type Category = (typeof CATEGORIES)[number]

/**
 * Derives a category from the part description. Order matters — the more
 * specific tests run first, so "Oven Control Board" lands in Control Boards
 * rather than being caught by a looser rule later.
 */
export function deriveCategory(description: string): Category {
  const d = description.toLowerCase()
  if (d.includes('gasket')) return 'Door Gaskets'
  if (d.includes('motor')) return 'Motors'
  if (d.includes('element')) return 'Heating Elements'
  if (d.includes('control board') || d.includes('relay board') || d.includes('control box')) {
    return 'Control Boards'
  }
  if (d.includes('display') || d.includes('panel') || d.includes('interface')) {
    return 'Display / UI'
  }
  if (
    d.includes('damper') ||
    d.includes('evaporator') ||
    d.includes('waterbox') ||
    d.includes('filter') ||
    d.includes('switch')
  ) {
    return 'Cooling & Other'
  }
  return 'Other'
}

/** Stored category wins; otherwise fall back to the derived one. */
export function categoryOf(description: string, stored?: string | null): string {
  return stored && stored.trim() !== '' ? stored : deriveCategory(description)
}
