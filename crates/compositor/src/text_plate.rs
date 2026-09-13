//! Le modèle de boîte de la plaque de fond d'un bloc de texte, partagé par les deux
//! rastériseurs.
//!
//! `text_windows.rs` (Direct2D) et `text_macos.rs` (CoreText) dessinent la même chose avec
//! deux API qui n'ont rien en commun ; ce qu'elles PEUVENT partager, ce sont les trois
//! nombres qui décident de l'allure du bloc. Ils vivent ici parce que c'est exactement le
//! genre de constante qui dérive en silence quand elle est recopiée : rien dans un rendu
//! Windows ne signale qu'une marge macOS a bougé, et personne ne compare les deux à l'œil.
//!
//! Les valeurs viennent du modèle de boîte de référence de l'app — le `<span>` que
//! l'overlay DOM posait derrière le texte et son jumeau canvas
//! (`src/lib/exporter/annotationRenderer.ts`) : `padding: 0.1em 0.2em`, `border-radius: 4px`
//! à la taille de police par défaut des sous-titres.
//!
//! Tout est exprimé en **em**, jamais en pixels : `font_size_px` est déjà mis à l'échelle de
//! la sortie par l'appelant (`font_size_rel * hauteur_du_rect_écran`), donc une marge en em
//! reste juste en 720p comme en 4K, là où une constante en pixels ne vaudrait qu'à une seule
//! résolution.

/// Marge interne horizontale de la plaque, en em.
const PAD_X_EM: f32 = 0.2;
/// Marge interne verticale, en em. Plus serrée que l'horizontale : la hauteur de ligne
/// apporte déjà du blanc au-dessus des capitales et sous les jambages, la largeur non.
const PAD_Y_EM: f32 = 0.1;
/// Rayon des coins, en em. La référence dit « 4 px » à la taille de police par défaut des
/// sous-titres (48 px sur une frame haute de 1080).
const RADIUS_EM: f32 = 4.0 / 48.0;

/// Marge interne `(horizontale, verticale)` de la plaque, en pixels de sortie.
pub fn padding(font_px: f32) -> (f32, f32) {
    let f = font_px.max(1.0);
    (f * PAD_X_EM, f * PAD_Y_EM)
}

/// Rayon des coins de la plaque, en pixels de sortie. `plate_w`/`plate_h` le bornent à la
/// moitié du plus petit côté : au-delà, Direct2D comme CoreGraphics rendent une forme
/// dégénérée plutôt qu'un rectangle arrondi.
pub fn radius(font_px: f32, plate_w: f32, plate_h: f32) -> f32 {
    (font_px.max(1.0) * RADIUS_EM)
        .min(plate_w * 0.5)
        .min(plate_h * 0.5)
        .max(0.0)
}

/// Largeur offerte aux lignes dans une boîte large de `box_w`.
///
/// La boîte est rentrée de la marge de plaque, comme le `p-2` que l'overlay DOM posait sur
/// le conteneur : sans ça, un texte aligné à gauche ou à droite colle au bord et sa plaque
/// se fait rogner du côté où elle devrait respirer. La mesure du bloc et le cadre de mise en
/// page doivent TOUS DEUX passer par ici — mesurer sur une largeur et composer sur une autre
/// coupe les lignes ailleurs que là où la plaque a été dimensionnée.
pub fn layout_width(box_w: f32, font_px: f32) -> f32 {
    (box_w - padding(font_px).0 * 2.0).max(1.0)
}

/// Plafond d'un côté de la boîte de texte, en pixels de sortie.
///
/// 8192 = la limite `max_texture_dimension_2d` par défaut de wgpu/D3D11 : au-delà, la
/// texture serait de toute façon refusée par le device, après l'allocation CPU.
pub const MAX_BOX_PX: u32 = 8192;

/// `spec.box_px` validé, tel que `w * h * 4` tient dans un `usize` et dans le device.
///
/// Les trois rastériseurs allouent `w * h * 4` octets d'après une boîte issue du JSON de
/// scène. `annotation_dst_in` borne déjà la boîte au cadre de sortie, mais rien n'oblige
/// un futur appelant à passer par là — et une texture plus grande que le device échoue
/// plus tard et plus mal. La garde est ici plutôt que recopiée trois fois.
pub fn checked_box_px(box_px: [u32; 2]) -> anyhow::Result<(u32, u32)> {
    let (w, h) = (box_px[0].max(1), box_px[1].max(1));
    if w > MAX_BOX_PX || h > MAX_BOX_PX {
        anyhow::bail!("boîte de texte {w}x{h} px au-delà du plafond {MAX_BOX_PX}");
    }
    Ok((w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Les valeurs de référence, à la taille de police par défaut des sous-titres. Ce test
    /// existe pour qu'un changement de marge soit un choix explicite et non un effet de bord.
    #[test]
    fn the_reference_box_model_at_the_default_caption_size() {
        let (pad_x, pad_y) = padding(48.0);
        assert!((pad_x - 9.6).abs() < 1e-4, "0.2em de 48 px");
        assert!((pad_y - 4.8).abs() < 1e-4, "0.1em de 48 px");
        assert!((radius(48.0, 400.0, 60.0) - 4.0).abs() < 1e-4, "4 px à 48 px de police");
    }

    /// Les marges suivent la police, donc la résolution de sortie : le même bloc rendu deux
    /// fois plus grand doit avoir des marges deux fois plus grandes, pas les mêmes.
    #[test]
    fn the_padding_scales_with_the_font() {
        let (x1, y1) = padding(48.0);
        let (x2, y2) = padding(96.0);
        assert!((x2 - x1 * 2.0).abs() < 1e-4);
        assert!((y2 - y1 * 2.0).abs() < 1e-4);
    }

    #[test]
    fn the_radius_never_degenerates_the_plate() {
        // Plaque plus mince que le rayon nominal : il se rabat sur la moitié du petit côté.
        assert!((radius(200.0, 300.0, 6.0) - 3.0).abs() < 1e-4);
        assert!(radius(48.0, 0.0, 0.0) >= 0.0);
    }

    #[test]
    fn the_layout_width_never_collapses() {
        assert!((layout_width(1000.0, 48.0) - (1000.0 - 19.2)).abs() < 1e-4);
        // Boîte plus étroite que ses propres marges : une largeur nulle ou négative ferait
        // boucler la mise en page au lieu de simplement déborder.
        assert!(layout_width(4.0, 200.0) >= 1.0);
    }

    /// Une boîte venue du JSON de scène ne doit jamais devenir un `vec![0u8; w * h * 4]`
    /// de plusieurs gigaoctets, ni faire déborder le produit.
    #[test]
    fn an_absurd_box_is_refused_rather_than_allocated() {
        assert!(checked_box_px([u32::MAX, u32::MAX]).is_err());
        assert!(checked_box_px([MAX_BOX_PX + 1, 10]).is_err());
        assert!(checked_box_px([10, MAX_BOX_PX + 1]).is_err());
        assert_eq!(checked_box_px([MAX_BOX_PX, MAX_BOX_PX]).unwrap(), (MAX_BOX_PX, MAX_BOX_PX));
        // Une boîte dégénérée reste ramenée à 1 px, comme avant.
        assert_eq!(checked_box_px([0, 0]).unwrap(), (1, 1));
    }
}
