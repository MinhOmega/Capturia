import { useCallback, useRef, useState } from 'react'
import { parseCustomPlaybackSpeedInput } from './customPlaybackSpeed'
import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED } from './types'

export const SEGMENT_SPEED_PRESETS = [
  0.25, 0.5, 0.75, 1, 1.5, 1.75, 2, 2.5, 3, 5, 8, 10, 20, 40,
] as const

/**
 * Free-form segment speed. Digits and one decimal separator (comma accepted),
 * applied live while typing when inside [MIN_PLAYBACK_SPEED, MAX_PLAYBACK_SPEED];
 * values above the cap are refused via `onError`. The draft mirrors the
 * segment's speed while unfocused (empty when it is one of the presets), so a
 * preset click, a pasted speed or a different selection is reflected at once.
 *
 * Typing is live but is ONE edit: `onChange` fires per keystroke so the preview
 * follows along, and `onCommit` fires once the user is done -- on blur, and on
 * Enter, which blurs. The caller opens a history batch on the first change and
 * closes it on the commit, so a typed speed costs one undo entry instead of one
 * per digit.
 */
export function SegmentSpeedInput({
  value,
  onChange,
  onCommit,
  onError,
  ariaLabel,
}: {
  value: number
  onChange: (speed: number) => void
  onCommit?: () => void
  onError: () => void
  ariaLabel: string
}) {
  const isPreset = (SEGMENT_SPEED_PRESETS as readonly number[]).includes(value)
  const [draft, setDraft] = useState(isPreset ? '' : String(value))
  const [isFocused, setIsFocused] = useState(false)

  const prevValue = useRef(value)
  if (!isFocused && prevValue.current !== value) {
    prevValue.current = value
    setDraft(isPreset ? '' : String(value))
  }

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const result = parseCustomPlaybackSpeedInput(e.target.value)
      if (result.status === 'too-fast') {
        onError()
        return
      }
      setDraft(result.draft)
      if (result.status === 'valid') {
        onChange(result.speed)
      }
    },
    [onChange, onError],
  )

  const handleBlur = useCallback(() => {
    setIsFocused(false)
    const result = parseCustomPlaybackSpeedInput(draft)
    if (result.status === 'valid') {
      setDraft(String(result.speed))
    } else {
      setDraft(isPreset ? '' : String(value))
    }
    // The single commit point: Enter blurs, so it lands here too.
    onCommit?.()
  }, [draft, isPreset, onCommit, value])

  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        inputMode="decimal"
        pattern="[0-9]*[.,]?[0-9]*"
        placeholder={`${MIN_PLAYBACK_SPEED}–${MAX_PLAYBACK_SPEED}`}
        aria-label={ariaLabel}
        value={draft}
        onFocus={() => setIsFocused(true)}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="w-16 text-[10px] bg-white/5 border border-white/10 rounded px-2 py-1 text-white text-center tabular-nums outline-none focus:border-[#34B27B]/50"
      />
      <span className="text-[10px] font-semibold text-slate-500">×</span>
    </div>
  )
}
