import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  backoffMs,
  captionModelDir,
  type CaptionModelDescriptor,
  downloadCaptionModel,
  getCaptionModelStatus,
  modelFileUrl,
  registerCaptionHandlers,
  resolveSidecarVideoPath,
  WHISPER_TINY_MODEL,
} from './captionHandlers'
import { approvedReadPaths } from './paths'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function fakeIpcMain() {
  const handlers = new Map<string, Handler>()
  const event = { sender: { isDestroyed: () => false, send: vi.fn() } } as unknown as IpcMainInvokeEvent
  return {
    ipcMain: {
      handle: (channel: string, handler: Handler) => {
        handlers.set(channel, handler)
      },
    },
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`no handler for ${channel}`)
      return handler(event, ...args)
    },
    handlers,
  }
}

/** `Response` accepts a Uint8Array at runtime; the DOM lib typing is stricter than Node's. */
function asBody(data: Uint8Array): BodyInit {
  return data as unknown as BodyInit
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Serves each file from a map; supports Range, and a scripted status sequence per URL. */
function fakeFetch(
  files: Record<string, Uint8Array>,
  scripted: Record<string, number[]> = {},
  options: { honorRange?: boolean } = {},
): { fetcher: typeof fetch; calls: Array<{ url: string; range?: string }> } {
  const calls: Array<{ url: string; range?: string }> = []
  const honorRange = options.honorRange ?? true
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, range: headers.range })
    const queue = scripted[url]
    if (queue && queue.length > 0) {
      const status = queue.shift()!
      if (status !== 200) {
        return new Response('nope', { status, headers: status === 429 ? { 'retry-after': '0' } : {} })
      }
    }
    const body = files[url]
    if (!body) return new Response('missing', { status: 404 })
    const range = headers.range ? /^bytes=(\d+)-$/.exec(headers.range) : null
    if (range && honorRange) {
      const from = Number(range[1])
      return new Response(asBody(body.slice(from)), { status: 206 })
    }
    return new Response(asBody(body), { status: 200 })
  }) as typeof fetch
  return { fetcher, calls }
}

const noBackoff = () => 0

let userDataDir: string
let recordingsDir: string

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(os.tmpdir(), 'capturia-captions-'))
  recordingsDir = path.join(userDataDir, 'recordings')
  await mkdir(recordingsDir, { recursive: true })
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

function tinyModel(contents: Record<string, string>, withDigest = true): { model: CaptionModelDescriptor; files: Record<string, Uint8Array> } {
  const model: CaptionModelDescriptor = {
    id: 'Test/tiny',
    revision: 'main',
    files: Object.entries(contents).map(([name, text]) => ({
      name,
      approximateBytes: text.length,
      expectedSha256: withDigest ? sha256Hex(bytes(text)) : null,
    })),
  }
  const files: Record<string, Uint8Array> = {}
  for (const file of model.files) files[modelFileUrl(model, file)] = bytes(contents[file.name]!)
  return { model, files }
}

describe('caption model status + download', () => {
  it('reports missing files, downloads them with progress and then reports present', async () => {
    const { model, files } = tinyModel({ 'config.json': '{"a":1}', 'onnx/encoder.onnx': 'ENCODER-BYTES' })
    const { fetcher, calls } = fakeFetch(files)

    const before = await getCaptionModelStatus(userDataDir, model)
    expect(before.present).toBe(false)
    expect(before.missingFiles).toEqual(['config.json', 'onnx/encoder.onnx'])
    expect(before.dir).toBe(path.join(userDataDir, 'caption-models'))

    const progress: number[] = []
    await downloadCaptionModel({
      userDataDir,
      model,
      fetcher,
      backoff: noBackoff,
      onProgress: (p) => progress.push(p.downloadedBytes),
    })

    const after = await getCaptionModelStatus(userDataDir, model)
    expect(after.present).toBe(true)
    expect(after.downloadedBytes).toBe(before.totalBytes)
    expect(progress[progress.length - 1]).toBe(before.totalBytes)
    expect(calls.map((c) => c.url)).toEqual(Object.keys(files))
    const dir = captionModelDir(userDataDir, model)
    expect(await readFile(path.join(dir, 'onnx/encoder.onnx'), 'utf-8')).toBe('ENCODER-BYTES')
    expect(dir).toBe(path.join(userDataDir, 'caption-models', 'Test', 'tiny'))
  })

  it('skips files already on disk and resumes a .partial with a Range request', async () => {
    const { model, files } = tinyModel({ 'a.json': 'AAAA', 'b.bin': '0123456789' }, false)
    const dir = captionModelDir(userDataDir, model)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'a.json'), 'AAAA')
    await writeFile(path.join(dir, 'b.bin.partial'), '0123')
    const { fetcher, calls } = fakeFetch(files)

    await downloadCaptionModel({ userDataDir, model, fetcher, backoff: noBackoff })

    expect(calls).toEqual([{ url: modelFileUrl(model, model.files[1]!), range: 'bytes=4-' }])
    expect(await readFile(path.join(dir, 'b.bin'), 'utf-8')).toBe('0123456789')
  })

  it('restarts from zero when the server ignores the Range request', async () => {
    const { model, files } = tinyModel({ 'b.bin': '0123456789' }, false)
    const dir = captionModelDir(userDataDir, model)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'b.bin.partial'), 'garbage')
    const { fetcher } = fakeFetch(files, {}, { honorRange: false })

    await downloadCaptionModel({ userDataDir, model, fetcher, backoff: noBackoff })
    expect(await readFile(path.join(dir, 'b.bin'), 'utf-8')).toBe('0123456789')
  })

  it('retries on 429/503 with backoff and fails fast on 404', async () => {
    const { model, files } = tinyModel({ 'a.json': 'AAAA' }, false)
    const url = modelFileUrl(model, model.files[0]!)
    const { fetcher, calls } = fakeFetch(files, { [url]: [429, 503, 200] })
    const backoff = vi.fn(() => 0)

    await downloadCaptionModel({ userDataDir, model, fetcher, backoff })
    expect(calls).toHaveLength(3)
    expect(backoff).toHaveBeenCalledTimes(2)
    expect(backoff).toHaveBeenNthCalledWith(1, 1, '0')

    const missing = tinyModel({ 'zzz.json': 'x' }, false)
    const notFound = fakeFetch({})
    await expect(
      downloadCaptionModel({ userDataDir, model: missing.model, fetcher: notFound.fetcher, backoff: noBackoff }),
    ).rejects.toThrow(/HTTP 404/)
    expect(notFound.calls).toHaveLength(1)
  })

  it('rejects a corrupted download and leaves no file behind', async () => {
    const { model, files } = tinyModel({ 'a.json': 'GOOD' })
    files[modelFileUrl(model, model.files[0]!)] = bytes('EVIL')
    const { fetcher } = fakeFetch(files)

    await expect(downloadCaptionModel({ userDataDir, model, fetcher, backoff: noBackoff })).rejects.toThrow(/Checksum mismatch/)
    expect((await getCaptionModelStatus(userDataDir, model)).present).toBe(false)
  })

  it('can be cancelled mid-way', async () => {
    const { model } = tinyModel({ 'a.json': 'AAAA' }, false)
    const controller = new AbortController()
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(bytes('AA'))
          controller.abort()
          init?.signal?.addEventListener('abort', () => ctrl.error(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        },
      })
      return new Response(stream, { status: 200 })
    }) as typeof fetch

    await expect(
      downloadCaptionModel({ userDataDir, model, fetcher, backoff: noBackoff, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect((await getCaptionModelStatus(userDataDir, model)).present).toBe(false)
  })

  it('exposes the pinned whisper-tiny file list', () => {
    expect(WHISPER_TINY_MODEL.id).toBe('Xenova/whisper-tiny')
    expect(WHISPER_TINY_MODEL.files.map((f) => f.name)).toContain('onnx/decoder_model_merged_quantized.onnx')
    expect(modelFileUrl(WHISPER_TINY_MODEL, WHISPER_TINY_MODEL.files[0]!)).toBe(
      'https://huggingface.co/Xenova/whisper-tiny/resolve/main/config.json',
    )
  })
})

describe('backoffMs', () => {
  it('honours Retry-After seconds and grows exponentially otherwise', () => {
    expect(backoffMs(1, '3')).toBe(3_000)
    expect(backoffMs(1, null, () => 0)).toBe(2_000)
    expect(backoffMs(3, null, () => 0)).toBe(8_000)
    expect(backoffMs(9, null, () => 0)).toBe(60_000)
  })
})

describe('registerCaptionHandlers', () => {
  it('registers the channels and answers status/dir', async () => {
    const { ipcMain, invoke, handlers } = fakeIpcMain()
    registerCaptionHandlers({ ipcMain, recordingsDir, userDataDir })

    expect([...handlers.keys()].sort()).toEqual([
      'analysis-save-sidecar',
      'caption-model-dir',
      'caption-model-download',
      'caption-model-download-cancel',
      'caption-model-status',
    ])
    expect(await invoke('caption-model-dir')).toEqual({ success: true, dir: path.join(userDataDir, 'caption-models') })
    const status = (await invoke('caption-model-status')) as { success: boolean; status: { modelId: string; present: boolean } }
    expect(status.success).toBe(true)
    expect(status.status.modelId).toBe('Xenova/whisper-tiny')
    expect(status.status.present).toBe(false)
    expect(await invoke('caption-model-status', 'Nope/model')).toMatchObject({ success: false })
    expect(await invoke('caption-model-download-cancel')).toEqual({ success: false })
  })

  it('writes the sidecar only for approved video paths and well-formed payloads', async () => {
    const { ipcMain, invoke } = fakeIpcMain()
    registerCaptionHandlers({ ipcMain, recordingsDir, userDataDir })
    const videoPath = path.join(recordingsDir, 'rec.mp4')
    await writeFile(videoPath, 'x')
    const analysis = {
      transcript: { locale: 'en-US', text: 'hi', words: [{ text: 'hi', startMs: 0, endMs: 100, synthetic: true, phraseIndex: 0 }], createdAtMs: 1 },
      subtitleCues: [],
      roughCutSuggestions: [],
    }

    const ok = (await invoke('analysis-save-sidecar', videoPath, analysis)) as { success: boolean; path?: string }
    expect(ok.success).toBe(true)
    expect(ok.path).toBe(path.join(recordingsDir, 'rec.analysis.json'))
    const written = JSON.parse(await readFile(ok.path!, 'utf-8'))
    expect(written).toEqual({ version: 1, analysis })

    expect(await invoke('analysis-save-sidecar', videoPath, { transcript: {} })).toMatchObject({ success: false })
    const outside = path.join(userDataDir, 'elsewhere.mp4')
    expect(await invoke('analysis-save-sidecar', outside, analysis)).toMatchObject({ success: false })
    expect(await invoke('analysis-save-sidecar', path.join(recordingsDir, 'notes.txt'), analysis)).toMatchObject({ success: false })
  })

  it('resolveSidecarVideoPath accepts explicitly approved paths outside the recordings dir', () => {
    const imported = path.join(userDataDir, 'imported.mov')
    expect(resolveSidecarVideoPath(imported, recordingsDir)).toBeNull()
    approvedReadPaths.approveFile(imported)
    try {
      expect(resolveSidecarVideoPath(imported, recordingsDir)).toBe(imported)
    } finally {
      approvedReadPaths.clear()
    }
  })
})
