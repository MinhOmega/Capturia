import { lazy, Suspense, useEffect, useState } from 'react'
import { CountdownOverlay } from './components/launch/CountdownOverlay'
import { LaunchWindow } from './components/launch/LaunchWindow'
import { NotesWindow } from './components/launch/NotesWindow'
import { PermissionCheckerWindow } from './components/launch/PermissionCheckerWindow'
import { SourceSelector } from './components/launch/SourceSelector'
import { GlobalErrorObserver } from './components/app/GlobalErrorObserver'
import { Toaster } from './components/ui/sonner'
import { loadAllCustomFonts } from './lib/customFonts'
import { useI18n } from './i18n'
import { ShortcutsProvider } from './contexts/ShortcutsContext'
import { ShortcutsConfigDialog } from './components/video-editor/ShortcutsConfigDialog'

// The editor pulls in PixiJS, the exporter and the timeline; the HUD,
// source-selector and permission windows never need any of it, so the editor
// bundle is only fetched by the editor window.
const VideoEditor = lazy(() => import('./components/video-editor/VideoEditor'))

export default function App() {
  const { t } = useI18n()
  const [windowType, setWindowType] = useState('')
  // The Notes window is addressed by its own query flag (`createNotesWindow`).
  const showNotes = new URLSearchParams(window.location.search).get('showNotes') === 'true'

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const type = params.get('windowType') || ''
    setWindowType(type)
    if (type === 'hud-overlay' || type === 'source-selector' || type === 'countdown-overlay') {
      document.body.style.background = 'transparent'
      document.documentElement.style.background = 'transparent'
      document.body.style.overflow = 'hidden'
      document.documentElement.style.overflow = 'hidden'
      document.getElementById('root')?.style.setProperty('background', 'transparent')
      document.getElementById('root')?.style.setProperty('overflow', 'hidden')
    }

    // Load custom fonts on app initialization
    loadAllCustomFonts().catch((error) => {
      console.error('Failed to load custom fonts:', error)
    })
  }, [])

  let content: JSX.Element
  switch (windowType) {
    case 'hud-overlay':
      content = <LaunchWindow />
      break
    case 'source-selector':
      content = <SourceSelector />
      break
    case 'countdown-overlay':
      content = <CountdownOverlay />
      break
    case 'permission-checker':
      content = <PermissionCheckerWindow />
      break
    case 'editor':
      content = (
        <ShortcutsProvider>
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-screen bg-[#09090b] text-slate-400">
                {t('editor.loadingEditor')}
              </div>
            }
          >
            <VideoEditor />
          </Suspense>
          <ShortcutsConfigDialog />
        </ShortcutsProvider>
      )
      break
    default:
      content = (
        <div className="w-full h-full bg-background text-foreground">
          <h1>{t('common.app.name')}</h1>
        </div>
      )
      break
  }

  return (
    <>
      <GlobalErrorObserver />
      {showNotes ? <NotesWindow /> : content}
      <Toaster theme="dark" className="pointer-events-auto" />
    </>
  )
}
