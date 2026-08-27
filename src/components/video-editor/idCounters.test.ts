import { describe, expect, it } from 'vitest';
import { ANNOTATION_ID_PREFIX, maxIdNum } from './idCounters';

describe('maxIdNum', () => {
  it('returns the highest numeric suffix for the given prefix', () => {
    const items = [{ id: 'zoom-3' }, { id: 'zoom-12' }, { id: 'zoom-7' }];
    expect(maxIdNum(items, 'zoom-')).toBe(12);
  });

  it('returns 0 when nothing matches', () => {
    expect(maxIdNum([], 'seg-')).toBe(0);
    expect(maxIdNum([{ id: 'zoom-1' }], 'seg-')).toBe(0);
  });

  it('ignores ids with a different prefix or a non-numeric suffix', () => {
    const items = [{ id: 'annotation-4' }, { id: 'annotation-x' }, { id: 'anno-9' }, { id: 'xannotation-20' }];
    expect(maxIdNum(items, 'annotation-')).toBe(4);
  });

  // Regression: VideoEditor used 'anno-' while ids are minted as 'annotation-N',
  // so restored projects restarted the counter at 1 and collided.
  it('matches the prefix annotations are actually minted with', () => {
    const restored = [
      { id: `${ANNOTATION_ID_PREFIX}1` },
      { id: `${ANNOTATION_ID_PREFIX}5` },
    ];
    expect(maxIdNum(restored, ANNOTATION_ID_PREFIX)).toBe(5);
    expect(maxIdNum(restored, 'anno-')).toBe(0);
  });

  it('treats regex metacharacters in the prefix literally', () => {
    expect(maxIdNum([{ id: 'a.b-2' }, { id: 'axb-9' }], 'a.b-')).toBe(2);
  });
});
