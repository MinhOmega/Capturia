export interface ParsedFeed {
  head: string[]
  entries: string[]
  tail: string[]
  version: string | null
}

export function parseUpdateFeed(text: string): ParsedFeed
export function mergeUpdateFeeds(texts: string[]): string
