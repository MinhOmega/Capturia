// @vitest-environment jsdom
//
// D2: the flagged-moment glyphs on the timeline ruler. `dnd-timeline` owns the
// pixel mapping, so its context is stubbed with a linear one: the assertions
// are about which markers are drawn, where, and what clicking one does.
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RecordingMarkers from './RecordingMarkers'

const timelineContext = vi.hoisted(() => ({
  value: {
    sidebarWidth: 100,
    range: { start: 0, end: 10_000 },
    // 10 000 ms across 1 000 px.
    valueToPixels: (value: number) => value / 10,
    pixelsToValue: (pixels: number) => pixels * 10,
  },
}))

vi.mock('dnd-timeline', () => ({
  useTimelineContext: () => timelineContext.value,
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}))

afterEach(() => {
  cleanup()
  timelineContext.value.range = { start: 0, end: 10_000 }
})

describe('RecordingMarkers', () => {
  it('draws nothing when the recording has no flagged moments', () => {
    const { container } = render(<RecordingMarkers markersMs={[]} videoDurationMs={10_000} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('draws nothing for a video with no duration yet', () => {
    const { container } = render(<RecordingMarkers markersMs={[1_000]} videoDurationMs={0} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('places one glyph per marker, offset by the sidebar', () => {
    render(<RecordingMarkers markersMs={[1_000, 5_000]} videoDurationMs={10_000} />)
    const markers = screen.getAllByTestId('timeline-recording-marker')
    expect(markers).toHaveLength(2)
    // 1 000 ms -> 100 px, plus the 100 px sidebar, less half the 12 px glyph.
    expect(markers[0]).toHaveStyle({ left: '194px' })
    expect(markers[1]).toHaveStyle({ left: '594px' })
  })

  it('omits markers outside the visible range', () => {
    timelineContext.value.range = { start: 2_000, end: 6_000 }
    render(<RecordingMarkers markersMs={[1_000, 4_000, 9_000]} videoDurationMs={10_000} />)
    const markers = screen.getAllByTestId('timeline-recording-marker')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toHaveAttribute('data-marker-ms', '4000')
  })

  it('seeks to the marker in seconds when one is clicked', () => {
    const onSeek = vi.fn()
    render(<RecordingMarkers markersMs={[4_500]} videoDurationMs={10_000} onSeek={onSeek} />)
    fireEvent.click(screen.getByTestId('timeline-recording-marker'))
    expect(onSeek).toHaveBeenCalledWith(4.5)
  })

  it('labels each marker with its time so it is reachable without the mouse', () => {
    timelineContext.value.range = { start: 0, end: 120_000 }
    render(<RecordingMarkers markersMs={[65_000]} videoDurationMs={120_000} />)
    expect(screen.getByTestId('timeline-recording-marker')).toHaveAttribute(
      'aria-label',
      'timeline.recordingMarkerAt:{"time":"1:05"}',
    )
  })
})
