#!/usr/bin/env node
/**
 * Generate the wallpaper picker thumbnails.
 *
 * The background picker shows every bundled wallpaper as a ~36 px swatch. The
 * originals are large (up to several MB, thousands of px wide), and decoding
 * all of them at once just to paint a few dozen pixels each made the picker
 * feel slow to open. This script writes a 240x240 (centre-cropped, cover)
 * JPEG next to them under `public/wallpapers/thumbs/`; the picker renders the
 * thumb while the project keeps storing the canonical full-res path.
 *
 * Run after adding or replacing a wallpaper and commit the output:
 *   node scripts/generate-wallpaper-thumbs.mjs
 *
 * Uses `sharp` (present transitively via @xenova/transformers); no new deps.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const SOURCE_DIR = path.join(ROOT, 'public', 'wallpapers')
const THUMB_DIR = path.join(SOURCE_DIR, 'thumbs')
const THUMB_SIZE = 240
const JPEG_QUALITY = 78

async function main() {
  await fs.mkdir(THUMB_DIR, { recursive: true })
  const entries = (await fs.readdir(SOURCE_DIR))
    .filter((name) => /^wallpaper\d+\.jpg$/i.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))

  let totalBytes = 0
  for (const name of entries) {
    const input = path.join(SOURCE_DIR, name)
    const output = path.join(THUMB_DIR, name.toLowerCase())
    const buffer = await sharp(input)
      .rotate()
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .toBuffer()
    await fs.writeFile(output, buffer)
    totalBytes += buffer.length
    console.log(`${path.relative(ROOT, output)}  ${(buffer.length / 1024).toFixed(1)} KB`)
  }
  console.log(`${entries.length} thumbnails, ${(totalBytes / 1024).toFixed(1)} KB total`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
