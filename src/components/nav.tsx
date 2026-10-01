'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function Nav() {
  const pathname = usePathname()
  const trackerActive = pathname === '/tracker' || pathname === '/'
  const moreActive =
    pathname.startsWith('/opportunities') ||
    pathname.startsWith('/research') ||
    pathname.startsWith('/inventory') ||
    pathname.startsWith('/settings')

  return (
    <header className="border-line border-b px-6 pt-5">
      <div className="mx-auto max-w-7xl">
        <div className="mb-4 flex items-baseline gap-3">
          <Link href="/tracker" className="text-ink text-base font-semibold tracking-tight">
            Ebay<span className="text-good">Decisions</span>
          </Link>
          <span className="text-ink-faint font-mono text-xs">Road Runner Appliance</span>
          <form action="/api/auth/logout" method="post" className="ml-auto">
            <button type="submit" className="text-ink-faint hover:text-ink font-mono text-xs">Sign out</button>
          </form>
        </div>

        <nav className="flex items-end gap-1" aria-label="Main">
          <Link
            href="/tracker"
            aria-current={trackerActive ? 'page' : undefined}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm ${
              trackerActive ? 'border-good text-ink' : 'text-ink-faint border-transparent hover:text-ink'
            }`}
          >
            Market Tracker
          </Link>
          <details className="group relative">
            <summary
              className={`-mb-px cursor-pointer list-none border-b-2 px-4 py-2.5 text-sm ${
                moreActive ? 'border-good text-ink' : 'text-ink-faint border-transparent hover:text-ink'
              }`}
            >
              More ▾
            </summary>
            <div className="border-line bg-surface absolute top-full left-0 z-50 mt-1 w-52 rounded border p-1 shadow-xl">
              {[
                ['/tracker?advanced=1', 'Advanced Research'],
                ['/opportunities', 'Market Opportunities'],
                ['/research', 'Research Queue'],
                ['/inventory', 'Inventory'],
                ['/settings', 'Settings'],
              ].map(([href, label]) => (
                <Link key={href} href={href} className="text-ink-dim hover:bg-white/[0.04] hover:text-ink block rounded px-3 py-2 text-xs">
                  {label}
                </Link>
              ))}
            </div>
          </details>
        </nav>
      </div>
    </header>
  )
}
