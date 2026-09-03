#!/usr/bin/env node
/**
 * Starts the renderer for a plain Chrome instead of Electron
 * (`npm run dev:browser`, see docs/testing/browser-harness.md).
 *
 * `VITE_BROWSER_HARNESS=1` is set before the config is resolved, which does two
 * things: `vite.config.ts` leaves the Electron plugin out (no app window, no
 * preload) and adds the fixture middleware, and the renderer sees the flag on
 * `import.meta.env` and installs `src/dev/browserBridge.ts` as
 * `window.electronAPI` before React mounts.
 *
 * The port is fixed so tooling can hardcode the URL; override with `PORT`.
 * Written in Node rather than as an inline `VAR=1 vite` so it behaves the same
 * on Windows.
 */
import { createServer } from 'vite'

process.env.VITE_BROWSER_HARNESS = '1'

const port = Number(process.env.PORT ?? 5180)

const server = await createServer({
  configFile: new URL('../vite.config.ts', import.meta.url).pathname,
  server: { port, strictPort: true },
})

await server.listen()
server.printUrls()

console.log(
  [
    '',
    'Capturia browser harness',
    `  launch screen : http://localhost:${port}/?windowType=hud-overlay`,
    `  editor        : http://localhost:${port}/?windowType=editor`,
    '  the editor opens the fixture recording served at /dev-fixtures/sample.webm',
    '',
  ].join('\n'),
)
