import { defineConfig, type Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

// C-1: ONNX Runtime wasm for the in-browser Whisper caption fallback. Only the two
// non-threaded builds are shipped (the worker runs numThreads=1: no SharedArrayBuffer
// under file://). Served from /ort/ in dev and emitted to dist/ort/ at build so the
// renderer resolves them relative to its own page URL (see captionModel.ts).
const ORT_WASM_FILES = ['ort-wasm.wasm', 'ort-wasm-simd.wasm']
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
          this.warn(`[capturia-ort-wasm] missing ${file}; in-browser captions will not work in this build`)
          continue
        }
        this.emitFile({ type: 'asset', fileName: `ort/${name}`, source: fs.readFileSync(file) })
      }
    },
  }
}

const EMPTY_NODE_MODULE = path.resolve(__dirname, 'src/lib/vite-stubs/empty-node-module.ts')

// Mirrors the guard in electron/main.ts: software rendering on Linux Wayland because
// Electron 39 could hard-crash on some Ubuntu Wayland GPU stacks at startup. Kept as-is
// through the Electron 41 upgrade (F8) until someone re-tests on a Wayland desktop; if
// 41 launches cleanly without it, drop both this and the main.ts block together.
const isLinuxWayland = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland'
const devElectronArgs = [
  '.',
  '--no-sandbox',
  ...(isLinuxWayland ? ['--in-process-gpu', '--disable-gpu', '--disable-gpu-compositing'] : []),
]

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    ortWasmPlugin(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'electron/main.ts',
        onstart({ startup }) {
          return startup(devElectronArgs)
        },
        vite: {
          build: {

          }
        }
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, 'electron/preload.ts'),
      },
      // Ployfill the Electron and Node.js API for Renderer process.
      // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
      // See https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer: process.env.NODE_ENV === 'test'
        // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
        ? undefined
        : {},
    }),
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
        pure_funcs: ['console.log', 'console.debug']
      }
    },
    rollupOptions: {
      output: {
        manualChunks: {
          'pixi': ['pixi.js'],
          'react-vendor': ['react', 'react-dom'],
          'video-processing': ['mediabunny', 'mp4box', '@fix-webm-duration/fix']
        }
      }
    },
    chunkSizeWarningLimit: 1000
  }
})
