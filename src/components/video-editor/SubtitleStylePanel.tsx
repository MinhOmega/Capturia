import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import {
  MAX_SUBTITLE_FONT_SCALE,
  MAX_SUBTITLE_MARGIN_RATIO,
  MIN_SUBTITLE_FONT_SCALE,
  SUBTITLE_ANCHORS,
  type SubtitleAnchor,
  type SubtitleStyle,
} from '@/lib/rendering/subtitleStyle'

/**
 * Caption look controls (P2-F1). Writes into the project's `subtitleStyle`,
 * which the preview overlay and the export renderer both resolve through
 * `resolveSubtitleLayout`, so what is set here is what lands in the file.
 */

interface SubtitleStylePanelProps {
  style: SubtitleStyle
  onChange: (patch: Partial<SubtitleStyle>) => void
  disabled?: boolean
}

const ANCHOR_LABEL_KEYS: Record<SubtitleAnchor, string> = {
  top: 'settings.captionsPositionTop',
  center: 'settings.captionsPositionCenter',
  bottom: 'settings.captionsPositionBottom',
}

/** Enough contrast on any wallpaper; the colour input covers everything else. */
const TEXT_COLOR_PRESETS = ['#FFFFFF', '#FFD166', '#34B27B', '#7DD3FC', '#F87171'] as const

export function SubtitleStylePanel({ style, onChange, disabled = false }: SubtitleStylePanelProps) {
  const { t } = useI18n()

  return (
    <div className="mt-2 rounded-lg border border-white/10 bg-white/5 p-2 space-y-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
        {t('settings.captionsStyle')}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-slate-300">{t('settings.captionsFontSize')}</span>
          <span className="text-[10px] text-slate-500 font-mono">
            {style.fontScale.toFixed(2)}×
          </span>
        </div>
        <Slider
          value={[style.fontScale]}
          onValueChange={(values) => onChange({ fontScale: values[0] })}
          min={MIN_SUBTITLE_FONT_SCALE}
          max={MAX_SUBTITLE_FONT_SCALE}
          step={0.05}
          disabled={disabled}
          aria-label={t('settings.captionsFontSize')}
          className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
        />
      </div>

      <div>
        <span className="text-[10px] text-slate-300">{t('settings.captionsPosition')}</span>
        <div
          className="mt-1 grid grid-cols-3 gap-1"
          role="radiogroup"
          aria-label={t('settings.captionsPosition')}
        >
          {SUBTITLE_ANCHORS.map((anchor) => (
            <button
              key={anchor}
              type="button"
              role="radio"
              aria-checked={style.anchor === anchor}
              disabled={disabled}
              onClick={() => onChange({ anchor })}
              className={cn(
                'h-7 rounded-md border text-[10px] transition-all disabled:opacity-50',
                style.anchor === anchor
                  ? 'bg-[#34B27B]/15 text-[#34B27B] border-[#34B27B]/30'
                  : 'bg-white/5 text-slate-300 border-white/10 hover:bg-white/10 hover:border-white/20 hover:text-white',
              )}
            >
              {t(ANCHOR_LABEL_KEYS[anchor])}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-slate-300">{t('settings.captionsMargin')}</span>
          <span className="text-[10px] text-slate-500 font-mono">
            {Math.round(style.marginRatio * 100)}%
          </span>
        </div>
        <Slider
          value={[style.marginRatio]}
          onValueChange={(values) => onChange({ marginRatio: values[0] })}
          min={0}
          max={MAX_SUBTITLE_MARGIN_RATIO}
          step={0.01}
          disabled={disabled || style.anchor === 'center'}
          aria-label={t('settings.captionsMargin')}
          className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
        />
        {style.anchor === 'center' && (
          <p className="mt-1 text-[10px] text-slate-500">
            {t('settings.captionsMarginCenterHint')}
          </p>
        )}
      </div>

      <div>
        <span className="text-[10px] text-slate-300">{t('settings.captionsTextColor')}</span>
        <div className="mt-1 flex items-center gap-1.5">
          {TEXT_COLOR_PRESETS.map((color) => (
            <button
              key={color}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ textColor: color })}
              aria-label={color}
              aria-pressed={style.textColor === color}
              className={cn(
                'h-5 w-5 rounded-full border transition-all disabled:opacity-50',
                style.textColor === color
                  ? 'border-[#34B27B] ring-2 ring-[#34B27B]/40'
                  : 'border-white/20 hover:border-white/50',
              )}
              style={{ backgroundColor: color }}
            />
          ))}
          <input
            type="color"
            value={style.textColor}
            disabled={disabled}
            onChange={(event) => onChange({ textColor: event.target.value })}
            aria-label={t('settings.captionsTextColorCustom')}
            title={t('settings.captionsTextColorCustom')}
            className="h-5 w-7 cursor-pointer rounded border border-white/20 bg-transparent p-0 disabled:opacity-50"
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-300">{t('settings.captionsBackground')}</span>
        <Switch
          checked={style.backgroundEnabled}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ backgroundEnabled: checked })}
          aria-label={t('settings.captionsBackground')}
          className="data-[state=checked]:bg-[#34B27B] scale-90"
        />
      </div>

      {style.backgroundEnabled && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-slate-300">
              {t('settings.captionsBackgroundOpacity')}
            </span>
            <span className="text-[10px] text-slate-500 font-mono">
              {Math.round(style.backgroundOpacity * 100)}%
            </span>
          </div>
          <Slider
            value={[style.backgroundOpacity]}
            onValueChange={(values) => onChange({ backgroundOpacity: values[0] })}
            min={0}
            max={1}
            step={0.01}
            disabled={disabled}
            aria-label={t('settings.captionsBackgroundOpacity')}
            className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
          />
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-300" title={t('settings.captionsHighlightHint')}>
          {t('settings.captionsHighlight')}
        </span>
        <Switch
          checked={style.highlightCurrentWord}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ highlightCurrentWord: checked })}
          aria-label={t('settings.captionsHighlight')}
          className="data-[state=checked]:bg-[#34B27B] scale-90"
        />
      </div>

      {style.highlightCurrentWord && (
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-300">{t('settings.captionsHighlightColor')}</span>
          <input
            type="color"
            value={style.highlightColor}
            disabled={disabled}
            onChange={(event) => onChange({ highlightColor: event.target.value })}
            aria-label={t('settings.captionsHighlightColor')}
            className="h-5 w-7 cursor-pointer rounded border border-white/20 bg-transparent p-0 disabled:opacity-50"
          />
        </div>
      )}
    </div>
  )
}
