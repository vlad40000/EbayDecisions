import { Nav } from '@/components/nav'
import { Notice } from '@/components/ui'
import { listParts } from '@/db/queries'
import { requireSession } from '@/lib/session'

/**
 * Counting parts also serves as the database probe. A fresh deploy usually lands
 * before Neon is wired up, and a helpful banner beats a stack trace.
 */
async function probe(): Promise<{ count: number; error: string | null }> {
  try {
    const parts = await listParts()
    return { count: parts.length, error: null }
  } catch (error) {
    return { count: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession()
  const { count, error } = await probe()

  return (
    <div className="min-h-dvh">
      <Nav partCount={count} />
      <main className="px-6 py-6">
        <div className="mx-auto max-w-7xl">
          {error && (
            <div className="mb-6">
              <Notice tone="bad">
                <strong className="font-medium">Cannot reach the database.</strong>{' '}
                {error.includes('DATABASE_URL')
                  ? 'DATABASE_URL is not set. Add your Neon pooled connection string in the Vercel project settings (or .env.local locally), then redeploy.'
                  : `Neon returned: ${error}`}{' '}
                Run <code className="font-mono">pnpm db:migrate</code> and{' '}
                <code className="font-mono">pnpm db:seed</code> if you have not yet created the
                tables.
              </Notice>
            </div>
          )}
          {children}
        </div>
      </main>
    </div>
  )
}
