import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";

export type AnnotationKind = AxcutAnnotationRegion["type"];

/**
 * Patch à appliquer quand l'utilisateur change le type d'une annotation.
 *
 * `content` est un slot UNIQUE partagé par le texte et l'image : la zone de saisie y écrit, et le
 * rendu d'image y lit une data URL. Changer de type sans déplacer la valeur déversait donc le
 * base64 de l'image, souvent plusieurs mégaoctets, dans le champ texte. Chaque contenu est rangé
 * dans son slot typé (`textContent` / `imageContent`) en sortant et restauré en entrant, si bien
 * qu'un aller-retour entre deux types ne perd rien.
 *
 * Vit ici plutôt que dans l'inspecteur depuis que « coller les attributs » convertit lui aussi :
 * le store ne peut pas importer un composant, et deux copies de la règle de rangement, c'est la
 * garantie qu'une seule des deux entrées préserve le contenu.
 */
export function convertAnnotationKind(
	region: AxcutAnnotationRegion,
	next: AnnotationKind,
): Partial<AxcutAnnotationRegion> {
	if (region.type === next) return {};
	const parked: Partial<AxcutAnnotationRegion> =
		region.type === "text"
			? { textContent: region.content ?? "" }
			: region.type === "image"
				? { imageContent: region.content ?? "" }
				: {};
	// Flèche et flou n'ont pas de contenu : on vide `content` plutôt que d'y laisser traîner le
	// texte ou le base64 du type précédent.
	const restored =
		next === "text"
			? (region.textContent ?? "")
			: next === "image"
				? (region.imageContent ?? "")
				: "";
	return { ...parked, type: next, content: restored };
}
