// Renderer reload / DevTools detach routinely produces EPIPE (and friends) on
// in-flight IPC replies. That is churn, not a bug: keep it out of the runtime
// error dialog. Capturia's runtime-error reporter is dialog-based, so this
// module only supplies the predicate that reporter consults.

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
