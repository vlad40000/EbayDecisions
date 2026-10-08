import { neon } from '@neondatabase/serverless'

const mode = process.argv[2]
if (mode !== 'pre' && mode !== 'post') {
  throw new Error('usage: node scripts/verify-migration-0005.mjs <pre|post>')
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is not available')

const sql = neon(databaseUrl)

const latestRows = await sql`
  select created_at
  from drizzle.__drizzle_migrations
  order by created_at desc
  limit 1
`
const latest = latestRows[0]?.created_at == null ? null : String(latestRows[0].created_at)

if (mode === 'pre') {
  if (latest !== '1791320687870') {
    throw new Error(`precheck failed: expected latest migration 1791320687870, got ${latest ?? 'none'}`)
  }
  console.log('[verify-0005] precheck passed: latest migration is 0004')
  process.exit(0)
}

if (latest !== '1791407608492') {
  throw new Error(`postcheck failed: expected latest migration 1791407608492, got ${latest ?? 'none'}`)
}

const columnRows = await sql`
  select data_type, numeric_precision, numeric_scale, is_nullable
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'parts'
    and column_name = 'new_price'
`
const column = columnRows[0]
if (
  !column ||
  String(column.data_type) !== 'numeric' ||
  String(column.numeric_precision) !== '10' ||
  String(column.numeric_scale) !== '2' ||
  String(column.is_nullable) !== 'YES'
) {
  throw new Error(`postcheck failed: unexpected parts.new_price shape ${JSON.stringify(column ?? null)}`)
}

const constraintRows = await sql`
  select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
  where conname = 'parts_new_price_sane'
`
const constraint = constraintRows[0]
if (!constraint) throw new Error('postcheck failed: parts_new_price_sane constraint missing')

console.log('[verify-0005] postcheck passed: latest migration is 0005')
console.log('[verify-0005] parts.new_price = numeric(10,2), nullable')
console.log('[verify-0005] parts_new_price_sane constraint present')
