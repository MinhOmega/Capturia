import { Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import ColorPicker from '@/components/ui/color-picker'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { useI18n } from '@/i18n'
import {
  addGradientStop,
  buildCssGradient,
  colorToHex,
  DEFAULT_GRADIENT_SPEC,
  type GradientKind,
  type GradientSpec,
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  normalizeGradientAngle,
  parseGradientSpec,
  removeGradientStop,
  updateGradientStop,
} from '@/lib/gradientBuilder'
import { cn } from '@/lib/utils'
import { BACKGROUND_GRADIENT_PRESETS } from './backgroundPresets'

interface GradientEditorProps {
  /** Current wallpaper value. When it is a gradient the editor loads it; otherwise the last edited spec is kept. */
  value: string
  /** Receives the CSS gradient string on every edit. */
  onChange: (css: string) => void
  presets?: readonly string[]
}

const STOP_COLOR_PALETTE = [
  '#34B27B',
  '#1E3A8A',
  '#7C3AED',
  '#EC4899',
  '#F97316',
  '#FACC15',
  '#0EA5E9',
  '#0F172A',
  '#F8FAFC',
  '#94A3B8',
]

/**
 * Builds a linear or radial CSS gradient from an angle and a list of colour
 * stops. Emits the same string format the exporter's gradient parser reads,
 * so preview (CSS) and export (canvas) show the same gradient.
 */
export function GradientEditor({
  value,
  onChange,
  presets = BACKGROUND_GRADIENT_PRESETS,
}: GradientEditorProps) {
  const { t } = useI18n()
  const [spec, setSpec] = useState<GradientSpec>(
    () => parseGradientSpec(value) ?? DEFAULT_GRADIENT_SPEC,
  )
  const lastEmittedRef = useRef<string | null>(null)

  // A gradient picked elsewhere (preset grid, restored project) reloads the editor;
  // our own emissions are skipped so typing a position does not reorder the rows.
  useEffect(() => {
    if (value === lastEmittedRef.current) return
    const parsed = parseGradientSpec(value)
    if (parsed) setSpec(parsed)
  }, [value])

  const apply = (next: GradientSpec) => {
    setSpec(next)
    const css = buildCssGradient(next)
    lastEmittedRef.current = css
    onChange(css)
  }

  const css = buildCssGradient(spec)
  const kinds: Array<{ value: GradientKind; label: string }> = [
    { value: 'linear', label: t('settings.gradientEditor.linear') },
    { value: 'radial', label: t('settings.gradientEditor.radial') },
  ]

  return (
    <div className="space-y-2.5" data-testid="gradient-editor">
      <div
        role="img"
        aria-label={t('settings.gradientEditor.preview')}
        data-testid="gradient-preview"
        className="w-full h-14 rounded-lg border border-white/10 shadow-inner"
        style={{ background: css }}
      />

      <div className="grid grid-cols-2 gap-1 p-0.5 rounded-lg bg-white/5 border border-white/5">
        {kinds.map((kind) => (
          <button
            key={kind.value}
            type="button"
            aria-pressed={spec.kind === kind.value}
            onClick={() => apply({ ...spec, kind: kind.value })}
            className={cn(
              'h-6 rounded-md text-[10px] font-medium transition-all',
              spec.kind === kind.value
                ? 'bg-[#34B27B] text-white'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5',
            )}
          >
            {kind.label}
          </button>
        ))}
      </div>

      {spec.kind === 'linear' && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-400 w-10 shrink-0">
            {t('settings.gradientEditor.angle')}
          </span>
          <Slider
            aria-label={t('settings.gradientEditor.angle')}
            value={[spec.angle]}
            onValueChange={(values) => apply({ ...spec, angle: normalizeGradientAngle(values[0]) })}
            min={0}
            max={359}
            step={1}
            className="flex-1 [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
          />
          <input
            type="number"
            aria-label={t('settings.gradientEditor.angleDegrees')}
            value={spec.angle}
            min={0}
            max={359}
            onChange={(event) =>
              apply({ ...spec, angle: normalizeGradientAngle(Number(event.target.value)) })
            }
            className="w-12 h-6 rounded-md border border-white/10 bg-white/5 px-1 text-[10px] text-right text-slate-200 outline-none focus:border-[#34B27B]/50"
          />
          <span className="text-[10px] text-slate-500">°</span>
        </div>
      )}

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-400">{t('settings.gradientEditor.stops')}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('settings.gradientEditor.addStop')}
            disabled={spec.stops.length >= MAX_GRADIENT_STOPS}
            onClick={() => apply(addGradientStop(spec))}
            className="h-5 px-1.5 gap-1 text-[10px] text-slate-300 hover:text-white hover:bg-white/10"
          >
            <Plus className="w-3 h-3" />
            {t('settings.gradientEditor.addStop')}
          </Button>
        </div>
        <ul className="space-y-1" aria-label={t('settings.gradientEditor.stops')}>
          {spec.stops.map((stop, index) => {
            const swatchColor = colorToHex(stop.color) ?? stop.color
            return (
              <li key={`stop-${index}`} className="flex items-center gap-1.5">
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label={`${t('settings.gradientEditor.stopColor')} ${index + 1}`}
                      className="w-6 h-6 rounded-md border border-white/20 shrink-0 shadow-sm"
                      style={{ backgroundColor: swatchColor }}
                    />
                  </PopoverTrigger>
                  <PopoverContent className="w-[260px] p-3 bg-[#1a1a1c] border border-white/10 rounded-xl shadow-xl">
                    <ColorPicker
                      selectedColor={swatchColor}
                      colorPalette={STOP_COLOR_PALETTE}
                      onUpdateColor={(color) => apply(updateGradientStop(spec, index, { color }))}
                      translations={{
                        colorWheel: t('settings.colorWheel'),
                        colorPalette: t('settings.colorPalette'),
                      }}
                    />
                  </PopoverContent>
                </Popover>
                <span className="text-[10px] font-mono text-slate-400 flex-1 truncate">
                  {swatchColor}
                </span>
                <input
                  type="number"
                  aria-label={`${t('settings.gradientEditor.stopPosition')} ${index + 1}`}
                  value={stop.position}
                  min={0}
                  max={100}
                  step={0.1}
                  onChange={(event) =>
                    apply(updateGradientStop(spec, index, { position: Number(event.target.value) }))
                  }
                  className="w-14 h-6 rounded-md border border-white/10 bg-white/5 px-1 text-[10px] text-right text-slate-200 outline-none focus:border-[#34B27B]/50"
                />
                <span className="text-[10px] text-slate-500">%</span>
                <button
                  type="button"
                  aria-label={`${t('settings.gradientEditor.removeStop')} ${index + 1}`}
                  disabled={spec.stops.length <= MIN_GRADIENT_STOPS}
                  onClick={() => apply(removeGradientStop(spec, index))}
                  className="w-5 h-5 rounded-md flex items-center justify-center text-slate-500 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500"
                >
                  <X className="w-3 h-3" />
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      {presets.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] text-slate-400">{t('settings.gradientEditor.presets')}</span>
          <div className="flex flex-wrap gap-1">
            {presets.map((preset, index) => (
              <button
                key={preset}
                type="button"
                aria-label={`${t('settings.gradientEditor.preset')} ${index + 1}`}
                onClick={() => {
                  const parsed = parseGradientSpec(preset)
                  if (parsed) apply(parsed)
                }}
                className={cn(
                  'w-5 h-5 rounded border transition-all',
                  css === preset
                    ? 'border-[#34B27B] ring-1 ring-[#34B27B]/30'
                    : 'border-white/10 hover:border-[#34B27B]/40 opacity-80 hover:opacity-100',
                )}
                style={{ background: preset }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
