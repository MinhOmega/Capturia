import { describe, expect, it, vi } from 'vitest'
import { CURSOR_KINDS } from '../../src/lib/cursor/cursorKinds'
import { getNativeCursorKind, parseCursorKindLine } from './cursorKindMonitor'

vi.mock('electron', async () => (await import('../ipc/__tests__/ipcTestKit')).createElectronMock())

describe('parseCursorKindLine', () => {
  it('accepts every kind of the widened set', () => {
    for (const kind of CURSOR_KINDS) {
      expect(parseCursorKindLine(`CURSOR_KIND ${kind}`)).toBe(kind)
    }
  })

  it('keeps reading the old helper binary (ibeam / arrow)', () => {
    expect(parseCursorKindLine('CURSOR_KIND ibeam')).toBe('text')
    expect(parseCursorKindLine('CURSOR_KIND arrow')).toBe('arrow')
    expect(parseCursorKindLine('ibeam')).toBe('text')
    expect(parseCursorKindLine('arrow')).toBe('arrow')
  })

  it('is case / whitespace tolerant and maps an unknown kind name to arrow', () => {
    expect(parseCursorKindLine('  cursor_kind   Resize-NWSE  ')).toBe('resize-nwse')
    expect(parseCursorKindLine('CURSOR_KIND something-from-a-newer-helper')).toBe('arrow')
  })

  it('ignores log lines', () => {
    expect(parseCursorKindLine('')).toBeNull()
    expect(parseCursorKindLine('[cursor-kind-monitor] starting')).toBeNull()
    expect(parseCursorKindLine('CURSOR_KIND')).toBeNull()
    expect(parseCursorKindLine('CURSOR_KIND text extra')).toBeNull()
  })

  it('defaults to arrow before any helper output', () => {
    expect(getNativeCursorKind()).toBe('arrow')
  })
})
