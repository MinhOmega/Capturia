#!/usr/bin/env python3
"""
Icon Processor & Multi-Platform Generator
==========================================
Extracts the app icon from a source image with a baked-in background
(checkered fake-transparency OR solid color), removes the background,
and produces all icon assets needed by Electron, macOS (.icns), and
Windows (.ico).

Strategy: Auto-detect background type by sampling corner pixels, then
find the icon's rounded-rectangle boundary using color distance from
the background. Composite glow/light effects that extend beyond it.

Usage:
    python3 scripts/generate-icons.py [source_image_path]

Requires: Pillow (pip install Pillow)
macOS .icns generation requires: iconutil (ships with Xcode CLI tools)
"""

import sys
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DEFAULT_SOURCE = os.path.expanduser(
    "~/Downloads/Gemini_Generated_Image_kxvfhjkxvfhjkxvf.png"
)
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
ICONS_DIR = PROJECT_ROOT / "icons" / "icons"

MACOS_ICONSET = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
}
WINDOWS_ICO_SIZES = [16, 24, 32, 48, 64, 256]
PNG_EXPORT_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]


# ---------------------------------------------------------------------------
# Step 1: Detect background color
# ---------------------------------------------------------------------------
def detect_background(arr_rgb: np.ndarray) -> dict:
    """
    Auto-detect the background type and color by sampling corner regions.
    Returns dict with 'color' (mean RGB), 'type' ('solid' or 'checker').
    """
    h, w = arr_rgb.shape[:2]
    margin = 30  # pixels from edge to sample

    # Sample 4 corner regions (30x30 blocks)
    corners = [
        arr_rgb[:margin, :margin],           # top-left
        arr_rgb[:margin, w - margin:],       # top-right
        arr_rgb[h - margin:, :margin],       # bottom-left
        arr_rgb[h - margin:, w - margin:],   # bottom-right
    ]

    all_pixels = np.concatenate([c.reshape(-1, 3) for c in corners], axis=0)
    mean_color = np.mean(all_pixels, axis=0)

    # Check if background is uniform (solid) or varied (checker)
    std_per_pixel = np.std(all_pixels, axis=0)
    overall_std = np.mean(std_per_pixel)

    if overall_std < 25:
        bg_type = "solid"
    else:
        bg_type = "checker"

    print(f"  Background: {bg_type}, color=RGB({mean_color[0]:.0f}, "
          f"{mean_color[1]:.0f}, {mean_color[2]:.0f}), std={overall_std:.1f}")

    return {
        "color": mean_color,
        "type": bg_type,
    }


def color_distance(arr_rgb: np.ndarray, ref_color: np.ndarray) -> np.ndarray:
    """Euclidean color distance from each pixel to a reference color."""
    diff = arr_rgb.astype(np.float64) - ref_color.astype(np.float64)
    return np.sqrt(np.sum(diff ** 2, axis=2))


# ---------------------------------------------------------------------------
# Step 2: Detect the icon's rounded-rectangle boundary
# ---------------------------------------------------------------------------
def detect_icon_bounds(arr_rgb: np.ndarray, bg_info: dict) -> dict:
    """
    Find the rounded-rectangle icon region by scanning for pixels that
    differ significantly from the detected background color.
    Returns dict with top, bottom, left, right, corner_radius.
    """
    h, w = arr_rgb.shape[:2]
    bg_color = bg_info["color"]

    # Compute per-pixel color distance from background
    cdist = color_distance(arr_rgb, bg_color)

    # Adaptive threshold: scale with expected bg→icon distance.
    # Dark icon interior is roughly (10,14,28). Threshold is ~30% of the
    # full distance, ensuring we detect the actual icon edge, not the
    # soft AA transition zone.
    dark_ref = np.array([10, 14, 28], dtype=np.float64)
    bg_to_dark = np.sqrt(np.sum((bg_color.astype(np.float64) - dark_ref) ** 2))
    dist_threshold = max(50, bg_to_dark * 0.30)
    mid_y, mid_x = h // 2, w // 2

    # Left edge: scan rightward at mid_y
    left = 0
    for x in range(w):
        if cdist[mid_y, x] > dist_threshold:
            left = x
            break

    # Right edge: scan leftward at mid_y
    right = w - 1
    for x in range(w - 1, -1, -1):
        if cdist[mid_y, x] > dist_threshold:
            right = x
            break

    # Top edge: scan downward at mid_x
    top = 0
    for y in range(h):
        if cdist[y, mid_x] > dist_threshold:
            top = y
            break

    # Bottom edge: scan upward at mid_x
    bottom = h - 1
    for y in range(h - 1, -1, -1):
        if cdist[y, mid_x] > dist_threshold:
            bottom = y
            break

    # Detect corner radius by scanning rows near the top.
    # Walk down from the top edge and find where the icon starts at each row.
    corner_radius = 0
    for offset in range(1, 400):
        y_check = top + offset
        if y_check >= h:
            break
        row_left = left
        for x in range(left, right):
            if cdist[y_check, x] > dist_threshold:
                row_left = x
                break
        if row_left <= left + 2:
            corner_radius = offset
            break

    return {
        "top": top,
        "bottom": bottom,
        "left": left,
        "right": right,
        "corner_radius": corner_radius,
        "width": right - left + 1,
        "height": bottom - top + 1,
    }


# ---------------------------------------------------------------------------
# Step 3: Build the alpha mask
# ---------------------------------------------------------------------------
def build_icon_mask(arr_rgb: np.ndarray, bounds: dict, bg_info: dict) -> np.ndarray:
    """
    Create a uint8 alpha mask that covers:
      1. The core rounded rectangle (100% opaque)
      2. Glow/light effects extending outside the rect (variable opacity)
      3. Smooth anti-aliased edges
    """
    h, w = arr_rgb.shape[:2]
    top, bottom = bounds["top"], bounds["bottom"]
    left, right = bounds["left"], bounds["right"]
    radius = bounds["corner_radius"]
    bg_color = bg_info["color"]

    # --- Layer 1: Core rounded rectangle mask ---
    # Inset the core mask by 5px so its AA edge sits inside the dark icon
    # interior, not at the bg↔icon transition zone. This prevents
    # background-colored pixels from showing through at partial alpha.
    # 5px on a ~1500px icon is 0.3% — negligible.
    inset = 5
    m_left = left + inset
    m_top = top + inset
    m_right = right - inset
    m_bottom = bottom - inset
    m_radius = max(1, radius - inset)

    # Drawn at 4x resolution for sub-pixel smooth anti-aliasing
    scale = 4
    mask_hr = Image.new("L", (w * scale, h * scale), 0)
    draw = ImageDraw.Draw(mask_hr)
    draw.rounded_rectangle(
        [
            (m_left * scale, m_top * scale),
            (m_right * scale, m_bottom * scale),
        ],
        radius=m_radius * scale,
        fill=255,
    )
    # Downsample with anti-aliasing
    core_mask = mask_hr.resize((w, h), Image.LANCZOS)
    core = np.array(core_mask, dtype=np.float32)

    # --- Layer 2: Glow / light-effect mask ---
    # Glow = bright light effects extending outside the rounded rect.
    # Must be: (a) far from background color, AND (b) reasonably bright
    # (to exclude dark transition pixels at the bg↔icon edge).
    cdist = color_distance(arr_rgb, bg_color)
    brightness = np.mean(arr_rgb, axis=2)

    # Soft distance ramp: 0 below 50, full at 90
    dist_ramp = np.clip((cdist - 50) / 40 * 255, 0, 255)

    # Brightness gate: glow effects are bright (light beams, lens flares).
    # Edge-transition pixels (brightness < 120) are NOT glow — they're just
    # AA blends between the dark icon and the background.
    bright_gate = np.clip((brightness - 120) / 40 * 255, 0, 255)

    glow = np.minimum(dist_ramp, bright_gate)

    # Limit glow to a band around the icon (within ~80px of boundary).
    # This prevents distant artifacts like watermarks from leaking in.
    expand = 80
    glow_region = np.zeros_like(glow)
    t_exp = max(0, top - expand)
    b_exp = min(h, bottom + expand)
    l_exp = max(0, left - expand)
    r_exp = min(w, right + expand)
    glow_region[t_exp:b_exp, l_exp:r_exp] = 1.0
    glow = glow * glow_region

    # Feather the glow mask so it fades smoothly
    glow_img = Image.fromarray(glow.astype(np.uint8))
    glow_img = glow_img.filter(ImageFilter.GaussianBlur(radius=3))
    glow = np.array(glow_img, dtype=np.float32)

    # --- Combine: core takes priority; glow only where core is absent ---
    # At the core's AA edge (core 10-240), using max(core, glow) would boost
    # alpha on bg-contaminated pixels, creating a visible fringe. Instead,
    # use core wherever it has any value, and glow only in the exterior.
    combined = np.where(core > 5, core, glow)
    combined = np.clip(combined, 0, 255).astype(np.uint8)

    return combined


# ---------------------------------------------------------------------------
# Step 3: Extract, crop, and clean the icon
# ---------------------------------------------------------------------------
def extract_icon(img: Image.Image) -> tuple[Image.Image, dict]:
    """
    Full extraction pipeline: detect background, detect bounds, build mask,
    apply, crop. Returns (cropped_icon_RGBA, bounds_info).
    """
    arr = np.array(img, dtype=np.float32)[:, :, :3]

    bg_info = detect_background(arr)
    bounds = detect_icon_bounds(arr, bg_info)

    print(f"  Detected bounds: L={bounds['left']} T={bounds['top']} "
          f"R={bounds['right']} B={bounds['bottom']} "
          f"({bounds['width']}x{bounds['height']}), "
          f"corner_r={bounds['corner_radius']}")

    alpha = build_icon_mask(arr, bounds, bg_info)

    # Assemble RGBA
    result = np.array(img).copy()
    result[:, :, 3] = alpha

    # Despill: remove background color bleed from semi-transparent edge pixels.
    # For pixels with partial alpha (AA edge), the RGB may be contaminated
    # by the background color. Replace their RGB with the icon's dark interior.
    bg_color = bg_info["color"]
    edge_mask = (alpha > 5) & (alpha < 240)
    if np.any(edge_mask):
        # Detect spill by checking color similarity to background
        pixel_dist = color_distance(arr, bg_color)
        # Pixels at the edge that are close to bg color → contaminated
        spill = edge_mask & (pixel_dist < 80)
        if np.any(spill):
            # Sample the icon's dark interior color for replacement
            interior = (alpha == 255)
            if np.any(interior):
                dark_rgb = np.median(
                    result[interior][:, :3].astype(np.float32), axis=0
                )
            else:
                dark_rgb = np.array([10, 14, 28], dtype=np.float32)
            # Blend: the more bg-like, the more we replace with dark fill
            blend = np.clip(1.0 - pixel_dist[spill] / 80.0, 0, 1)
            for c in range(3):
                ch = result[:, :, c].astype(np.float32)
                ch[spill] = ch[spill] * (1 - blend) + dark_rgb[c] * blend
                result[:, :, c] = np.clip(ch, 0, 255).astype(np.uint8)

    icon_full = Image.fromarray(result)

    # Crop to bounding box of opaque content, then make square
    rows = np.any(alpha > 10, axis=1)
    cols = np.any(alpha > 10, axis=0)
    t, b = np.where(rows)[0][[0, -1]]
    l, r = np.where(cols)[0][[0, -1]]

    cx = (l + r) / 2.0
    cy = (t + b) / 2.0
    side = max(b - t + 1, r - l + 1)
    # Add 1% padding
    padding = int(side * 0.01)
    side += 2 * padding

    x0 = int(cx - side / 2)
    y0 = int(cy - side / 2)

    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    # Paste with clamping
    src_x0 = max(0, x0)
    src_y0 = max(0, y0)
    src_x1 = min(img.size[0], x0 + side)
    src_y1 = min(img.size[1], y0 + side)
    region = icon_full.crop((src_x0, src_y0, src_x1, src_y1))
    canvas.paste(region, (max(0, -x0), max(0, -y0)))

    return canvas, bounds


# ---------------------------------------------------------------------------
# Step 4: Platform-specific base images
# ---------------------------------------------------------------------------
def sample_dark_bg(icon: Image.Image) -> tuple:
    """Sample the icon's dark background colour from the interior."""
    arr = np.array(icon)
    size = icon.size[0]
    # Sample from the center-left area (should be the dark icon background)
    samples = []
    for dy in range(-20, 21, 10):
        for dx in range(-20, 21, 10):
            y = size // 2 + dy
            x = size // 4 + dx
            if 0 <= y < size and 0 <= x < size and arr[y, x, 3] > 200:
                samples.append(arr[y, x, :3])
    if samples:
        avg = np.mean(samples, axis=0).astype(np.uint8)
        if np.mean(avg) < 80:
            return tuple(avg.tolist())
    return (10, 14, 28)  # fallback dark navy


def make_macos_base(icon: Image.Image) -> Image.Image:
    """
    macOS applies its own squircle mask. Provide the icon composited
    on a solid dark background filling the full square.
    """
    size = icon.size[0]
    fill = sample_dark_bg(icon)
    canvas = Image.new("RGBA", (size, size), (*fill, 255))
    canvas.paste(icon, (0, 0), icon)
    return canvas


def make_rounded_icon(icon: Image.Image, radius_frac: float = 0.185) -> Image.Image:
    """
    Apply a rounded-corner mask for Windows/Linux.
    radius_frac ≈ 0.185 closely matches the icon's own built-in radius.
    """
    size = icon.size[0]
    radius = int(size * radius_frac)

    fill = sample_dark_bg(icon)
    canvas = Image.new("RGBA", (size, size), (*fill, 255))
    canvas.paste(icon, (0, 0), icon)

    # Create rounded-rect alpha mask (4x supersampled for smooth edges)
    scale = 4
    mask_hr = Image.new("L", (size * scale, size * scale), 0)
    draw = ImageDraw.Draw(mask_hr)
    draw.rounded_rectangle(
        [(0, 0), (size * scale - 1, size * scale - 1)],
        radius=radius * scale,
        fill=255,
    )
    mask = mask_hr.resize((size, size), Image.LANCZOS)
    canvas.putalpha(mask)
    return canvas


# ---------------------------------------------------------------------------
# Resize helper
# ---------------------------------------------------------------------------
def resize_icon(img: Image.Image, target_size: int) -> Image.Image:
    return img.resize((target_size, target_size), Image.LANCZOS)


# ---------------------------------------------------------------------------
# macOS .icns
# ---------------------------------------------------------------------------
def generate_macos_icns(base_img: Image.Image, output_dir: Path):
    iconset_dir = output_dir / "mac" / "icon.iconset"
    iconset_dir.mkdir(parents=True, exist_ok=True)

    for filename, px in MACOS_ICONSET.items():
        resize_icon(base_img, px).save(iconset_dir / filename, "PNG")
        print(f"  macOS: {filename} ({px}x{px})")

    icns_path = output_dir / "mac" / "icon.icns"
    try:
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset_dir), "-o", str(icns_path)],
            check=True, capture_output=True,
        )
        print(f"  macOS: icon.icns created")
        shutil.rmtree(iconset_dir)
    except FileNotFoundError:
        print("  WARNING: iconutil not found (needs Xcode CLI tools)")
    except subprocess.CalledProcessError as e:
        print(f"  WARNING: iconutil failed: {e.stderr.decode()}")


# ---------------------------------------------------------------------------
# Windows .ico
# ---------------------------------------------------------------------------
def generate_windows_ico(base_img: Image.Image, output_dir: Path):
    ico_dir = output_dir / "win"
    ico_dir.mkdir(parents=True, exist_ok=True)

    # Pillow's ICO writer works best when you provide the largest image
    # and specify which sizes to embed — it handles the downsampling.
    largest = resize_icon(base_img, max(WINDOWS_ICO_SIZES))
    for px in WINDOWS_ICO_SIZES:
        print(f"  Windows: {px}x{px}")

    ico_path = ico_dir / "icon.ico"
    largest.save(
        ico_path, format="ICO",
        sizes=[(px, px) for px in WINDOWS_ICO_SIZES],
    )
    print(f"  Windows: icon.ico created ({len(WINDOWS_ICO_SIZES)} sizes)")


# ---------------------------------------------------------------------------
# PNG set
# ---------------------------------------------------------------------------
def generate_png_set(icon: Image.Image, output_dir: Path):
    png_dir = output_dir / "png"
    png_dir.mkdir(parents=True, exist_ok=True)

    for px in PNG_EXPORT_SIZES:
        resize_icon(icon, px).save(png_dir / f"{px}x{px}.png", "PNG")
        print(f"  PNG: {px}x{px}.png")

    icon.save(png_dir / "icon-original.png", "PNG")
    print(f"  PNG: icon-original.png ({icon.size[0]}x{icon.size[1]})")


# ---------------------------------------------------------------------------
# GIF
# ---------------------------------------------------------------------------
def generate_gif(base_img: Image.Image, output_dir: Path):
    gif_dir = output_dir / "gif"
    gif_dir.mkdir(parents=True, exist_ok=True)

    gif_icon = resize_icon(base_img, 256)
    fill = sample_dark_bg(base_img)
    rgb = Image.new("RGB", gif_icon.size, fill)
    rgb.paste(gif_icon, mask=gif_icon.split()[3])
    rgb.save(gif_dir / "gif.gif", "GIF")
    print(f"  GIF: gif.gif (256x256)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    source_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not os.path.exists(source_path):
        print(f"ERROR: Source image not found: {source_path}")
        sys.exit(1)

    print(f"Source: {source_path}")
    print(f"Output: {ICONS_DIR}\n")

    src = Image.open(source_path).convert("RGBA")
    print(f"Loaded: {src.size[0]}x{src.size[1]} {src.mode}")

    # --- Extract icon ---
    print("\n[1/6] Detecting icon boundary and extracting...")
    icon_raw, bounds = extract_icon(src)
    print(f"  Extracted icon: {icon_raw.size[0]}x{icon_raw.size[1]}")

    # --- Platform bases ---
    print("\n[2/6] Building platform base images...")
    icon_macos = make_macos_base(icon_raw)
    icon_rounded = make_rounded_icon(icon_raw)

    # --- Debug output ---
    debug_dir = ICONS_DIR / "_debug"
    debug_dir.mkdir(parents=True, exist_ok=True)
    icon_raw.save(debug_dir / "01_extracted_raw.png")
    icon_macos.save(debug_dir / "02_macos_fullbleed.png")
    icon_rounded.save(debug_dir / "03_rounded_transparent.png")
    print(f"  Debug images → {debug_dir}")

    # --- Generate all formats ---
    print("\n[3/6] Generating macOS icons...")
    generate_macos_icns(icon_macos, ICONS_DIR)

    print("\n[4/6] Generating Windows icon...")
    generate_windows_ico(icon_rounded, ICONS_DIR)

    print("\n[5/6] Generating PNG icon set...")
    generate_png_set(icon_rounded, ICONS_DIR)

    print("\n[6/6] Generating GIF icon...")
    generate_gif(icon_rounded, ICONS_DIR)

    # --- Copy to project locations ---
    print("\n[Post] Copying to project locations...")
    pub = PROJECT_ROOT / "public"
    pub.mkdir(exist_ok=True)
    src_1024 = ICONS_DIR / "png" / "1024x1024.png"
    if src_1024.exists():
        shutil.copy2(src_1024, pub / "app-icon.png")
        print(f"  → public/app-icon.png")

    # Copy the banner logo (full wordmark image) if present
    banner = ICONS_DIR / "png" / "icon-original.png"
    if banner.exists():
        shutil.copy2(banner, pub / "icon-banner.png")
        print(f"  → public/icon-banner.png")

    print("\n=== Done ===")
    print(f"  macOS:   {ICONS_DIR / 'mac'}")
    print(f"  Windows: {ICONS_DIR / 'win'}")
    print(f"  PNG:     {ICONS_DIR / 'png'}")
    print(f"  GIF:     {ICONS_DIR / 'gif'}")
    print(f"  Debug:   {debug_dir}")


if __name__ == "__main__":
    main()
