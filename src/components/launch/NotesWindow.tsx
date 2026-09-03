import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  clampNotesFontSize,
  clampTeleprompterSpeed,
  createTeleprompterRunState,
  getMaxScrollTop,
  holdTeleprompter,
  isAtTeleprompterEnd,
  NOTES_FONT_SIZE_STEP,
  type NotesTeleprompterSettings,
  scaleScrollTop,
  shouldSpaceTogglePlayback,
  stepTeleprompter,
  type TeleprompterRunState,
} from '@/lib/notesTeleprompter'
import { loadUserPreferences, saveUserPreferences } from '@/lib/userPreferences'
import { NotesToolbar } from './NotesToolbar'
import './NotesWindow.css'

export const NOTES_STORAGE_KEY = 'capturia.notes'

/**
 * Notes persist as HTML. Anything stored before the rich-text editor was plain
 * text; wrap it in paragraphs so StarterKit can parse it instead of dropping it.
 */
export function getInitialNotesContent(storage: Pick<Storage, 'getItem'> = localStorage): string {
  const stored = storage.getItem(NOTES_STORAGE_KEY)
  if (!stored) {
    return ''
  }

  if (!stored.trim().startsWith('<')) {
    const escaped = stored.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<p>${escaped.replace(/\n/g, '</p><p>')}</p>`
  }

  return stored
}

function loadTeleprompterSettings(): NotesTeleprompterSettings {
  return loadUserPreferences().notesTeleprompter
}

/**
 * Scratchpad shown in its own always-on-top window while recording. The window
 * is content-protected where the OS supports it, so it stays out of the capture.
 *
 * Teleprompter mode turns the note read-only and scrolls it at a steady pace so
 * it can be read to camera; the formatting toolbar returns when it is switched
 * off, at the same reading position.
 */
export function NotesWindow() {
  const [settings, setSettings] = useState(loadTeleprompterSettings)
  const [teleprompterEnabled, setTeleprompterEnabled] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [mirrored, setMirrored] = useState(false)

  const editor = useEditor({
    extensions: [StarterKit],
    content: getInitialNotesContent(),
    autofocus: 'end',
    editable: !teleprompterEnabled,
    editorProps: {
      attributes: {
        class: 'tiptap',
      },
    },
    onUpdate: ({ editor: nextEditor }) => {
      try {
        localStorage.setItem(NOTES_STORAGE_KEY, nextEditor.getHTML())
      } catch (error) {
        console.warn('Failed to persist notes.', error)
      }
    },
  })

  // Only write preferences the user actually changed: comparing against the
  // loaded object's identity stays correct under StrictMode's doubled effects.
  const loadedSettingsRef = useRef(settings)
  useEffect(() => {
    if (settings === loadedSettingsRef.current) {
      return
    }
    saveUserPreferences({ notesTeleprompter: settings })
  }, [settings])

  // `emitUpdate: false` — the content did not change, so there is nothing to persist.
  useEffect(() => {
    editor?.setEditable(!teleprompterEnabled, false)
  }, [editor, teleprompterEnabled])

  // The font size only applies in teleprompter mode, so toggling the mode or
  // stepping the size re-flows the note. Capture the relative position before
  // the state change and restore it once the new layout has been committed;
  // the effect runs on every commit and is a no-op unless a capture is pending.
  const pendingScrollFractionRef = useRef<number | null>(null)
  const keepReadingPosition = useCallback(
    (update: () => void) => {
      const scrollElement = editor?.view.dom
      if (scrollElement) {
        const maximum = getMaxScrollTop(scrollElement)
        pendingScrollFractionRef.current = maximum > 0 ? scrollElement.scrollTop / maximum : 0
      }
      update()
    },
    [editor],
  )

  const appliedFontSize = teleprompterEnabled ? settings.fontSize : null
  useLayoutEffect(() => {
    const fraction = pendingScrollFractionRef.current
    const scrollElement = editor?.view.dom
    if (fraction === null || !scrollElement) {
      return
    }
    pendingScrollFractionRef.current = null
    const maximum = getMaxScrollTop(scrollElement)
    scrollElement.scrollTop = scaleScrollTop(fraction, 1, maximum)
  })

  // Playback state lives in a ref so restart and manual-scroll holds can reset
  // it without tearing down the animation loop.
  const runRef = useRef<TeleprompterRunState | null>(null)
  // Read through a ref so dragging the speed slider does not restart the loop.
  const speedRef = useRef(settings.speed)
  speedRef.current = settings.speed

  useEffect(() => {
    if (!isPlaying || !editor) {
      return
    }

    const scrollElement = editor.view.dom

    // Starting from the bottom — the end of a previous run, or a manual scroll —
    // replays from the top instead of leaving the play button looking inert.
    if (isAtTeleprompterEnd(scrollElement.scrollTop, getMaxScrollTop(scrollElement))) {
      scrollElement.scrollTop = 0
    }

    runRef.current = createTeleprompterRunState(scrollElement.scrollTop)
    let frameId: number | null = null

    const tick = (timestamp: number) => {
      const run = runRef.current ?? createTeleprompterRunState(scrollElement.scrollTop)
      const result = stepTeleprompter(run, {
        timestamp,
        actualScrollTop: scrollElement.scrollTop,
        maxScrollTop: getMaxScrollTop(scrollElement),
        speed: speedRef.current,
      })
      runRef.current = result.state

      if (result.scrollTop !== null) {
        scrollElement.scrollTop = result.scrollTop
      }

      if (result.atEnd) {
        frameId = null
        setIsPlaying(false)
        return
      }

      frameId = requestAnimationFrame(tick)
    }

    // Wheel and touch input are the reader taking over: wait before resuming.
    // Scrollbar drags and keyboard scrolling are caught by the drift check in
    // the frame step instead.
    const handleManualScroll = () => {
      if (runRef.current) {
        runRef.current = holdTeleprompter(
          runRef.current,
          performance.now(),
          scrollElement.scrollTop,
        )
      }
    }
    scrollElement.addEventListener('wheel', handleManualScroll, { passive: true })
    scrollElement.addEventListener('touchmove', handleManualScroll, { passive: true })

    frameId = requestAnimationFrame(tick)
    return () => {
      scrollElement.removeEventListener('wheel', handleManualScroll)
      scrollElement.removeEventListener('touchmove', handleManualScroll)
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
      runRef.current = null
    }
  }, [editor, isPlaying])

  // Space toggles playback while the focus is not in the note or on a control.
  useEffect(() => {
    if (!teleprompterEnabled || !editor) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const editorContainsTarget = target !== null && editor.view.dom.contains(target)
      if (
        !shouldSpaceTogglePlayback(
          event,
          target instanceof HTMLElement ? target : null,
          editorContainsTarget,
        )
      ) {
        return
      }
      event.preventDefault()
      setIsPlaying((current) => !current)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [editor, teleprompterEnabled])

  const toggleTeleprompter = useCallback(() => {
    keepReadingPosition(() => {
      setIsPlaying(false)
      setTeleprompterEnabled((current) => !current)
    })
  }, [keepReadingPosition])

  const restartFromTop = useCallback(() => {
    const scrollElement = editor?.view.dom
    if (!scrollElement) {
      return
    }
    scrollElement.scrollTop = 0
    if (runRef.current) {
      runRef.current = createTeleprompterRunState(0)
    }
  }, [editor])

  const changeSpeed = useCallback((speed: number) => {
    setSettings((current) => ({ ...current, speed: clampTeleprompterSpeed(speed) }))
  }, [])

  const changeFontSize = useCallback(
    (delta: number) => {
      const fontSize = clampNotesFontSize(settings.fontSize + delta)
      if (fontSize === settings.fontSize) {
        return
      }
      keepReadingPosition(() => {
        setSettings((current) => ({ ...current, fontSize }))
      })
    },
    [keepReadingPosition, settings.fontSize],
  )

  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-white px-6 pb-4 pt-3 gap-4">
        <div className="flex min-w-0 shrink-0 justify-center">
          <NotesToolbar
            editor={editor}
            teleprompterEnabled={teleprompterEnabled}
            isPlaying={isPlaying}
            speed={settings.speed}
            fontSize={settings.fontSize}
            mirrored={mirrored}
            onToggleTeleprompter={toggleTeleprompter}
            onTogglePlaying={() => setIsPlaying((current) => !current)}
            onRestart={restartFromTop}
            onSpeedChange={changeSpeed}
            onDecreaseFontSize={() => changeFontSize(-NOTES_FONT_SIZE_STEP)}
            onIncreaseFontSize={() => changeFontSize(NOTES_FONT_SIZE_STEP)}
            onToggleMirror={() => setMirrored((current) => !current)}
          />
        </div>

        <EditorContent
          editor={editor}
          className="notes-content min-h-0 flex-1"
          data-testid="notes-editor"
          data-teleprompter={teleprompterEnabled}
          data-mirrored={teleprompterEnabled && mirrored}
          style={appliedFontSize === null ? undefined : { fontSize: `${appliedFontSize}px` }}
        />
      </div>
    </TooltipProvider>
  )
}
