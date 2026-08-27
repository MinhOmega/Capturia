# Review: W1-a i18n restructure

Branch `worktree-agent-a7b0c3fc5e9f664fd`, 8 commits, merged `--no-ff`.

## Verified independently (merged tree)
- lint 0 errors / 117 warnings; tsc + typecheck:test clean; vitest 51 files / 416 tests;
  `npm run i18n:check` PASS: 430 en keys / 7 namespaces, zh-CN + vi in parity, 10 partial locales
  warn-only, 453 key literals in `src/` resolve.
- Loader fallback chain read: locale → en → `ns.key` marker. Interpolation leaves unknown `{{var}}`
  in place (upstream behaviour). Persisted locale key unchanged (`capturia.locale`).
- Call-site renames spot-checked (`export.*` → `dialogs.export.*`, `permission.*` → `launch.permission.*`).
- HUD picker is data-driven from `getAvailableLocales()`.

## Lead-requested change (done in `080a888`)
- First-launch OS-language detection restricted to `COMPLETE_LOCALES = [en, zh-CN, vi]`; manual picker
  and stored preferences may select any available locale. `i18n-check` strict list is parsed from the
  same constant. zh-TW/zh-HK/zh-Hant → zh-CN until zh-TW is complete. 5 tests added.

## Notes
- `vi`: 430/430 keys (205 from upstream twins, 225 translated by the agent) — needs a native read-through
  at some point; flagged as backlog, not a gate.
- Locale JSON and loader files are tab-indented (upstream style); the end-of-sync Biome format pass
  will normalise `.ts` files, JSON stays as is.
- New keys added by later batches must go straight into the JSON namespaces (`docs/i18n.md`).
