//! A failed export must not leave its half-written file at the destination the
//! user picked — and must not eat a pre-existing file it never touched.
//!
//! The MP4 pipelines themselves cannot be driven from a plain `cargo test`:
//! `run_composited_multi` takes a `&Compositor`, which needs a real GPU device
//! (Vulkan on Linux, Metal on macOS, D3D11 on Windows), so every test that
//! reaches them is opt-in behind an env var and a fixture — see
//! `compose_linux.rs` and `export_timing.rs`. The cleanup contract lives
//! entirely in `partial_output::discard_partial_output`, which the three
//! pipelines and `gif_export` all route through, so it is exercised directly.

use openscreen_compositor::partial_output::discard_partial_output;
use std::path::PathBuf;

fn scratch(name: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("openscreen_partial_output_{}_{}", std::process::id(), name));
    let _ = std::fs::remove_file(&p);
    p
}

#[test]
fn failed_export_leaves_no_file_behind() {
    // The case from the bug report: nothing at the destination, the export
    // creates its output, then dies partway. No corrupt file may survive.
    let out = scratch("created");
    let err = discard_partial_output(&out, || -> anyhow::Result<()> {
        std::fs::write(&out, b"moov-less mp4")?;
        anyhow::bail!("encoder died");
    });
    assert!(err.is_err());
    assert!(!out.exists(), "un export rate a laisse {} derriere lui", out.display());

    // Exporting over an existing file: `avio_open` truncates it, so the
    // original is already gone by the time the run fails. Removing the corrupt
    // remains beats leaving them under the name the user expects.
    let over = scratch("clobbered");
    std::fs::write(&over, b"the user's previous export").unwrap();
    // mtime granularity on some filesystems is coarse; change the length too so
    // the fingerprint moves for the reason the helper documents.
    let err = discard_partial_output(&over, || -> anyhow::Result<()> {
        std::fs::write(&over, b"trunc")?;
        anyhow::bail!("encoder died");
    });
    assert!(err.is_err());
    assert!(!over.exists(), "le fichier tronque a survecu");

    // A run that fails BEFORE opening the output (empty clip list, no encoder,
    // muxer refused) must not touch a file it never wrote. Deleting the user's
    // pre-existing video here would be far worse than the bug being fixed.
    let untouched = scratch("untouched");
    std::fs::write(&untouched, b"the user's previous export").unwrap();
    let err = discard_partial_output(&untouched, || -> anyhow::Result<()> {
        anyhow::bail!("aucun clip a exporter")
    });
    assert!(err.is_err());
    assert_eq!(
        std::fs::read(&untouched).unwrap(),
        b"the user's previous export",
        "un echec precoce a supprime un fichier que l'export n'a jamais ecrit"
    );

    // Success keeps its output, obviously.
    let ok = scratch("ok");
    let stats = discard_partial_output(&ok, || -> anyhow::Result<u64> {
        std::fs::write(&ok, b"a whole mp4")?;
        Ok(42)
    })
    .expect("succes");
    assert_eq!(stats, 42);
    assert!(ok.exists(), "un export reussi a ete supprime");

    for p in [&out, &over, &untouched, &ok] {
        let _ = std::fs::remove_file(p);
    }
}
