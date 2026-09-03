import { describe, expect, it } from 'vitest'
import {
  RECORDING_DISK_SPACE_BLOCK_BYTES,
  RECORDING_DISK_SPACE_WARN_BYTES,
  assessRecordingDiskSpace,
  formatAvailableSpace,
} from './recordingDiskSpace'

const snapshot = (availableBytes: number) => ({ success: true, availableBytes })

describe('assessRecordingDiskSpace', () => {
  it('blocks below 200 MB', () => {
    expect(assessRecordingDiskSpace(snapshot(0))).toEqual({ level: 'blocked', availableBytes: 0 })
    expect(assessRecordingDiskSpace(snapshot(RECORDING_DISK_SPACE_BLOCK_BYTES - 1))).toMatchObject({
      level: 'blocked',
    })
    // Exactly at the threshold is not blocked.
    expect(assessRecordingDiskSpace(snapshot(RECORDING_DISK_SPACE_BLOCK_BYTES))).toMatchObject({
      level: 'warn',
    })
  })

  it('warns between 200 MB and 2 GB, and is happy above', () => {
    expect(assessRecordingDiskSpace(snapshot(900 * 1024 * 1024))).toEqual({
      level: 'warn',
      availableBytes: 900 * 1024 * 1024,
    })
    expect(assessRecordingDiskSpace(snapshot(RECORDING_DISK_SPACE_WARN_BYTES - 1))).toMatchObject({
      level: 'warn',
    })
    expect(assessRecordingDiskSpace(snapshot(RECORDING_DISK_SPACE_WARN_BYTES))).toEqual({
      level: 'ok',
    })
    expect(assessRecordingDiskSpace(snapshot(64 * 1024 * 1024 * 1024))).toEqual({ level: 'ok' })
  })

  it('never blocks on a check that could not run', () => {
    expect(assessRecordingDiskSpace(undefined)).toEqual({ level: 'ok' })
    expect(assessRecordingDiskSpace(null)).toEqual({ level: 'ok' })
    expect(assessRecordingDiskSpace({ success: false, message: 'nope' })).toEqual({ level: 'ok' })
    expect(assessRecordingDiskSpace({ success: true })).toEqual({ level: 'ok' })
    expect(assessRecordingDiskSpace({ success: true, availableBytes: Number.NaN })).toEqual({
      level: 'ok',
    })
  })
})

describe('formatAvailableSpace', () => {
  it('uses MB under a gigabyte and GB above it', () => {
    expect(formatAvailableSpace(150 * 1024 * 1024)).toBe('150 MB')
    expect(formatAvailableSpace(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
    expect(formatAvailableSpace(-1)).toBe('0 MB')
  })
})
