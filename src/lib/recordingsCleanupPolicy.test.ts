import { describe, expect, it } from 'vitest';
import {
  createRecordingCleanupPolicy,
  isManagedRecordingArtifactName,
  planRecordingCleanup,
  recordingGroupKeyFromFileName,
  type RecordingArtifactEntry,
} from './recordingsCleanupPolicy';

function entry(name: string, size: number, mtimeMs: number): RecordingArtifactEntry {
  return { name, size, mtimeMs };
}

describe('recordingsCleanupPolicy', () => {
  it('keeps newest groups and trims oldest when total bytes exceed cap', () => {
    const entries: RecordingArtifactEntry[] = [
      entry('recording-1.webm', 100, 10),
      entry('recording-1.cursor.json', 10, 10),
      entry('recording-2.webm', 100, 20),
      entry('recording-2.cursor.json', 10, 20),
      entry('recording-3.webm', 100, 30),
      entry('recording-3.cursor.json', 10, 30),
      entry('recording-4.webm', 100, 40),
      entry('recording-4.cursor.json', 10, 40),
      entry('recording-5.mp4', 100, 50),
      entry('recording-5.cursor.json', 10, 50),
      entry('recording-6.mp4', 100, 60),
      entry('recording-6.cursor.json', 10, 60),
    ];

    const plan = planRecordingCleanup(entries, {
      nowMs: 1_000,
      policy: createRecordingCleanupPolicy({
        maxTotalBytes: 420,
        targetTotalBytes: 220,
        maxVideoAgeMs: 1_000_000,
        minKeepVideoGroups: 2,
        orphanSidecarAgeMs: 1_000_000,
      }),
    });

    expect(plan.filesToDelete).toEqual([
      'recording-1.cursor.json',
      'recording-1.webm',
      'recording-2.cursor.json',
      'recording-2.webm',
      'recording-3.cursor.json',
      'recording-3.webm',
      'recording-4.cursor.json',
      'recording-4.webm',
    ]);
  });

  it('deletes aged recordings but preserves minimum newest groups', () => {
    const entries: RecordingArtifactEntry[] = [
      entry('recording-10.webm', 120, 100),
      entry('recording-11.mp4', 120, 200),
      entry('recording-12.webm', 120, 4_300),
      entry('recording-13.mp4', 120, 4_500),
    ];

    const plan = planRecordingCleanup(entries, {
      nowMs: 5_000,
      policy: createRecordingCleanupPolicy({
        maxTotalBytes: 10_000,
        targetTotalBytes: 8_000,
        maxVideoAgeMs: 1_000,
        minKeepVideoGroups: 1,
        orphanSidecarAgeMs: 10_000,
      }),
    });

    expect(plan.filesToDelete).toEqual([
      'recording-10.webm',
      'recording-11.mp4',
    ]);
  });

  it('cleans orphan cursor sidecars older than threshold', () => {
    const entries: RecordingArtifactEntry[] = [
      entry('recording-200.cursor.json', 12, 100),
      entry('recording-201.cursor.json', 12, 4_900),
      entry('recording-300.webm', 120, 4_900),
    ];

    const plan = planRecordingCleanup(entries, {
      nowMs: 5_000,
      policy: createRecordingCleanupPolicy({
        maxTotalBytes: 10_000,
        targetTotalBytes: 8_000,
        maxVideoAgeMs: 10_000,
        minKeepVideoGroups: 1,
        orphanSidecarAgeMs: 500,
      }),
    });

    expect(plan.filesToDelete).toEqual(['recording-200.cursor.json']);
  });

  it('ignores unmanaged files', () => {
    const entries: RecordingArtifactEntry[] = [
      entry('example.mp4', 120, 10),
      entry('manual-export.mov', 120, 20),
      entry('recording-1.webm', 120, 30),
    ];

    const plan = planRecordingCleanup(entries, {
      nowMs: 10_000,
      policy: createRecordingCleanupPolicy({
        maxTotalBytes: 10_000,
        targetTotalBytes: 8_000,
        maxVideoAgeMs: 100,
        minKeepVideoGroups: 1,
        orphanSidecarAgeMs: 10_000,
      }),
    });

    expect(plan.filesToDelete).toEqual([]);
  });

  it('detects managed artifacts and extracts group keys', () => {
    expect(isManagedRecordingArtifactName('recording-123.webm')).toBe(true);
    expect(isManagedRecordingArtifactName('recording-123.mp4')).toBe(true);
    expect(isManagedRecordingArtifactName('recording-123.cursor.json')).toBe(true);
    expect(isManagedRecordingArtifactName('manual-video.mp4')).toBe(false);

    expect(recordingGroupKeyFromFileName('recording-123.webm')).toBe('recording-123');
    expect(recordingGroupKeyFromFileName('recording-123.cursor.json')).toBe('recording-123');
    expect(recordingGroupKeyFromFileName('manual-video.mp4')).toBeNull();
  });

  it('treats duration-patch scratch files as managed members of their recording group', () => {
    // Keyed to the recording so a post-recording cleanup with that path excluded also
    // spares an in-flight patch file, and so it is deleted along with the group.
    expect(isManagedRecordingArtifactName('recording-123.webm.duration-patch.tmp')).toBe(true);
    expect(recordingGroupKeyFromFileName('recording-123.webm.duration-patch.tmp')).toBe('recording-123');
    expect(recordingGroupKeyFromFileName('other.webm.duration-patch.tmp')).toBeNull();
  });

  it('deletes stale duration-patch leftovers next to a kept video, but not fresh ones', () => {
    const entries: RecordingArtifactEntry[] = [
      // Patch died mid-way long ago: the video is kept, the scratch file is an orphan.
      entry('recording-10.webm', 120, 4_900),
      entry('recording-10.webm.duration-patch.tmp', 120, 100),
      // Patch possibly still running: younger than the orphan threshold, keep it.
      entry('recording-11.webm', 120, 4_950),
      entry('recording-11.webm.duration-patch.tmp', 120, 4_950),
      // Video already gone: the leftover is an orphan group of its own.
      entry('recording-12.webm.duration-patch.tmp', 120, 100),
    ];

    const plan = planRecordingCleanup(entries, {
      nowMs: 5_000,
      policy: createRecordingCleanupPolicy({
        maxTotalBytes: 10_000,
        targetTotalBytes: 8_000,
        maxVideoAgeMs: 10_000,
        minKeepVideoGroups: 1,
        orphanSidecarAgeMs: 500,
      }),
    });

    expect(plan.filesToDelete).toEqual([
      'recording-10.webm.duration-patch.tmp',
      'recording-12.webm.duration-patch.tmp',
    ]);
    expect(plan.estimatedBytesFreed).toBe(240);
  });
});
