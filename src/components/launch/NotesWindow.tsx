import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TooltipProvider } from '@/components/ui/tooltip'
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

/**
 * Scratchpad shown in its own always-on-top window while recording. The window
 * is content-protected where the OS supports it, so it stays out of the capture.
 */
export function NotesWindow() {
  const editor = useEditor({
    extensions: [StarterKit],
    content: getInitialNotesContent(),
    autofocus: 'end',
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

  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-white px-6 pb-4 pt-3 gap-4">
        <div className="shrink-0 flex justify-center">
          <NotesToolbar editor={editor} />
        </div>

        <EditorContent editor={editor} className="min-h-0 flex-1" data-testid="notes-editor" />
      </div>
    </TooltipProvider>
  )
}
