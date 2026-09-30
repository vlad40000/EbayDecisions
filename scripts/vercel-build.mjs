import { spawnSync } from 'node:child_process'

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(args) {
  const result = spawnSync(pnpm, args, {
    stdio: 'inherit',
    env: process.env,
  })

  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.env.VERCEL_ENV === 'production') {
  console.log('[db:migrate] production Vercel build: applying pending Drizzle migrations')
  run(['db:migrate'])
  console.log('[db:migrate] production migration step completed')
} else {
  console.log(
    `[db:migrate] skipped (VERCEL_ENV=${process.env.VERCEL_ENV ?? 'unset'}); CI and preview builds do not touch Neon`,
  )
}

run(['exec', 'next', 'build'])
