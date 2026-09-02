// Renderer reload / DevTools detach routinely produces EPIPE (and friends) on
// in-flight IPC replies. That is churn, not a bug: keep it out of the runtime
// error dialog. Ported from upstream `electron/main-process-errors.ts`; Capturia
// keeps its own dialog-based reporter, so only the filter is used here.

const SWALLOWED_ERROR_CODES: ReadonlySet<string> = new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
])

export function shouldSwallowMainProcessError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code !== undefined && SWALLOWED_ERROR_CODES.has(code)
}
