//! Un démultiplexage qui échoue ne doit pas emporter un descripteur de fichier avec lui.
//!
//! `avformat_open_input` réussi tient un fd. Tout `?` posé entre l'ouverture et la
//! fermeture explicite en fuitait un — et le compositeur tourne dans le processus
//! principal d'Electron, qui vit des heures : un export de 200 clips dont quelques-uns
//! sont illisibles finissait en `EMFILE` sur un fichier sans aucun rapport, longtemps
//! après la cause. `ffi::InputGuard` ferme le contexte sur tous les chemins.
//!
//! Linux seulement : la mesure passe par `/proc/self/fd`, qui n'existe pas ailleurs. Le
//! `Drop` testé, lui, est du code partagé par les trois plateformes.
#![cfg(target_os = "linux")]

use openscreen_compositor::audio::decode_clip_audio;
use openscreen_compositor::ffi::*;
use std::ffi::CString;
use std::ptr;

/// Descripteurs ouverts par le processus.
fn fd_count() -> usize {
    std::fs::read_dir("/proc/self/fd").expect("/proc/self/fd").count()
}

/// Matroska minimal à une piste VIDÉO, sans audio : `decode_clip_audio` y répond
/// `Ok(None)` après avoir ouvert — et donc après avoir pris un fd.
///
/// VP8 parce que matroska le range sans jamais regarder la charge utile ; le test est de
/// niveau conteneur, comme `remux_seek_index.rs`.
fn write_video_only_matroska(path: &str) {
    let cpath = CString::new(path).unwrap();
    let cfmt = CString::new("matroska").unwrap();
    unsafe {
        let mut octx: *mut AVFormatContext = ptr::null_mut();
        assert!(
            avformat_alloc_output_context2(&mut octx, ptr::null(), cfmt.as_ptr(), cpath.as_ptr())
                >= 0,
            "alloc_output_context2"
        );
        let st = avformat_new_stream(octx, ptr::null());
        assert!(!st.is_null(), "avformat_new_stream");
        (*(*st).codecpar).codec_type = AVMediaType::AVMEDIA_TYPE_VIDEO;
        (*(*st).codecpar).codec_id = AVCodecID::AV_CODEC_ID_VP8;
        (*(*st).codecpar).width = 16;
        (*(*st).codecpar).height = 16;
        (*st).time_base = AVRational { num: 1, den: 1000 };

        let mut pb: *mut AVIOContext = ptr::null_mut();
        assert!(avio_open(&mut pb, cpath.as_ptr(), AVIO_FLAG_WRITE as i32) >= 0, "avio_open");
        sn_fmt_set_pb(octx, pb);
        assert!(avformat_write_header(octx, ptr::null_mut()) >= 0, "write_header");

        let payload = vec![0x42u8; 256];
        let pkt = av_packet_alloc();
        for i in 0..10i64 {
            assert!(av_new_packet(pkt, payload.len() as i32) >= 0, "av_new_packet");
            ptr::copy_nonoverlapping(payload.as_ptr(), (*pkt).data, payload.len());
            (*pkt).stream_index = 0;
            (*pkt).pts = i * 40;
            (*pkt).dts = i * 40;
            (*pkt).duration = 40;
            (*pkt).flags = AV_PKT_FLAG_KEY as i32;
            assert!(av_interleaved_write_frame(octx, pkt) >= 0, "write_frame");
        }
        let mut pkt = pkt;
        av_packet_free(&mut pkt);
        assert!(av_write_trailer(octx) >= 0, "write_trailer");
        let mut pb = sn_fmt_get_pb(octx);
        avio_closep(&mut pb);
        avformat_free_context(octx);
    }
}

/// Matroska à une piste `pcm_s16le` STÉRÉO dont les paquets ne font pas un nombre entier
/// d'échantillons (6 octets pour un `block_align` de 4).
///
/// `pcm_decode_frame` refuse ça par `AVERROR_INVALIDDATA`, remonté par
/// `avcodec_receive_frame` : c'est un `?` réellement atteignable au milieu de
/// `decode_clip_audio_inner`, donc exactement le chemin qui fuitait.
fn write_misaligned_pcm_matroska(path: &str) {
    let cpath = CString::new(path).unwrap();
    let cfmt = CString::new("matroska").unwrap();
    unsafe {
        let mut octx: *mut AVFormatContext = ptr::null_mut();
        assert!(
            avformat_alloc_output_context2(&mut octx, ptr::null(), cfmt.as_ptr(), cpath.as_ptr())
                >= 0
        );
        let st = avformat_new_stream(octx, ptr::null());
        let par = (*st).codecpar;
        (*par).codec_type = AVMediaType::AVMEDIA_TYPE_AUDIO;
        (*par).codec_id = AVCodecID::AV_CODEC_ID_PCM_S16LE;
        (*par).sample_rate = 48_000;
        (*par).format = AVSampleFormat::AV_SAMPLE_FMT_S16 as i32;
        (*par).bits_per_coded_sample = 16;
        (*par).block_align = 4;
        av_channel_layout_default(&mut (*par).ch_layout, 2);
        (*st).time_base = AVRational { num: 1, den: 48_000 };

        let mut pb: *mut AVIOContext = ptr::null_mut();
        assert!(avio_open(&mut pb, cpath.as_ptr(), AVIO_FLAG_WRITE as i32) >= 0);
        sn_fmt_set_pb(octx, pb);
        assert!(avformat_write_header(octx, ptr::null_mut()) >= 0);

        // 6 octets : 1,5 échantillon stéréo. Le décodeur PCM rejette.
        let payload = [1u8, 2, 3, 4, 5, 6];
        let pkt = av_packet_alloc();
        for i in 0..20i64 {
            assert!(av_new_packet(pkt, payload.len() as i32) >= 0);
            ptr::copy_nonoverlapping(payload.as_ptr(), (*pkt).data, payload.len());
            (*pkt).stream_index = 0;
            (*pkt).pts = i;
            (*pkt).dts = i;
            (*pkt).duration = 1;
            (*pkt).flags = AV_PKT_FLAG_KEY as i32;
            assert!(av_interleaved_write_frame(octx, pkt) >= 0);
        }
        let mut pkt = pkt;
        av_packet_free(&mut pkt);
        assert!(av_write_trailer(octx) >= 0);
        let mut pb = sn_fmt_get_pb(octx);
        avio_closep(&mut pb);
        avformat_free_context(octx);
    }
}

fn fixture(name: &str) -> (std::path::PathBuf, String) {
    let dir = std::env::temp_dir().join(format!("capturia-fd-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("clip.mkv");
    let s = path.to_str().unwrap().to_string();
    write_video_only_matroska(&s);
    (dir, s)
}

/// Le garde lui-même : 300 ouvertures abandonnées sans fermeture explicite.
///
/// C'est le défaut à l'état pur — avant, le `?` qui sautait la fermeture laissait
/// exactement ça derrière lui.
#[test]
fn an_abandoned_input_guard_closes_its_file_descriptor() {
    let (dir, path) = fixture("guard");
    let cpath = CString::new(path.as_str()).unwrap();

    // Un tour à vide : ffmpeg charge ses protocoles et ses tables au premier appel, ce
    // qui peut ouvrir des fd une bonne fois. La mesure part d'après.
    unsafe {
        let mut warm = InputGuard::empty();
        avformat_open_input(&mut warm.0, cpath.as_ptr(), ptr::null_mut(), ptr::null_mut());
    }
    let before = fd_count();
    for _ in 0..300 {
        unsafe {
            let mut open = InputGuard::empty();
            assert!(
                avformat_open_input(&mut open.0, cpath.as_ptr(), ptr::null_mut(), ptr::null_mut())
                    >= 0,
                "open_input"
            );
            // Aucune fermeture explicite : c'est `Drop` qui doit s'en charger.
        }
    }
    let after = fd_count();
    assert!(
        after <= before + 2,
        "300 ouvertures abandonnées ont laissé {} fd ouverts ({before} -> {after})",
        after as i64 - before as i64
    );

    // `release()` cède la propriété : le contexte DOIT survivre, sinon le chemin de
    // succès d'un `open` rendrait une structure au pointeur déjà fermé.
    unsafe {
        let mut open = InputGuard::empty();
        assert!(
            avformat_open_input(&mut open.0, cpath.as_ptr(), ptr::null_mut(), ptr::null_mut()) >= 0
        );
        let mut fmt = open.release();
        assert!(!fmt.is_null(), "release a rendu NULL");
        // Toujours vivant : on peut encore l'interroger, puis c'est à nous de fermer.
        assert!(sn_fmt_nb_streams(fmt) > 0, "contexte fermé trop tôt par le garde");
        avformat_close_input(&mut fmt);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Et le même compte à travers `decode_clip_audio`, qui est le call site qui fuyait.
#[test]
fn decoding_audio_from_two_hundred_clips_does_not_grow_the_fd_table() {
    let (dir, path) = fixture("audio");

    let _ = decode_clip_audio(&path, 0.0, 1.0);
    let before = fd_count();
    for _ in 0..200 {
        // Pas de piste audio : `Ok(None)`, après ouverture — donc après avoir pris un fd.
        let r = decode_clip_audio(&path, 0.0, 1.0).expect("pas d'erreur attendue");
        assert!(r.is_none(), "ce clip n'a pas de piste audio");
    }
    let after = fd_count();
    assert!(
        after <= before + 2,
        "200 décodages ont laissé {} fd ouverts ({before} -> {after})",
        after as i64 - before as i64
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// **Le chemin qui fuyait vraiment** : un `?` au milieu du décodage.
///
/// Une piste PCM mal alignée fait sortir `avcodec_receive_frame` en `AVERROR_INVALIDDATA`,
/// donc `decode_clip_audio` par `?` — entre l'ouverture et la fermeture explicite. Avant
/// le garde, chacun de ces 200 appels emportait un `AVFormatContext` et son fd.
#[test]
fn a_clip_that_fails_mid_decode_still_closes_its_file() {
    let dir = std::env::temp_dir().join("capturia-fd-midfail");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("clip.mkv");
    let path = path.to_str().unwrap().to_string();
    write_misaligned_pcm_matroska(&path);

    let first = decode_clip_audio(&path, 0.0, 1.0);
    assert!(first.is_err(), "ce clip doit échouer en cours de décodage : {first:?}");

    let before = fd_count();
    for _ in 0..200 {
        assert!(decode_clip_audio(&path, 0.0, 1.0).is_err());
    }
    let after = fd_count();
    assert!(
        after <= before + 2,
        "200 échecs en cours de décodage ont laissé {} fd ouverts ({before} -> {after})",
        after as i64 - before as i64
    );
    let _ = std::fs::remove_dir_all(&dir);
}
