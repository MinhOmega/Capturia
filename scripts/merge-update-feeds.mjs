#!/usr/bin/env node
/**
 * Merges the per-architecture `latest-mac.yml` update feeds into one.
 *
 * The release workflow builds the Intel and Apple-silicon installers on two
 * runners, and electron-builder writes a `latest-mac.yml` on each that lists
 * only that leg's DMG + ZIP. electron-updater reads a single `latest-mac.yml`
 * from the release and picks the ZIP for the running architecture from its
 * `files` list, so the two feeds must be combined before they are attached.
 *
 * No YAML dependency: the feed layout is fixed (`version`, a `files` sequence
 * of two-space-indented entries, then `path` / `sha512` / `releaseDate`), so
 * the `files` entries of every extra feed are spliced into the first one.
 *
 * Usage:
 *   node scripts/merge-update-feeds.mjs <out.yml> <feed1.yml> <feed2.yml> [...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {{ head: string[]; entries: string[]; tail: string[]; version: string | null }} ParsedFeed
 */

/**
 * @param {string} text
 * @returns {ParsedFeed}
 */
export function parseUpdateFeed(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  const filesIndex = lines.findIndex((line) => line === 'files:')
  if (filesIndex < 0) throw new Error('update feed has no `files:` sequence')
  let end = filesIndex + 1
  while (end < lines.length && lines[end].startsWith('  ')) end += 1
  const versionLine = lines.find((line) => line.startsWith('version:'))
  return {
    head: lines.slice(0, filesIndex + 1),
    entries: lines.slice(filesIndex + 1, end),
    tail: lines.slice(end),
    version: versionLine ? versionLine.slice('version:'.length).trim() : null,
  }
}

/**
 * @param {string[]} texts feed contents; the first one keeps its `path`/`sha512`/`releaseDate`
 * @returns {string}
 */
export function mergeUpdateFeeds(texts) {
  if (texts.length === 0) throw new Error('no update feeds to merge')
  const feeds = texts.map(parseUpdateFeed)
  const [primary, ...others] = feeds
  for (const feed of others) {
    if (feed.version !== primary.version) {
      throw new Error(`update feeds disagree on the version: ${primary.version} vs ${feed.version}`)
    }
  }
  const seen = new Set()
  const entries = []
  for (const feed of feeds) {
    let current = []
    const flush = () => {
      if (current.length === 0) return
      const key = current[0]
      if (!seen.has(key)) {
        seen.add(key)
        entries.push(...current)
      }
      current = []
    }
    for (const line of feed.entries) {
      if (line.startsWith('  - ')) flush()
      current.push(line)
    }
    flush()
  }
  return `${[...primary.head, ...entries, ...primary.tail].join('\n')}\n`
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const [outFile, ...inputs] = process.argv.slice(2)
  if (!outFile || inputs.length === 0) {
    console.error('usage: merge-update-feeds.mjs <out.yml> <feed.yml> [<feed.yml> ...]')
    process.exit(2)
  }
  const merged = mergeUpdateFeeds(inputs.map((file) => fs.readFileSync(file, 'utf8')))
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, merged)
  console.log(`merged ${inputs.length} feed(s) into ${outFile}`)
}
