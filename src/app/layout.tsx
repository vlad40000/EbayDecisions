import type { Metadata, Viewport } from 'next'

/*
 * Fonts come from npm and are bundled with the app, rather than fetched from a
 * font CDN at page load. That removes a render-blocking third-party request on
 * every visit, keeps the app working on a restricted network, and means the
 * build never depends on Google being reachable.
 */
import '@fontsource-variable/work-sans'
import '@fontsource/dm-mono/400.css'
import '@fontsource/dm-mono/500.css'

import './globals.css'

export const metadata: Metadata = {
  title: 'EbayDecisions',
  description:
    'Appliance parts market tracker and listing decision engine for Road Runner Appliance.',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  themeColor: '#08090d',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-bg text-ink font-sans antialiased">{children}</body>
    </html>
  )
}
