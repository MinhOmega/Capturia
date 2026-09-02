import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ALLOWED_IMPORT_VIDEO_EXTENSIONS,
  ApprovedPathRegistry,
  approvedExportPaths,
  approvedReadPaths,
  approveFilePath,
  hasAllowedReadableExtension,
  isAllowedExportPath,
  isAllowedExternalUrl,
  isAllowedRevealPath,
  isApprovedPath,
  isPathWithinDir,
  isReadablePathAllowed,
  localMediaUrlToPath,
  normalizeExternalUrl,
  normalizeVideoSourcePath,
  resolveOutputPathInDir,
  resolveRecordingOutputPath,
} from './paths'

const RECORDINGS_DIR = path.resolve('/tmp/capturia-test/recordings')

describe('isPathWithinDir', () => {
  it('accepts the directory itself and nested files', () => {
    expect(isPathWithinDir(RECORDINGS_DIR, RECORDINGS_DIR)).toBe(true)
    expect(isPathWithinDir(path.join(RECORDINGS_DIR, 'a.webm'), RECORDINGS_DIR)).toBe(true)
    expect(isPathWithinDir(path.join(RECORDINGS_DIR, 'sub', 'a.webm'), RECORDINGS_DIR)).toBe(true)
  })

  it('rejects traversal out of the directory', () => {
    expect(isPathWithinDir(path.join(RECORDINGS_DIR, '..', 'a.webm'), RECORDINGS_DIR)).toBe(false)
    expect(
      isPathWithinDir(path.join(RECORDINGS_DIR, 'sub', '..', '..', 'x.webm'), RECORDINGS_DIR),
    ).toBe(false)
  })

  it('rejects sibling directories sharing a prefix', () => {
    expect(isPathWithinDir(`${RECORDINGS_DIR}-other/a.webm`, RECORDINGS_DIR)).toBe(false)
  })

  it('handles win32 semantics (case-insensitive, backslashes)', () => {
    const win = path.win32
    expect(isPathWithinDir('C:\\Users\\me\\rec\\a.webm', 'C:\\Users\\me\\rec', win)).toBe(true)
    expect(isPathWithinDir('c:\\users\\ME\\rec\\a.webm', 'C:\\Users\\me\\rec', win)).toBe(true)
    expect(isPathWithinDir('C:\\Users\\me\\rec\\..\\a.webm', 'C:\\Users\\me\\rec', win)).toBe(false)
    expect(isPathWithinDir('C:\\Users\\me\\rec-other\\a.webm', 'C:\\Users\\me\\rec', win)).toBe(
      false,
    )
    expect(isPathWithinDir('C:/Users/me/rec/a.webm', 'C:\\Users\\me\\rec', win)).toBe(true)
  })
})

describe('ApprovedPathRegistry', () => {
  it('matches exact files and files below approved directories', () => {
    const reg = new ApprovedPathRegistry()
    reg.approveFile('/home/u/Videos/clip.mp4')
    reg.approveDirectory('/home/u/Exports')
    expect(reg.isApproved('/home/u/Videos/clip.mp4')).toBe(true)
    expect(reg.isApproved('/home/u/Videos/../Videos/clip.mp4')).toBe(true)
    expect(reg.isApproved('/home/u/Videos/other.mp4')).toBe(false)
    expect(reg.isApproved('/home/u/Exports/out.mp4')).toBe(true)
    expect(reg.isApproved('/home/u/Exports')).toBe(true)
    expect(reg.isApprovedDirectory('/home/u/Exports')).toBe(true)
    expect(reg.isApprovedDirectory('/home/u/Exports/nested')).toBe(false)
    expect(reg.isApproved('/home/u/Exports-other/out.mp4')).toBe(false)
    expect(reg.size).toBe(2)
    reg.clear()
    expect(reg.size).toBe(0)
  })

  it('is case-insensitive under win32', () => {
    const reg = new ApprovedPathRegistry(path.win32)
    reg.approveFile('C:\\Users\\me\\clip.mp4')
    expect(reg.isApprovedFile('c:\\users\\me\\CLIP.mp4')).toBe(true)
  })
})

describe('extension allowlists', () => {
  it('mirrors upstream import extensions', () => {
    expect([...ALLOWED_IMPORT_VIDEO_EXTENSIONS].sort()).toEqual(
      ['.avi', '.flv', '.m4v', '.mkv', '.mov', '.mp4', '.ts', '.webm', '.wmv'].sort(),
    )
  })

  it('allows video + json, rejects images and everything else', () => {
    expect(hasAllowedReadableExtension('/a/b.WEBM')).toBe(true)
    expect(hasAllowedReadableExtension('/a/b.cursor.json')).toBe(true)
    expect(hasAllowedReadableExtension('/a/b.png')).toBe(false)
    expect(hasAllowedReadableExtension('/a/b.jpg')).toBe(false)
    expect(hasAllowedReadableExtension('/etc/passwd')).toBe(false)
    expect(hasAllowedReadableExtension('/a/b.mp4.exe')).toBe(false)
  })
})

describe('isReadablePathAllowed', () => {
  beforeEach(() => {
    approvedReadPaths.clear()
  })

  it('allows video files inside the recordings dir', () => {
    expect(
      isReadablePathAllowed(path.join(RECORDINGS_DIR, 'recording-1.webm'), {
        recordingsDir: RECORDINGS_DIR,
      }),
    ).toBe(true)
    expect(
      isReadablePathAllowed(path.join(RECORDINGS_DIR, 'recording-1.cursor.json'), {
        recordingsDir: RECORDINGS_DIR,
      }),
    ).toBe(true)
  })

  it('rejects traversal out of the recordings dir', () => {
    expect(
      isReadablePathAllowed(path.join(RECORDINGS_DIR, '..', 'secret.webm'), {
        recordingsDir: RECORDINGS_DIR,
      }),
    ).toBe(false)
    expect(isReadablePathAllowed('/etc/passwd', { recordingsDir: RECORDINGS_DIR })).toBe(false)
    expect(isReadablePathAllowed('/etc/passwd.webm', { recordingsDir: RECORDINGS_DIR })).toBe(false)
  })

  it('rejects relative paths and empty input', () => {
    expect(isReadablePathAllowed('recordings/a.webm', { recordingsDir: RECORDINGS_DIR })).toBe(
      false,
    )
    expect(isReadablePathAllowed('', { recordingsDir: RECORDINGS_DIR })).toBe(false)
  })

  it('rejects non-media extensions even inside the recordings dir', () => {
    expect(
      isReadablePathAllowed(path.join(RECORDINGS_DIR, 'notes.txt'), {
        recordingsDir: RECORDINGS_DIR,
      }),
    ).toBe(false)
  })

  it('allows explicitly approved files outside the recordings dir', () => {
    const external = path.resolve('/home/u/Videos/clip.mov')
    expect(isReadablePathAllowed(external, { recordingsDir: RECORDINGS_DIR })).toBe(false)
    approveFilePath(external)
    expect(isApprovedPath(external)).toBe(true)
    expect(isReadablePathAllowed(external, { recordingsDir: RECORDINGS_DIR })).toBe(true)
    // approval is per-file, not per-directory
    expect(
      isReadablePathAllowed(path.resolve('/home/u/Videos/other.mov'), {
        recordingsDir: RECORDINGS_DIR,
      }),
    ).toBe(false)
  })

  it('does not let an approved path with a bad extension through', () => {
    const external = path.resolve('/home/u/secret.txt')
    approveFilePath(external)
    expect(isReadablePathAllowed(external, { recordingsDir: RECORDINGS_DIR })).toBe(false)
  })

  it('works with an isolated registry and win32 paths', () => {
    const reg = new ApprovedPathRegistry(path.win32)
    const opts = {
      recordingsDir: 'C:\\Users\\me\\AppData\\Capturia\\recordings',
      registry: reg,
      platformPath: path.win32,
    }
    expect(
      isReadablePathAllowed('C:\\Users\\me\\AppData\\Capturia\\recordings\\rec.mp4', opts),
    ).toBe(true)
    expect(
      isReadablePathAllowed('C:\\Users\\me\\AppData\\Capturia\\recordings\\..\\..\\x.mp4', opts),
    ).toBe(false)
    expect(isReadablePathAllowed('D:\\Videos\\clip.mp4', opts)).toBe(false)
    reg.approveFile('D:\\Videos\\clip.mp4')
    expect(isReadablePathAllowed('d:\\videos\\CLIP.mp4', opts)).toBe(true)
  })
})

describe('normalizeVideoSourcePath', () => {
  it('returns null for non-string or empty input', () => {
    expect(normalizeVideoSourcePath(undefined)).toBeNull()
    expect(normalizeVideoSourcePath(null)).toBeNull()
    expect(normalizeVideoSourcePath(42)).toBeNull()
    expect(normalizeVideoSourcePath('   ')).toBeNull()
  })

  it('converts file:// URLs to paths', () => {
    const p = path.resolve('/home/u/My Videos/clip.mp4')
    expect(normalizeVideoSourcePath(pathToFileURL(p).toString())).toBe(p)
  })

  it('normalizes redundant segments', () => {
    expect(normalizeVideoSourcePath('/home/u//Videos/./clip.mp4')).toBe('/home/u/Videos/clip.mp4')
    expect(normalizeVideoSourcePath('  /home/u/clip.mp4  ')).toBe('/home/u/clip.mp4')
  })

  it('normalizes win32 paths with the win32 implementation', () => {
    expect(normalizeVideoSourcePath('C:/Users/me/../me/clip.mp4', path.win32)).toBe(
      'C:\\Users\\me\\clip.mp4',
    )
  })
})

describe('localMediaUrlToPath', () => {
  it('decodes the renderer URL form back to a posix path', () => {
    const p = '/home/u/My Videos/clip (1).webm'
    const url = `local-media://host${encodeURI(p)}`
    expect(localMediaUrlToPath(url, path.posix)).toBe(p)
  })

  it('strips the leading slash before a drive letter on win32', () => {
    expect(localMediaUrlToPath('local-media://host/C:/Users/me/clip.webm', path.win32)).toBe(
      'C:\\Users\\me\\clip.webm',
    )
  })

  it('returns null for unparsable URLs or bad escapes', () => {
    expect(localMediaUrlToPath('not a url', path.posix)).toBeNull()
    expect(localMediaUrlToPath('local-media://host/%E0%A4%A', path.posix)).toBeNull()
  })

  it('collapses traversal so the policy sees the real target', () => {
    expect(localMediaUrlToPath('local-media://host/tmp/rec/../../etc/passwd', path.posix)).toBe(
      '/etc/passwd',
    )
  })
})

describe('resolveRecordingOutputPath', () => {
  it('joins a plain file name under the recordings dir', () => {
    expect(resolveRecordingOutputPath(RECORDINGS_DIR, 'recording-123.webm')).toBe(
      path.join(RECORDINGS_DIR, 'recording-123.webm'),
    )
    expect(resolveRecordingOutputPath(RECORDINGS_DIR, '  recording-1.mp4 ')).toBe(
      path.join(RECORDINGS_DIR, 'recording-1.mp4'),
    )
  })

  it.each([
    '',
    '   ',
    '.',
    '..',
    '../escape.webm',
    'sub/recording.webm',
    'sub\\recording.webm',
    '..\\escape.webm',
    '/etc/passwd',
    'C:\\Windows\\evil.webm',
    '/abs.webm',
  ])('rejects %j', (name) => {
    expect(() => resolveRecordingOutputPath(RECORDINGS_DIR, name)).toThrow(
      /Invalid recording file name/,
    )
  })

  it('rejects non-string names', () => {
    expect(() => resolveRecordingOutputPath(RECORDINGS_DIR, undefined)).toThrow()
    expect(() => resolveRecordingOutputPath(RECORDINGS_DIR, 12 as unknown as string)).toThrow()
  })

  it('applies the same rules under win32', () => {
    const win = path.win32
    expect(resolveOutputPathInDir('C:\\rec', 'a.webm', win)).toBe('C:\\rec\\a.webm')
    expect(() => resolveOutputPathInDir('C:\\rec', '..\\a.webm', win)).toThrow()
    expect(() => resolveOutputPathInDir('C:\\rec', 'D:\\a.webm', win)).toThrow()
    expect(() => resolveOutputPathInDir('C:\\rec', 'sub/a.webm', win)).toThrow()
  })
})

describe('external URL allowlist', () => {
  it('allows http, https and mailto', () => {
    expect(isAllowedExternalUrl('https://github.com/MinhOmega/Capturia/issues')).toBe(true)
    expect(isAllowedExternalUrl('http://example.com')).toBe(true)
    expect(isAllowedExternalUrl('mailto:someone@example.com')).toBe(true)
    expect(normalizeExternalUrl('  https://example.com/a b ')).toBe('https://example.com/a%20b')
  })

  it('rejects everything else', () => {
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('x-apple.systempreferences:com.apple.preference.security')).toBe(
      false,
    )
    expect(isAllowedExternalUrl('smb://server/share')).toBe(false)
    expect(isAllowedExternalUrl('not a url')).toBe(false)
    expect(isAllowedExternalUrl('')).toBe(false)
    expect(isAllowedExternalUrl(undefined)).toBe(false)
    expect(normalizeExternalUrl('ftp://x')).toBeNull()
  })
})

describe('isAllowedExportPath', () => {
  beforeEach(() => {
    approvedExportPaths.clear()
  })

  it('rejects paths that were never returned by a dialog', () => {
    expect(isAllowedExportPath('/home/u/Downloads/export-1.mp4')).toBe(false)
  })

  it('allows an exact save-dialog result with a valid extension', () => {
    approvedExportPaths.approveFile('/home/u/Downloads/export-1.mp4')
    approvedExportPaths.approveFile('/home/u/Downloads/export-1.gif')
    approvedExportPaths.approveFile('/home/u/Downloads/export-1.txt')
    expect(isAllowedExportPath('/home/u/Downloads/export-1.mp4')).toBe(true)
    expect(isAllowedExportPath('/home/u/Downloads/export-1.gif')).toBe(true)
    expect(isAllowedExportPath('/home/u/Downloads/export-1.txt')).toBe(false)
    expect(isAllowedExportPath('/home/u/Downloads/export-2.mp4')).toBe(false)
  })

  it('allows direct children of an approved export directory only', () => {
    approvedExportPaths.approveDirectory('/home/u/Exports')
    expect(isAllowedExportPath('/home/u/Exports/export-1.mp4')).toBe(true)
    expect(isAllowedExportPath('/home/u/Exports/export-1-16x9.mp4')).toBe(true)
    expect(isAllowedExportPath('/home/u/Exports/nested/export-1.mp4')).toBe(false)
    expect(isAllowedExportPath('/home/u/Exports/../evil.mp4')).toBe(false)
    expect(isAllowedExportPath('/home/u/Exports/export-1.sh')).toBe(false)
  })

  it('rejects relative and empty paths', () => {
    approvedExportPaths.approveDirectory(path.resolve('.'))
    expect(isAllowedExportPath('export-1.mp4')).toBe(false)
    expect(isAllowedExportPath('')).toBe(false)
    expect(isAllowedExportPath(null)).toBe(false)
  })

  it('supports win32 paths via an isolated registry', () => {
    const reg = new ApprovedPathRegistry(path.win32)
    reg.approveDirectory('C:\\Users\\me\\Exports')
    const opts = { registry: reg, platformPath: path.win32 }
    expect(isAllowedExportPath('C:\\Users\\me\\Exports\\out.mp4', opts)).toBe(true)
    expect(isAllowedExportPath('c:\\users\\me\\exports\\OUT.GIF', opts)).toBe(true)
    expect(isAllowedExportPath('C:\\Users\\me\\Exports\\..\\out.mp4', opts)).toBe(false)
    expect(isAllowedExportPath('\\Exports\\out.mp4', opts)).toBe(false)
  })
})

describe('isAllowedRevealPath', () => {
  beforeEach(() => {
    approvedReadPaths.clear()
    approvedExportPaths.clear()
  })

  it('allows recordings, approved reads and approved exports', () => {
    const opts = { recordingsDir: RECORDINGS_DIR }
    expect(isAllowedRevealPath(path.join(RECORDINGS_DIR, 'recording-1.webm'), opts)).toBe(true)
    expect(isAllowedRevealPath('/home/u/Downloads/export-1.mp4', opts)).toBe(false)
    approvedExportPaths.approveFile('/home/u/Downloads/export-1.mp4')
    expect(isAllowedRevealPath('/home/u/Downloads/export-1.mp4', opts)).toBe(true)
    approvedExportPaths.approveDirectory('/home/u/Exports')
    expect(isAllowedRevealPath('/home/u/Exports/export-2.mp4', opts)).toBe(true)
    approvedReadPaths.approveFile('/home/u/Videos/clip.mov')
    expect(isAllowedRevealPath('/home/u/Videos/clip.mov', opts)).toBe(true)
  })

  it('rejects arbitrary and relative paths', () => {
    const opts = { recordingsDir: RECORDINGS_DIR }
    expect(isAllowedRevealPath('/etc/passwd', opts)).toBe(false)
    expect(isAllowedRevealPath('recording-1.webm', opts)).toBe(false)
    expect(isAllowedRevealPath(undefined, opts)).toBe(false)
  })
})
