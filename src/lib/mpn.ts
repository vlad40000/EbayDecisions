/**
 * Shared D1 MPN key: trim -> uppercase -> strip every non-[A-Z0-9] character.
 *
 * This is the identity key Parts Engine and EbayDecisions agree on. It only
 * removes representation differences (case, spaces, dashes, slashes). It never
 * merges superseding or replacement part numbers — those stay distinct keys.
 *
 * `parts.mpn` keeps the display spelling; `parts.mpn_key` holds this value.
 * Migration 0004 backfills existing rows with the same rule in SQL.
 */
export function toMpnKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}
