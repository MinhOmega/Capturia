// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { shouldStartTimelineScrub } from './timelineScrub'

function makeTimeline(): HTMLDivElement {
  const timeline = document.createElement('div')
  timeline.className = 'select-none relative group'
  document.body.appendChild(timeline)
  return timeline
}

function child(parent: HTMLElement, className = '', attrs: Record<string, string> = {}) {
  const el = document.createElement('div')
  el.className = className
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
  parent.appendChild(el)
  return el
}

describe('shouldStartTimelineScrub', () => {
  let timeline: HTMLDivElement

  beforeEach(() => {
    document.body.innerHTML = ''
    timeline = makeTimeline()
  })

  it('starts on empty lane space', () => {
    const row = child(timeline, 'border-b bg-[#18181b]')
    const lane = child(row, '')
    expect(shouldStartTimelineScrub(lane, timeline)).toBe(true)
  })

  it('starts on the timeline root itself (its own group class is ignored)', () => {
    expect(shouldStartTimelineScrub(timeline, timeline)).toBe(true)
  })

  it('refuses inside a dnd-timeline item (group wrapper)', () => {
    const item = child(timeline, 'group')
    const content = child(item, 'flex items-center')
    expect(shouldStartTimelineScrub(content, timeline)).toBe(false)
  })

  it('does not treat a class merely containing "group" as an item', () => {
    const el = child(timeline, 'group/cursor-like')
    expect(shouldStartTimelineScrub(el, timeline)).toBe(true)
  })

  it('refuses on drag and resize handles', () => {
    expect(shouldStartTimelineScrub(child(timeline, 'cursor-grab'), timeline)).toBe(false)
    expect(shouldStartTimelineScrub(child(timeline, 'active:cursor-grabbing'), timeline)).toBe(
      false,
    )
    const cap = child(timeline, 'zoomEndCap')
    cap.style.cursor = 'col-resize'
    expect(shouldStartTimelineScrub(cap, timeline)).toBe(false)
  })

  it('refuses on the playhead hit area', () => {
    const hit = child(timeline, 'absolute w-[12px] cursor-ew-resize pointer-events-auto')
    expect(shouldStartTimelineScrub(hit, timeline)).toBe(false)
  })

  it('refuses inside an element that opted out via data-timeline-scrub="off"', () => {
    const segment = child(timeline, 'absolute rounded cursor-pointer', {
      'data-timeline-scrub': 'off',
    })
    const label = child(segment, 'text-[9px]')
    expect(shouldStartTimelineScrub(label, timeline)).toBe(false)
  })

  it('refuses for non-element targets', () => {
    expect(shouldStartTimelineScrub(null, timeline)).toBe(false)
    expect(shouldStartTimelineScrub(document.createTextNode('x'), timeline)).toBe(false)
  })
})
