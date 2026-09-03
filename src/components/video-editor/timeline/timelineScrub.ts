/**
 * Decides whether a pointer-down on the timeline should start a press-drag
 * scrub. Walks up from the event target to the timeline root and refuses when
 * the press landed on anything interactive: a dnd-timeline item
 * (`group`), a drag/resize handle, the playhead, or an element that opted out
 * explicitly with `data-timeline-scrub="off"` (Capturia's segment blocks, which
 * select on click instead).
 */
export const TIMELINE_SCRUB_OPT_OUT_ATTR = 'data-timeline-scrub'

export function shouldStartTimelineScrub(
  target: EventTarget | null,
  timelineElement: HTMLElement,
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  for (let element: HTMLElement | null = target; element && element !== timelineElement; ) {
    const className = element.className
    const classText = typeof className === 'string' ? className : ''

    if (
      classText.split(/\s+/).includes('group') ||
      classText.includes('cursor-grab') ||
      classText.includes('cursor-grabbing') ||
      classText.includes('cursor-ew-resize') ||
      element.style.cursor === 'col-resize' ||
      element.getAttribute(TIMELINE_SCRUB_OPT_OUT_ATTR) === 'off'
    ) {
      return false
    }

    element = element.parentElement
  }

  return true
}
