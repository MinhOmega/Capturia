/** Prefix used when minting annotation ids (`annotation-1`, `annotation-2`, ...). */
export const ANNOTATION_ID_PREFIX = 'annotation-'

/** Prefix used when minting blur region ids (`blur-1`, `blur-2`, ...); they live in the annotation list. */
export const BLUR_ID_PREFIX = 'blur-'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Highest numeric suffix among ids of the form `${prefix}${n}`; 0 when none
 * match. Used after restoring a project to continue id counters past the
 * ids already in use.
 */
export function maxIdNum(items: ReadonlyArray<{ id: string }>, prefix: string): number {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`)
  return items.reduce((max, item) => {
    const match = item.id.match(pattern)
    return match ? Math.max(max, parseInt(match[1], 10)) : max
  }, 0)
}
