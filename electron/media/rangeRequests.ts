/**
 * `Range: bytes=...` parsing for the `local-media://` handler.
 *
 * The editor's `<video>` and the exporter's decoder both seek by asking for
 * byte ranges, and the previous handler understood exactly one shape,
 * `bytes=<a>-<b?>`, with no clamping: an open-ended `bytes=<a>-` allocated
 * everything from `a` to the end of the file in one Buffer, and an end past the
 * end of the file allocated past the end of the file. On a 500 MB recording
 * that is a 500 MB allocation in the main process for a request that only had
 * to move the playhead.
 *
 * What RFC 9110 §14 asks for, and what this implements:
 *
 *  - `bytes=a-b`, `bytes=a-` and `bytes=-n` (a suffix length) are understood;
 *  - the last byte position is clamped to `size - 1`;
 *  - a first byte position at or past the end is *unsatisfiable* → 416 with
 *    `Content-Range: bytes * /size`;
 *  - anything else — another unit, a multi-range request, a reversed or
 *    unparsable spec — is ignored, and ignoring a Range header means serving
 *    the whole representation with 200. That is a legal answer to every range
 *    request, so an unusual client degrades to working rather than to an error.
 */

export type RangeRequest =
  /** No usable `Range` header: answer 200 with the whole file. */
  | { readonly kind: 'full' }
  /** Answer 206 with `[start, end]` inclusive. */
  | {
      readonly kind: 'partial'
      readonly start: number
      readonly end: number
      readonly length: number
    }
  /** Answer 416; the client asked past the end of the file. */
  | { readonly kind: 'unsatisfiable' }

const BYTES_RANGE = /^bytes=(\d*)-(\d*)$/

/**
 * Decide what to serve for `rangeHeader` against a file of `size` bytes.
 * `size` is the real file size; a zero-length file makes every range
 * unsatisfiable.
 */
export function parseRangeHeader(
  rangeHeader: string | null | undefined,
  size: number,
): RangeRequest {
  if (!rangeHeader) return { kind: 'full' }
  if (!Number.isFinite(size) || size < 0) return { kind: 'full' }

  const match = BYTES_RANGE.exec(rangeHeader.trim())
  if (!match) return { kind: 'full' }

  const [, rawFirst, rawLast] = match
  if (rawFirst === '' && rawLast === '') return { kind: 'full' }

  if (rawFirst === '') {
    // `bytes=-n`: the last n bytes.
    const suffixLength = Number.parseInt(rawLast, 10)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { kind: 'unsatisfiable' }
    if (size === 0) return { kind: 'unsatisfiable' }
    const start = Math.max(0, size - suffixLength)
    return { kind: 'partial', start, end: size - 1, length: size - start }
  }

  const start = Number.parseInt(rawFirst, 10)
  if (!Number.isFinite(start)) return { kind: 'full' }
  if (start >= size) return { kind: 'unsatisfiable' }

  if (rawLast === '') {
    // `bytes=a-`: to the end of the file.
    return { kind: 'partial', start, end: size - 1, length: size - start }
  }

  const requestedEnd = Number.parseInt(rawLast, 10)
  if (!Number.isFinite(requestedEnd)) return { kind: 'full' }
  // A reversed spec is invalid, and an invalid spec means: ignore the header.
  if (requestedEnd < start) return { kind: 'full' }

  const end = Math.min(requestedEnd, size - 1)
  return { kind: 'partial', start, end, length: end - start + 1 }
}

/** `Content-Range` for a 206 response. */
export function contentRangeHeader(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`
}

/** `Content-Range` for a 416 response. */
export function unsatisfiableContentRangeHeader(size: number): string {
  return `bytes */${size}`
}
