/**
 * Whether a modal dialog currently owns the screen.
 *
 * The editor registers its shortcuts on `window` in the capture phase, so
 * without this check they keep firing underneath an open dialog: Space toggles
 * playback the user cannot see, the arrow keys seek, and Ctrl+Z undoes a
 * timeline edit hidden behind the dialog. Rather than thread an "is some
 * dialog open" flag through every panel, a dialog is recognised by the
 * `aria-modal="true"` attribute it already has to carry for assistive
 * technology — one fact to keep true, in the place that opens the dialog.
 *
 * @param root Document to query; defaults to the ambient one. Pass explicitly
 * from tests, or when the caller may run without a DOM.
 */
export function isModalDialogOpen(root?: Document | null): boolean {
  const doc = root === undefined ? (typeof document === 'undefined' ? null : document) : root
  return Boolean(doc?.querySelector('[aria-modal="true"]'))
}
