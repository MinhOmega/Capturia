//! Nettoyage du fichier de sortie quand un export échoue.
//!
//! Un run interrompu laisse le MP4 sans son `moov` (ou le GIF sans son
//! trailer) : illisible, et portant exactement le nom du fichier que
//! l'utilisateur croit avoir exporté. Le retirer plutôt que le laisser traîner.
//!
//! Le helper vit ici — et pas dans un `pipeline_*.rs` — parce que les trois
//! pipelines et l'export GIF en ont besoin à l'identique : c'est la même
//! propriété produit sur les trois plateformes, donc une seule copie. Il ne
//! touche qu'à `std::fs`, rien de spécifique à un backend.
//!
//! # Posé sur les façades, pas sur chaque `?`
//!
//! Les `*_inner` sortent par une trentaine de points, tous concernés de la même
//! façon. Une façade qui enveloppe l'appel les couvre tous sans toucher au
//! corps.
//!
//! ponytail: seul le fichier est nettoyé ; les contextes ffmpeg alloués dans les
//! `*_inner` fuient toujours sur ces sorties-là (il faudrait une garde RAII par
//! pointeur, comme `FrameGuard`). Un export raté est rare et ne boucle pas — à
//! reprendre si ça devient un mode de marche.

use anyhow::Result;
use std::path::Path;

/// Empreinte bon marché d'un fichier : `(taille, date de modification)`.
/// `None` si le fichier n'existe pas (ou si le système de fichiers ne rend pas
/// de mtime).
fn fingerprint(out: &Path) -> Option<(u64, std::time::SystemTime)> {
    let md = std::fs::metadata(out).ok()?;
    Some((md.len(), md.modified().ok()?))
}

/// Exécute `run` et, s'il échoue, supprime le fichier de sortie — mais
/// UNIQUEMENT si ce run l'a touché.
///
/// # Pourquoi l'empreinte, et pas une suppression sèche
///
/// L'utilisateur peut exporter PAR-DESSUS un fichier existant. Si le run échoue
/// avant d'avoir ouvert la sortie (liste de clips vide, encodeur indisponible,
/// muxer refusé), une suppression sèche détruirait un fichier que l'export
/// n'a jamais écrit — bien pire que le tronqué qu'on cherche à éviter. On
/// compare donc l'empreinte d'avant et d'après :
///
///   - absent avant, présent après → créé par ce run → supprimé ;
///   - présent avant et modifié → `avio_open` l'a déjà tronqué, l'original est
///     perdu de toute façon → supprimé, plutôt que de laisser un imposteur
///     corrompu sous le nom attendu ;
///   - présent avant et intact → jamais touché → CONSERVÉ ;
///   - absent après → rien à faire.
///
/// ponytail: `(taille, mtime)` et pas un hash — une troncature qui retomberait
/// sur la taille exacte de l'ancien fichier DANS le même tic de mtime passerait
/// pour intacte. Le fichier serait alors conservé, c'est-à-dire le comportement
/// d'avant ce correctif : on échoue du côté sûr. Un hash si ça se produit un
/// jour.
pub fn discard_partial_output<T>(out: impl AsRef<Path>, run: impl FnOnce() -> Result<T>) -> Result<T> {
    let out = out.as_ref();
    let before = fingerprint(out);
    let result = run();
    if result.is_err() && fingerprint(out).is_some_and(|after| Some(after) != before) {
        let _ = std::fs::remove_file(out);
    }
    result
}
