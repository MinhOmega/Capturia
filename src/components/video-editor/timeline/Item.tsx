import { useMemo } from 'react'
import { useItem } from 'dnd-timeline'
import type { Span } from 'dnd-timeline'
import { cn } from '@/lib/utils'
import {
  ZoomIn,
  Scissors,
  MessageSquare,
  Captions,
  VolumeX,
  MousePointer2,
  EyeOff,
} from 'lucide-react'
import glassStyles from './ItemGlass.module.css'
import { useI18n } from '@/i18n'
import { formatTooltipMs } from './snapping'

// Minimum clickable width on the outer wrapper. Kept small so items keep their real
// positions; zoom in to interact with sub-second items precisely.
const MIN_ITEM_PX = 6

interface ItemProps {
  id: string
  span: Span
  rowId: string
  children: React.ReactNode
  isSelected?: boolean
  onSelect?: () => void
  zoomDepth?: number
  /** Effective zoom scale (customScale-aware); when set it replaces the depth label, e.g. "2.35×". */
  zoomScale?: number
  /** Zoom follows the recorded cursor (focusMode 'auto'): shows the cursor marker. */
  zoomAutoFocus?: boolean
  variant?: 'zoom' | 'trim' | 'annotation' | 'blur' | 'subtitle' | 'audio-edit'
  editable?: boolean
}

// Map zoom depth to multiplier labels
const ZOOM_LABELS: Record<number, string> = {
  1: '1.25×',
  2: '1.5×',
  3: '1.8×',
  4: '2.2×',
  5: '3.5×',
  6: '5×',
}

export default function Item({
  id,
  span,
  rowId,
  isSelected = false,
  onSelect,
  zoomDepth = 1,
  zoomScale,
  zoomAutoFocus = false,
  variant = 'zoom',
  editable = true,
  children,
}: ItemProps) {
  const { t } = useI18n()
  const { setNodeRef, attributes, listeners, itemStyle, itemContentStyle } = useItem({
    id,
    span,
    data: { rowId },
  })

  const isZoom = variant === 'zoom'
  const isTrim = variant === 'trim'
  const isSubtitle = variant === 'subtitle'
  const isAudioEdit = variant === 'audio-edit'
  const isBlur = variant === 'blur'

  const glassClass = isZoom
    ? glassStyles.glassGreen
    : isTrim
      ? glassStyles.glassRed
      : isAudioEdit
        ? glassStyles.glassRed
        : isSubtitle
          ? glassStyles.glassBlue
          : isBlur
            ? glassStyles.glassPurple
            : glassStyles.glassYellow

  const endCapColor = isZoom
    ? '#21916A'
    : isTrim
      ? '#ef4444'
      : isAudioEdit
        ? '#ef4444'
        : isSubtitle
          ? '#2E6EE6'
          : isBlur
            ? '#8B5CF6'
            : '#B4A046'

  // Start–end label shown on hover / when selected (T13)
  const timeLabel = useMemo(
    () => `${formatTooltipMs(span.start)} – ${formatTooltipMs(span.end)}`,
    [span.start, span.end],
  )
  const safeItemStyle = { ...itemStyle, minWidth: MIN_ITEM_PX }

  return (
    <div
      ref={setNodeRef}
      style={safeItemStyle}
      {...(editable ? listeners : {})}
      {...(editable ? attributes : {})}
      onPointerDownCapture={() => onSelect?.()}
      className="group"
    >
      <div style={itemContentStyle}>
        <div
          className={cn(
            glassClass,
            'w-full h-full overflow-hidden flex items-center justify-center gap-1.5 relative',
            editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
            isSelected && glassStyles.selected,
          )}
          style={{ height: 40, color: '#fff' }}
          onClick={(event) => {
            event.stopPropagation()
            onSelect?.()
          }}
        >
          <div
            className={cn(glassStyles.zoomEndCap, glassStyles.left)}
            style={{
              cursor: editable ? 'col-resize' : 'default',
              pointerEvents: editable ? 'auto' : 'none',
              width: 8,
              opacity: editable ? 0.9 : 0,
              background: endCapColor,
            }}
            title={t('timeline.resizeLeft')}
          />
          <div
            className={cn(glassStyles.zoomEndCap, glassStyles.right)}
            style={{
              cursor: editable ? 'col-resize' : 'default',
              pointerEvents: editable ? 'auto' : 'none',
              width: 8,
              opacity: editable ? 0.9 : 0,
              background: endCapColor,
            }}
            title={t('timeline.resizeRight')}
          />
          {/* Content */}
          <div className="relative z-10 flex min-w-0 flex-col items-center justify-center text-white/90 opacity-80 group-hover:opacity-100 transition-opacity select-none overflow-hidden px-2">
            <div className="flex items-center gap-1.5">
              {isZoom ? (
                <>
                  <ZoomIn className="w-3.5 h-3.5" />
                  <span className="text-[11px] font-semibold tracking-tight">
                    {zoomScale != null
                      ? `${zoomScale.toFixed(2).replace(/\.?0+$/, '')}×`
                      : ZOOM_LABELS[zoomDepth] || `${zoomDepth}×`}
                  </span>
                  {zoomAutoFocus && (
                    <span className="flex shrink-0" title={t('timeline.zoomAutoFocus')}>
                      <MousePointer2
                        className="w-3 h-3 opacity-90"
                        aria-label={t('timeline.zoomAutoFocus')}
                      />
                    </span>
                  )}
                </>
              ) : isTrim ? (
                <>
                  <Scissors className="w-3.5 h-3.5" />
                  <span className="text-[11px] font-semibold tracking-tight">
                    {t('timeline.trim')}
                  </span>
                </>
              ) : isSubtitle ? (
                <>
                  <Captions className="w-3.5 h-3.5" />
                  <span className="text-[11px] font-semibold tracking-tight">{children}</span>
                </>
              ) : isAudioEdit ? (
                <>
                  <VolumeX className="w-3.5 h-3.5" />
                  <span className="text-[11px] font-semibold tracking-tight">
                    {children || t('timeline.audioMutedSegment')}
                  </span>
                </>
              ) : isBlur ? (
                <>
                  <EyeOff className="w-3.5 h-3.5" />
                  <span className="text-[11px] font-semibold tracking-tight">{children}</span>
                </>
              ) : (
                <>
                  <MessageSquare className="w-3.5 h-3.5" />
                  <span className="text-[11px] font-semibold tracking-tight">{children}</span>
                </>
              )}
            </div>
            <span
              className={cn(
                'text-[9px] tabular-nums tracking-tight whitespace-nowrap transition-opacity',
                isSelected ? 'opacity-60' : 'opacity-0 group-hover:opacity-40',
              )}
            >
              {timeLabel}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
