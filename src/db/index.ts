import 'server-only'

import { neon } from '@neondatabase/serverless'
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http'

import * as schema from './schema'

type Database = NeonHttpDatabase<typeof schema>

let instance: Database | null = null

function connect(): Database {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Add it in your Vercel project settings, or copy .env.example to .env.local for local work.',
    )
  }

  /*
   * Neon over HTTP. Each query is its own fetch, which is the right shape for
   * serverless: no connection pool to exhaust, no socket to keep warm.
   *
   * Worth knowing: neon-http has no interactive transactions. Nothing here
   * needs one — the only multi-row write is a snapshot batch insert, and
   * Postgres already makes a single statement atomic.
   */
  return drizzle({ client: neon(url), schema })
}

/**
 * Lazily connected database handle.
 *
 * The connection is opened on first query rather than at import, which matters
 * during `next build`: the build imports every route's module graph, and a
 * top-level connect would fail the whole build on a machine that has no
 * DATABASE_URL. Deferring it means a missing variable surfaces as the setup
 * banner in the running app, where it can be read and acted on.
 */
export const db = new Proxy({} as Database, {
  get(_target, property, receiver) {
    instance ??= connect()
    return Reflect.get(instance, property, receiver)
  },
})

/**
 * Test-only seam.
 *
 * The integration tests run the real queries — DISTINCT ON, the upserts, the
 * snapshot coalescing — against an in-process Postgres, which is the only way
 * to find out whether that SQL is actually correct. Swapping the handle here
 * keeps `queries.ts` free of any awareness that it is being tested.
 */
export function setDatabaseForTests(replacement: unknown): void {
  instance = replacement as Database
}

export { schema }
