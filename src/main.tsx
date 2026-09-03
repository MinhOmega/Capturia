import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { I18nProvider } from './i18n'
import './index.css'

function mount(): void {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </React.StrictMode>,
  )
}

// Browser harness (`npm run dev:browser`): a plain Chrome tab has no preload,
// so `window.electronAPI` is installed from `src/dev/browserBridge.ts` before
// React mounts and reads it. Both flags are statically false in a production
// build, so the branch — and the module behind the dynamic import — is dropped
// from the bundle; the Electron app always takes the `else`.
if (import.meta.env.DEV && import.meta.env.VITE_BROWSER_HARNESS === '1') {
  void import('./dev/browserBridge').then(({ installBrowserBridge }) => {
    installBrowserBridge()
    mount()
  })
} else {
  mount()
}
