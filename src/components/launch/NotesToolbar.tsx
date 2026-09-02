import type { Editor } from '@tiptap/react'
import {
  Bold,
  Code,
  FlipHorizontal2,
  Italic,
  List,
  ListOrdered,
  Minus,
  Pause,
  Play,
  Plus,
  Quote,
  RotateCcw,
  ScrollText,
  Strikethrough,
} from 'lucide-react'
import { type ReactNode, useEffect, useId, useMemo, useReducer } from 'react'
import { Tooltip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import {
  MAX_NOTES_FONT_SIZE,
  MAX_TELEPROMPTER_SPEED,
  MIN_NOTES_FONT_SIZE,
  MIN_TELEPROMPTER_SPEED,
  TELEPROMPTER_SPEED_STEP,
} from '@/lib/notesTeleprompter'
import { cn } from '@/lib/utils'

export type NotesToolbarProps = {
  editor: Editor | null
  /** Teleprompter mode: the note is read-only and the playback row is shown. */
  teleprompterEnabled: boolean
  isPlaying: boolean
  /** Scroll speed in px/s. */
  speed: number
  /** Note body font size in px. */
  fontSize: number
  mirrored: boolean
  onToggleTeleprompter: () => void
  onTogglePlaying: () => void
  onRestart: () => void
  onSpeedChange: (speed: number) => void
  onDecreaseFontSize: () => void
  onIncreaseFontSize: () => void
  onToggleMirror: () => void
}

type ToolbarButtonProps = {
  'aria-label': string
  tooltipContent: string
  /** Toggle state: drives both `aria-pressed` and the pressed styling. */
  active?: boolean
  /**
   * Pressed styling without `aria-pressed`, for buttons whose label already
   * changes with their state. Announcing both would say it twice.
   */
  highlighted?: boolean
  disabled?: boolean
  describedBy?: string
  onClick: () => void
  children: ReactNode
}

function ToolbarButton({
  'aria-label': ariaLabel,
  tooltipContent,
  active,
  highlighted = false,
  disabled = false,
  describedBy,
  onClick,
  children,
}: ToolbarButtonProps) {
  return (
    <Tooltip content={tooltipContent}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-pressed={active}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-md border-0 bg-transparent text-gray-700 transition-colors hover:bg-gray-200 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gray-900 disabled:cursor-not-allowed disabled:opacity-35',
          (active || highlighted) && 'bg-gray-900 text-white hover:bg-gray-800 hover:text-white',
        )}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function ToolbarDivider() {
  return (
    <div className="grid h-8 w-5 shrink-0 place-content-center">
      <span className="mx-0.5 h-5 w-px bg-gray-300" aria-hidden="true" />
    </div>
  )
}

/** Re-render the toolbar on selection/transaction so `isActive` reflects the caret. */
function useEditorRevision(editor: Editor | null): void {
  const [, bumpRevision] = useReducer((revision: number) => revision + 1, 0)

  useEffect(() => {
    if (!editor) {
      return
    }

    const handleUpdate = () => {
      bumpRevision()
    }

    editor.on('selectionUpdate', handleUpdate)
    editor.on('transaction', handleUpdate)

    return () => {
      editor.off('selectionUpdate', handleUpdate)
      editor.off('transaction', handleUpdate)
    }
  }, [editor])
}

export function NotesToolbar({
  editor,
  teleprompterEnabled,
  isPlaying,
  speed,
  fontSize,
  mirrored,
  onToggleTeleprompter,
  onTogglePlaying,
  onRestart,
  onSpeedChange,
  onDecreaseFontSize,
  onIncreaseFontSize,
  onToggleMirror,
}: NotesToolbarProps) {
  useEditorRevision(editor)
  const { t, locale } = useI18n()
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const speedReadoutId = useId()
  const spaceHintId = useId()

  // Formatting commands only make sense while the note accepts edits.
  const formattingDisabled = teleprompterEnabled

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-1.5 rounded-[0.625rem] border border-gray-200 bg-gray-50 p-1.5">
      <div
        data-testid="notes-formatting-controls"
        className="flex w-full min-w-0 items-center overflow-x-auto"
      >
        <div className="flex min-w-max items-center gap-1">
          <div className="flex shrink-0 items-center gap-1">
            <ToolbarButton
              aria-label={t('launch.tooltips.notesToolbar.bold')}
              tooltipContent={t('launch.tooltips.notesToolbar.bold')}
              active={editor?.isActive('bold') ?? false}
              disabled={formattingDisabled || !editor?.can().chain().focus().toggleBold().run()}
              onClick={() => editor?.chain().focus().toggleBold().run()}
            >
              <Bold size={16} />
            </ToolbarButton>
            <ToolbarButton
              aria-label={t('launch.tooltips.notesToolbar.italic')}
              tooltipContent={t('launch.tooltips.notesToolbar.italic')}
              active={editor?.isActive('italic') ?? false}
              disabled={formattingDisabled || !editor?.can().chain().focus().toggleItalic().run()}
              onClick={() => editor?.chain().focus().toggleItalic().run()}
            >
              <Italic size={16} />
            </ToolbarButton>
            <ToolbarButton
              aria-label={t('launch.tooltips.notesToolbar.strikethrough')}
              tooltipContent={t('launch.tooltips.notesToolbar.strikethrough')}
              active={editor?.isActive('strike') ?? false}
              disabled={formattingDisabled || !editor?.can().chain().focus().toggleStrike().run()}
              onClick={() => editor?.chain().focus().toggleStrike().run()}
            >
              <Strikethrough size={16} />
            </ToolbarButton>
          </div>
          <ToolbarDivider />
          <div className="flex shrink-0 items-center gap-1">
            <ToolbarButton
              aria-label={t('launch.tooltips.notesToolbar.bulletList')}
              tooltipContent={t('launch.tooltips.notesToolbar.bulletList')}
              active={editor?.isActive('bulletList') ?? false}
              disabled={
                formattingDisabled || !editor?.can().chain().focus().toggleBulletList().run()
              }
              onClick={() => editor?.chain().focus().toggleBulletList().run()}
            >
              <List size={16} />
            </ToolbarButton>
            <ToolbarButton
              aria-label={t('launch.tooltips.notesToolbar.numberedList')}
              tooltipContent={t('launch.tooltips.notesToolbar.numberedList')}
              active={editor?.isActive('orderedList') ?? false}
              disabled={
                formattingDisabled || !editor?.can().chain().focus().toggleOrderedList().run()
              }
              onClick={() => editor?.chain().focus().toggleOrderedList().run()}
            >
              <ListOrdered size={16} />
            </ToolbarButton>
          </div>
          <ToolbarDivider />
          <div className="flex shrink-0 items-center gap-1">
            <ToolbarButton
              aria-label={t('launch.tooltips.notesToolbar.blockquote')}
              tooltipContent={t('launch.tooltips.notesToolbar.blockquote')}
              active={editor?.isActive('blockquote') ?? false}
              disabled={
                formattingDisabled || !editor?.can().chain().focus().toggleBlockquote().run()
              }
              onClick={() => editor?.chain().focus().toggleBlockquote().run()}
            >
              <Quote size={16} />
            </ToolbarButton>
            <ToolbarButton
              aria-label={t('launch.tooltips.notesToolbar.codeBlock')}
              tooltipContent={t('launch.tooltips.notesToolbar.codeBlock')}
              active={editor?.isActive('codeBlock') ?? false}
              disabled={
                formattingDisabled || !editor?.can().chain().focus().toggleCodeBlock().run()
              }
              onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
            >
              <Code size={16} />
            </ToolbarButton>
          </div>
          <ToolbarDivider />
          <ToolbarButton
            aria-label={t('launch.tooltips.notesToolbar.teleprompter')}
            tooltipContent={t('launch.tooltips.notesToolbar.teleprompter')}
            active={teleprompterEnabled}
            disabled={!editor}
            onClick={onToggleTeleprompter}
          >
            <ScrollText size={16} />
          </ToolbarButton>
        </div>
      </div>

      {teleprompterEnabled && (
        <div
          data-testid="notes-teleprompter-controls"
          className="flex w-full min-w-0 items-center overflow-x-auto"
        >
          <div className="flex min-w-max items-center gap-1">
            <ToolbarButton
              aria-label={t(
                isPlaying
                  ? 'launch.tooltips.notesToolbar.pause'
                  : 'launch.tooltips.notesToolbar.play',
              )}
              tooltipContent={t(
                isPlaying
                  ? 'launch.tooltips.notesToolbar.pause'
                  : 'launch.tooltips.notesToolbar.play',
              )}
              highlighted={isPlaying}
              disabled={!editor}
              describedBy={spaceHintId}
              onClick={onTogglePlaying}
            >
              {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            </ToolbarButton>
            <ToolbarButton
              aria-label={t('launch.tooltips.notesToolbar.restart')}
              tooltipContent={t('launch.tooltips.notesToolbar.restart')}
              disabled={!editor}
              onClick={onRestart}
            >
              <RotateCcw size={16} />
            </ToolbarButton>

            <ToolbarDivider />

            <div
              role="group"
              aria-label={t('launch.tooltips.notesToolbar.speed')}
              className="flex shrink-0 items-center gap-2 px-1"
            >
              <input
                type="range"
                aria-label={t('launch.tooltips.notesToolbar.speed')}
                aria-describedby={speedReadoutId}
                min={MIN_TELEPROMPTER_SPEED}
                max={MAX_TELEPROMPTER_SPEED}
                step={TELEPROMPTER_SPEED_STEP}
                value={speed}
                onChange={(event) => onSpeedChange(Number(event.currentTarget.value))}
                className="h-1.5 w-28 cursor-pointer accent-gray-900"
              />
              <output
                id={speedReadoutId}
                className="min-w-16 text-center text-xs tabular-nums text-gray-700"
              >
                {t('launch.notesTeleprompter.speedReadout', {
                  value: numberFormatter.format(speed),
                })}
              </output>
            </div>

            <ToolbarDivider />

            <div
              role="group"
              aria-label={t('launch.tooltips.notesToolbar.fontSize')}
              className="flex shrink-0 items-center gap-1"
            >
              <ToolbarButton
                aria-label={t('launch.tooltips.notesToolbar.decreaseFontSize')}
                tooltipContent={t('launch.tooltips.notesToolbar.decreaseFontSize')}
                disabled={fontSize <= MIN_NOTES_FONT_SIZE}
                onClick={onDecreaseFontSize}
              >
                <Minus size={16} />
              </ToolbarButton>
              <output className="min-w-12 text-center text-xs tabular-nums text-gray-700">
                {t('launch.notesTeleprompter.fontSizeReadout', {
                  value: numberFormatter.format(fontSize),
                })}
              </output>
              <ToolbarButton
                aria-label={t('launch.tooltips.notesToolbar.increaseFontSize')}
                tooltipContent={t('launch.tooltips.notesToolbar.increaseFontSize')}
                disabled={fontSize >= MAX_NOTES_FONT_SIZE}
                onClick={onIncreaseFontSize}
              >
                <Plus size={16} />
              </ToolbarButton>
            </div>

            <ToolbarDivider />

            <ToolbarButton
              aria-label={t('launch.tooltips.notesToolbar.mirror')}
              tooltipContent={t('launch.tooltips.notesToolbar.mirror')}
              active={mirrored}
              onClick={onToggleMirror}
            >
              <FlipHorizontal2 size={16} />
            </ToolbarButton>
            <span id={spaceHintId} className="sr-only">
              {t('launch.notesTeleprompter.spaceHint')}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
