---
id: whats-new
title: What's new since openscreen
sidebar_position: 3.5
sidebar_label: What's new
description: "What Capturia 2.1 and 2.2 changed against the openscreen 1.10 baseline: area recording, saved looks, flag zooms, the region menu, speech models, and more."
keywords:
  - Capturia changelog
  - openscreen fork
  - area recording
  - saved looks
  - what's new
---

# What's new since openscreen

Capturia is a fork of [openscreen](https://github.com/getopenscreen/openscreen), re-baselined onto upstream **v1.10.0**. Everything in the table below arrived after that baseline, in Capturia **2.1** and **2.2**. Feature names link to the page that documents them.

| Feature | openscreen 1.10 | Capturia 2.1–2.2 |
|---|---|---|
| [Area recording](./recording.md#choosing-a-source) | Whole screen or one window | Drag a rectangle on a screen and record just that. Not offered on Linux.<br />![Area selection overlay](/img/screens/area-recording.png) |
| [Saved looks](./editing-timeline.md#saved-looks) | Not in 1.10 | Save background, effects, cursor and caption styling as a named look; star one as the default for new projects.<br />![Saved looks popover](/img/screens/saved-looks.png) |
| [Zooms at flagged moments](./editing-timeline.md#auto-enhance) | No way to mark a moment while recording | Flag a moment from the HUD while recording; auto-enhance turns each flag into one zoom.<br />![Timeline with zooms on the flagged moments](/img/screens/flag-zooms.png) |
| [Right-click region menu + paste attributes](./editing-timeline.md#right-click-menu) | `Ctrl/Cmd + C` / `V` only — the menu was open as [upstream #24](https://github.com/getopenscreen/openscreen/issues/24) | Copy, Paste at playhead, Delete on a region pill; Split at playhead on a clip; `Ctrl/Cmd + Shift + V` pastes attributes onto a region you already have.<br />![Right-click menu on a region](/img/screens/region-menu.png) |
| [Poster thumbnails](./media-library.md#starting-a-project) | Recent projects listed without poster frames | Each recent project shows a frame grabbed from its own footage.<br />![Open project dialog with poster frames](/img/screens/project-posters.png) |
| [Speech-model choice](./ai-editing.md#speech-model) | One built-in Whisper model, not configurable | Fast, Balanced, or Accurate — switch without losing existing transcripts.<br />![Speech model cards](/img/screens/speech-model.png) |
| [Recordings folder](./recording.md#where-recordings-are-saved) | Default location only | Point new takes at any folder, and reset back. Earlier recordings stay where they were saved.<br />![Save recordings to, in HUD settings](/img/screens/recordings-folder.png) |
| Pre-release channel | Stable releases only | **Get pre-release builds** in settings: opt in to release candidates, off by default. |
| Click highlight | Not in 1.10 | An opt-in ring under the cursor on every recorded click, drawn by the same cursor pass in preview and export, so it follows zoom and tilt. Off by default; saved looks carry it. |
| [Speed up idle](./editing-timeline.md#auto-enhance) | Not in 1.10 | Auto-enhance lays 3× speed regions over stretches where the cursor sits still and nobody is speaking. |
| Export dialog memory | Defaults on every open | Format, quality, frame rate, codec, aspect ratio and GIF options come back from the last export that succeeded. |
| Auto-level | Open on the roadmap as voice enhancement | One click measures the take's loudness on this device and sets the output gain so speech lands around −16 LUFS, within ±12 dB. |
| [Linux hardware encode](./export.md#how-mp4-is-rendered) | Software H.264 encode on Linux | H.264 export goes through `h264_vaapi` from the compositor's own dmabuf, and falls back to software when the driver refuses the imported frame. HEVC and non-VAAPI stacks stay software-encoded. |

The [roadmap](/roadmap) tracks what is still open, including the items above that are only partly done.
