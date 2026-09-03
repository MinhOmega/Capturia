interface AudioLevelMeterProps {
  /** 0-100 */
  level: number
  className?: string
}

const bars = [
  { threshold: 10, height: '30%' },
  { threshold: 25, height: '45%' },
  { threshold: 45, height: '60%' },
  { threshold: 65, height: '75%' },
  { threshold: 85, height: '90%' },
]

function getBarColor(level: number, threshold: number) {
  if (!level || level < threshold) return 'bg-slate-700'
  if (threshold > 80) return 'bg-red-500'
  if (threshold > 60) return 'bg-yellow-500'
  if (threshold > 40) return 'bg-green-500'
  return 'bg-emerald-500'
}

/** Five-bar microphone input meter for the HUD microphone popover. */
export function AudioLevelMeter({ level, className = '' }: AudioLevelMeterProps) {
  return (
    <div
      className={`flex items-end justify-between gap-1.5 h-6 ${className}`}
      role="meter"
      aria-valuenow={Math.round(level)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {bars.map((bar) => (
        <div
          key={bar.threshold}
          className={`flex-1 rounded-sm transition-all duration-100 ease-out ${getBarColor(level, bar.threshold)}`}
          style={{
            height: level >= bar.threshold ? bar.height : '15%',
            opacity: level >= bar.threshold ? 1 : 0.4,
          }}
        />
      ))}
    </div>
  )
}
