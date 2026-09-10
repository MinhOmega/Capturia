//! Annulation d'un export en cours.
//!
//! Un export long (plusieurs minutes sur une timeline chargée) doit pouvoir être
//! interrompu depuis l'interface. Le seul point d'interruption dont on ait besoin
//! est la boucle par frame de `timeline_walk::walk_composited_timeline` : les
//! trois pipelines ET l'export GIF y passent, donc un unique test couvre les
//! quatre chemins de sortie. Poser le test dans chaque `pipeline_*.rs` aurait
//! donné trois copies de la même ligne pour le même effet.
//!
//! L'annulation ressort en `Err`, pas en `Ok` tronqué. C'est délibéré : les
//! façades de nettoyage (`discard_partial_output`) ne suppriment le fichier de
//! sortie que sur un `Err`, donc une annulation emprunte gratuitement le même
//! nettoyage qu'un échec — l'utilisateur ne retrouve pas un MP4 sans `moov` au
//! nom du fichier qu'il croit avoir exporté.
//!
//! ponytail: un seul drapeau global, donc un seul export à la fois — ce que
//! l'interface impose déjà (une seule fenêtre d'export). Passer à une map
//! `sessionId -> AtomicBool` le jour où deux exports peuvent tourner ensemble.

use anyhow::{bail, Result};
use std::sync::atomic::{AtomicBool, Ordering};

static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Jeton stable porté par l'erreur d'annulation.
///
/// Volontairement NON traduit et non formaté : le renderer le compare tel quel
/// pour distinguer « l'utilisateur a annulé » (retour à l'état neutre) de « l'export
/// a échoué » (affichage d'une erreur). Une phrase traduite ici rendrait ce test
/// dépendant de la langue.
pub const CANCELLED_TOKEN: &str = "EXPORT_CANCELLED";

/// Demande l'arrêt de l'export en cours. Sans effet s'il n'y en a pas.
pub fn request() {
    CANCEL_REQUESTED.store(true, Ordering::Relaxed);
}

/// Rearme le drapeau. À appeler au DÉMARRAGE de chaque export, sinon une
/// annulation précédente tuerait le suivant dès sa première frame.
pub fn reset() {
    CANCEL_REQUESTED.store(false, Ordering::Relaxed);
}

pub fn is_requested() -> bool {
    CANCEL_REQUESTED.load(Ordering::Relaxed)
}

/// `Err(CANCELLED_TOKEN)` si une annulation est demandée, `Ok(())` sinon.
pub fn check() -> Result<()> {
    if is_requested() {
        bail!(CANCELLED_TOKEN);
    }
    Ok(())
}
