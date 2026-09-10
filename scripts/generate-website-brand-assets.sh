#!/usr/bin/env bash
#
# Regenerates the website's branding images from the fork's own application icon.
#
# Why this exists: website/static/img/ shipped upstream OpenScreen's art. The
# navbar mark, the favicon (docusaurus.config.ts points `favicon` at the same
# logo-icon.png) and the Open Graph card were byte-identical to
# getopenscreen/openscreen, so every shared link previewed a competitor's
# wordmark. The application icon under icons/icons/ was already Capturia's own —
# only the website never picked it up. This script closes that gap by DERIVING
# the web assets from that one master instead of introducing a second set of art.
#
# Like scripts/generate-appx-assets.mjs, the outputs are committed and nothing in
# the build depends on this script; run it by hand when the app icon or the
# tagline changes. It is bash rather than .mjs because every step is an
# ImageMagick invocation — the repo deliberately carries no image library (see
# the header of generate-appx-assets.mjs), and ImageMagick is a developer tool
# here, not a dependency of the app or the site.
#
# Requires: ImageMagick (`convert`), python3 with fontTools + brotli (for the
# font, see below). Run: bash scripts/generate-website-brand-assets.sh
#
# Type: Geist, the fork's own brand face — src/assets/fonts/Geist-Variable.woff2,
# SIL OFL 1.1, already vendored with its OFL.txt beside it and already the app's
# UI font (src/styles/fonts.css). No font file is added by this script: the
# variable woff2 is decompressed and instanced at the needed weights into a
# temporary directory that is deleted on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_ICON="$ROOT/icons/icons/png/1024x1024.png"
SRC_FONT="$ROOT/src/assets/fonts/Geist-Variable.woff2"
OUT="$ROOT/website/static/img"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- font: variable woff2 -> static ttf at the two weights the card uses -------
cp "$SRC_FONT" "$TMP/geist.woff2"
python3 - "$TMP" <<'PY'
import sys
from fontTools.ttLib import TTFont, woff2
from fontTools.varLib import instancer

tmp = sys.argv[1]
woff2.decompress(f"{tmp}/geist.woff2", f"{tmp}/geist.ttf")
for weight in (400, 700):
    font = TTFont(f"{tmp}/geist.ttf")
    instancer.instantiateVariableFont(font, {"wght": weight}, inplace=True)
    font.save(f"{tmp}/geist-{weight}.ttf")
PY
FONT_REGULAR="$TMP/geist-400.ttf"
FONT_BOLD="$TMP/geist-700.ttf"

# --- square icons -------------------------------------------------------------
# Sizes are the ones already referenced: 96 is what the navbar and the favicon
# link expect, 180 is the apple-touch-icon <link> in docusaurus.config.ts.
# Downscales of the 1024 master only — nothing here upsamples.
convert "$SRC_ICON" -resize 96x96   -strip "$OUT/logo-icon.png"
convert "$SRC_ICON" -resize 180x180 -strip "$OUT/apple-touch-icon.png"

# --- Open Graph card ----------------------------------------------------------
# Composition is upstream's, which was good, reproduced by measurement from the
# old card so the replacement drops in without reflowing anything: 1200x630, a
# green glow behind a centred icon, wordmark, tagline, platform line, and a
# 5px emerald rule along the bottom edge. Only the BRANDING changes — the
# wordmark, the glyph and the tagline.
#
# Text is positioned by baseline, matched to the old card: 345 / 412 / 491.
# `-gravity North -annotate +0+N` centres horizontally (exact) and puts the
# font's ascent top at N, so N = baseline - round(1.005 * pointsize) for Geist
# (hhea ascent 1005, unitsPerEm 1000). Point sizes come from the old card's
# measured cap heights over Geist's cap height ratio of 0.71.
TAGLINE="A free, open-source screen recorder and editor."   # docusaurus.config.ts `tagline`
PLATFORMS="Windows  ·  macOS  ·  Linux"                     # electron-builder targets all three
LICENCE="MIT licensed"                                      # LICENSE + package.json "license"

FG_WHITE="#ffffff"    # wordmark
FG_MUTED="#94a3b8"    # tagline
FG_DIM="#64748b"      # platform line
ACCENT="#10b981"      # licence + bottom rule
BG_BASE="#080a0d"     # card corners
BG_GLOW="#082e25"     # glow peak behind the icon

# Background: radial glow centred on the icon at (600, 200). ImageMagick's
# radial-gradient always centres on its own canvas and falls off LINEARLY over a
# radius of half the canvas, so it is rendered oversized and cropped to move the
# centre where it belongs, then bent into the S-curve the old card actually used
# — flat near the glyph, then dropping to nothing by ~620px out. The constants
# were fitted to the old card's measured profile (0.83 / 0.33 / 0.14 / 0.00 of
# peak at 140 / 300 / 400 / 613px from centre).
convert -size 1300x1300 radial-gradient:white-black -crop 1200x630+50+450 +repage \
	-sigmoidal-contrast 7x62% -depth 8 "$TMP/glow-mask.png"
convert -size 1200x630 xc:"$BG_BASE" \( -size 1200x630 xc:"$BG_GLOW" \) \
	"$TMP/glow-mask.png" -composite -depth 8 "$TMP/bg.png"

convert "$TMP/bg.png" \
	\( "$SRC_ICON" -resize 132x132 \) -geometry +534+118 -composite \
	-font "$FONT_BOLD"    -pointsize 79 -fill "$FG_WHITE" -gravity North -annotate +0+266 'Capturia' \
	-font "$FONT_REGULAR" -pointsize 37 -fill "$FG_MUTED" -gravity North -annotate +0+375 "$TAGLINE" \
	-strip "$TMP/card.png"

# Platform line is two colours, so it is drawn as two runs centred as one group:
# with total width W and a GAP between them, the grey run's centre sits at
# -(GAP + green)/2 from centre and the green run's at +(GAP + grey)/2.
GAP=40
w_platforms=$(convert -font "$FONT_REGULAR" -pointsize 25 label:"$PLATFORMS" -format '%w' info:)
w_licence=$(convert -font "$FONT_REGULAR" -pointsize 25 label:"$LICENCE" -format '%w' info:)
dx_platforms=$(( -(GAP + w_licence) / 2 ))
dx_licence=$(( (GAP + w_platforms) / 2 ))

convert "$TMP/card.png" -font "$FONT_REGULAR" -pointsize 25 -gravity North \
	-fill "$FG_DIM"    -annotate "${dx_platforms}+466" "$PLATFORMS" \
	-fill "$ACCENT"    -annotate "+${dx_licence}+466" "$LICENCE" \
	-fill "$ACCENT" -draw 'rectangle 0,625 1199,629' \
	-strip -depth 8 -define png:compression-level=9 "$OUT/og-image.png"

printf 'wrote:\n'
identify "$OUT/logo-icon.png" "$OUT/apple-touch-icon.png" "$OUT/og-image.png"
