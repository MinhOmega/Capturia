import { useI18n } from '@/i18n'
import { CAPTION_MODEL_CHOICES } from '@/lib/captioning/captionConstants'
import { formatMegabytes } from '@/lib/captioning/captionModel'
import {
  CAPTION_LANGUAGE_AUTO,
  CAPTION_LANGUAGES,
  MAX_CAPTION_VOCABULARY_LENGTH,
} from '@/lib/captioning/captionTranscriptionSettings'
import { cn } from '@/lib/utils'

/**
 * Transcription quality controls (P2-F4): which Whisper weights to download and
 * run, which language to force, and a short list of product names to correct in
 * the transcript. They apply to the in-browser engine; the native macOS engine
 * takes its language from the app locale and has no model to choose.
 */

interface TranscriptionQualityPanelProps {
  modelId: string
  onModelIdChange: (modelId: string) => void
  language: string
  onLanguageChange: (language: string) => void
  vocabulary: string
  onVocabularyChange: (vocabulary: string) => void
  disabled?: boolean
}

export function TranscriptionQualityPanel({
  modelId,
  onModelIdChange,
  language,
  onLanguageChange,
  vocabulary,
  onVocabularyChange,
  disabled = false,
}: TranscriptionQualityPanelProps) {
  const { t } = useI18n()

  return (
    <div className="mt-2 rounded-lg border border-white/10 bg-white/5 p-2 space-y-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
        {t('settings.captionsQuality')}
      </div>

      <div>
        <span className="text-[10px] text-slate-300">{t('settings.captionsModel')}</span>
        <div
          className="mt-1 grid grid-cols-3 gap-1"
          role="radiogroup"
          aria-label={t('settings.captionsModel')}
        >
          {CAPTION_MODEL_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={modelId === choice.id}
              disabled={disabled}
              data-testid={`caption-model-${choice.label.toLowerCase()}`}
              onClick={() => onModelIdChange(choice.id)}
              title={t('settings.captionsModelHint', {
                size: formatMegabytes(choice.approximateBytes),
              })}
              className={cn(
                'flex h-9 flex-col items-center justify-center rounded-md border text-[10px] leading-tight transition-all disabled:opacity-50',
                modelId === choice.id
                  ? 'bg-[#34B27B]/15 text-[#34B27B] border-[#34B27B]/30'
                  : 'bg-white/5 text-slate-300 border-white/10 hover:bg-white/10 hover:border-white/20 hover:text-white',
              )}
            >
              <span>{choice.label}</span>
              {/* The download is not bundled: show what it costs before committing. */}
              <span className="text-[9px] text-slate-500 font-mono">
                {formatMegabytes(choice.approximateBytes)}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-[10px] text-slate-300" htmlFor="caption-language">
          {t('settings.captionsLanguage')}
        </label>
        <select
          id="caption-language"
          data-testid="caption-language"
          value={language}
          disabled={disabled}
          onChange={(event) => onLanguageChange(event.target.value)}
          className="mt-1 w-full h-7 rounded-md border border-white/10 bg-[#141821] px-2 text-[10px] text-slate-200 disabled:opacity-50"
        >
          <option value={CAPTION_LANGUAGE_AUTO}>{t('settings.captionsLanguageAuto')}</option>
          {CAPTION_LANGUAGES.map(([code, autonym]) => (
            <option key={code} value={code}>
              {autonym}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-[10px] text-slate-300" htmlFor="caption-vocabulary">
          {t('settings.captionsVocabulary')}
        </label>
        <input
          id="caption-vocabulary"
          data-testid="caption-vocabulary"
          type="text"
          value={vocabulary}
          disabled={disabled}
          maxLength={MAX_CAPTION_VOCABULARY_LENGTH}
          placeholder={t('settings.captionsVocabularyPlaceholder')}
          onChange={(event) => onVocabularyChange(event.target.value)}
          className="mt-1 w-full h-7 rounded-md border border-white/10 bg-[#141821] px-2 text-[10px] text-slate-200 placeholder:text-slate-600 disabled:opacity-50"
        />
        <p className="mt-1 text-[9px] leading-snug text-slate-500">
          {t('settings.captionsVocabularyHint')}
        </p>
      </div>
    </div>
  )
}
