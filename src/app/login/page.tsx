import { redirect } from 'next/navigation'

import { isSignedIn } from '@/lib/session'

import { signIn } from './actions'

export const metadata = { title: 'Sign in — EbayDecisions' }

export default async function LoginPage(props: {
  searchParams: Promise<{ from?: string; error?: string }>
}) {
  if (await isSignedIn()) redirect('/decisions')

  const { from, error } = await props.searchParams

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-ink text-xl font-semibold tracking-tight">
            Ebay<span className="text-good">Decisions</span>
          </h1>
          <p className="text-ink-dim mt-1 text-sm">
            Appliance parts market tracker and listing decision engine.
          </p>
        </div>

        <form action={signIn} className="bg-surface border-line space-y-3 rounded border p-4">
          <input type="hidden" name="from" value={from ?? '/decisions'} />

          <div>
            <label
              htmlFor="password"
              className="text-ink-faint mb-1.5 block text-xs tracking-widest uppercase"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoFocus
              autoComplete="current-password"
              className="field w-full px-3 py-2 font-mono text-sm outline-none focus:border-[var(--color-good)]"
            />
          </div>

          {error && (
            <p role="alert" className="text-bad text-xs">
              {error === 'invalid'
                ? 'That password is not right.'
                : error === 'unconfigured'
                  ? 'Sign-in is not configured on the server — APP_PASSWORD and AUTH_SECRET need to be set.'
                  : 'Something went wrong signing in.'}
            </p>
          )}

          <button
            type="submit"
            className="border-good/40 bg-good/12 text-good hover:bg-good/20 w-full rounded border px-3 py-2 text-sm transition-colors"
          >
            Sign in
          </button>
        </form>
      </div>
    </main>
  )
}
