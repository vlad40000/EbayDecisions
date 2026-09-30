import { Nav } from '@/components/nav'
import { requireSession } from '@/lib/session'

/**
 * Deliberately does no data access.
 *
 * Neon bills by compute time and autosuspends when idle, so every extra
 * round-trip per navigation has a running cost. This layout used to query all
 * parts just to show a count in the nav — on top of whatever the page itself
 * needed, which made every page load two queries instead of one. Each page
 * loads its own data and renders its own error state, so one page load is now
 * one query.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession()

  return (
    <div className="min-h-dvh">
      <Nav />
      <main className="px-6 py-6">
        <div className="mx-auto max-w-7xl">{children}</div>
      </main>
    </div>
  )
}
