import { describe, expect, it } from 'vitest';
import { parseCustomPlaybackSpeedInput } from './customPlaybackSpeed';
import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED } from './types';

describe('parseCustomPlaybackSpeedInput', () => {
  it('accepts decimal playback speeds', () => {
    expect(parseCustomPlaybackSpeedInput('1.1')).toEqual({
      status: 'valid',
      draft: '1.1',
      speed: 1.1,
    });
  });

  it('keeps a single decimal point while typing', () => {
    expect(parseCustomPlaybackSpeedInput('1.2.3')).toEqual({
      status: 'valid',
      draft: '1.23',
      speed: 1.23,
    });
  });

  it('reports an empty draft while the user is still typing', () => {
    expect(parseCustomPlaybackSpeedInput('')).toEqual({ status: 'empty', draft: '' });
    expect(parseCustomPlaybackSpeedInput('.')).toEqual({ status: 'empty', draft: '.' });
    expect(parseCustomPlaybackSpeedInput('abc')).toEqual({ status: 'empty', draft: '' });
  });

  it('allows sub-1 custom speeds down to the editor minimum', () => {
    expect(MIN_PLAYBACK_SPEED).toBe(0.25);
    expect(parseCustomPlaybackSpeedInput('0.25')).toEqual({
      status: 'valid',
      draft: '0.25',
      speed: 0.25,
    });
  });

  it('rejects speeds below the editor minimum', () => {
    expect(parseCustomPlaybackSpeedInput('0.2')).toEqual({
      status: 'too-slow',
      draft: '0.2',
    });
  });

  it('accepts comma decimal input by normalizing to a dot', () => {
    expect(parseCustomPlaybackSpeedInput('1,1')).toEqual({
      status: 'valid',
      draft: '1.1',
      speed: 1.1,
    });
  });

  it('accepts the maximum editor speed', () => {
    expect(MAX_PLAYBACK_SPEED).toBe(40);
    expect(parseCustomPlaybackSpeedInput('40')).toEqual({
      status: 'valid',
      draft: '40',
      speed: 40,
    });
  });

  it('accepts high speeds that exceed the native preview rate', () => {
    // 16.1x is above Chromium's playbackRate cap but inside the editor range.
    expect(parseCustomPlaybackSpeedInput('16.1')).toEqual({
      status: 'valid',
      draft: '16.1',
      speed: 16.1,
    });
  });

  it('rejects speeds above the editor maximum', () => {
    expect(parseCustomPlaybackSpeedInput('40.1')).toEqual({
      status: 'too-fast',
      draft: '40.1',
    });
  });

  it('rounds valid speeds to two decimals', () => {
    expect(parseCustomPlaybackSpeedInput('1.234')).toEqual({
      status: 'valid',
      draft: '1.234',
      speed: 1.23,
    });
  });
});
