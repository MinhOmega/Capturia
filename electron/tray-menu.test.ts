import { describe, expect, it, vi } from 'vitest'
import { buildTrayMenuTemplate, type TrayMenuActions, trayMenuItemIds } from './tray-menu'

const labels = {
  stopRecording: 'Stop Recording',
  open: 'Open',
  checkForUpdates: 'Check for Updates…',
  about: 'About Capturia',
  saveDiagnostics: 'Save Diagnostics…',
  quit: 'Quit',
}

function actions(): TrayMenuActions {
  return {
    stopRecording: vi.fn(),
    open: vi.fn(),
    checkForUpdates: vi.fn(),
    about: vi.fn(),
    saveDiagnostics: vi.fn(),
    quit: vi.fn(),
  }
}

describe('buildTrayMenuTemplate', () => {
  it('holds only Stop Recording while recording, whatever the channel offers', () => {
    const acts = actions()
    const template = buildTrayMenuTemplate({
      recording: true,
      offersUpdateCheck: true,
      nativeAboutPanel: false,
      labels,
      actions: acts,
    })
    expect(trayMenuItemIds(template)).toEqual(['stop-recording'])
    expect(template[0].label).toBe('Stop Recording')
    ;(template[0].click as () => void)()
    expect(acts.stopRecording).toHaveBeenCalledTimes(1)
  })

  it('carries Open, Check for Updates, About, Save Diagnostics and Quit when idle', () => {
    const acts = actions()
    const template = buildTrayMenuTemplate({
      recording: false,
      offersUpdateCheck: true,
      nativeAboutPanel: false,
      labels,
      actions: acts,
    })
    expect(trayMenuItemIds(template)).toEqual([
      'open',
      'check-for-updates',
      'about',
      'save-diagnostics',
      'quit',
    ])
    expect(template.some((item) => item.type === 'separator')).toBe(true)
    for (const item of template) {
      if (typeof item.click === 'function') (item.click as () => void)()
    }
    expect(acts.open).toHaveBeenCalledTimes(1)
    expect(acts.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(acts.about).toHaveBeenCalledTimes(1)
    expect(acts.saveDiagnostics).toHaveBeenCalledTimes(1)
    expect(acts.quit).toHaveBeenCalledTimes(1)
    expect(acts.stopRecording).not.toHaveBeenCalled()
  })

  it('omits Check for Updates entirely when the install cannot offer one', () => {
    const template = buildTrayMenuTemplate({
      recording: false,
      offersUpdateCheck: false,
      nativeAboutPanel: false,
      labels,
      actions: actions(),
    })
    expect(trayMenuItemIds(template)).toEqual(['open', 'about', 'save-diagnostics', 'quit'])
    expect(template.map((item) => item.label)).not.toContain(labels.checkForUpdates)
  })

  it('uses the native About role on macOS and a click handler elsewhere', () => {
    const acts = actions()
    const mac = buildTrayMenuTemplate({
      recording: false,
      offersUpdateCheck: false,
      nativeAboutPanel: true,
      labels,
      actions: acts,
    })
    const about = mac.find((item) => item.id === 'about')
    expect(about?.role).toBe('about')
    expect(about?.click).toBeUndefined()

    const other = buildTrayMenuTemplate({
      recording: false,
      offersUpdateCheck: false,
      nativeAboutPanel: false,
      labels,
      actions: acts,
    })
    const aboutOther = other.find((item) => item.id === 'about')
    if (!aboutOther) throw new Error('about item missing')
    expect(aboutOther.role).toBeUndefined()
    ;(aboutOther.click as () => void)()
    expect(acts.about).toHaveBeenCalledTimes(1)
  })

  it('keeps every label localisable through the labels object', () => {
    const template = buildTrayMenuTemplate({
      recording: false,
      offersUpdateCheck: true,
      nativeAboutPanel: false,
      labels: { ...labels, open: 'Mở', quit: 'Thoát' },
      actions: actions(),
    })
    expect(template.find((item) => item.id === 'open')?.label).toBe('Mở')
    expect(template.find((item) => item.id === 'quit')?.label).toBe('Thoát')
  })
})
