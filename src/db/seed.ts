/**
 * Seeds the parts catalogue.
 *
 *   pnpm db:seed
 *
 * Idempotent — safe to re-run. Parts are matched by MPN, so an existing row is
 * updated in place rather than duplicated.
 *
 * Deliberately absent: market prices. The original spreadsheet prototype filled
 * the grid with randomly generated numbers so the charts had something to draw.
 * In a tool you price inventory from, invented comps are worse than an empty
 * cell — an empty cell tells you to go look, a fabricated one tells you a lie
 * with a chart attached. Every market figure here comes from an eBay sync or
 * from you typing it in.
 */
import 'dotenv/config'

import { getSettings, upsertPartByMpn } from './queries'
import { SEED_PARTS } from './seed-data'

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
  }

  // Materialises the settings row with its defaults if it is not there yet.
  await getSettings()

  let inserted = 0
  let updated = 0

  for (const part of SEED_PARTS) {
    const outcome = await upsertPartByMpn(part)
    if (outcome === 'inserted') inserted += 1
    else updated += 1
  }

  const units = SEED_PARTS.reduce((total, part) => total + (part.inventoryQty ?? 0), 0)

  console.log(`Seed complete: ${inserted} inserted, ${updated} updated.`)
  console.log(`${SEED_PARTS.length} MPNs, ${units} units on hand.`)
  console.log('')
  console.log('Next: set a cost basis per part in Inventory (or import a CSV) so the')
  console.log('decision engine can compute margin. Market data arrives via sync or the Tracker.')
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Seed failed:', error)
    process.exit(1)
  })
