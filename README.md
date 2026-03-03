> [!WARNING]
> Capturia is still in beta and some workflows may be unstable on specific machines.

[简体中文](./README.zh-CN.md)

<p align="center">
  <img src="public/app-icon.png" alt="Capturia Banner" width="256" />
  <br />
  <a href="https://github.com/MinhOmega/Capturia">
    <img src="https://img.shields.io/badge/GitHub-Capturia-181717?logo=github" alt="Capturia on GitHub" />
  </a>
  <a href="https://MinhOmega.github.io/Capturia/">
    <img src="https://img.shields.io/badge/Website-Landing%20Page-blue?logo=astro" alt="Capturia Landing Page" />
  </a>
  <a href="https://github.com/MinhOmega/Capturia/releases">
    <img src="https://img.shields.io/github/downloads/MinhOmega/Capturia/total?logo=github&label=Downloads" alt="Total Downloads" />
  </a>
</p>

# <p align="center">Capturia</p>

<p align="center"><strong>Capturia is a free, open-source screen recorder and editor for creators, developers, and teams making product demos and walkthrough videos.</strong></p>

Capturia is built on top of the excellent [OpenScreen](https://github.com/siddharthvaddem/openscreen) foundation and significantly upgraded for a stronger macOS-native capture and editing workflow.

<p align="center">
  <img src="public/preview.png" alt="Capturia Preview 1" style="height: 320px; margin-right: 12px;" />
  <img src="public/preview2.png" alt="Capturia Preview 2" style="height: 320px; margin-right: 12px;" />
  <img src="public/preview3.png" alt="Capturia Preview 3" style="height: 320px; margin-right: 12px;" />
  <img src="public/preview4.png" alt="Capturia Preview 4" style="height: 320px; margin-right: 12px;" />
</p>

## Core Features

- Record full screen or a selected app window.
- Native macOS capture helper with native cursor hide/show capture behavior.
- Camera overlay capture on the native recording pipeline.
- Microphone voice recording with editor-side gain adjustment.
- Timeline editing: trim, crop, zoom, cursor effects, and annotations.
- Subtitle generation and rough-cut workflow in editor.
- Multi-aspect export (16:9, 9:16, 1:1 and more), including batch export.
- Export audio controls: track toggle, gain, loudness normalization, limiter.
- Recording UX controls: countdown, auto-hide launcher, customizable stop shortcut, permission diagnostics.

## Installation

Download the latest installer for your platform from [GitHub Releases](https://github.com/MinhOmega/Capturia/releases).

### macOS

If macOS Gatekeeper blocks an unsigned build, or you see "Capturia is damaged and can't be opened", run:

```bash
xattr -rd com.apple.quarantine "/Applications/Capturia.app"
```

Then grant required permissions in **System Settings -> Privacy & Security**:

- Screen Recording (or Screen & System Audio on newer macOS)
- Accessibility
- Microphone (for voice recording)
- Camera (for camera overlay)

### Linux

Download the `.AppImage` from releases and run:

```bash
chmod +x Capturia-Linux-*.AppImage
./Capturia-Linux-*.AppImage
```

## Development

### Requirements

- Node.js 20+
- npm 10+
- macOS + Xcode Command Line Tools (for native helper build)

### Run

```bash
npm install
npm run dev
```

### Build

```bash
npm run build
```

## Built With

- Electron
- React
- TypeScript
- Vite
- PixiJS
- dnd-timeline

## Contributing

Contributions are welcome through issues and pull requests.

- Issues: [https://github.com/MinhOmega/Capturia/issues](https://github.com/MinhOmega/Capturia/issues)
- Discussions: [https://github.com/MinhOmega/Capturia/discussions](https://github.com/MinhOmega/Capturia/discussions)

## Acknowledgements

- Upstream project: [siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen)

## License

This project is licensed under the [MIT License](./LICENSE).
