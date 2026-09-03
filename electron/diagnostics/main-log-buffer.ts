/**
 * Ring buffer for main-process console output.
 *
 * Captures the last `capacity` lines written via console.log / info / warn /
 * error into one in-memory buffer so a diagnostic report or a bug-report URL
 * can carry the tail of what main was doing. Capturia installs it always at a
 * low capacity (see main.ts); `CAPTURIA_DIAGNOSTIC=1` raises it for a more
 * complete "Save diagnostics" payload.
 *
 * Cost when installed: one array push + occasional splice per console call.
 */

const DEFAULT_CAPACITY = 500

export interface MainLogEntry {
  timestampMs: number
  level: 'info' | 'warn' | 'error' | 'log'
  text: string
}

type ConsoleLevel = MainLogEntry['level']
type ConsoleFn = (...args: unknown[]) => void

const LEVELS: readonly ConsoleLevel[] = ['log', 'info', 'warn', 'error']

export class MainLogBuffer {
  private readonly capacity: number
  private readonly entries: MainLogEntry[] = []
  private installed = false
  private readonly originals: Partial<Record<ConsoleLevel, ConsoleFn>> = {}

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, capacity)
  }

  install(): void {
    if (this.installed) return
    this.installed = true
    const console_ = console as unknown as Record<ConsoleLevel, ConsoleFn>
    for (const level of LEVELS) {
      this.originals[level] = console_[level].bind(console)
      console_[level] = (...args: unknown[]) => {
        this.push(level, args)
        this.originals[level]?.(...args)
      }
    }
  }

  uninstall(): void {
    if (!this.installed) return
    this.installed = false
    const console_ = console as unknown as Record<ConsoleLevel, ConsoleFn>
    for (const level of LEVELS) {
      const original = this.originals[level]
      if (original) console_[level] = original
      this.originals[level] = undefined
    }
  }

  snapshot(): MainLogEntry[] {
    return this.entries.slice()
  }

  /** Last `count` entries rendered as `HH:MM:SS.mmm LEVEL text` lines. */
  tail(count: number): string[] {
    const start = Math.max(0, this.entries.length - Math.max(0, count))
    return this.entries.slice(start).map(formatMainLogEntry)
  }

  clear(): void {
    this.entries.length = 0
  }

  private push(level: ConsoleLevel, args: unknown[]): void {
    const text = args
      .map((arg) => {
        if (typeof arg === 'string') return arg
        if (arg instanceof Error) return arg.stack || arg.message
        try {
          return JSON.stringify(arg)
        } catch {
          return String(arg)
        }
      })
      .join(' ')
    this.entries.push({ timestampMs: Date.now(), level, text })
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity)
    }
  }
}

export function formatMainLogEntry(entry: MainLogEntry): string {
  const time = new Date(entry.timestampMs).toISOString().slice(11, 23)
  return `${time} ${entry.level.toUpperCase().padEnd(5)} ${entry.text}`
}

export function isDiagnosticModeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.CAPTURIA_DIAGNOSTIC
  if (!raw) return false
  const lowered = raw.trim().toLowerCase()
  return lowered === '1' || lowered === 'true' || lowered === 'yes'
}

/** Lines kept when diagnostic mode is off: enough for an issue body, cheap to hold. */
export const LOW_CAPACITY = 200

export const mainLogBuffer = new MainLogBuffer(
  isDiagnosticModeEnabled() ? DEFAULT_CAPACITY : LOW_CAPACITY,
)
