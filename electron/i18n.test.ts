import { beforeEach, describe, expect, it } from 'vitest'
import { getMainLocale, mainT, resolveMainLocale, setMainLocale } from './i18n'

describe('electron/i18n', () => {
  beforeEach(() => {
    setMainLocale('en')
  })

  it('keeps the tray strings identical to the previous inline dictionaries', () => {
    expect(mainT('en', 'common.electron.tray.openScreen')).toBe('Capturia')
    expect(mainT('en', 'common.electron.tray.recording', { source: 'Screen 1' })).toBe(
      'Recording: Screen 1',
    )
    expect(mainT('en', 'common.electron.tray.stopRecording')).toBe('Stop Recording')
    expect(mainT('en', 'common.electron.tray.open')).toBe('Open')
    expect(mainT('en', 'common.electron.tray.quit')).toBe('Quit')
    expect(mainT('zh-CN', 'common.electron.tray.recording', { source: '屏幕' })).toBe(
      '录制中：屏幕',
    )
    expect(mainT('zh-CN', 'common.electron.tray.stopRecording')).toBe('停止录制')
    expect(mainT('zh-CN', 'common.electron.tray.open')).toBe('打开')
    expect(mainT('zh-CN', 'common.electron.tray.quit')).toBe('退出')
  })

  it('keeps the runtime-error dialog and file-dialog strings', () => {
    expect(mainT('en', 'common.electron.runtimeError.report')).toBe('Report Bug')
    expect(mainT('zh-CN', 'common.electron.runtimeError.detailPrefix')).toBe('错误编号')
    expect(mainT('en', 'common.electron.exportPathRejected')).toBe(
      'Export destination must be chosen through the save dialog',
    )
    expect(mainT('zh-CN', 'common.electron.unsupportedVideoFile')).toBe(
      '所选文件不是受支持的视频文件',
    )
    expect(mainT('zh-CN', 'common.electron.chooseExportFolder')).toBe('选择导出文件夹')
  })

  it('uses the announced locale when none is passed, and falls back to en', () => {
    setMainLocale('vi')
    expect(getMainLocale()).toBe('vi')
    expect(mainT(undefined, 'common.electron.tray.quit')).toBe('Thoát')
    // Capturia-only key without an upstream twin: partial locale falls back to en
    expect(mainT('fr', 'common.electron.exportSaved')).toBe('Video exported successfully')
    expect(mainT('fr', 'common.electron.tray.quit')).toBe('Quitter')
    expect(mainT('en', 'common.missing.key')).toBe('common.missing.key')
    expect(mainT('en', 'nokey')).toBe('nokey')
  })

  it('resolves language tags like the renderer does', () => {
    expect(resolveMainLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(resolveMainLocale('zh-TW')).toBe('zh-TW')
    expect(resolveMainLocale('vi-VN')).toBe('vi')
    expect(resolveMainLocale('pt-BR')).toBe('pt-BR')
    expect(resolveMainLocale('xx')).toBe('en')
    setMainLocale('zh-Hans')
    expect(getMainLocale()).toBe('zh-CN')
    expect(resolveMainLocale(undefined)).toBe('zh-CN')
  })
})
