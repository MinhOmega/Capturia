import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { fixParsedWebmDuration } from '@fix-webm-duration/fix'
import { WebmFile } from '@fix-webm-duration/parser'

export type DurationPatchResult =
  | { patched: true }
  | { patched: false; reason: 'no-section' | 'already-valid' | 'io-error' | 'internal' }

/** Suffix of the scratch file written next to the recording while patching. */
export const DURATION_PATCH_TEMP_SUFFIX = '.duration-patch.tmp'

// Read 2MB from the start of the file. Headers for WebM recordings are typically well under 100KB.
const HEADER_CHUNK_SIZE = 2 * 1024 * 1024

const EBML_ID_SEGMENT = 0x8538067
const EBML_ID_INFO = 0x549a966
const EBML_ID_CLUSTER = 0xf43b675

interface WebmContainerShape {
  start: number
  isInfinite?: boolean
  data: { id: number; data: unknown }[]
  getSectionById?: (id: number) => unknown
}

/**
 * Patch the WebM Duration header on a finalized recording file.
 *
 * MediaRecorder writes WebM with no Duration EBML element. When the recording was
 * streamed to disk the renderer never held the whole blob, so the fix has to happen
 * here on the file.
 *
 * Rather than reading the entire multi-gigabyte file into memory (which crashes
 * the main process on long recordings), read only the first 2MB chunk containing
 * the metadata headers, patch the Info section, and stream the remaining clusters
 * from the original file using Node streams. Files under 2MB and files whose
 * header chunk has no Cluster fall back to the whole-file in-memory patch.
 */
export async function patchWebmDurationOnDisk(
  filePath: string,
  durationMs: number,
): Promise<DurationPatchResult> {
  let fileHandle: fs.FileHandle | null = null
  const tmpPath = `${filePath}${DURATION_PATCH_TEMP_SUFFIX}`
  try {
    const stat = await fs.stat(filePath)
    if (stat.size < HEADER_CHUNK_SIZE) {
      return await patchWebmDurationInMemory(filePath, durationMs)
    }

    fileHandle = await fs.open(filePath, 'r')
    const buffer = Buffer.alloc(HEADER_CHUNK_SIZE)
    const { bytesRead } = await fileHandle.read(buffer, 0, HEADER_CHUNK_SIZE, 0)
    await fileHandle.close()
    fileHandle = null

    const chunk = buffer.subarray(0, bytesRead)
    const webm = new WebmFile(new Uint8Array(chunk))

    if (!webm.data || !webm.source) {
      console.warn(
        `[webm-duration] Segment data or source is missing in chunk for ${filePath}; falling back to whole-file`,
      )
      return await patchWebmDurationInMemory(filePath, durationMs)
    }

    const segmentSec = webm.data.find((sec) => sec.id === EBML_ID_SEGMENT)
    if (!segmentSec || !segmentSec.data) {
      console.warn(
        `[webm-duration] Segment section is missing in chunk for ${filePath}; falling back to whole-file`,
      )
      return await patchWebmDurationInMemory(filePath, durationMs)
    }

    const segment = segmentSec.data as WebmContainerShape
    const info = segment.getSectionById?.(EBML_ID_INFO)
    if (!info) {
      console.warn(
        `[webm-duration] Info section is missing in chunk for ${filePath}; falling back to whole-file`,
      )
      return await patchWebmDurationInMemory(filePath, durationMs)
    }

    // Start of the Segment payload, following EBML VINT length rules for the id and size.
    const segmentStart = segment.start
    const idByte = webm.source[segmentStart]
    const idLen = 9 - idByte.toString(2).length
    const lenByte = webm.source[segmentStart + idLen]
    const lenLen = 9 - lenByte.toString(2).length
    const segmentPayloadStart = segmentStart + idLen + lenLen

    const segmentData = segment.data
    const clusterIdx = segmentData.findIndex((sec) => sec.id === EBML_ID_CLUSTER)
    if (clusterIdx === -1) {
      console.warn(
        `[webm-duration] No Cluster section found in header chunk for ${filePath}; falling back to whole-file`,
      )
      return await patchWebmDurationInMemory(filePath, durationMs)
    }

    const clusterSec = segmentData[clusterIdx]
    const clusterData = clusterSec.data as { start: number }
    const clusterOffset = segmentPayloadStart + clusterData.start

    // Drop the Cluster and everything after it so updateByData() only regenerates the
    // metadata headers; the clusters are appended from the original file below.
    segment.data = segmentData.slice(0, clusterIdx)

    // The Segment size was either unknown (-1) or the original file size. An unknown
    // size is valid for a live-written Segment, so keep it unknown after the patch.
    segment.isInfinite = true

    const patched = fixParsedWebmDuration(webm, durationMs, { logger: false })
    if (!patched) {
      return { patched: false, reason: inferUnpatchedReason(webm) }
    }

    if (!webm.source) {
      console.error(`[webm-duration] patched but source missing for ${filePath}`)
      return { patched: false, reason: 'internal' }
    }

    const patchedBytes = Buffer.from(
      webm.source.buffer,
      webm.source.byteOffset,
      webm.source.byteLength,
    )

    const ws = createWriteStream(tmpPath)
    const rs = createReadStream(filePath, { start: clusterOffset })
    try {
      await new Promise<void>((resolve, reject) => {
        ws.write(patchedBytes, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      await pipeline(rs, ws)
    } finally {
      rs.destroy()
      ws.destroy()
    }

    await fs.rename(tmpPath, filePath)
    return { patched: true }
  } catch (error) {
    console.error(`[webm-duration] failed to patch ${filePath} using optimized method:`, error)
    if (fileHandle) {
      await fileHandle.close().catch(() => undefined)
    }
    await fs.unlink(tmpPath).catch(() => undefined)
    return { patched: false, reason: 'io-error' }
  }
}

async function patchWebmDurationInMemory(
  filePath: string,
  durationMs: number,
): Promise<DurationPatchResult> {
  const tmpPath = `${filePath}${DURATION_PATCH_TEMP_SUFFIX}`
  try {
    const fileBytes = await fs.readFile(filePath)
    const webm = new WebmFile(new Uint8Array(fileBytes))

    const patched = fixParsedWebmDuration(webm, durationMs, { logger: false })
    if (!patched) {
      const reason = inferUnpatchedReason(webm)
      if (reason === 'no-section') {
        console.warn(
          `[webm-duration] no Segment/Info section in ${filePath}; file may be truncated`,
        )
      }
      return { patched: false, reason }
    }

    if (!webm.source) {
      console.error(`[webm-duration] patched but source missing for ${filePath}`)
      return { patched: false, reason: 'internal' }
    }

    const patchedBytes = Buffer.from(
      webm.source.buffer,
      webm.source.byteOffset,
      webm.source.byteLength,
    )
    try {
      await fs.writeFile(tmpPath, patchedBytes)
      await fs.rename(tmpPath, filePath)
      return { patched: true }
    } catch (writeError) {
      console.error(`[webm-duration] failed to write patched ${filePath}:`, writeError)
      await fs.unlink(tmpPath).catch(() => undefined)
      return { patched: false, reason: 'io-error' }
    }
  } catch (error) {
    console.error(`[webm-duration] failed to patch ${filePath} in memory:`, error)
    return { patched: false, reason: 'io-error' }
  }
}

/**
 * Distinguish "no Segment/Info section" (malformed/truncated file) from "Info present
 * but Duration already valid" (patch unnecessary).
 */
function inferUnpatchedReason(webm: WebmFile): 'no-section' | 'already-valid' {
  const segment = webm.getSectionById?.(EBML_ID_SEGMENT)
  if (!segment) return 'no-section'
  const info = (segment as unknown as WebmContainerShape).getSectionById?.(EBML_ID_INFO)
  return info ? 'already-valid' : 'no-section'
}
