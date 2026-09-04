import { defineConfig, type Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

// ONNX Runtime wasm for the in-browser Whisper caption fallback. Only the
// single-threaded SIMD build is shipped: the worker runs numThreads=1 (no
// SharedArrayBuffer under file://) and Electron's Chromium always has WebAssembly
// SIMD, so the non-SIMD build would never be loaded (the worker maps exactly this
// file name through `wasmPaths`, see src/lib/captioning/ortWasm.ts). Served from
// /ort/ in dev and emitted to dist/ort/ at build so the renderer resolves it
// relative to its own page URL (see captionModel.ts).
const ORT_WASM_FILES = ['ort-wasm-simd.wasm']
const ORT_WASM_SRC_DIR = path.resolve(__dirname, 'node_modules/onnxruntime-web/dist')

function ortWasmPlugin(): Plugin {
  return {
    name: 'capturia-ort-wasm',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = /^\/ort\/([A-Za-z0-9._-]+\.wasm)(?:\?.*)?$/.exec(req.url ?? '')
        if (!match || !ORT_WASM_FILES.includes(match[1])) return next()
        const file = path.join(ORT_WASM_SRC_DIR, match[1])
        if (!fs.existsSync(file)) return next()
        res.setHeader('Content-Type', 'application/wasm')
        res.setHeader('Cache-Control', 'no-cache')
        fs.createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      for (const name of ORT_WASM_FILES) {
        const file = path.join(ORT_WASM_SRC_DIR, name)
        if (!fs.existsSync(file)) {
          this.warn(
            `[capturia-ort-wasm] missing ${file}; in-browser captions will not work in this build`,
          )
          continue
        }
        this.emitFile({ type: 'asset', fileName: `ort/${name}`, source: fs.readFileSync(file) })
      }
    },
  }
}

/**
 * Browser harness (`npm run dev:browser`, docs/testing/browser-harness.md):
 * serve the renderer to a plain Chrome instead of Electron, so a change can be
 * driven through real DevTools before an end-to-end spec exists for it. Two
 * things change, both dev-server only:
 *  - the Electron plugin is left out, so no app window is spawned and no
 *    preload is built (a preload bridge would shadow the harness shim);
 *  - the recording fixture the shim points the editor at is served over HTTP.
 */
const BROWSER_HARNESS = process.env.VITE_BROWSER_HARNESS === '1'
const HARNESS_FIXTURE_DIR = path.resolve(__dirname, 'src/__fixtures__')
/**
 * Recordings the harness serves, by URL path. `sample.webm` is what the editor
 * opens by default; `scrolling-table.webm` is the one with content that moves,
 * which is the only way to check a tracked blur by hand
 * (docs/specs/tracked-blur-regions.md §4.3). Point the editor at another with
 * `electronAPI.setCurrentVideoPath('/dev-fixtures/scrolling-table.webm')`.
 */
const HARNESS_FIXTURES = ['sample.webm', 'scrolling-table.webm']

function browserHarnessPlugin(): Plugin {
  return {
    name: 'capturia-browser-harness',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        const fixtureMatch = /^\/dev-fixtures\/([A-Za-z0-9._-]+)$/.exec(url)
        if (!fixtureMatch || !HARNESS_FIXTURES.includes(fixtureMatch[1])) return next()
        const fixtureFile = path.join(HARNESS_FIXTURE_DIR, fixtureMatch[1])
        if (!fs.existsSync(fixtureFile)) return next()
        const size = fs.statSync(fixtureFile).size
        res.setHeader('Content-Type', 'video/webm')
        res.setHeader('Cache-Control', 'no-cache')
        // `<video>` seeking and the exporter's chunked reads both ask for ranges.
        res.setHeader('Accept-Ranges', 'bytes')
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
        if (match && (match[1] !== '' || match[2] !== '')) {
          const start = match[1] === '' ? size - Number(match[2]) : Number(match[1])
          const end = match[1] === '' || match[2] === '' ? size - 1 : Number(match[2])
          const from = Math.max(0, Math.min(start, size - 1))
          const to = Math.max(from, Math.min(end, size - 1))
          res.statusCode = 206
          res.setHeader('Content-Range', `bytes ${from}-${to}/${size}`)
          res.setHeader('Content-Length', String(to - from + 1))
          fs.createReadStream(fixtureFile, { start: from, end: to }).pipe(res)
          return
        }
        res.setHeader('Content-Length', String(size))
        fs.createReadStream(fixtureFile).pipe(res)
      })
    },
  }
}

const EMPTY_NODE_MODULE = path.resolve(__dirname, 'src/lib/vite-stubs/empty-node-module.ts')

// Mirrors the guard in electron/main.ts: software rendering on Linux Wayland because
// Electron 39 could hard-crash on some Ubuntu Wayland GPU stacks at startup. Kept as-is
// through the Electron 41 upgrade (F8) until someone re-tests on a Wayland desktop; if
// 41 launches cleanly without it, drop both this and the main.ts block together.
const isLinuxWayland =
  process.platform === 'linux' && (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland'
const devElectronArgs = [
  '.',
  '--no-sandbox',
  ...(isLinuxWayland ? ['--in-process-gpu', '--disable-gpu', '--disable-gpu-compositing'] : []),
]

function electronPlugin() {
  return electron({
    main: {
      // Shortcut of `build.lib.entry`.
      entry: 'electron/main.ts',
      onstart({ startup }) {
        return startup(devElectronArgs)
      },
      vite: {
        build: {},
      },
    },
    preload: {
      // Shortcut of `build.rollupOptions.input`.
      // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
      input: path.join(__dirname, 'electron/preload.ts'),
    },
    // Ployfill the Electron and Node.js API for Renderer process.
    // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
    // See https://github.com/electron-vite/vite-plugin-electron-renderer
    renderer:
      process.env.NODE_ENV === 'test'
        ? // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
          undefined
        : {},
  })
}

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    ortWasmPlugin(),
    // The harness serves the renderer to a browser; Electron must not boot.
    ...(BROWSER_HARNESS ? [browserHarnessPlugin()] : [electronPlugin()]),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // @xenova/transformers: env.js statically imports fs/path/url; onnx.js imports
      // onnxruntime-node (must not be bundled in the renderer: it requires fs).
      // These aliases only apply to the renderer build; the electron main/preload
      // builds have their own config and keep the real Node modules.
      fs: EMPTY_NODE_MODULE,
      path: EMPTY_NODE_MODULE,
      url: EMPTY_NODE_MODULE,
      'onnxruntime-node': path.resolve(__dirname, 'src/lib/vite-stubs/onnxruntime-node-stub.ts'),
    },
  },
  optimizeDeps: {
    exclude: ['@xenova/transformers'],
  },
  // The captioning worker dynamically imports @xenova/transformers, which makes the
  // worker bundle code-split, unsupported by the default "iife" worker format.
  worker: {
    format: 'es',
  },
  build: {
    target: 'esnext',
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
        pure_funcs: ['console.log', 'console.debug'],
      },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          'pixi': ['pixi.js'],
          'react-vendor': ['react', 'react-dom'],
          'video-processing': ['mediabunny', 'mp4box', '@fix-webm-duration/fix'],
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
})
