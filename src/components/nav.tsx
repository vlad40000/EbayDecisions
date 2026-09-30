'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/decisions', label: 'Decisions' },
  { href: '/inventory', label: 'Inventory' },
  { href: '/tracker', label: 'Tracker' },
  { href: '/settings', label: 'Settings' },
] as const

export function Nav() {
  const pathname = usePathname()

  return (
    <header className="border-line border-b px-6 pt-5">
      <div className="mx-auto max-w-7xl">
        <div className="mb-4 flex items-baseline gap-3">
          <Link href="/decisions" className="text-ink text-base font-semibold tracking-tight">
            Ebay<span className="text-good">Decisions</span>
          </Link>
          <span className="text-ink-faint font-mono text-xs">Road Runner Appliance</span>
          <form action="/api/auth/logout" method="post" className="ml-auto">
            <button
              type="submit"
              className="text-ink-faint hover:text-ink font-mono text-xs transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>

        <nav className="flex gap-0" aria-label="Main">
          {LINKS.map((link) => {
            const active = pathname === link.href || pathname.startsWith(`${link.href}/`)
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`-mb-px border-b-2 px-4 py-2.5 text-sm transition-colors ${
                  active
                    ? 'border-good text-ink'
                    : 'text-ink-faint hover:text-ink-dim border-transparent'
                }`}
              >
                {link.label}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
