import { mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

if (process.platform !== 'darwin') {
  console.log('[native-helper] non-macOS platform, skipping ScreenCaptureKit helper build');
  process.exit(0);
}

const projectRoot = process.cwd();
const arch = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
const swiftTarget = `${arch}-apple-macos13.0`;
const helperEntitlements = path.join(projectRoot, 'build/entitlements.native-helper.plist');
const helperEntitlementsAV = path.join(projectRoot, 'build/entitlements.native-helper-av.plist');

const helpers = [
  {
    label: 'ScreenCaptureKit recorder helper',
    sourcePath: path.join(projectRoot, 'electron/native/macos/sck-recorder.swift'),
    outputPath: path.join(projectRoot, 'electron/native/bin/sck-recorder'),
    entitlements: helperEntitlementsAV,
    frameworks: [
      'ScreenCaptureKit',
      'AVFoundation',
      'CoreMedia',
      'CoreVideo',
      'CoreGraphics',
      'Foundation',
    ],
  },
  {
    label: 'cursor kind monitor helper',
    sourcePath: path.join(projectRoot, 'electron/native/macos/cursor-kind-monitor.swift'),
    outputPath: path.join(projectRoot, 'electron/native/bin/cursor-kind-monitor'),
    entitlements: helperEntitlements,
    frameworks: [
      'Foundation',
      'AppKit',
      'CryptoKit',
    ],
  },
  {
    label: 'mouse button monitor helper',
    sourcePath: path.join(projectRoot, 'electron/native/macos/mouse-button-monitor.swift'),
    outputPath: path.join(projectRoot, 'electron/native/bin/mouse-button-monitor'),
    entitlements: helperEntitlements,
    frameworks: [
      'Foundation',
      'AppKit',
    ],
  },
  {
    label: 'speech transcriber helper',
    sourcePath: path.join(projectRoot, 'electron/native/macos/speech-transcriber.swift'),
    outputPath: path.join(projectRoot, 'electron/native/bin/speech-transcriber'),
    entitlements: helperEntitlementsAV,
    frameworks: [
      'Foundation',
      'AVFoundation',
      'Speech',
    ],
  },
];

for (const helper of helpers) {
  mkdirSync(path.dirname(helper.outputPath), { recursive: true });

  const args = [
    'swiftc',
    '-parse-as-library',
    '-O',
    '-target', swiftTarget,
    helper.sourcePath,
    ...helper.frameworks.flatMap((framework) => ['-framework', framework]),
    '-o', helper.outputPath,
  ];

  console.log(`[native-helper] compiling ${helper.label} (target: ${swiftTarget})...`);
  const result = spawnSync('xcrun', args, {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  if (!existsSync(helper.outputPath)) {
    console.error(`[native-helper] expected output binary was not created: ${helper.outputPath}`);
    process.exit(1);
  }

  spawnSync('chmod', ['755', helper.outputPath], { stdio: 'inherit' });

  if (!existsSync(helper.entitlements)) {
    console.error(`[native-helper] entitlements file not found: ${helper.entitlements}`);
    process.exit(1);
  }

  console.log(`[native-helper] signing ${helper.label} with entitlements...`);
  const signResult = spawnSync('codesign', [
    '--sign', '-',
    '--force',
    '--entitlements', helper.entitlements,
    helper.outputPath,
  ], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  if (signResult.status !== 0) {
    console.error(`[native-helper] codesign failed for ${helper.outputPath}`);
    process.exit(signResult.status ?? 1);
  }

  // Verify the deployment target is set to 13.0 (Darwin 22.0) in the built binary.
  const vtoolResult = spawnSync('vtool', ['-show', helper.outputPath], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (vtoolResult.status === 0) {
    const vtoolOutput = String(vtoolResult.stdout);
    const minosMatch = /minos\s+(\d+)\.(\d+)/.exec(vtoolOutput);
    if (minosMatch) {
      const minosMajor = Number(minosMatch[1]);
      const minosMinor = Number(minosMatch[2]);
      if (minosMajor !== 13 || minosMinor !== 0) {
        console.error(`[native-helper] deployment target mismatch for ${helper.outputPath}: expected minos 13.0, got ${minosMajor}.${minosMinor}`);
        process.exit(1);
      }
      console.log(`[native-helper] verified deployment target: minos ${minosMajor}.${minosMinor}`);
    } else {
      console.warn(`[native-helper] could not parse minos from vtool output for ${helper.outputPath}, skipping verification`);
    }
  } else {
    // vtool not available, fall back to otool
    const otoolResult = spawnSync('otool', ['-l', helper.outputPath], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (otoolResult.status === 0) {
      const otoolOutput = String(otoolResult.stdout);
      const minosMatch = /minos\s+(\d+)\.(\d+)/.exec(otoolOutput);
      if (minosMatch) {
        const minosMajor = Number(minosMatch[1]);
        const minosMinor = Number(minosMatch[2]);
        if (minosMajor !== 13 || minosMinor !== 0) {
          console.error(`[native-helper] deployment target mismatch for ${helper.outputPath}: expected minos 13.0, got ${minosMajor}.${minosMinor}`);
          process.exit(1);
        }
        console.log(`[native-helper] verified deployment target: minos ${minosMajor}.${minosMinor}`);
      } else {
        console.warn(`[native-helper] could not parse minos from otool output for ${helper.outputPath}, skipping verification`);
      }
    } else {
      console.warn(`[native-helper] neither vtool nor otool available, skipping deployment target verification`);
    }
  }

  console.log(`[native-helper] built ${helper.outputPath}`);
}
