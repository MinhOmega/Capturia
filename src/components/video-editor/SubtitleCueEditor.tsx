import { useEffect, useMemo, useRef, useState } from 'react'
import { Split, Merge, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import type { SubtitleCue } from '@/lib/analysis/types'

/**
 * Editor for the caption cue selected on the timeline (P2-F2). Every action
 * calls one pure operation in `src/lib/captions/captionOps.ts`; nothing here
 * decides what a legal edit is.
 */

interface SubtitleCueEditorProps {
  cues: SubtitleCue[]
  selectedCueId: string | null
  onSelectCue: (id: string | null) => void
  onTextChange: (id: string, text: string) => void
  onSplit: (id: string) => void
  onMergeNext: (id: string) => void
  onMergePrevious: (id: string) => void
  onDelete: (id: string) => void
  disabled?: boolean
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`
}

export function SubtitleCueEditor({
  cues,
  selectedCueId,
  onSelectCue,
  onTextChange,
  onSplit,
  onMergeNext,
  onMergePrevious,
  onDelete,
  disabled = false,
}: SubtitleCueEditorProps) {
  const { t } = useI18n()
  const sorted = useMemo(
    () => [...cues].sort((left, right) => left.startMs - right.startMs),
    [cues],
  )
  const index = sorted.findIndex((cue) => cue.id === selectedCueId)
  const cue = index >= 0 ? sorted[index] : null

  // Local draft so typing does not push an undo entry per keystroke; the edit
  // is committed on blur or Enter.
  const [draft, setDraft] = useState(cue?.text ?? '')
  const committedRef = useRef(cue?.text ?? '')
  useEffect(() => {
    setDraft(cue?.text ?? '')
    committedRef.current = cue?.text ?? ''
  }, [cue?.text])

  if (cues.length === 0) return null

  const commit = () => {
    if (!cue) return
    if (draft === committedRef.current) return
    committedRef.current = draft
    onTextChange(cue.id, draft)
  }

  return (
    <div className="mt-2 rounded-lg border border-white/10 bg-white/5 p-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
          {t('settings.captionsCueEditor')}
        </span>
        {cue && (
          <span className="text-[10px] text-slate-500 tabular-nums">
            {formatSeconds(cue.startMs)} – {formatSeconds(cue.endMs)}
          </span>
        )}
      </div>

      <select
        value={selectedCueId ?? ''}
        disabled={disabled}
        onChange={(event) => onSelectCue(event.target.value || null)}
        aria-label={t('settings.captionsCueSelect')}
        className="w-full h-7 rounded-md border border-white/10 bg-white/5 px-2 text-[10px] text-slate-200 disabled:opacity-50"
      >
        <option value="">{t('settings.captionsCueNone')}</option>
        {sorted.map((entry, entryIndex) => (
          <option key={entry.id} value={entry.id}>
            {entryIndex + 1}. {entry.text.slice(0, 40)}
          </option>
        ))}
      </select>

      {cue ? (
        <>
          <textarea
            value={draft}
            disabled={disabled}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                commit()
                event.currentTarget.blur()
              }
              if (event.key === 'Escape') {
                setDraft(committedRef.current)
                event.currentTarget.blur()
              }
            }}
            aria-label={t('settings.captionsCueText')}
            data-testid="caption-cue-text"
            className="w-full resize-none rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] text-slate-100 outline-none focus:border-[#34B27B]/50"
          />

          <div className="grid grid-cols-2 gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => onSplit(cue.id)}
              title={t('settings.captionsCueSplitHint')}
              className="gap-1.5 h-7 bg-white/5 text-slate-200 border border-white/10 text-[10px] hover:bg-white/10 hover:text-white"
            >
              <Split className="w-3 h-3 text-[#34B27B]" />
              {t('settings.captionsCueSplit')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || index >= sorted.length - 1}
              onClick={() => onMergeNext(cue.id)}
              title={t('settings.captionsCueMergeNextHint')}
              className="gap-1.5 h-7 bg-white/5 text-slate-200 border border-white/10 text-[10px] hover:bg-white/10 hover:text-white"
            >
              <Merge className="w-3 h-3 text-[#34B27B]" />
              {t('settings.captionsCueMergeNext')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || index <= 0}
              onClick={() => onMergePrevious(cue.id)}
              title={t('settings.captionsCueMergePreviousHint')}
              className="gap-1.5 h-7 bg-white/5 text-slate-200 border border-white/10 text-[10px] hover:bg-white/10 hover:text-white"
            >
              <Merge className="w-3 h-3 rotate-180 text-[#34B27B]" />
              {t('settings.captionsCueMergePrevious')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => onDelete(cue.id)}
              className="gap-1.5 h-7 bg-[#ef4444]/10 text-[#ef4444] border border-[#ef4444]/20 text-[10px] hover:bg-[#ef4444]/20 hover:text-[#ef4444]"
            >
              <Trash2 className="w-3 h-3" />
              {t('settings.captionsCueDelete')}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-[10px] text-slate-500">{t('settings.captionsCueSelectHint')}</p>
      )}
    </div>
  )
}
