export type AnnotationTextAnimation =
	| "none"
	| "fade"
	| "rise"
	| "pop"
	| "slide-left"
	| "typewriter"
	| "pulse";

/** Les sept animations, dans l'ordre où le sélecteur les propose. */
export const TEXT_ANIMATION_VALUES: AnnotationTextAnimation[] = [
	"none",
	"fade",
	"rise",
	"pop",
	"slide-left",
	"typewriter",
	"pulse",
];

export function normalizeTextAnimation(value: unknown): AnnotationTextAnimation {
	return TEXT_ANIMATION_VALUES.includes(value as AnnotationTextAnimation)
		? (value as AnnotationTextAnimation)
		: "none";
}
