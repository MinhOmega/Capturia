import { Copy, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { useI18n } from '@/i18n'
import { getBlurOverlayColor, normalizeBlurData } from '@/lib/blurEffects'
import { cn } from '@/lib/utils'
import {
  type AnnotationRegion,
  type BlurColor,
  type BlurData,
  type BlurShape,
  MAX_BLUR_BLOCK_SIZE,
  MAX_BLUR_INTENSITY,
  MIN_BLUR_BLOCK_SIZE,
  MIN_BLUR_INTENSITY,
} from './types'

interface BlurSettingsPanelProps {
  blurRegion: AnnotationRegion
  onBlurDataChange: (blurData: BlurData) => void
  onDuplicate?: () => void
  onDelete: () => void
}

const SLIDER_CLASS =
  'w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3'

/** Settings for a selected blur (mosaic) region: shape, shade colour, block size and shade intensity. */
export function BlurSettingsPanel({
  blurRegion,
  onBlurDataChange,
  onDuplicate,
  onDelete,
}: BlurSettingsPanelProps) {
  const { t } = useI18n()
  const blurData = normalizeBlurData(blurRegion.blurData)

  const update = (patch: Partial<BlurData>) => {
    onBlurDataChange(normalizeBlurData({ ...blurData, ...patch }))
  }

  const shapeOptions: Array<{ value: BlurShape; label: string }> = [
    { value: 'rectangle', label: t('settings.annotation.blurShapeRectangle') },
    { value: 'oval', label: t('settings.annotation.blurShapeOval') },
  ]
  const colorOptions: Array<{ value: BlurColor; label: string }> = [
    { value: 'white', label: t('settings.annotation.blurColorWhite') },
    { value: 'black', label: t('settings.annotation.blurColorBlack') },
  ]

  return (
    <div className="w-full min-w-0 bg-[#09090b] border border-white/5 rounded-2xl flex flex-col shadow-xl h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
        <div className="mb-4">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            {t('settings.annotation.blurTypeMosaic')}
          </span>
          <div className="mt-1 text-lg font-semibold text-slate-100">
            {t('settings.annotation.typeBlur')}
          </div>
        </div>

        <label className="text-xs font-medium text-slate-300 mb-2 block">
          {t('settings.annotation.blurShape')}
        </label>
        <div
          className="grid grid-cols-2 gap-2"
          role="radiogroup"
          aria-label={t('settings.annotation.blurShape')}
        >
          {shapeOptions.map((shape) => {
            const isActive = blurData.shape === shape.value
            return (
              <button
                key={shape.value}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => update({ shape: shape.value })}
                className={cn(
                  'h-11 rounded-lg border flex items-center justify-center gap-2 p-2 transition-all',
                  isActive
                    ? 'bg-[#34B27B] border-[#34B27B] text-white'
                    : 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20 text-slate-300',
                )}
              >
                <div
                  className={cn(
                    'w-7 h-4 border-2',
                    shape.value === 'oval' ? 'rounded-full' : 'rounded-sm',
                    isActive ? 'border-white' : 'border-slate-400',
                  )}
                />
                <span className="text-[10px] leading-none font-medium">{shape.label}</span>
              </button>
            )
          })}
        </div>

        <label className="text-xs font-medium text-slate-300 mt-4 mb-2 block">
          {t('settings.annotation.blurColor')}
        </label>
        <div
          className="grid grid-cols-2 gap-2"
          role="radiogroup"
          aria-label={t('settings.annotation.blurColor')}
        >
          {colorOptions.map((option) => {
            const isActive = blurData.color === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => update({ color: option.value })}
                className={cn(
                  'h-9 rounded-lg border flex items-center gap-2 px-3 transition-all',
                  isActive
                    ? 'bg-[#34B27B] border-[#34B27B]'
                    : 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20',
                )}
              >
                <div className="w-4 h-4 rounded-full border border-white/20 bg-slate-500 overflow-hidden">
                  <div
                    className="w-full h-full"
                    style={{
                      backgroundColor: getBlurOverlayColor({ ...blurData, color: option.value }),
                    }}
                  />
                </div>
                <span className="text-xs text-slate-200">{option.label}</span>
              </button>
            )
          })}
        </div>

        <div className="mt-4 p-3 rounded-lg bg-white/[0.03] border border-white/5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-300">
              {t('settings.annotation.mosaicBlockSize')}
            </span>
            <span className="text-[10px] text-slate-400 font-mono">
              {Math.round(blurData.blockSize)}px
            </span>
          </div>
          <Slider
            aria-label={t('settings.annotation.mosaicBlockSize')}
            value={[blurData.blockSize]}
            onValueChange={(values) => update({ blockSize: values[0] })}
            min={MIN_BLUR_BLOCK_SIZE}
            max={MAX_BLUR_BLOCK_SIZE}
            step={1}
            className={SLIDER_CLASS}
          />
        </div>

        <div className="mt-3 p-3 rounded-lg bg-white/[0.03] border border-white/5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-300">
              {t('settings.annotation.blurIntensity')}
            </span>
            <span className="text-[10px] text-slate-400 font-mono">
              {Math.round(blurData.intensity)}
            </span>
          </div>
          <Slider
            aria-label={t('settings.annotation.blurIntensity')}
            value={[blurData.intensity]}
            onValueChange={(values) => update({ intensity: values[0] })}
            min={MIN_BLUR_INTENSITY}
            max={MAX_BLUR_INTENSITY}
            step={1}
            className={SLIDER_CLASS}
          />
          <p className="mt-2 text-[10px] text-slate-500 leading-snug">
            {t('settings.annotation.blurIntensityHint')}
          </p>
        </div>

        <div className="mt-4 space-y-2">
          {onDuplicate && (
            <Button
              onClick={onDuplicate}
              variant="outline"
              size="sm"
              className="w-full gap-2 bg-white/5 text-slate-200 border-white/10 hover:bg-[#34B27B] hover:text-white hover:border-[#34B27B] transition-all"
            >
              <Copy className="w-4 h-4" />
              {t('settings.annotation.duplicate')}
            </Button>
          )}
          <Button
            onClick={onDelete}
            variant="destructive"
            size="sm"
            className="w-full gap-2 bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:border-red-500/30 transition-all"
          >
            <Trash2 className="w-4 h-4" />
            {t('settings.annotation.deleteBlur')}
          </Button>
        </div>
      </div>
    </div>
  )
}
