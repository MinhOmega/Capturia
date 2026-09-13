//! Ce que les trois rastériseurs de texte partagent : la `TextSpec` qu'ils prennent
//! tous en entrée (et son `cache_key`, une clé CROSS-PLATEFORME), et le modèle de
//! boîte de la plaque de fond d'un bloc de texte.
//!
//! `text_windows.rs` (Direct2D), `text_macos.rs` (CoreText) et `text_linux.rs`
//! (cosmic-text) dessinent la même chose avec des API qui n'ont rien en commun ; ce
//! qu'elles PEUVENT partager, ce sont les trois nombres qui décident de l'allure du
//! bloc. Ils vivent ici parce que c'est exactement le genre de constante qui dérive en
//! silence quand elle est recopiée : rien dans un rendu Windows ne signale qu'une marge
//! macOS a bougé, et personne ne compare les deux à l'œil.
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
}

/// Tout ce dont le rendu d'un texte depend, et rien d'autre : deux specs egales
/// donnent la meme texture, donc `cache_key` couvre exactement ces champs.
///
/// Partage par les trois rastériseurs (`text_windows`, `text_macos`,
/// `text_linux`), qui le re-exportent. Les trois en portaient une copie
/// caractere pour caractere, chacune avec un commentaire demandant aux deux
/// autres de rester synchronisees -- ce que rien ne verifiait. Le `cache_key`
/// est une cle CROSS-PLATEFORME : l'ordre des `mix` fait partie du contrat, pas
/// du detail d'implementation d'un backend.
#[derive(Clone, PartialEq)]
pub struct TextSpec {
    pub content: String,
    /// RGBA 0..1 (deja parse depuis la chaine CSS cote appelant).
    pub color: [f32; 4],
    /// RGBA 0..1 ; alpha 0 = pas de fond (le CSS `transparent`).
    pub background: [f32; 4],
    pub font_size_px: f32,
    pub font_family: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    /// "left" | "center" | "right".
    pub align: String,
    /// "top" | "center" | "bottom" -- quelle arete du bloc de texte est epinglee
    /// a la boite. "center" est le comportement historique (et celui des
    /// annotations, qui reproduisent `alignItems: center` de l'overlay web) ; les
    /// sous-titres passent "bottom" ou "top" pour que l'arete ancree ne bouge pas
    /// quand le texte gagne une ligne.
    pub valign: String,
    /// Taille de la boite en px de sortie -- la mise en page en depend (retours
    /// a la ligne).
    pub box_px: [u32; 2],
}

impl TextSpec {
    /// FNV-1a sur les champs. Sert a decider s'il faut re-rasteriser ;
    /// volontairement insensible a tout ce qui n'affecte pas les pixels
    /// (position, opacite d'animation...).
    pub fn cache_key(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |bytes: &[u8]| {
            for b in bytes {
                h ^= *b as u64;
                h = h.wrapping_mul(0x100_0000_01b3);
            }
        };
        mix(self.content.as_bytes());
        mix(self.font_family.as_bytes());
        mix(&self.font_size_px.to_bits().to_le_bytes());
        for c in self.color.iter().chain(self.background.iter()) {
            mix(&c.to_bits().to_le_bytes());
        }
        mix(&[self.bold as u8, self.italic as u8, self.underline as u8]);
        mix(self.align.as_bytes());
        // Juste apres `align`, memes octets et meme position sur les trois
        // backends : deux specs ne differant que par l'alignement vertical
        // rendraient sinon les pixels l'une de l'autre depuis le cache.
        mix(self.valign.as_bytes());
        mix(&self.box_px[0].to_le_bytes());
        mix(&self.box_px[1].to_le_bytes());
        h
    }
}
