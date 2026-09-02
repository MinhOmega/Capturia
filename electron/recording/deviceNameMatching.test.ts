import { describe, expect, it } from 'vitest'
import {
  DEVICE_NAME_MATCH_EXACT,
  DEVICE_NAME_MATCH_EXACT_WITHOUT_USB_IDS,
  DEVICE_NAME_MATCH_IDENTIFIER,
  DEVICE_NAME_MATCH_WORDS,
  DEVICE_NAME_NO_MATCH,
  containsAsWords,
  normalizeDeviceName,
  pickDeviceByName,
  scoreDeviceNameMatch,
  stripUsbIdSuffix,
} from './deviceNameMatching'

describe('normalizeDeviceName', () => {
  it('reduces punctuation and case to single-spaced lowercase', () => {
    expect(normalizeDeviceName('Camera (NVIDIA Broadcast)')).toBe('camera nvidia broadcast')
    expect(normalizeDeviceName('Logitech StreamCam (046d:0893)')).toBe(
      'logitech streamcam 046d 0893',
    )
    expect(normalizeDeviceName('  MacBook Pro Microphone ')).toBe('macbook pro microphone')
  })

  it('keeps non-Latin letters and combining marks', () => {
    expect(normalizeDeviceName('カメラ A')).toBe('カメラ a')
    expect(normalizeDeviceName('Micro (Việt Nam)')).toBe('micro việt nam')
    // Decomposed form: the combining mark must not become a word boundary.
    expect(normalizeDeviceName('Việt')).toBe('việt')
  })
})

describe('stripUsbIdSuffix', () => {
  it('drops the Chromium vendor:product pair only', () => {
    expect(stripUsbIdSuffix('Logitech StreamCam (046d:0893)')).toBe('Logitech StreamCam')
    expect(stripUsbIdSuffix('Logitech StreamCam (046D:0893) ')).toBe('Logitech StreamCam')
    expect(stripUsbIdSuffix('FaceTime HD Camera (Built-in)')).toBe('FaceTime HD Camera (Built-in)')
  })
})

describe('containsAsWords', () => {
  it('only accepts matches on word boundaries', () => {
    expect(containsAsWords('logitech streamcam 046d 0893', 'logitech streamcam')).toBe(true)
    expect(containsAsWords('logitech streamcam', 'logi')).toBe(false)
    expect(containsAsWords('microphone logitech pro x', 'micro')).toBe(false)
    expect(containsAsWords('', 'x')).toBe(false)
    expect(containsAsWords('x', '')).toBe(false)
  })
})

describe('scoreDeviceNameMatch', () => {
  it('scores an exact name highest', () => {
    expect(
      scoreDeviceNameMatch('Camera (NVIDIA Broadcast)', '{clsid}', 'Camera (NVIDIA Broadcast)'),
    ).toBe(DEVICE_NAME_MATCH_EXACT)
  })

  it('prefers the exact name once the USB ids are stripped over a word match', () => {
    expect(
      scoreDeviceNameMatch('Logitech StreamCam', 'uid', 'Logitech StreamCam (046d:0893)'),
    ).toBe(DEVICE_NAME_MATCH_EXACT_WITHOUT_USB_IDS)
  })

  it('matches when either name is the other plus decoration, as whole words', () => {
    expect(scoreDeviceNameMatch('Logitech HD Pro Webcam C920', 'uid', 'HD Pro Webcam C920')).toBe(
      DEVICE_NAME_MATCH_WORDS,
    )
    expect(
      scoreDeviceNameMatch('MacBook Pro Microphone', 'uid', 'MacBook Pro Microphone (Built-in)'),
    ).toBe(DEVICE_NAME_MATCH_WORDS)
  })

  it('refuses a word that is merely inside another word', () => {
    expect(scoreDeviceNameMatch('Logitech StreamCam', 'uid', 'Logi Capture')).toBe(
      DEVICE_NAME_NO_MATCH,
    )
    expect(scoreDeviceNameMatch('Microphone (Logitech PRO X)', 'uid', 'Micro Studio')).toBe(
      DEVICE_NAME_NO_MATCH,
    )
    expect(scoreDeviceNameMatch('Microphone (Logitech StreamCam)', 'uid', 'Micro')).toBe(
      DEVICE_NAME_NO_MATCH,
    )
    expect(scoreDeviceNameMatch('Logitech StreamCam', 'uid', 'Logi')).toBe(DEVICE_NAME_NO_MATCH)
  })

  it('refuses a partial match on a shared brand', () => {
    expect(scoreDeviceNameMatch('Logitech StreamCam', 'uid', 'Logitech BRIO')).toBe(
      DEVICE_NAME_NO_MATCH,
    )
  })

  it('scores nothing when no name was requested', () => {
    expect(scoreDeviceNameMatch('Logitech StreamCam', 'uid', undefined)).toBe(DEVICE_NAME_NO_MATCH)
    expect(scoreDeviceNameMatch('Logitech StreamCam', 'uid', null)).toBe(DEVICE_NAME_NO_MATCH)
    expect(scoreDeviceNameMatch('Logitech StreamCam', 'uid', '   ')).toBe(DEVICE_NAME_NO_MATCH)
  })

  it('keeps non-Latin names apart', () => {
    expect(scoreDeviceNameMatch('カメラ A', 'uid', 'ウェブカメラ A')).toBe(DEVICE_NAME_NO_MATCH)
    expect(scoreDeviceNameMatch('Веб-камера 1', 'uid', 'Веб-камера 2')).toBe(DEVICE_NAME_NO_MATCH)
  })

  it('still matches identical non-Latin names', () => {
    expect(scoreDeviceNameMatch('カメラ A', 'uid', 'カメラ A')).toBe(DEVICE_NAME_MATCH_EXACT)
    expect(scoreDeviceNameMatch('摄像头（罗技）', 'uid', '摄像头（罗技）')).toBe(
      DEVICE_NAME_MATCH_EXACT,
    )
  })

  it('falls back to the identifier when the friendly name says nothing', () => {
    expect(scoreDeviceNameMatch('', 'usb elgato facecam 0fd9', 'Elgato Facecam')).toBe(
      DEVICE_NAME_MATCH_IDENTIFIER,
    )
  })
})

describe('pickDeviceByName', () => {
  const devices = [
    { name: 'MacBook Pro Microphone', id: 'BuiltInMicrophoneDevice' },
    { name: 'Logitech StreamCam', id: '0x14100000046d0893' },
    { name: 'Logitech BRIO', id: '0x14200000046d085e' },
  ]

  it('returns the best-scoring candidate', () => {
    expect(pickDeviceByName(devices, 'Logitech StreamCam (046d:0893)')?.id).toBe(
      '0x14100000046d0893',
    )
    expect(pickDeviceByName(devices, 'MacBook Pro Microphone (Built-in)')?.id).toBe(
      'BuiltInMicrophoneDevice',
    )
  })

  it('returns undefined instead of a weak match', () => {
    expect(pickDeviceByName(devices, 'Logi Capture')).toBeUndefined()
    expect(pickDeviceByName(devices, 'Logitech C920')).toBeUndefined()
    expect(pickDeviceByName(devices, undefined)).toBeUndefined()
    expect(pickDeviceByName([], 'Logitech StreamCam')).toBeUndefined()
  })

  it('keeps platform order on ties', () => {
    const twins = [
      { name: 'USB Audio', id: 'a' },
      { name: 'USB Audio', id: 'b' },
    ]
    expect(pickDeviceByName(twins, 'USB Audio')?.id).toBe('a')
  })
})
