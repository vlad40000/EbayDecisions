import { spawnSync } from 'node:child_process'

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env,
  })

  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.env.VERCEL_ENV === 'production') {
  console.log('[db:migrate] production precheck for migration 0005')
  run(process.execPath, ['scripts/verify-migration-0005.mjs', 'pre'])

  console.log('[db:migrate] applying pending Drizzle migrations')
  run(pnpm, ['db:migrate'])

  console.log('[db:migrate] production postcheck for migration 0005')
  run(process.execPath, ['scripts/verify-migration-0005.mjs', 'post'])
} else {
  console.log(
    `[db:migrate] skipped (VERCEL_ENV=${process.env.VERCEL_ENV ?? 'unset'}); only the explicit production ops deployment may touch Neon`,
  )
}

run(pnpm, ['exec', 'next', 'build'])
