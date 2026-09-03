import fs from 'node:fs/promises'

/**
 * Minimal ISO-BMFF (MP4) box reader, used for exactly one question: does this
 * file have a top-level `moov` box?
 *
 * The native recorder writes `moov` when it finalizes the file. If the helper
 * is killed first — which Capturia itself does after a 15 s stop timeout — the
 * file still has an `ftyp` and a large `mdat`, so a size check says "fine" and
 * the editor then opens a video no demuxer can read. Walking the top-level
 * boxes answers it properly for a few kilobytes of I/O.
 *
 * Only the two ends of the file are read. `moov` is either near the front
 * (fragmented / faststart output) or at the very back (the normal
 * AVAssetWriter layout, after a multi-gigabyte `mdat`), and the `mdat` in
 * between is exactly what must not be read.
 *
 * Pure Node (`fs` only) so it runs under vitest without Electron; the buffer
 * scan itself takes no I/O at all.
 */

/** Bytes read from the start of the file: enough for `ftyp` plus a front `moov` header. */
export const MP4_HEAD_SCAN_BYTES = 64 * 1024
/** Bytes read from the end of the file: a `moov` for a long recording stays well inside this. */
export const MP4_TAIL_SCAN_BYTES = 8 * 1024 * 1024

/** Smallest legal box: a 32-bit size plus a four-character type. */
const BOX_HEADER_BYTES = 8
/** `size == 1` means the real size is a 64-bit `largesize` right after the type. */
const LARGE_SIZE_HEADER_BYTES = 16

export type Mp4MoovScanInput = {
  /** First bytes of the file (at most `MP4_HEAD_SCAN_BYTES`). */
  head: Uint8Array
  /** Last bytes of the file (at most `MP4_TAIL_SCAN_BYTES`). */
  tail: Uint8Array
  /** Offset of `tail` within the file. */
  tailOffset: number
  /** Total size of the file on disk. */
  fileSize: number
}

export type Mp4MoovScanReason =
  /** The file is too small to hold even one box header. */
  | 'empty'
  /** The first box header is not a plausible ISO-BMFF box. */
  | 'not-mp4'
  /** A box header runs past the end of the file: the writer was killed mid-box. */
  | 'truncated-box'
  /** Every box was walked and none of them was `moov`. */
  | 'not-found'

export type Mp4MoovScanResult = {
  hasMoov: boolean
  /** Which window the box was found in. */
  foundIn?: 'head' | 'tail'
  /** Offset of the `moov` box header within the file. */
  offset?: number
  /** Why no `moov` was found. Absent when `hasMoov` is true. */
  reason?: Mp4MoovScanReason
  /** Four-character types of the top-level boxes the head walk saw, in order. */
  topLevelTypes: string[]
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  )
}

/** 64-bit `largesize` as a JS number; MP4 sizes never approach 2^53 in practice. */
function readUint64BE(bytes: Uint8Array, offset: number): number {
  return readUint32BE(bytes, offset) * 0x100000000 + readUint32BE(bytes, offset + 4)
}

function readBoxType(bytes: Uint8Array, offset: number): string {
  let type = ''
  for (let index = offset; index < offset + 4; index += 1) type += String.fromCharCode(bytes[index])
  return type
}

/** A box type is four printable ASCII characters; anything else means we lost the framing. */
function isPlausibleBoxType(type: string): boolean {
  return /^[\x20-\x7e]{4}$/.test(type)
}

/**
 * Resolved size of the box whose header starts at `offset`, or `null` when the
 * header itself is cut short or nonsensical. `size == 0` means "to end of file",
 * which only the last box may use.
 */
function resolveBoxSize(
  bytes: Uint8Array,
  offset: number,
  absoluteOffset: number,
  fileSize: number,
): number | null {
  const size32 = readUint32BE(bytes, offset)
  if (size32 === 1) {
    if (offset + LARGE_SIZE_HEADER_BYTES > bytes.length) return null
    const large = readUint64BE(bytes, offset + BOX_HEADER_BYTES)
    return large >= LARGE_SIZE_HEADER_BYTES ? large : null
  }
  if (size32 === 0) return Math.max(0, fileSize - absoluteOffset)
  return size32 >= BOX_HEADER_BYTES ? size32 : null
}

/**
 * Walks the top-level boxes from the start of the file. `ftyp`, `mdat`, `free`
 * and `wide` need no special handling: each one is skipped by its own declared
 * size, including the 64-bit `largesize` form a long `mdat` uses.
 */
function scanHead(input: Mp4MoovScanInput): { result: Mp4MoovScanResult; complete: boolean } {
  const { head, fileSize } = input
  const topLevelTypes: string[] = []
  if (head.length < BOX_HEADER_BYTES) {
    return { result: { hasMoov: false, reason: 'empty', topLevelTypes }, complete: true }
  }

  let offset = 0
  while (offset + BOX_HEADER_BYTES <= head.length) {
    const type = readBoxType(head, offset + 4)
    if (!isPlausibleBoxType(type)) {
      return {
        result: {
          hasMoov: false,
          reason: topLevelTypes.length === 0 ? 'not-mp4' : 'truncated-box',
          topLevelTypes,
        },
        complete: true,
      }
    }
    topLevelTypes.push(type)
    if (type === 'moov') {
      return { result: { hasMoov: true, foundIn: 'head', offset, topLevelTypes }, complete: true }
    }

    const size = resolveBoxSize(head, offset, offset, fileSize)
    if (size === null) {
      return { result: { hasMoov: false, reason: 'truncated-box', topLevelTypes }, complete: true }
    }
    const next = offset + size
    if (next > fileSize) {
      // The box claims more bytes than the file holds: the writer died mid-box.
      return { result: { hasMoov: false, reason: 'truncated-box', topLevelTypes }, complete: true }
    }
    if (next === fileSize) {
      // Walked every top-level box; the answer is final and the tail cannot add one.
      return { result: { hasMoov: false, reason: 'not-found', topLevelTypes }, complete: true }
    }
    offset = next
  }

  // The walk ran out of head window with boxes still to come; the tail decides.
  return { result: { hasMoov: false, reason: 'not-found', topLevelTypes }, complete: false }
}

/**
 * Looks for a `moov` header in the tail window. The walk cannot reach here (the
 * `mdat` in between is never read), so a hit is only accepted when the four
 * bytes in front of it are a size that ends inside the file — which is what
 * tells a real box header apart from the same four letters inside media data.
 */
function scanTail(input: Mp4MoovScanInput): Mp4MoovScanResult | null {
  const { tail, tailOffset, fileSize } = input
  for (let index = 4; index + 4 <= tail.length; index += 1) {
    if (
      tail[index] !== 0x6d /* m */ ||
      tail[index + 1] !== 0x6f /* o */ ||
      tail[index + 2] !== 0x6f /* o */ ||
      tail[index + 3] !== 0x76 /* v */
    ) {
      continue
    }
    const headerOffset = index - 4
    const absoluteOffset = tailOffset + headerOffset
    const size = resolveBoxSize(tail, headerOffset, absoluteOffset, fileSize)
    if (size === null) continue
    if (absoluteOffset + size > fileSize) continue
    return { hasMoov: true, foundIn: 'tail', offset: absoluteOffset, topLevelTypes: [] }
  }
  return null
}

/**
 * Does this file carry a top-level `moov` box? Head walk first (it is exact),
 * then the tail heuristic for the usual "moov after a huge mdat" layout.
 */
export function scanMp4ForMoov(input: Mp4MoovScanInput): Mp4MoovScanResult {
  const { result, complete } = scanHead(input)
  if (result.hasMoov || complete) return result

  const tailResult = scanTail(input)
  if (tailResult) return { ...tailResult, topLevelTypes: result.topLevelTypes }
  return result
}

async function readWindow(
  handle: fs.FileHandle,
  position: number,
  length: number,
): Promise<Uint8Array> {
  if (length <= 0) return new Uint8Array(0)
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return buffer.subarray(0, filled)
}

/**
 * Reads the two windows and answers the same question for a file on disk.
 * A file that cannot be opened or stat-ed answers "no `moov`" rather than
 * throwing: the caller is already on an error path.
 */
export async function fileHasMp4MoovBox(filePath: string): Promise<Mp4MoovScanResult> {
  let handle: fs.FileHandle | null = null
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size < BOX_HEADER_BYTES) {
      return { hasMoov: false, reason: 'empty', topLevelTypes: [] }
    }
    handle = await fs.open(filePath, 'r')
    const head = await readWindow(handle, 0, Math.min(MP4_HEAD_SCAN_BYTES, stat.size))
    const tailLength = Math.min(MP4_TAIL_SCAN_BYTES, stat.size)
    const tailOffset = stat.size - tailLength
    const tail = await readWindow(handle, tailOffset, tailLength)
    return scanMp4ForMoov({ head, tail, tailOffset, fileSize: stat.size })
  } catch {
    return { hasMoov: false, reason: 'empty', topLevelTypes: [] }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
